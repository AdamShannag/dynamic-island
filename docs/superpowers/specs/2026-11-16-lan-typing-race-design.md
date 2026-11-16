# LAN typing race

## Intent

Dynamic Island is currently single-machine: the daemon only ever talks to
its own GNOME Shell extension, over the session D-Bus. This feature adds
the project's first notion of *other people*: discovering other machines
on the same LAN that also run `dynamic-islandd`, and racing them in a
TypeRacer-style typing contest from inside the pill/dashboard. It's a fun,
social feature, and the first of what may become a small family of
multiplayer features later.

## Goals

- See who else on the same LAN is running Dynamic Island.
- Host a race: invite as many of them as you want.
- Host starts the race whenever they want — they don't have to wait for
  everyone invited to accept. Whoever has accepted by then races.
- Everyone racing gets the same passage of text at the same time and types
  it; progress is visible live as people type; the race ends when everyone
  finishes (or leaves/times out), and a simple result (ranked by time/WPM)
  is shown.
- An invite reaches you the same way any other alert does today — as a
  pill notification with Accept/Decline actions — so your dashboard
  doesn't need to be open, just `dynamic-islandd` running.
- Build the peer-discovery and lobby/invite layer as a **reusable
  primitive**, not something wired specifically to typing races, so a
  second multiplayer feature later (another mini-game, or some other
  "cool thing with whoever's online") can reuse discovery, presence, and
  the invite/lobby/start flow without rebuilding them.

## Non-goals (for this pass)

- **No persistence.** No race history, no leaderboard, no cross-race
  stats. A race's result is shown once and then forgotten. (Explicitly
  deferred — can be revisited once the core loop is proven out.)
- **No speculative plugin system.** The reusability goal above is about
  cleanly separating "who's online, lobby, invite, start" (game-agnostic)
  from "what happens once a race starts" (typing-race-specific) — not
  about designing a generic plugin/registration API for games that don't
  exist yet. With only one game to build against, a real plugin interface
  would just be guessing. The seam for "add a second game later" is: a
  new package implementing its own logic against the same discovery/lobby
  layer, plus its own D-Bus methods and dashboard page — the same shape
  `race.go` itself will follow.
- **LAN only.** No internet play, no relay server, no NAT traversal. If
  mDNS can't see you, you're not racing.

## Anti-goals

