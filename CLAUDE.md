# CLAUDE.md

Guide for AI agents (and humans) working on **Dynamic Island**: a macOS-style Dynamic Island for Ubuntu's GNOME Shell (46–50; 46–49 run on X11 or Wayland, 50 is Wayland-only since GNOME Shell dropped X11). It has two halves that talk over the session D-Bus:

```
MPRIS / UPower / notifications / docker / /proc / ss / CLI
   ──► dynamic-islandd (Go: plugins → priority Manager → View JSON)
            ══ D-Bus io.github.AdamShannag.DynamicIsland ══►
   GNOME Shell extension (GJS: renders the pill + dashboard)
```

The **daemon owns all logic and state**. The **extension is a view**: it renders the `View` JSON it receives, and calls daemon methods for data (Docker, ports, clipboard, notes and so on). Keep it that way. Logic in the extension runs on the compositor's thread and can drop frames or crash the desktop.

## Names

| Thing | Name |
|---|---|
| Go module | `github.com/AdamShannag/dynamic-island` |
| Daemon binary | `dynamic-islandd` (`cmd/dynamic-islandd`) |
| CLI | `island` (`cmd/island`). Don't rename it: Claude Code hooks call it. |
| systemd user unit | `dynamic-island.service` |
| D-Bus name, interface | `io.github.AdamShannag.DynamicIsland` |
| D-Bus object path | `/io/github/AdamShannag/DynamicIsland` |
| Extension UUID | `dynamic-island@adamshannag.github.io` |
| CSS class prefix | `island-` (the root actor is `.island`) |
| Data, config, cache | `~/.local/share/dynamic-island`, `~/.config/dynamic-island`, `~/.cache/dynamic-island` (always through `internal/paths`) |

The project used to be called "Go Island" (`go-island@local`, `islandd`, `org.goisland.Island`). `paths.Migrate()` moves the old directories, `install.sh` removes an old install, and `island claude install` replaces old hooks. Don't reintroduce the old names anywhere else.

## Commands

```sh
make check      # gofmt check, go vet, extension static checks (npm run check)
make test       # go test -race ./... and the extension's node tests
make build      # bin/dynamic-islandd, bin/island
make install    # build and install into ~/.local (daemon + unit + extension)
make logs       # follow daemon and gnome-shell logs
make dist       # dist/dynamic-island-<version>.tar.gz (amd64 + arm64)
make deb        # dist/*.deb via nfpm (NFPM=/path/to/nfpm)
```

Run `npm ci` in `extension/` once before `make check` or `make test`. Node 22.

## Repository layout

```
cmd/dynamic-islandd/    daemon entry: config, plugins list, D-Bus Serve
cmd/island/             CLI: notify, run, open, kill-port, pomodoro, claude, setup, version
internal/
  island/               Manager: Activities (ID, Priority, View, TTL) → the highest-priority View
  dbusapi/              D-Bus service, one file per feature; introspect.go is the interface XML
  plugins/              mpris, battery, notifications (eavesdrop), pomodoro, docker events,
                        context (process scanner for builds and dev servers), usb
  paths/                XDG directories and legacy migration
  settings/             daemon-owned user settings (theme, tabs, features)
  agents/               Claude Code sessions from hooks and the status line
  clipboard/ notes/ sites/ inbox/   stores (inbox is memory-only by design)
  docker/ ports/ sysmon/ tools/     Docker CLI, listening ports, system stats, QR and colour picker
extension/
  dynamic-island@adamshannag.github.io/   the shipped extension (no build step)
    extension.js        Extension entry: lifecycle, wiring, settings, clipboard, presenting
    island.js           Island actor: pill, dashboard shell, morph, state → widgets, input
    lib/                constants, dbus (interface XML + DaemonClient), widgets, motion,
                        format (pure helpers), tools (pure Transform tools), shell (GNOME
                        helpers), gnome (OSD/banner patches), clipboard, personality, tabbar, face
    pages/              one Page subclass per dashboard tab; index.js registers them
  scripts/check.mjs     static checks (imports, undefined names, D-Bus calls, collisions)
  test/                 node:test unit tests for the pure modules
packaging/              nfpm.yaml, maintainer scripts, apt-repo.sh
systemd/                dynamic-island.service (~/.local) and dynamic-island.package.service (/usr)
.github/workflows/      ci.yml, release.yml
```

## The extension

### Page contract (`pages/page.js`)

Each dashboard tab is a class extending `Page`, configured with static fields:

```js
export class FooPage extends Page {
    static id = 'foo';          // tab id; must match TABS in lib/constants.js
    static title = '';          // header text for sub-pages, e.g. '›  Logs'
    static parent = undefined;  // tab to highlight; undefined = itself, null = none
    static height = 500;        // sheet height in logical px (the maximum, if autoHeight)
    static autoHeight = false;  // sheet hugs the content; call this.refit() when it changes
    static interval = 0;        // ms; refresh() is called this often while the tab is shown

    build() { return actor; }   // once, at enable
    onShow() { this.refresh(); return focusActorOrNull; }
    onHide() {}                 // tab switched away or dashboard closed: flush pending work
    refresh() {}                // load data
    onState() {}                // the island's state changed (Home uses this)
    onSettings(st) {}           // settings changed
    tick(now) {}                // every second while shown and `get ticking()` is true
    destroy() {}
}
```

