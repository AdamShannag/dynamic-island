# Go Island

A Dynamic Island for Ubuntu (GNOME Shell 46). It replaces the top-bar clock with a pill. When nothing is happening the pill shows the time. When something happens, the pill grows down out of the top bar.

- **Left-click** opens the dashboard, with tabs for Home, Docker, Ports, Clipboard and Web.
- **Right-click** opens the regular calendar and notifications menu.
- **Esc** or clicking outside the dashboard closes it.
- **`island open [tab]`** toggles the dashboard from the command line. Bind it to a key in Settings → Keyboard → Custom Shortcuts, for example Super+Space → `island open`.

## Context awareness

You don't need to wrap anything. The daemon checks your processes about once a second and recognises dev commands:

- **Go:** `go build`, `test`, `mod`, `generate` and `run`
- **Maven:** including IntelliJ's built-in runner
- **Gradle**
- **JavaScript:** npm, pnpm, yarn and bun
- **Others:** cargo, make, `docker build`, pytest, uvicorn and Django
- **IDE run configurations:** JetBrains Java and Go run configurations

It also traces each command back to the app that started it: GoLand, IntelliJ, VS Code, Cursor, a terminal, or Claude Code.

- **Builds and tests** appear as a slim pill with a live timer. Hover over it to see the project and the app. Tasks launched from an IDE also show a "Finished" popup.
- **Dev servers** (`go run`, `npm run dev`, `spring-boot:run`, `bootRun`, IDE run configurations) appear as a service along with their ports, for example `:8080`. Services rank below music.
- **Clicking** jumps to the window that started the command.

Linux won't let one process read another unrelated process's exit code. Commands the watcher detects on its own are therefore reported as *Finished*, not passed or failed. `island run` and the bash hook do know the exit code.

## Claude Code

```sh
island claude install      # adds hooks + wraps your status line (backs up ~/.claude/settings.json first)
island claude uninstall    # removes exactly what install added
```

The island shows a Claude session as:

| State | Shown as |
|---|---|
| Working | A slim pill: `Claude · project`, a live timer, and the current tool on hover (e.g. `$ go test ./...` or `Editing ports.go`) |
| Needs approval | A yellow popup with the command or tool waiting for you |
| Finished | A popup with the turn's duration, its cost, and the start of Claude's reply. Only for turns longer than 5 s. |
| Error | A red popup with the API error (rate limit, overloaded and so on), from the `StopFailure` hook |

Clicking any of these focuses the terminal or IDE the session runs in. The **Agents** tab lists every session with its state, cost and context usage.

Cost and context usage come from Claude Code's documented status-line feed. Your own status-line command still runs and still prints the same output. Transcripts are not parsed, because their format is internal and changes between versions.

## Dashboard

| Tab | What it does |
|---|---|
| Agents | Claude Code sessions with their state, cost, context usage and when they were last active. Click a session to focus its window. |
| Home | A Now Playing card (art, live progress with time remaining, controls) and a Today card with a one-click focus timer and a container summary. |
| Docker | Running containers grouped by compose project, with health, ports and image. Each one has restart and stop buttons. Refreshes live. |
| Ports | Every listening TCP port and which process or container owns it. **Kill** frees the port (two clicks to confirm). You can also type a port number and press Enter to free it. Ports published by Docker stop their container. |
| Clipboard | A history of everything you copy, saved across reboots. Click an entry to copy it again; you can also pin, delete or filter. Copies flagged by password managers are skipped. |
| Web | A Google search box (a typed URL or `localhost:3000` opens directly), plus a grid of saved sites. **＋** adds a site and right-click removes one. Icons are fetched from each site itself. |

```
MPRIS / UPower / notifications / docker / ss / CLI
        ──► islandd (plugins → priority Manager) ══ D-Bus ══► GNOME extension (pill)
```

- **`islandd`** is a Go daemon. It runs plugins and serves the island state on the session bus as `org.goisland.Island`.
- **`extension/go-island@local`** is a GNOME Shell extension that draws the pill. It just renders whatever state the daemon sends.

## Install

