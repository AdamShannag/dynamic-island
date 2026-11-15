# Go Island

A Dynamic Island for Ubuntu (GNOME Shell 46). It replaces the top-bar clock with a pill. When nothing is happening the pill shows the time. When something happens, the pill grows down out of the top bar.

- **Left-click** opens the dashboard, with tabs for Home, Docker, Ports, Clipboard and Web.
- **Right-click** opens the regular calendar and notifications menu.
- **Esc** or clicking outside the dashboard closes it.
- **`island open [tab]`** toggles the dashboard from the command line. Bind it to a key in Settings → Keyboard → Custom Shortcuts, for example Super+Space → `island open`.

## Tools in the header

- **Colour picker (eyedropper):** pick any pixel on screen. The HEX value is copied, and the island shows a swatch along with RGB and HSL values. It uses the desktop portal.
- **Presentation mode (sunglasses):** hides track names, album art, command details, clipboard history and notes. It also pauses mirroring of desktop notifications, stops recording clipboard copies, and turns GNOME's notification banners off (restoring them afterwards). The face puts on sunglasses. It **turns on automatically when a screen share starts** and off again when the share ends, unless you turned it on yourself.

The **Transform** tab has an input box that is pre-filled with your **latest clipboard text**. Below it are chips for JSON pretty-print, Base64 encode and decode, URL encode and decode, UPPER, lower, Title, snake, camel and kebab. Each one shows its result in the output box and copies it. **Use as input** lets you chain transforms, for example pretty-print and then Base64-encode.

## Volume and brightness

GNOME's volume, brightness and microphone popups are replaced by a slim level bar that grows out of the notch, showing an icon, the level and a percentage. Over-amplified volume reads above 100%.

## Personality

- **Face:** two eyes next to the clock that follow your cursor and blink every now and then. They go dizzy when the CPU is pegged, turn into hearts when something succeeds, and look surprised when you plug in a USB device.
- **Sleepy:** after 3 minutes of inactivity the eyes close and little Zs float up. Moving the mouse wakes it.
- **Wobble:** shake your mouse quickly over the island, or middle-click it, and it wobbles like jelly with a `> <` face.
- **Hover intent:** a slim live pill (agent, build or service) only expands after you rest the cursor on it for about half a second, so passing over it does nothing.
- **USB reactions:** drives, keyboards, mice, game controllers, phones, audio devices and cameras each get a popup with an icon and a little bounce.

## Context awareness

You don't need to wrap anything. The daemon checks your processes about once a second and recognises dev commands:

- **Go:** `go build`, `test`, `mod`, `generate` and `run`
- **Maven:** including IntelliJ's built-in runner
- **Gradle**
- **JavaScript:** npm, pnpm, yarn and bun
- **Others:** cargo, make, `docker build`, pytest, uvicorn and Django
- **IDE run configurations:** JetBrains Java and Go run configurations

It also traces each command back to the app that started it: GoLand, IntelliJ, VS Code, Cursor, a terminal, or Claude Code.

- Detected commands **never appear in the pill**. They're listed in the dashboard's **Activity** tab:
  - **Running:** builds and tests with a live timer, and dev servers (`go run`, `npm run dev`, `spring-boot:run`, `bootRun`, IDE run configurations) with clickable port chips that open `localhost:PORT`.
  - **Recently finished:** the last 15 tasks, with how long each took.
- **Clicking** a row jumps to the window that started the command.

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
| Activity | Builds, tests and dev servers running on your machine, plus recently finished tasks (see Context awareness). |
| Agents | Claude Code sessions with their state, cost, context usage and when they were last active. Click a session to focus its window. |
| Home | A Now Playing card (art, live progress with time remaining, controls) and a Today card with a one-click focus timer and a container summary. |
| Docker | Running containers grouped by compose project, with health, **live CPU and memory**, and **clickable port chips** that open `localhost:PORT`. Each one has a **logs view** (last 50 lines, following live), restart and stop. |
| Ports | Every listening TCP port and which process or container owns it. Click a port to open it in your browser. **Kill** frees the port (two clicks to confirm). You can also type a port number and press Enter to free it. Ports published by Docker stop their container. |
| Notes | A scratchpad that saves automatically (`~/.local/share/go-island/notes.md`, mode 0600). Open it directly with `island open notes`. |
| Clipboard | A history of everything you copy, saved across reboots. Click an entry to copy it again; you can also pin, delete or filter. Copies flagged by password managers are skipped. |
| QR | Click the grid icon on any clipboard item, or next to the Web search box, to get a scannable QR code. |
| Web | A calculator (type `150*1.16` and press Enter to copy `174`) and a Google search box (a typed URL or `localhost:3000` opens directly), plus a grid of saved sites. **＋** adds a site and right-click removes one. Icons are fetched from each site itself. |