Helpers on `Page`: `this.ext` (the Extension), `this.island`, `this.active`, `this.call(method, args, cb)`, `this.fetch(method, args, (value, err) => ...)` (JSON-decoded, **dropped if the tab is no longer active**), `this.refit()`, `this.close()`.

To add a tab: create the page, add it to `PAGES` in `pages/index.js`, add `[id, name, icon]` to `TABS` in `lib/constants.js` (and a badge colour in `SETTING_COLORS`), add styles to `stylesheet.css`. Sub-pages (Logs, QR) aren't in `TABS`. Open them with `island.page('logs').open(...)`.

### Reusable widgets (`lib/widgets.js`)

Use these rather than building the same actors by hand: `label`, `setText` (no-op if unchanged, which avoids relayouts), `iconButton`, `pillButton`, `confirmButton` (two-click destructive), `searchEntry`, `multilineEntry`, `wrappingLabel`, `scrollView`, `page`, `column`, `group` (Apple-style inset grouped list: returns `{actor, list}`), `badge`, `appBadge`, `rowText`, `hoverActions` (fade-in row buttons, unclickable while hidden), `portButton`, `fillList` (builds rows a few per frame), `setMessage`, `EmptyState`, `Toggle`, `Equalizer`.

### Rules that keep it smooth and crash-free