```sh
make install                        # binaries + systemd user unit + extension
# first time / after JS changes: restart GNOME Shell (X11: Alt+F2 → r; Wayland: log out/in)
gnome-extensions enable go-island@local
```

## Features

| Plugin | What it shows |
|---|---|
| `mpris` | The current track from Spotify, browsers, mpv and so on. Click the pill to expand it into album art, a live progress bar and controls. |
| `battery` | A popup when you plug in or unplug, and warnings at 20%, 10% and 5%. |
| `notifications` | Mirrors desktop notifications (Slack, Telegram, calendar and so on) into the island. |
| `pomodoro` | A focus countdown, followed by a break. |
| `docker` | Alerts when a container crashes (a non-zero exit that wasn't from `docker stop`), turns unhealthy, or runs out of memory. |

**Tip:** to avoid getting GNOME's own banner as well as the island for each notification, turn GNOME banners off: `gsettings set org.gnome.desktop.notifications show-banners false`. Notifications still land in the calendar menu.

## CLI

```sh
island notify "Deployed" "prod is live"           # -a ok|warn|error  -i icon  -t ms
island run -- make test                           # live elapsed timer, then ✓/✗ with duration
island run -n "deploy" -- ./deploy.sh
island kill-port 8080                             # kill the process, or stop the container, holding a port
island pomodoro start|stop|toggle
island action media.play-pause                    # any registered action
island state                                      # current View JSON
```

### Long-command alerts in bash

```sh
echo 'source ~/personal/go-island/contrib/island-hook.bash' >> ~/.bashrc
```

Any command that runs for 15 seconds or more pops the island with ✓ or ✗ and how long it took. Set `ISLAND_MIN_SECS` to change the threshold and `ISLAND_IGNORE` to skip commands. The hook installs a `DEBUG` trap, so it can conflict with other preexec hooks such as bash-preexec.

## Config

Optional. Copy `config.example.json` to `~/.config/go-island/config.json`, then run `systemctl --user restart islandd`.

```json
{
  "disable": ["docker"],
  "notifications": { "enabled": true, "ignoreApps": ["Spotify"] },
  "pomodoro": { "focusMinutes": 25, "breakMinutes": 5 }
}
```

Data lives in `~/.local/share/go-island/`: `clipboard.json` and `sites.json` (both mode 0600), plus `site-icons/`.

## D-Bus API (`org.goisland.Island` at `/org/goisland/Island`)

| Member | Signature | Notes |
|---|---|---|
| `GetState()` | `→ s` | Current View as JSON |
| `Action(name)` | `s →` | e.g. `media.next`, `notify.dismiss`, `pomodoro.toggle` |
| `Notify(title, body, icon, accent, timeout_ms)` | `ssssi → u` | A timeout ≤ 0 means 5 s |
| `TaskStart(title)` / `TaskEnd(id, exit_code)` | `s → u` / `ui →` | Used by `island run` |
| `DockerList()` / `DockerAction(id, op)` | `→ s` / `ss →` | `op` is start, stop or restart |
| `PortsList()` / `PortFree(port)` | `→ s` / `u → s` | |
| `ClipboardAdd/List/Delete/Pin/Clear` | | Clipboard history |
| `SitesList()` / `SiteAdd(url, name)` / `SiteRemove(id)` | | Saved sites |
| `StateChanged(state)` | signal `s` | Sent whenever the View changes |

Live values are sent as timestamps (`endsAt`, `startedAt`, `timing`), and the extension ticks them locally, so the daemon doesn't have to emit a signal every second.

## Adding a plugin

1. Implement `island.Plugin` (`Name()` and `Run(ctx, host)`) in `internal/plugins/`.
2. Call `host.Set(island.Activity{ID, Priority, View, TTL})` to take over the island, and `host.Clear(id)` to give it back. The activity with the highest priority wins; ties go to the most recent one. The standard priorities are in `internal/island`.
3. Register any UI actions with `host.HandleAction("myplugin.thing", fn)`. Set `View.Click` to choose what clicking the pill does.
4. Add the plugin to the list in `cmd/islandd/main.go`.

If a plugin's `Run` returns an error, the daemon restarts it with exponential backoff.