```
MPRIS / UPower / notifications / docker / ss / CLI
        ──► islandd (plugins → priority Manager) ══ D-Bus ══► GNOME extension (pill)
```

- **`islandd`** is a Go daemon. It runs plugins and serves the island state on the session bus as `org.goisland.Island`.
- **`extension/go-island@local`** is a GNOME Shell extension that draws the pill. It just renders whatever state the daemon sends.

## Install

**Requirements:** Ubuntu or any other distro with GNOME Shell **46–49** (Ubuntu 24.04 through 25.10), on X11 or Wayland, on x86-64 or ARM64. Docker is optional.

**From a release tarball (no Go needed):**

```sh
tar xzf go-island-<version>.tar.gz && cd go-island
./install.sh
```

**From source** (needs Go 1.22 or newer: `sudo apt install golang-go`):

```sh
./install.sh            # or: make install
```

The installer:
1. puts `islandd` and `island` in `~/.local/bin`,
2. enables the `islandd` systemd user service,
3. installs and enables the extension.

A brand-new extension loads only after GNOME Shell restarts. On **X11**, press Alt+F2, type `r` and press Enter. On **Wayland** (the Ubuntu default), log out and back in.

`make dist` builds the release tarball, with static binaries for amd64 and arm64. `./uninstall.sh` removes everything. Your data in `~/.local/share/go-island` is kept unless you pass `--purge`.

**Portability notes:**
- Sizes follow your display scale, so 2× HiDPI and fractional scaling stay in proportion.
- On GNOME 48 and later, the extension uses the newer layout API.
- Volume and brightness popups fall back to GNOME's own popup over fullscreen apps and while the dashboard is open.
- Only GNOME 46 has actually been run. 47–49 are declared supported and use the matching APIs, but haven't been tested yet.

## Features

| Plugin | What it shows |
|---|---|
| `mpris` | The current track from Spotify, browsers, mpv and so on. Click the pill to expand it into album art, a live progress bar and controls. |
| `battery` | A popup when you plug in or unplug, and warnings at 20%, 10% and 5%. |
| `notifications` | Mirrors desktop notifications (Slack, Telegram, calendar and so on) into the island. |
| `pomodoro` | A focus countdown, followed by a break. |
| `docker` | Alerts when a container crashes (a non-zero exit that wasn't from `docker stop`), turns unhealthy, or runs out of memory. |

While the island is running, **GNOME's own notification banners are suppressed**, so you only see the island. Notifications still collect in the calendar menu (right-click the pill). If the daemon stops, GNOME's banners come back automatically.

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

## Resource use and stability

- **Daemon:** about 14 MB of RAM and roughly 0.15% of one CPU core. It caches process scans, and its heap is capped softly at 32 MB.
- **Extension:**
  - The eyes animate on the display's own frame clock (60, 144 Hz and so on) with a critically damped spring, which glides with no overshoot. That loop runs only while the eyes move and stops once they settle. A light 7–16 Hz check wakes it when the cursor moves.
  - The equalizer steps at about 5 fps, and only while it's on screen.
  - Live timers tick once a second.
  - Docker stats run only while the Docker tab is open.
- **Clipboard:** a GNOME Shell crash was traced to clipboard reads completing into a JavaScript callback. The extension now reads the clipboard only to record history: once per burst of changes (debounced 400 ms), never two reads at a time, and never for text it copied itself. Everything else uses the daemon's history.

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
