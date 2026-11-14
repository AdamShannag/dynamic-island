# Go Island

A Dynamic Island for Ubuntu (GNOME Shell 46). It has two parts:

- **`islandd`** is a Go daemon. It runs plugins and serves the island state on the session bus as `org.goisland.Island`.
- **`extension/go-island@local`** is a GNOME Shell extension that draws the pill. It just renders whatever state the daemon sends.

```
MPRIS / UPower / CLI ──► islandd (plugins → Manager) ══ D-Bus ══► GNOME extension (pill)
```

## Install

```sh
make install                        # builds, installs binaries + systemd user unit, copies the extension
# first time only: restart GNOME Shell (X11: Alt+F2 → r; Wayland: log out/in)
gnome-extensions enable go-island@local
```

## Use

```sh
island notify "Build complete" "all tests passed"
island notify -t 10000 -i dialog-warning-symbolic "Disk almost full"
island action media.play-pause
island state                         # prints the current View JSON
make logs                            # daemon + extension logs
```

Click the media pill to expand it and show the controls. Click a notification to dismiss it.

## D-Bus API (`org.goisland.Island` at `/org/goisland/Island`)

| Member | Signature | Notes |
|---|---|---|
| `GetState()` | `→ s` | Current View as JSON |
| `Action(name)` | `s →` | e.g. `media.next`, `notify.dismiss` |
| `Notify(title, body, icon, timeout_ms)` | `sssi → u` | Timeout ≤ 0 means 5 s |
| `StateChanged(state)` | signal `s` | Sent whenever the View changes |

## Adding a plugin

1. Implement `island.Plugin` (`Name()` and `Run(ctx, host)`) in `internal/plugins/`.
2. Call `host.Set(island.Activity{ID, Priority, View, TTL})` to take over the island, and `host.Clear(id)` to give it back. The activity with the highest priority wins. Ties go to the most recent one.
3. Register any UI actions with `host.HandleAction("myplugin.thing", fn)`.
4. Add the plugin to the list in `cmd/islandd/main.go`.

If a plugin's `Run` returns an error, the daemon restarts it with exponential backoff.
