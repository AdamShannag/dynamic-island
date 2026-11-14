# Go Island

A Dynamic Island for Ubuntu (GNOME Shell 46). It replaces the top-bar clock with a pill. When nothing is happening the pill shows the time, and clicking it opens the usual calendar. When something happens, the pill grows down out of the top bar.

```
MPRIS / UPower / notifications / gh / docker / CLI
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
| `github` | A "CI running" chip while runs are in progress, and a pass/fail alert when one finishes. Click to open the run in your browser. |
| `docker` | Alerts when a container crashes (a non-zero exit that wasn't from `docker stop`), turns unhealthy, or runs out of memory. |

**Tip:** to avoid getting GNOME's own banner as well as the island for each notification, turn GNOME banners off: `gsettings set org.gnome.desktop.notifications show-banners false`. Notifications still land in the calendar menu.

## CLI

```sh
island notify "Deployed" "prod is live"           # -a ok|warn|error  -i icon  -t ms
island run -- make test                           # live elapsed timer, then ✓/✗ with duration
island run -n "deploy" -- ./deploy.sh
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
  "pomodoro": { "focusMinutes": 25, "breakMinutes": 5 },
  "github": { "repos": ["owner/repo"], "onlyMine": true, "intervalSeconds": 60 }
}
```

The GitHub plugin uses the `gh` CLI, so run `gh auth login` first.

## D-Bus API (`org.goisland.Island` at `/org/goisland/Island`)

| Member | Signature | Notes |
|---|---|---|
| `GetState()` | `→ s` | Current View as JSON |
| `Action(name)` | `s →` | e.g. `media.next`, `notify.dismiss`, `pomodoro.toggle` |
| `Notify(title, body, icon, accent, timeout_ms)` | `ssssi → u` | A timeout ≤ 0 means 5 s |
| `TaskStart(title)` / `TaskEnd(id, exit_code)` | `s → u` / `ui →` | Used by `island run` |
| `StateChanged(state)` | signal `s` | Sent whenever the View changes |

Live values are sent as timestamps (`endsAt`, `startedAt`, `timing`), and the extension ticks them locally, so the daemon doesn't have to emit a signal every second.

## Adding a plugin

1. Implement `island.Plugin` (`Name()` and `Run(ctx, host)`) in `internal/plugins/`.
2. Call `host.Set(island.Activity{ID, Priority, View, TTL})` to take over the island, and `host.Clear(id)` to give it back. The activity with the highest priority wins; ties go to the most recent one. The standard priorities are in `internal/island`.
3. Register any UI actions with `host.HandleAction("myplugin.thing", fn)`. Set `View.Click` to choose what clicking the pill does.
4. Add the plugin to the list in `cmd/islandd/main.go`.

If a plugin's `Run` returns an error, the daemon restarts it with exponential backoff.