- The feature must be **off by default**. Nobody should have their
  presence broadcast on a network, or a port opened, without explicitly
  opting in via settings (same pattern as every other feature in
  `lib/constants.js`'s `FEATURES`).
- Must not affect the single-user experience when the feature is off, or
  when it's on but nobody else is around — mDNS browsing with zero peers
  found should be silent and cheap.
- Must respect `Presenting()`: no incoming race invites, and no outgoing
  presence advertisement, while presenting (consistent with how other
  personal-content features already behave on a shared screen).
- Must not become a new attack surface that trusts network input blindly.
  Every message from a peer is untrusted input and must be validated
  (bounded sizes, expected shapes) the same way the daemon already treats
  D-Bus callers as semi-trusted but still validates.

## Constraints (from the existing project)

- **The daemon owns all logic; the extension is a view.** Race state
  (who's invited, who's accepted, the passage, timing, scores) lives in
  the daemon. The extension only renders what it's told and calls daemon
  D-Bus methods for actions (invite, accept, decline, start, submit
  keystroke progress).
- **Resource limits.** The daemon runs with a 32 MB soft memory limit and
  `GOMAXPROCS=2`. The HTTP server and mDNS browsing must be lightweight
  and idle-cheap (no busy polling; mDNS browsing is inherently event-driven
  already).
- **D-Bus contract.** Every new method the extension calls must be added
  to `INTERFACE_XML` in `lib/dbus.js` and implemented in a new
  `internal/dbusapi/race.go`, matching the existing one-file-per-feature
  pattern. `TestExtensionInterfaceMatchesDaemon` must keep passing.
- **Settings.** A new `race` entry in `FEATURES` (`lib/constants.js`),
  gated the same way as `usb`, `battery`, etc. (`settings.Enabled`).

## Approaches considered

**Discovery:** mDNS/Avahi (the standard LAN service-discovery mechanism on
Linux) vs. a custom UDP broadcast protocol. mDNS wins outright — it's
already running on virtually every Linux desktop, handles the "who's
actually still here" bookkeeping (TTLs, goodbye packets) for us, and is
the thing other LAN-discoverable Linux software already uses. This is the
project's first new Go dependency beyond `godbus` and `rsc.io/qr`.

**Peer transport** (sending invites and live race progress between
daemons), three options considered:

1. Raw TCP with a hand-rolled JSON line protocol. Zero new dependencies,
   full control, but reconnect/framing/heartbeat logic has to be built by
   hand.
2. **Chosen:** a small embedded `net/http` server per daemon. Invites,
   accept/decline, and race start are plain POST requests; live progress
   is pushed to joined peers via Server-Sent Events (one-way, host →
   client, which is all that's needed since typing progress updates are
   infrequent — people type at human speed, not 60 fps). Client → host
   progress updates are just occasional POSTs. Zero new dependencies
   (`net/http` is stdlib), debuggable with `curl`, and matches the
   project's existing "minimal dependencies" style.
3. WebSocket. Full duplex, "feels" most real-time, but needs a third-party
   library and is more mechanism than a human-speed typing race needs.

**Topology:** host-authoritative (a single daemon — the one that created
the lobby — holds the race state and is the source of truth; everyone
else is a thin client reporting their own progress and rendering what the
host sends) vs. a full peer-to-peer mesh. Host-authoritative is both
simpler and is what you already described ("the host just starts the
race") — a mesh adds synchronization complexity this doesn't need for
small, ad hoc lobbies.

## What's decided

- Genre: a TypeRacer-style typing race.
- Flow: lobby, invite as many people as you want, host starts whenever
  ready (not blocked on universal acceptance).
- Scope: light — no persistence/history/leaderboard for this pass.
- Transport: embedded HTTP server + SSE (option 2 above), host-authoritative.
- Discovery: mDNS.
- **Resilience: clean failure.** If the host disconnects (crash, sleep,
  WiFi loss, quits), every other racer gets an explicit "host left" state
  and the lobby/race ends cleanly — it does not just silently stall. In
  the host-authoritative model this is detected as the client's SSE
  stream from the host closing/erroring; `internal/race`'s state machine
  and `pages/race.js` both need this as a first-class end state, not an
  afterthought. (If a non-host racer drops instead, the race simply
  continues without them — only the host disappearing is special, since
  only the host holds the authoritative state.)
- **One race at a time per daemon.** A daemon can't be hosting one lobby
  while also racing in another; `internal/race`'s state is a single
  current-race pointer, not a map of concurrent races.
- **The pill shows a light summary, not live per-keystroke progress**
  (e.g. "Race: 2/4 ready" while lobbying, a coarse note while racing).
  Full live detail — the passage, everyone's progress bars — only renders
  in the open dashboard tab, consistent with the project's rule against
  pushing frequent updates into the always-visible pill.

## Left to the builder

- Go package layout, following the reusability split above:
  - `internal/discovery/`: the mDNS advertise/browse wrapper. Nothing
    game-specific — just "who's on the LAN running Dynamic Island."
  - `internal/lobby/` (or similar): game-agnostic peer messaging (the
    embedded HTTP+SSE server), lobby state (who's invited/accepted), and
    the start signal. Exposes something like "create a lobby for
    activity kind X, invite these peers, tell me when it starts and who's
    in it" without knowing what X actually is.
  - `internal/race/`: typing-race-specific logic (passage selection,
    keystroke progress, WPM/results), built as a consumer of
    `internal/lobby`, not entangled with it.
  - `plugins/race.go`: bridges race state into the normal `Activity`/
    `Host` mechanism for pill notifications, same as any other plugin.
  - This split is what makes a second game later cheap: a new
    `internal/<game>/` package reusing `internal/discovery` and
    `internal/lobby` as-is, plus its own plugin, D-Bus methods, and
    dashboard page.
- mDNS service type/name and exactly what goes in the TXT record (needs at
  minimum: a stable per-install peer ID, a display name, the HTTP port).
  Self-discovery (seeing your own advertised service while browsing) must
  be filtered out.
- Display name: default to the OS username, overridable via a settings
  field, shown in the peer list and in-race.
- Exact HTTP endpoint shapes (`POST /invite`, `POST /accept`,
  `POST /decline`, `POST /start`, `GET /progress` as SSE, `POST /progress`
  for a client's own updates, etc.) and their JSON bodies.
- Passage source: bundle a small built-in corpus of short sentences
  (plain text, no network fetch needed); the host picks one at race start
  and sends it to everyone so all racers get identical text.
- New dashboard page (`pages/race.js`, added to `TABS`/`PAGES`) covering:
  the peer list with an invite action, a pending-lobby view (who's in,
  who's still pending, a Start button for the host), the live race view
  (passage text, each racer's progress bar, your own typing input), and a
  simple results view. Exact visual layout is the builder's call, following
  existing widgets (`lib/widgets.js`) and the Page contract.
- How an incoming invite surfaces in the pill: a new high-priority
  `Activity` (own priority tier, likely near `PriorityAlert`) with
  Accept/Decline `HandleAction`s, following the existing notification
  pattern exactly.
- Validation/hardening specifics for inbound peer HTTP requests: body size
  caps, expected-shape checks, rejecting anything from an unknown/unexpected
  peer ID, and whatever minimal rate limiting keeps a misbehaving peer from
  spamming the daemon (exact numbers are the builder's call).
- Whether the HTTP listener binds to all interfaces or only the one mDNS
  advertises on; whatever is simplest and consistent with "LAN only" is
  fine.
- Test strategy: since this needs two or more live daemons to exercise
  for real, the plan should include running multiple `dynamic-islandd`
  instances locally (different `XDG_*` dirs and ports, like the existing
  headless-GNOME-Shell recipe runs one daemon) to test discovery and a
  full invite → accept → start → progress → finish race end to end, in
  addition to normal unit tests around the race state machine.