- **60 fps budget.** GNOME Shell's JS shares the compositor thread. Build long lists with `fillList` (4 rows per frame). On periodic refreshes compute a signature and update text in place; rebuild rows only when the set of items changes (see `pages/agents.js` and `pages/docker.js`).
- **Animations run on the frame clock.** Use `Clutter.Timeline` plus `lib/motion.js` (`springTo`, `CriticalSpring`, `frameLoop`, `eachFrame`). **Never** use `Clutter.Transition.set_progress_func` from GJS: it freezes the transition. Round pixel geometry so text stays sharp.
- **Clipboard reads crashed the shell** (SIGSEGV in a GJS trampoline). `lib/clipboard.js` reads only for history: debounced 400 ms, one read at a time, never for its own copies, with the work scheduled out of the native callback. Everything else (Transform, QR, Paste) uses the daemon's history via `ext.latestClip()`. Don't add new `St.Clipboard.get_text` calls.
- **No negative CSS margins.** St miscomputes the width (a 2^32-px row hid the whole Ports page).
- **Use `FixedLayout` for exact positions.** `BinLayout` ignores alignment for children placed by x and y; the tab indicator and the unread dot use fixed positions.
- **Scrollbars:** `overlay_scrollbars: false` (in `scrollView`) so the bar gets its own lane and cards don't paint under it.
- **Auto-height tabs** must call `this.refit()` (or pass it as `fillList`'s `onDone`, or to `EmptyState`/`setMessage`) when content arrives after the sheet was sized.
- **Modal grab:** on X11 (46–49), `openDash` requires `Clutter.GrabState.ALL`; with a keyboard-only grab, X11 sends outside clicks to the windows underneath and the dashboard can't be dismissed. GNOME Shell 50 removed `Clutter.Grab.get_seat_state()`/`Clutter.GrabState` entirely (grabs are always full on Wayland-only Mutter), so that check is feature-detected and skipped there. The release that follows an outside-click close is swallowed (`_swallowRelease`), or it would reopen the dashboard. `openDash` releases the grab on any exception thrown after `pushModal` — without that, a thrown error leaves `_grab` set but `dashOpen` false, so `closeDash` never pops the modal and keyboard/mouse input is lost until logout.
- **Don't name a method the same as a field** (`this._foo = ...` plus `_foo() {}`). `npm run check` catches it.
- **GNOME version differences** go in `lib/constants.js` (see `VERTICAL`, which uses `orientation` on GNOME 48+ and `vertical` before; `SHELL_MAJOR` is exported for this). `lib/gnome.js`'s `OsdTakeover` branches on it too: GNOME 50 changed `Main.osdWindowManager.show()` from `(monitorIndex, icon, label, level, maxLevel)` to `(icon, label, levels)`, where `levels` is `{[monitorIndex]: {level, maxLevel}}`. GNOME 50's `showAll()` (what the volume/brightness OSD actually calls) bypasses `show()` entirely, so it's patched separately too. `extension.js`'s `_showOsd` intercepts every monitor index, not just the primary one: on multi-monitor setups GNOME can attribute an OSD event (volume or brightness) to a non-primary monitor, and since the pill only exists on one screen, the fix is to always show it there rather than let the real popup appear on whichever monitor GNOME picked.
- **Every D-Bus method** the extension calls must be declared in `INTERFACE_XML` in `lib/dbus.js`. A missing one fails silently at runtime. Both `npm run check` and the Go test `TestExtensionInterfaceMatchesDaemon` enforce this.
- **Patching GNOME** (the OSD popup, `MessageTray.bannerBlocked`) lives in `lib/gnome.js` and must be fully undone in `disable()`.

## The daemon

- **Plugins** implement `island.Plugin` (`Name`, `Run(ctx, host)`). Post with `host.Set(island.Activity{ID, Priority, View, TTL})` and remove with `host.Clear(id)`. Standard priorities are in `internal/island`. Register UI actions with `host.HandleAction`. A plugin that returns an error is restarted with backoff. Respect `host.Presenting()` (no personal content on a shared screen) and `settings.Enabled(feature)`.
- **D-Bus methods** live in `internal/dbusapi/<feature>.go` as methods on `*api`. Add each one to `introspect.go` (a test checks the XML matches the exported methods) and to the extension's `lib/dbus.js`. Return JSON strings through the `toJSON`/`resultJSON`/`listJSON` helpers and errors through `dbusErr`.
- **Notifications** are observed with `BecomeMonitor` on a dedicated connection. GNOME forwards every `Notify` call again with an `x-shell-sender` hint, so those copies are skipped (otherwise each notification appears twice).
- **Resource limits:** the daemon sets a soft memory limit of 32 MB and `GOMAXPROCS=2`. `plugins/context.go` caches `/proc` scans. Keep polling proportional to whether anyone is looking (the extension only calls stats methods while their tab is open).
- **Paths:** always `paths.Data()/Config()/Cache()` (or `DataFile` and friends), never `$HOME/...` by hand. Files holding user content are written with mode 0600.

## Testing

- **Unit:** `make test`. Pure extension modules (`lib/format.js`, `lib/tools.js`) must not import `gi://` so node can test them. Put new pure logic there.
- **Headless GNOME Shell** (manual or agent-driven), which never touches the real desktop:

  ```sh
  dbus-run-session -- bash -c '
    XDG_DATA_HOME=/tmp/di/data XDG_CONFIG_HOME=/tmp/di/config XDG_CACHE_HOME=/tmp/di/cache ./bin/dynamic-islandd &
    GSETTINGS_BACKEND=memory gnome-shell --headless --wayland --unsafe-mode --virtual-monitor 1600x900'
  ```

  The extension must be visible to that shell (for example, symlink the extension directory into `~/.local/share/gnome-shell/extensions/`). Then, with that session's `DBUS_SESSION_BUS_ADDRESS`:
  - Enable it: `gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.gnome.Shell.Eval "Main.extensionManager.enableExtension('dynamic-island@adamshannag.github.io')"`.
  - Drive it: find the actor with `Main.layoutManager.uiGroup.get_children().find(a => a.constructor.name.includes('Island'))`, then call `openDash('docker')`, `showTab(...)`, `page('qr').open(...)`.
  - Screenshot: `org.gnome.Shell.Screenshot.ScreenshotArea`.
  - Real clicks: a Clutter virtual pointer, `Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE)`.

  Gotchas:
  - Re-acquire the actor after any disable/enable; the old one is destroyed.
  - `gdbus` mangles `\n` and regex escapes inside Eval strings.
  - `pkill -f` can match its own shell; kill by session id.
  - After a refactor, cycle every tab and check the shell log for `JS ERROR`.

## Releasing

1. Tag: `git tag v0.2.0 && git push origin v0.2.0`.
2. `release.yml`:
   - tests the code;
   - builds the tarball and `.deb`s for amd64 and arm64 with nfpm (the version comes from the tag);
   - creates the GitHub release;
   - publishes the signed APT repository to the `gh-pages` branch with `packaging/apt-repo.sh`.
3. One-time setup:
   - Create a signing key:
     ```sh
     gpg --quick-gen-key "Dynamic Island APT <you@example.com>" ed25519 sign never
     gpg --armor --export-secret-keys <id>
     ```
   - Store the exported key as the repository secret `APT_GPG_PRIVATE_KEY` (and `APT_GPG_PASSPHRASE` if it has one).
   - In repository settings, set Pages to deploy from the `gh-pages` branch.
4. Users install with `curl -fsSL https://adamshannag.github.io/dynamic-island/setup.sh | sudo sh`, then `sudo apt install dynamic-island`, then `island setup`.

The package installs:
- the binaries to `/usr/bin`;
- the unit to `/usr/lib/systemd/user` (enabled globally by `postinst`);
- the extension to `/usr/share/gnome-shell/extensions`;
- the bash hook and example config to `/usr/share/dynamic-island`.

`island setup` is the per-user step: it starts the service and enables the extension.

## Code style

- **No comments.** Code should read clearly through names and small functions. Put explanations in this file or in commit messages.
- **Go:** gofmt, standard library first, small packages, errors wrapped with context.
- **JS:**
  - GNOME Shell's style: 4 spaces, single quotes, trailing commas, `const` by default.
  - Private members start with `_`.
  - Imports: `gi://` first, then `resource:///`, then local modules.
- **Keep files focused.** When a page grows large, split it into small component classes in the same file or a new module (see `MetricTile` and `ProcessRow` in `pages/activity.js`).
