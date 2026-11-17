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
  identity/             stable per-install peer id and display name
  discovery/            mDNS advertise/browse of other daemons on the LAN, and LocalIP
  lobby/                game-agnostic HTTP+SSE lobby: invite, respond, start, progress, events
  race/                 typing-race engine built on discovery + lobby (host-authoritative)
extension/
  dynamic-island@adamshannag.github.io/   the shipped extension (no build step)
    extension.js        Extension entry: lifecycle, wiring, settings, clipboard, presenting
    island.js           Island actor: pill, dashboard shell, morph, state → widgets, input
    lib/                constants, dbus (interface XML + DaemonClient), widgets, motion, spring (pure
                        island springs), format (pure helpers), tools (pure Transform tools), home (Home
                        favourites and Continue items), find (pure search matching and grouping), finder
                        (the search results view), shell (GNOME helpers), gnome (OSD/banner/panel patches),
                        shoulders (notch fillets), clipboard, personality, face
    pages/              one Page subclass per dashboard tab (more.js: favourites + every tab); index.js registers them
    schemas/            GSettings schema (the global search shortcut) and its compiled form
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
    blocks() {}                 // top-level actors that fade in one by one when the page appears
    get heading() {}            // title in the back row; defaults to `title` or the tab name
    get navActions() {}         // optional actor on the right of the back row
    get backTab() {}            // where the back button goes; `parent` for sub-pages, else Home
    destroy() {}
}
```

Helpers on `Page`: `this.ext` (the Extension), `this.island`, `this.active`, `this.call(method, args, cb)`, `this.fetch(method, args, (value, err) => ...)` (JSON-decoded, **dropped if the tab is no longer active**), `this.refit()`, `this.close()`.

To add a tab: create the page, add it to `PAGES` in `pages/index.js`, add `[id, name, icon]` to `TABS` in `lib/constants.js` (and a badge colour in `SETTING_COLORS`), add styles to `stylesheet.css`. Sub-pages (Logs, QR) aren't in `TABS`. Open them with `island.page('logs').open(...)`.

**Header and navigation.** The header is: a grid button (toggles More ↔ Home, accent-tinted while More is open), the search field, a bell (accent dot for unread notifications, opens Notifications), the presentation button and the clock. There are no tab icons. Home is the default page; every other page gets a 32px back row (back button, `heading`, optional `navActions`) above its content. Esc leaves search first, then goes back to Home, then closes. `pages/more.js` shows a Favorites row of 5 slots (dashed "Empty" slots) and an "All tabs" grid of 6 columns (every enabled tab except Home, Settings included) using the Home tile style; Edit wiggles the tiles and toggles favourites with a ★ badge, saving `home.favorites` through `ext.updateSettings`. `toggleFavorite` (`lib/home.js`) refuses a sixth favourite and the tile shakes. A new tab shows up in More and search automatically; add its id to `settings.TabIDs` in Go so it can be a favourite (`settings` is accepted too, through `FavoriteIDs`).

**Search.** Focusing the header field (click, Ctrl+K while the dashboard is open, or the global `search-shortcut`, default Super+K, bound with `Main.wm.addKeybinding` from `schemas/` and removed in `disable()`) swaps the page for `lib/finder.js`. Results come from the tabs, `actionItems` (start focus, pick a colour, copy LAN address via `LanAddress`, kill port N via `PortFree`, restart container X via `DockerAction`), `ClipboardList` and `NotesList` (both hidden while presenting). `lib/find.js` ranks substring matches above subsequence ones and caps results at 4 per group with an empty query and 8 in total while filtering. ↑/↓ move, Enter runs, hovering selects. Actions close the dashboard and report through `ext.notify` (the daemon's `Notify`, the same path as `island notify`). Never bind Ctrl+K globally. After changing the schema XML, run `make schemas` and commit `gschemas.compiled`.

The old `bar` setting is gone: `settings.Load` moves a legacy file's bar pins (minus home and inbox) into `home.favorites` once, when the file has `bar` but no `home`.

**Home** (`pages/home.js`) is a media card and a 3×2 favourites grid side by side (the row's layout is homogeneous and both columns are `y_expand` + `FILL`, so they always share one height), then a Continue row of up to 3 cards. Favourites are the daemon-owned `home.favorites` setting (default `docker, ports, clipboard, notes, agents`, at most 5, `home` and unknown ids dropped); the 6th tile is always More. `settings` can be a favourite. Continue shows, in order, a running build or dev server (`ActivityList`; `expectedMs` is how long the last run of the same command in the same project took, which gives the percentage and time left), the Docker count, and the Pomodoro timer; with none it shows a "Nothing running" card. The pure parts live in `lib/home.js`. Live values update in place every second; the Continue row is rebuilt only when its item ids change. When nothing is playing, `MediaLastPlayer` names the last MPRIS player and the Resume button sends `media.resume`.

### Reusable widgets (`lib/widgets.js`)

Use these rather than building the same actors by hand: `label`, `setText` (no-op if unchanged, which avoids relayouts), `iconButton`, `pillButton`, `confirmButton` (two-click destructive), `searchEntry`, `multilineEntry`, `wrappingLabel`, `scrollView`, `page`, `column`, `group` (Apple-style inset grouped list: returns `{actor, list}`), `badge`, `appBadge`, `rowText`, `hoverActions` (fade-in row buttons, unclickable while hidden), `portButton`, `fillList` (builds rows a few per frame), `setMessage`, `EmptyState`, `Toggle`, `Equalizer`.

### Rules that keep it smooth and crash-free

- **60 fps budget.** GNOME Shell's JS shares the compositor thread. Build long lists with `fillList` (4 rows per frame). On periodic refreshes compute a signature and update text in place; rebuild rows only when the set of items changes (see `pages/agents.js` and `pages/docker.js`).
- **Animations run on the frame clock.** Use `Clutter.Timeline` plus `lib/motion.js` (`springTo`, `frameLoop`, `eachFrame`) and `lib/spring.js`. **Never** use `Clutter.Transition.set_progress_func` from GJS: it freezes the transition. Round pixel geometry so text stays sharp.
- **Clipboard reads crashed the shell** (SIGSEGV in a GJS trampoline). `lib/clipboard.js` reads only for history: debounced 400 ms, one read at a time, never for its own copies, with the work scheduled out of the native callback. Everything else (Transform, QR, Paste) uses the daemon's history via `ext.latestClip()`. Don't add new `St.Clipboard.get_text` calls.
- **No negative CSS margins.** St miscomputes the width (a 2^32-px row hid the whole Ports page).
- **Use `FixedLayout` for exact positions.** `BinLayout` ignores alignment for children placed by x and y; the tab indicator and the unread dot use fixed positions.
- **Scrollbars:** `overlay_scrollbars: false` (in `scrollView`) so the bar gets its own lane and cards don't paint under it.
- **Auto-height tabs** must call `this.refit()` (or pass it as `fillList`'s `onDone`, or to `EmptyState`/`setMessage`) when content arrives after the sheet was sized.
- **Modal grab:** on X11 (46–49), `openDash` requires `Clutter.GrabState.ALL`; with a keyboard-only grab, X11 sends outside clicks to the windows underneath and the dashboard can't be dismissed. GNOME Shell 50 removed `Clutter.Grab.get_seat_state()`/`Clutter.GrabState` entirely (grabs are always full on Wayland-only Mutter), so that check is feature-detected and skipped there. The release that follows an outside-click close is swallowed (`_swallowRelease`), or it would reopen the dashboard. `openDash` releases the grab on any exception thrown after `pushModal` — without that, a thrown error leaves `_grab` set but `dashOpen` false, so `closeDash` never pops the modal and keyboard/mouse input is lost until logout.
- **Don't name a method the same as a field** (`this._foo = ...` plus `_foo() {}`). `npm run check` catches it.
- **`Clutter.Text.position_to_coords(index)`** (used by `pages/race.js` to place a caret at a character position) returns stale, unwrapped coordinates until the actor has actually gone through a layout/allocation pass — setting `width`/`line_wrap` alone isn't enough. Call `label.get_allocation_box()` first (it forces a synchronous allocate) or the returned `x`/`y` assume one long unwrapped line.
- **GNOME version differences** go in `lib/constants.js` (see `VERTICAL`, which uses `orientation` on GNOME 48+ and `vertical` before; `SHELL_MAJOR` is exported for this). `lib/gnome.js`'s `OsdTakeover` branches on it too: GNOME 50 changed `Main.osdWindowManager.show()` from `(monitorIndex, icon, label, level, maxLevel)` to `(icon, label, levels)`, where `levels` is `{[monitorIndex]: {level, maxLevel}}`. GNOME 50's `showAll()` (what the volume/brightness OSD actually calls) bypasses `show()` entirely, so it's patched separately too. `extension.js`'s `_showOsd` intercepts every monitor index, not just the primary one: on multi-monitor setups GNOME can attribute an OSD event (volume or brightness) to a non-primary monitor, and since the pill only exists on one screen, the fix is to always show it there rather than let the real popup appear on whichever monitor GNOME picked.
- **Every D-Bus method** the extension calls must be declared in `INTERFACE_XML` in `lib/dbus.js`. A missing one fails silently at runtime. Both `npm run check` and the Go test `TestExtensionInterfaceMatchesDaemon` enforce this.
- **Patching GNOME** (the OSD popup, `MessageTray.bannerBlocked`, the `island-transparent-panel` class on `Main.panel` behind the `transparentPanel` feature) lives in `lib/gnome.js` and must be fully undone in `disable()`.
- **Island motion:** the island's width, height, bottom radius, shoulder radius, content opacity (`op`), pill cross-fade (`fade`) and scale are springs (`lib/spring.js`: semi-implicit Euler, substeps ≤ 1/240 s, size k=320 c=30, opacity k=260 c=30, settled when |v| and |x−target| < 0.02). One `frameLoop` steps them all and `_paint` applies them; `relayout` only retargets, so interrupting open/close keeps the velocity. Targets are `SHAPES` in `lib/constants.js` (pill 184/214×bar height, notification 440×72, dashboard 640 × header + the page's natural height). Dashboard opacity is `dashReveal(op)` = clamp((op−0.35)/0.65) with translation_y −8→0; the pill uses `pillReveal(op)`, so the two never overlap. The island has no background or padding of its own: `.island-bg` (inside the clip) paints the shape and gets its radius as an inline style each frame, the pill's padding lives on `.island-content`, and the dashboard's on `.island-dash`. The island keeps its last pill mode class while the dashboard is open (plus `dashboard`), so the fading pill doesn't restyle. With reduce-motion on, `relayout` jumps to the targets.
- **Page transitions** (`Island._swap`): outgoing 170 ms to opacity 0 and x −26 (EASE_IN_CUBIC), incoming 380 ms from x +26 after 60 ms (EASE_OUT_CUBIC), reversed for back; search swaps slide 6 px vertically. `Page.reveal()` then fades each of `blocks()` up from +10 px, 420 ms, 38 ms apart. The sheet height is measured from the incoming page (header + back row + page), never from the body, because both pages are in the BinLayout during the swap. `tactile()` in `lib/widgets.js` gives buttons a press scale (0.94 round, 0.97 tiles) and an optional 1 px hover lift.
- **Shoulders:** `lib/shoulders.js` adds two `St.DrawingArea` children to the island and places them outside its box in `Island.vfunc_allocate` (left at `-r`, right at `width`), so they follow every frame, scale, opacity and fullscreen hiding with no extra sync. Their colour is `.island-bg`'s theme-node background, repainted only when it changes; the radius is the `shoulder` spring.

## The daemon

- **Plugins** implement `island.Plugin` (`Name`, `Run(ctx, host)`). Post with `host.Set(island.Activity{ID, Priority, View, TTL})` and remove with `host.Clear(id)`. Standard priorities are in `internal/island`. Register UI actions with `host.HandleAction`. A plugin that returns an error is restarted with backoff. Respect `host.Presenting()` (no personal content on a shared screen) and `settings.Enabled(feature)`.
- **D-Bus methods** live in `internal/dbusapi/<feature>.go` as methods on `*api`. Add each one to `introspect.go` (a test checks the XML matches the exported methods) and to the extension's `lib/dbus.js`. Return JSON strings through the `toJSON`/`resultJSON`/`listJSON` helpers and errors through `dbusErr`.
- **Notifications** are observed with `BecomeMonitor` on a dedicated connection. GNOME forwards every `Notify` call again with an `x-shell-sender` hint, so those copies are skipped (otherwise each notification appears twice).
- **Resource limits:** the daemon sets a soft memory limit of 32 MB and `GOMAXPROCS=2`. `plugins/context.go` caches `/proc` scans. Keep polling proportional to whether anyone is looking (the extension only calls stats methods while their tab is open).
- **LAN race is the daemon's only network listener** and the first code that talks to other machines. It is off by default (`settings` keeps `race` off until the user opts in) and is torn down while presenting. The listener (`lobby.Server`, port 54372, `ISLAND_RACE_PORT` overrides) binds synchronously in `Enable`. Treat every peer message as untrusted: the lobby rejects bad shapes and oversized fields, caps subscribers, and takes peer IPs from the connection rather than the body; the race host clamps reported progress. Outbound calls use a short timeout, and the host sends an SSE heartbeat so a guest sees a silent host within about 15 s. `discovery.LocalIP` is the single answer to "what is our LAN address" (it skips docker, bridge and VPN interfaces). A second multiplayer feature should reuse `discovery` and `lobby` as they are and add its own engine package, plugin, D-Bus file and page.
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
