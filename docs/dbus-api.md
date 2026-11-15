# D-Bus API

The daemon owns `io.github.AdamShannag.DynamicIsland` on the session bus. Its object is at `/io/github/AdamShannag/DynamicIsland` and it implements the interface of the same name. Anything that can talk to D-Bus can drive the island. The `island` CLI is a thin client over these methods.

Methods that return data return JSON strings. Errors are standard D-Bus errors with a readable message.

```sh
gdbus call --session \
  -d io.github.AdamShannag.DynamicIsland \
  -o /io/github/AdamShannag/DynamicIsland \
  -m io.github.AdamShannag.DynamicIsland.Notify "Deployed" "prod is live" "" "ok" 5000
```

## State

| Method | Signature | Description |
|---|---|---|
| `GetState()` | `→ s` | The current view as JSON. |
| `Action(name)` | `s →` | Runs a registered action, for example `media.next`, `notify.dismiss` or `pomodoro.toggle`. |
| `Notify(title, body, icon, accent, timeout_ms)` | `ssssi → u` | Shows a popup. `accent` is empty, `ok`, `warn` or `error`. A timeout of 0 or less means 5 s. |
| `TaskStart(title)` | `s → u` | Shows a running task with a live timer. Returns its id. |
| `TaskEnd(id, exit_code)` | `ui →` | Finishes a task and shows a success or failure popup. |
| `Open(tab)` | `s →` | Toggles the dashboard on a tab (`home`, `docker`, `notes` and so on). |
| `SetPresenting(on)` | `b →` | Turns presentation mode on or off. |

## Dashboard data

| Method | Signature | Description |
|---|---|---|
| `SystemStats()` | `→ s` | CPU, memory, disk, network and the top processes. |
| `ActivityList()` | `→ s` | Detected builds, tests and dev servers. |
| `DockerList()` | `→ s` | Running containers with their status, ports and stats. |
| `DockerAction(id, op)` | `ss →` | `op` is `start`, `stop` or `restart`. |
| `DockerLogs(id, lines)` | `si → s` | The last `lines` lines of a container's logs. |
| `PortsList()` | `→ s` | Listening TCP ports and their owners. |
| `PortFree(port)` | `u → s` | Kills the process holding the port, or stops its container. |
| `AgentsList()` | `→ s` | Claude Code sessions. |
| `AgentEvent(event, focus)` | `sai →` | A Claude Code hook payload. Used by `island claude hook`. |
| `AgentStatus(status)` | `s →` | A Claude Code status-line payload. |

## Stores

| Method | Signature |
|---|---|
| `ClipboardList()`, `ClipboardAdd(text)`, `ClipboardDelete(id)`, `ClipboardPin(id, pinned)`, `ClipboardClear()` | `→ s`, `s →`, `u →`, `ub →`, `→` |
| `NotesList()`, `NoteCreate()`, `NoteSave(id, text)`, `NotePin(id, pinned)`, `NoteDelete(id)` | `→ s`, `→ s`, `us →`, `ub →`, `u →` |
| `InboxList()`, `InboxRemove(id)`, `InboxClear()` | `→ s`, `u →`, `→` |
| `SitesList()`, `SiteAdd(url, name)`, `SiteRemove(id)` | `→ s`, `ss →`, `u →` |
| `GetSettings()`, `SetSettings(patch)` | `→ s`, `s → s` |

## Tools

| Method | Signature | Description |
|---|---|---|
| `QR(text)` | `s → s` | Renders a QR code and returns the path of the PNG. |
| `PickColor()` | `→` | Opens the desktop portal's colour picker. The result arrives as `ColorPicked`. |

## Signals

| Signal | Signature | Description |
|---|---|---|
| `StateChanged(state)` | `s` | The view changed. |
| `SettingsChanged(settings)` | `s` | Settings were saved. |
| `OpenDashboard(tab)` | `s` | Something asked to open the dashboard. |
| `ColorPicked(hex)` | `s` | The colour picker returned a colour. |

Live values (`endsAt`, `startedAt`, `timing`) are sent as Unix-millisecond timestamps. The extension updates timers and progress locally, so the daemon doesn't signal every second.
