# LAN Typing Race Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let people running Dynamic Island on the same LAN discover each other, invite one another into a lobby, and race a shared typing passage (TypeRacer-style), rendered in a new dashboard page and summarized in the pill.

**Architecture:** Three new Go packages layered so a future game can reuse the bottom two: `internal/discovery` (mDNS presence, game-agnostic), `internal/lobby` (an embedded HTTP+SSE server doing generic invite/accept/start/progress messaging between daemons, game-agnostic), and `internal/race` (the typing-race state machine, built on top of the other two). A new `plugins/race.go` bridges race state into the existing `Activity`/`Host` mechanism (pill + `HandleAction`), a new `internal/dbusapi/race.go` exposes it over D-Bus, and a new `pages/race.js` renders it. Everything is gated behind a new `race` feature flag, off by default.

**Tech Stack:** Go (stdlib `net/http` for the peer transport, `github.com/hashicorp/mdns` v1.0.7 for discovery), GJS/GNOME Shell extension (existing `Page` contract and widgets).

**Spec:** `docs/superpowers/specs/2026-11-16-lan-typing-race-design.md`

## Global Constraints

- The daemon owns all race/lobby logic and state; the extension only renders what the daemon's D-Bus methods return and calls daemon methods for actions. (Spec: "Constraints.")
- Every new D-Bus method must be added to `INTERFACE_XML` in both `internal/dbusapi/introspect.go` and the extension's `lib/dbus.js`; `TestExtensionInterfaceMatchesDaemon` must keep passing.
- The `race` feature is off by default (new entry in `settings.FeatureIDs` / `lib/constants.js`'s `FEATURES`, same as `usb`/`battery`); no socket opens and no mDNS advertising/browsing happens unless `settings.Enabled("race")` is true.
- No persistence: a race's result is shown once and forgotten. No history/leaderboard store.
- One race at a time per daemon: a daemon is never simultaneously hosting one lobby and joined to another.
- The pill shows only a light summary (e.g. "Race: 2/4 ready"); full detail (passage, per-person progress) renders only in the open `race` dashboard tab.
- Host disconnecting is a clean failure: every other racer reaches an explicit "host left" state, not a silent stall. A non-host racer disconnecting does not end the race for anyone else.
- Treat every inbound peer HTTP message as untrusted: bound body size, validate shape, and never let a malformed peer message crash the daemon.
- Respect `Host.Presenting()`: no incoming race invite becomes a pill Activity, and presence is not advertised, while presenting.
- Daemon resource limits: 32 MB soft memory limit, `GOMAXPROCS=2` — discovery/transport must be event-driven, not busy-polling.
- Go 1.22, no comments in code (explanations belong in this plan/spec or commit messages), gofmt.

## Review Focus

- A malformed or oversized JSON body on any `internal/lobby` HTTP endpoint (e.g. truncated JSON, a 50 MB body, missing required fields) must be rejected with a 4xx response, not crash the handler or the daemon.
- Discovering a service advertisement that is this daemon's own (same peer ID) must never appear in `discovery.Peers()` — otherwise a user could invite/race themselves.
- An inbound race invite, and this daemon's own mDNS advertisement, must both be suppressed while `Host.Presenting()` is true.
- If the host's SSE connection to a joined client closes or errors, that client's race state must move to an explicit "host left" phase within one reconnect-attempt cycle, never hang waiting silently.
- A `/start`, `/progress`, or SSE event referencing a `lobbyId` this daemon doesn't currently know about (already left, never invited, or a stale message from a previous race) must be ignored, not panic or corrupt the current race's state.

---

## Task 1: Peer identity and display name

**Files:**
- Create: `internal/identity/identity.go`
- Test: `internal/identity/identity_test.go`
- Modify: `internal/settings/settings.go` (add `DisplayName` field)
- Modify: `internal/settings/settings_test.go` (cover the new field)

**Interfaces:**
- Produces: `identity.ID() (string, error)` — a stable, randomly generated, persisted-on-first-call peer ID. `identity.Ephemeral() string` — a same-shape random id that is never written to disk, for the caller to fall back to if `ID()` errors. `identity.Name() string` — `settings.Get().DisplayName` if non-empty, else the OS username.

- [ ] **Step 1: Write the failing test for a stable persisted ID**

```go
func TestIDPersistsAcrossCalls(t *testing.T) {
    t.Setenv("XDG_DATA_HOME", t.TempDir())
    first, err := identity.ID()
    if err != nil || first == "" {
        t.Fatalf("ID() = %q, %v", first, err)
    }
    second, err := identity.ID()
    if err != nil || second != first {
        t.Fatalf("ID() not stable: %q then %q", first, second)
    }
}

func TestIDUniquePerDataDir(t *testing.T) {
    t.Setenv("XDG_DATA_HOME", t.TempDir())
    a, _ := identity.ID()
    t.Setenv("XDG_DATA_HOME", t.TempDir())
    b, _ := identity.ID()
    if a == b {
        t.Fatal("expected different IDs for different data dirs")
    }
}

func TestEphemeralNeverPersists(t *testing.T) {
    dir := t.TempDir()
    t.Setenv("XDG_DATA_HOME", dir)
    a := identity.Ephemeral()
    b := identity.Ephemeral()
    if a == "" || a == b {
        t.Fatalf("Ephemeral() should return fresh non-empty ids, got %q and %q", a, b)
    }
    entries, _ := os.ReadDir(dir)
    if len(entries) != 0 {
        t.Fatalf("Ephemeral() must not write to disk, found: %v", entries)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/identity/... -v`
Expected: FAIL (package does not exist)

- [ ] **Step 3: Implement `internal/identity/identity.go`**

`func ID() (string, error)`: reads `paths.DataFile("peer-id")`; if missing, generates 16 random bytes via `crypto/rand`, hex-encodes them, writes the file with mode `0600` (creating the data dir with `0700` first), and returns it. Cache the loaded value in a package-level `sync.Once` so repeated calls in the same process don't re-read the file.

`func Name() string`: returns `settings.Get().DisplayName` if non-empty, else `user.Current().Username` (`os/user`), else `"Player"` as a last-resort fallback if both are unavailable.

`func Ephemeral() string`: the same 16-random-bytes-hex-encoded generation `ID()` uses on a first run, but returned directly without touching `paths.DataFile` at all — factor the generation into a small unexported `newID() (string, error)` both call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/identity/... -v`
Expected: PASS

- [ ] **Step 5: Add `DisplayName` to `settings.Settings` and its merge logic, and register the `race` feature/tab ids**

In `internal/settings/settings.go`: add `DisplayName string \`json:"displayName"\`` to the `Settings` struct. In `merge`, add `DisplayName *string \`json:"displayName"\`` to the patch struct and, when non-nil, assign it directly to `base.DisplayName` (a free-text field, no allow-list check needed, but trim whitespace and cap length — reject with an error if longer than 40 runes, matching the kind of bound other free-text settings would need).

Also append `"race"` to both `FeatureIDs` and `TabIDs` here — pulled forward from what would otherwise be a later task, because Task 5's test needs `settings.Enabled("race")`/`Update({"features":{"race":...}})` to actually recognize the id, and nothing about registering the id depends on any other task.

- [ ] **Step 6: Write the failing test for the settings change**

```go
func TestUpdateDisplayName(t *testing.T) {
    t.Setenv("XDG_CONFIG_HOME", t.TempDir())
    mu.Lock()
    cur = Defaults()
    mu.Unlock()
    s, err := Update([]byte(`{"displayName":"Adam"}`))
    if err != nil || s.DisplayName != "Adam" {
        t.Fatalf("got %+v, %v", s, err)
    }
    if _, err := Update([]byte(`{"displayName":"` + strings.Repeat("x", 41) + `"}`)); err == nil {
        t.Fatal("expected error for an over-long display name")
    }
    if !Enabled("race") || !TabOn("race") {
        t.Fatal("race feature/tab ids must be registered and default on, like every other feature")
    }
}
```

- [ ] **Step 7: Run test to verify it fails, then passes after Step 5's implementation**

Run: `go test ./internal/settings/... -run TestUpdateDisplayName -v`
Expected: FAIL, then PASS once Step 5 is in place.

- [ ] **Step 8: Run the full settings test and identity test suites**

Run: `go test ./internal/settings/... ./internal/identity/... -v`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add internal/identity internal/settings
git commit -m "feat: add peer identity and display name setting"
```

---

## Task 2: LAN peer discovery (mDNS)

**Files:**
- Create: `internal/discovery/discovery.go`
- Test: `internal/discovery/discovery_test.go`
- Modify: `go.mod`, `go.sum` (new dependency)

**Interfaces:**
- Consumes: nothing from other new packages (only `identity.ID`/`identity.Name` values passed in by the caller, not imported directly — keeps this package usable standalone).
- Produces:
  ```go
  type Peer struct {
      ID   string `json:"id"`
      Name string `json:"name"`
      Addr string `json:"addr"` // "ip:port", suitable for lobby.Send*(addr, ...)
  }

  func Start(selfID, selfName string, port int) (*Discovery, error)
  func (d *Discovery) Peers() []Peer
  func (d *Discovery) Close() error
  ```

- [ ] **Step 1: Add the dependency**

Run: `go get github.com/hashicorp/mdns@v1.0.7`

- [ ] **Step 2: Write the failing test for self-filtering and peer listing**

Two real `Discovery` instances on `127.0.0.1` with different ports exercise this for real (mDNS multicast works over loopback). Use distinct ports per call so parallel test runs don't collide.

```go
func TestDiscoveryFindsPeerNotSelf(t *testing.T) {
    a, err := discovery.Start("peer-a", "Alice", 48551)
    if err != nil { t.Fatal(err) }
    defer a.Close()
    b, err := discovery.Start("peer-b", "Bob", 48552)
    if err != nil { t.Fatal(err) }
    defer b.Close()

    var found discovery.Peer
    deadline := time.Now().Add(10 * time.Second)
    for time.Now().Before(deadline) {
        for _, p := range a.Peers() {
            if p.ID == "peer-b" {
                found = p
            }
        }
        if found.ID != "" {
            break
        }
        time.Sleep(200 * time.Millisecond)
    }
    if found.ID != "peer-b" || found.Name != "Bob" || found.Addr == "" {
        t.Fatalf("did not discover peer-b in time: %+v", found)
    }
    for _, p := range a.Peers() {
        if p.ID == "peer-a" {
            t.Fatal("Peers() must not include self")
        }
    }
}
```

Mark this test with `if testing.Short() { t.Skip("needs multicast") }` so `go test -short` (used in sandboxes without multicast) still passes; `make test` does not pass `-short`, so this still runs in CI/normal `make test`.

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/discovery/... -v`
Expected: FAIL (package does not exist)

- [ ] **Step 4: Implement `internal/discovery/discovery.go`**

Service name constant: `const serviceName = "_dynamicisland._tcp"`.

`Start(selfID, selfName string, port int) (*Discovery, error)`:
- Advertise: `mdns.NewMDNSService(selfID, serviceName, "", "", port, nil, []string{"id=" + selfID, "name=" + selfName})`, then `mdns.NewServer(&mdns.Config{Zone: svc})`. Store the `*mdns.Server` for `Close`.
- Browse: start a goroutine that loops every 5 seconds (and once immediately before the first wait) calling `mdns.Lookup(serviceName, entriesCh)` into a locally buffered channel drained by a nested goroutine into a `map[string]Peer` scratch map (keyed by the `id=` TXT value), then atomically swaps that into the `Discovery`'s guarded current-peer map. Parse `id=` and `name=` out of each entry's `InfoFields` (format `"key=value"`); skip any entry whose `id=` matches `selfID`, and skip any entry missing an `id=` field. Build `Addr` as `net.JoinHostPort(entry.AddrV4.String(), strconv.Itoa(entry.Port))` (fall back to `entry.AddrV6` if `AddrV4` is nil).
- Stop the browse loop via a `context.Context`/`cancel` stored on `Discovery`, cancelled in `Close`.

`(d *Discovery) Peers() []Peer`: returns a snapshot copy of the current guarded map's values (mutex-protected, matching the `sync.Mutex` pattern used elsewhere in this codebase, e.g. `internal/notes`).

`(d *Discovery) Close() error`: cancels the browse loop and calls `d.server.Shutdown()`.

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/discovery/... -v`
Expected: PASS (allow up to ~15s for the 10s discovery-wait loop)

- [ ] **Step 6: Run `make check`**

Run: `make check`
Expected: passes (gofmt, go vet)

- [ ] **Step 7: Commit**

```bash
git add internal/discovery go.mod go.sum
git commit -m "feat: add LAN peer discovery via mDNS"
```

---

## Task 3: Generic lobby transport (HTTP + SSE)

**Files:**
- Create: `internal/lobby/lobby.go`
- Test: `internal/lobby/lobby_test.go`

**Interfaces:**
- Consumes: nothing from `discovery`/`race` (this package knows only peer addresses as plain strings, passed in by its caller — keeps it reusable for any future game).
- Produces:
  ```go
  type Invite struct {
      LobbyID, Kind, HostID, HostName, HostAddr string
  }
  type Response struct {
      LobbyID, PeerID, PeerName string
      Accept bool
  }
  type Start struct {
      LobbyID string
      Payload json.RawMessage
  }
  type Progress struct {
      LobbyID, PeerID string
      Payload json.RawMessage
  }
  type Callbacks struct {
      OnInvite   func(Invite)
      OnRespond  func(Response)
      OnStart    func(Start)
      OnProgress func(Progress)
  }

  func NewServer(port int, cb Callbacks) *Server
  func (s *Server) ListenAndServe() error
  func (s *Server) Close() error
  func (s *Server) Broadcast(lobbyID string, payload json.RawMessage)
  func (s *Server) EndLobby(lobbyID string, payload json.RawMessage)

  func SendInvite(addr string, inv Invite) error
  func SendRespond(addr string, r Response) error
  func SendStart(addr string, s Start) error
  func SendProgress(addr string, p Progress) error
  func Subscribe(addr, lobbyID string, onEvent func(json.RawMessage), onClosed func(error)) (cancel func())
  ```
  `DefaultPort = 54372` exported constant, used as the default when a caller doesn't need a different port (tests use distinct ports to run concurrently).

- [ ] **Step 1: Write the failing test for invite → respond round trip over real HTTP**

```go
func TestInviteRespondRoundTrip(t *testing.T) {
    var got lobby.Invite
    invited := make(chan struct{})
    invitee := lobby.NewServer(48561, lobby.Callbacks{
        OnInvite: func(inv lobby.Invite) { got = inv; close(invited) },
    })
    go invitee.ListenAndServe()
    defer invitee.Close()
    time.Sleep(50 * time.Millisecond)

    err := lobby.SendInvite("127.0.0.1:48561", lobby.Invite{
        LobbyID: "l1", Kind: "race", HostID: "h1", HostName: "Host", HostAddr: "127.0.0.1:48560",
    })
    if err != nil { t.Fatal(err) }
    select {
    case <-invited:
    case <-time.After(2 * time.Second):
        t.Fatal("OnInvite never called")
    }
    if got.LobbyID != "l1" || got.Kind != "race" {
        t.Fatalf("got %+v", got)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/lobby/... -v`
Expected: FAIL (package does not exist)

- [ ] **Step 3: Implement the server side in `internal/lobby/lobby.go`**

`NewServer`/`ListenAndServe`/`Close` wrap a `*http.Server` bound to `fmt.Sprintf(":%d", port)` with `http.NewServeMux()` routes:
- `POST /invite` → decode `Invite`, call `cb.OnInvite`.
- `POST /respond` → decode `Response`, call `cb.OnRespond`.
- `POST /start` → decode `Start`, call `cb.OnStart`.
- `POST /progress` → decode `Progress`, call `cb.OnProgress`.
- `GET /events?lobby=<id>` → SSE: set `Content-Type: text/event-stream`, flush a registered subscriber channel (`chan json.RawMessage`) per `lobbyID` into `data: <json>\n\n` lines using `http.Flusher`, keyed in a `map[string][]chan json.RawMessage` guarded by a mutex; remove the subscriber channel when the request context is done (client disconnected).

Every decode uses `json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&v)`; a decode error responds `http.Error(w, "bad request", http.StatusBadRequest)` and returns without calling any callback (Review Focus: malformed/oversized body).

`Broadcast(lobbyID, payload)`: sends `payload` to every subscriber channel registered for `lobbyID`. `EndLobby(lobbyID, payload)`: same, then closes and removes those channels (ending their SSE responses), so `Subscribe`'s `onClosed` fires on the listener side.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/lobby/... -run TestInviteRespondRoundTrip -v`
Expected: PASS

- [ ] **Step 5: Write the failing test for malformed/oversized input (Review Focus)**

```go
func TestServerRejectsBadBody(t *testing.T) {
    called := false
    s := lobby.NewServer(48562, lobby.Callbacks{OnInvite: func(lobby.Invite) { called = true }})
    go s.ListenAndServe()
    defer s.Close()
    time.Sleep(50 * time.Millisecond)

    resp, err := http.Post("http://127.0.0.1:48562/invite", "application/json", strings.NewReader("not json"))
    if err != nil { t.Fatal(err) }
    if resp.StatusCode != http.StatusBadRequest {
        t.Fatalf("status = %d, want 400", resp.StatusCode)
    }
    if called {
        t.Fatal("OnInvite must not be called for a malformed body")
    }

    huge := strings.NewReader(strings.Repeat("a", 1<<20))
    resp2, err := http.Post("http://127.0.0.1:48562/invite", "application/json", huge)
    if err != nil { t.Fatal(err) }
    if resp2.StatusCode != http.StatusBadRequest {
        t.Fatalf("oversized body status = %d, want 400", resp2.StatusCode)
    }
}
```

- [ ] **Step 6: Run test to verify it fails, then implement/adjust until it passes**

Run: `go test ./internal/lobby/... -run TestServerRejectsBadBody -v`
Expected: FAIL, then PASS (the `MaxBytesReader` + decode-error handling from Step 3 should already cover this; adjust if not).

- [ ] **Step 7: Write the failing test for SSE `Subscribe` delivering a `Broadcast` and `onClosed` firing on `EndLobby`**

```go
func TestSubscribeReceivesBroadcastAndClose(t *testing.T) {
    s := lobby.NewServer(48563, lobby.Callbacks{})
    go s.ListenAndServe()
    defer s.Close()
    time.Sleep(50 * time.Millisecond)

    events := make(chan json.RawMessage, 4)
    closedErr := make(chan error, 1)
    cancel := lobby.Subscribe("127.0.0.1:48563", "l1",
        func(p json.RawMessage) { events <- p },
        func(err error) { closedErr <- err })
    defer cancel()
    time.Sleep(50 * time.Millisecond)

    s.Broadcast("l1", json.RawMessage(`{"n":1}`))
    select {
    case got := <-events:
        if string(got) != `{"n":1}` { t.Fatalf("got %s", got) }
    case <-time.After(2 * time.Second):
        t.Fatal("event never received")
    }

    s.EndLobby("l1", json.RawMessage(`{"ended":true}`))
    select {
    case <-closedErr:
    case <-time.After(2 * time.Second):
        t.Fatal("onClosed never called after EndLobby")
    }
}
```

- [ ] **Step 8: Run test to verify it fails, then implement `Subscribe`/`SendRespond`/`SendStart`/`SendProgress` until it passes**

`Subscribe` opens `GET http://<addr>/events?lobby=<lobbyID>` with `http.Client{}` (no timeout, since it's a long-lived stream), reads `data: ` lines with `bufio.Scanner`, calls `onEvent` per line, and calls `onClosed(err)` when the read loop ends (EOF, error, or the server closing the body for `EndLobby`). `cancel()` aborts the request via a stored `context.CancelFunc`. `SendRespond`/`SendStart`/`SendProgress` POST their JSON-encoded struct to the matching path, mirroring `SendInvite`.

Run: `go test ./internal/lobby/... -v`
Expected: PASS

- [ ] **Step 9: Run `make check` and `make test`**

Run: `make check && make test`
Expected: both pass

- [ ] **Step 10: Commit**

```bash
git add internal/lobby
git commit -m "feat: add generic lobby transport (HTTP + SSE)"
```

---

## Task 4: Typing race engine

**Files:**
- Create: `internal/race/race.go`, `internal/race/passages.go`
- Test: `internal/race/race_test.go`

**Interfaces:**
- Consumes: `discovery.Peer` (`ID`, `Name`, `Addr` fields, from Task 2) and the `lobby.Invite`/`Response`/`Start`/`Progress`/`Callbacks`/`Server`/`Subscribe`/`Send*` names (from Task 3).
- Produces:
  ```go
  type Phase string
  const (
      PhaseIdle     Phase = "idle"
      PhaseLobby    Phase = "lobby"
      PhaseRacing   Phase = "racing"
      PhaseFinished Phase = "finished"
      PhaseHostLeft Phase = "host_left"
  )
  type Racer struct {
      PeerID       string  `json:"peerId"`
      Name         string  `json:"name"`
      Status       string  `json:"status"` // "pending" | "accepted" | "declined"
      Progress     float64 `json:"progress"` // 0..1
      FinishedAtMs int64   `json:"finishedAtMs"`
      WPM          float64 `json:"wpm"`
  }
  type State struct {
      LobbyID string  `json:"lobbyId"`
      IsHost  bool    `json:"isHost"`
      Phase   Phase   `json:"phase"`
      Passage string  `json:"passage"`
      Racers  []Racer `json:"racers"`
  }

  func NewEngine(selfID, selfName, selfAddr string, port int) *Engine
  func (e *Engine) Enable() error   // idempotent: opens the mDNS advertisement/browse and the lobby HTTP listener
  func (e *Engine) Disable()        // idempotent: Leave()s any active lobby/race first, then closes both
  func (e *Engine) Enabled() bool
  func (e *Engine) Discovery() *discovery.Discovery // nil when Disabled
  func (e *Engine) OnChange(fn func(State))
  func (e *Engine) State() State
  func (e *Engine) CreateLobby() string
  func (e *Engine) Invite(peer discovery.Peer) error
  func (e *Engine) Respond(accept bool) error
  func (e *Engine) Start() error
  func (e *Engine) SubmitProgress(typedChars int) error
  func (e *Engine) Leave()
  ```
  `NewEngine` performs no I/O and opens no socket — it only becomes network-active once `Enable()` is called. `CreateLobby`/`Invite`/`Respond`/`Start`/`SubmitProgress` return an error (or, for the two that don't already return one, are changed to return one) if `!e.Enabled()`. This is what makes "off by default, no network activity until opted in" (a Global Constraint) actually hold: `NewEngine` runs unconditionally at daemon startup in Task 9, but nothing touches the network until something calls `Enable()` — which Task 5's plugin loop does, gated on `settings.Enabled("race")`.

- [ ] **Step 1: Write the failing test for a host-starts-with-one-accepted-racer flow, entirely in-process (two `Engine`s on loopback, no `discovery`)**

```go
func TestHostStartRace(t *testing.T) {
    host := race.NewEngine("h1", "Host", "127.0.0.1", 48571)
    if err := host.Enable(); err != nil { t.Fatal(err) }
    defer host.Disable()
    guest := race.NewEngine("g1", "Guest", "127.0.0.1", 48572)
    if err := guest.Enable(); err != nil { t.Fatal(err) }
    defer guest.Disable()

    var guestStates []race.State
    guest.OnChange(func(s race.State) { guestStates = append(guestStates, s) })

    lobbyID := host.CreateLobby()
    if err := host.Invite(discovery.Peer{ID: "g1", Name: "Guest", Addr: "127.0.0.1:48572"}); err != nil {
        t.Fatal(err)
    }
    waitFor(t, func() bool { return guest.State().Phase == race.PhaseLobby })

    if err := guest.Respond(true); err != nil { t.Fatal(err) }
    waitFor(t, func() bool {
        for _, r := range host.State().Racers {
            if r.PeerID == "g1" && r.Status == "accepted" { return true }
        }
        return false
    })

    if err := host.Start(); err != nil { t.Fatal(err) }
    waitFor(t, func() bool { return guest.State().Phase == race.PhaseRacing && guest.State().Passage != "" })

    passage := guest.State().Passage
    if err := guest.SubmitProgress(len(passage)); err != nil { t.Fatal(err) }
    waitFor(t, func() bool {
        for _, r := range host.State().Racers {
            if r.PeerID == "g1" && r.FinishedAtMs != 0 { return true }
        }
        return false
    })
    if lobbyID == "" { t.Fatal("empty lobby id") }
}
```

Add a small local `waitFor(t *testing.T, cond func() bool)` test helper in `race_test.go` that polls every 50ms up to a 5s deadline and calls `t.Fatal` on timeout.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/race/... -v`
Expected: FAIL (package does not exist)

- [ ] **Step 3: Implement `internal/race/passages.go`**

`var passages = []string{...}`: at least 15 short (60–120 character) plain-English sentences, no code snippets (hardcoded literal strings — the spec leaves exact wording to the builder). `func randomPassage() string` picks one via `math/rand/v2`.

- [ ] **Step 4: Implement `internal/race/race.go`**

`Engine` holds `selfID, selfName, selfAddr string`, `port int`, mutex-guarded `State`, an `enabled bool`, a `*discovery.Discovery` (nil unless enabled), a `*lobby.Server` (nil unless enabled), `host bool`, `hostAddr string` (only meaningful when `!host`), and an `unsubscribe func()` (the guest's `lobby.Subscribe` cancel function, set in the callback that handles a `Start` message — see below).

- `NewEngine(selfID, selfName, selfAddr string, port int) *Engine`: stores the fields, sets initial `State{Phase: PhaseIdle}`. Opens nothing.
- `Enable() error`: no-op if already `enabled`. Otherwise calls `discovery.Start(selfID, selfName, port)` (storing the result), constructs `lobby.NewServer(port, cb)` with `Callbacks` wired to the methods below (storing the result), starts it with `go server.ListenAndServe()`, sets `enabled = true`. Returns whatever error `discovery.Start` produced, without setting `enabled`, if it failed.
- `Disable()`: no-op if not `enabled`. Otherwise calls `Leave()` first (clean teardown of any active lobby/race), then `discovery.Close()` and `server.Close()`, sets `enabled = false`, clears both stored pointers, and fires `OnChange` with a reset `State{Phase: PhaseIdle}`.
- `Enabled() bool`, `Discovery() *discovery.Discovery` (returns the stored pointer, nil when disabled): plain accessors.
- `CreateLobby() string`: returns `""` without changing state if `!enabled`. Otherwise generates a random lobby ID (same style as the peer ID in Task 1 — short random hex), sets `host = true`, `State = {LobbyID: id, IsHost: true, Phase: PhaseLobby, Racers: [{PeerID: selfID, Name: selfName, Status: "accepted"}]}`, fires `OnChange`, returns the ID.
- `Invite(peer)`: returns an error if `!enabled` or not hosting; otherwise appends a `Racer{PeerID: peer.ID, Name: peer.Name, Status: "pending"}` to `State.Racers`, fires `OnChange`, calls `lobby.SendInvite(peer.Addr, lobby.Invite{LobbyID, Kind: "race", HostID: selfID, HostName: selfName, HostAddr: fmt.Sprintf("%s:%d", selfAddr, port)})`.
- The `Callbacks.OnInvite` handler (wired on construction): only valid when `Phase == PhaseIdle` (Global Constraint: one race at a time — if already in a lobby/race, respond immediately with `Response{Accept: false}` without changing state); otherwise sets `State = {LobbyID: inv.LobbyID, IsHost: false, Phase: PhaseLobby, Racers: [{PeerID: inv.HostID, Name: inv.HostName, Status: "accepted"}]}`, stores `hostAddr = inv.HostAddr`, fires `OnChange`.
- `Respond(accept)`: only valid for a non-host engine in `PhaseLobby`; calls `lobby.SendRespond(hostAddr, lobby.Response{LobbyID, PeerID: selfID, PeerName: selfName, Accept: accept})`; if `!accept`, resets to `PhaseIdle`.
- The host's `Callbacks.OnRespond` handler: finds the matching `Racer` by `PeerID` in `State.Racers` and sets its `Status` to `"accepted"` or `"declined"`, fires `OnChange`.
- `Start()`: host-only, valid in `PhaseLobby`; picks `randomPassage()`, sets `State.Phase = PhaseRacing`, `State.Passage = passage`, fires `OnChange`, then for every accepted racer (excluding self) calls `lobby.SendStart(<that racer's addr — the host must have recorded it from the Invite call, so add an `addr` field alongside each `Racer`, not part of the exported struct: keep a parallel `map[string]string` of `peerID -> addr` on `Engine`>, lobby.Start{LobbyID, Payload: json.RawMessage(mustMarshal(passage))})`.
- The guest's `Callbacks.OnStart` handler: ignores a `Start` whose `LobbyID` doesn't match the current `State.LobbyID` (Review Focus: stale/unknown lobby id); otherwise unmarshals `Payload` into the passage string, sets `Phase = PhaseRacing`, `Passage = passage`, fires `OnChange`, and opens `unsubscribe = lobby.Subscribe(hostAddr, LobbyID, onEvent, onClosed)` where `onEvent` unmarshals a `State` snapshot JSON and replaces local `State.Racers` with it (keeping local `IsHost`/`LobbyID`/`Phase`/`Passage` — the host is the source of truth for everyone's progress) and fires `OnChange`; `onClosed` sets `Phase = PhaseHostLeft` and fires `OnChange` (Review Focus: clean host-left failure), unless the engine already left/reset (guard with a generation counter or the current `LobbyID` still matching, to avoid a late callback from a stale subscription clobbering a newer lobby's state).
- `SubmitProgress(typedChars)`: the wire/local payload is always just the raw `typedChars` count — define `type progressPayload struct { TypedChars int \`json:"typedChars"\` }` (unexported, used only between a guest and its host, never reaches `dbusapi` or the extension) so the *host* is the only side that ever turns a char count into progress/WPM/finished-at, using its own clock. Concretely: if `host`, call a shared unexported `applyProgress(peerID string, typedChars int)` method directly as `applyProgress(selfID, typedChars)`; if guest, call `lobby.SendProgress(hostAddr, lobby.Progress{LobbyID: State.LobbyID, PeerID: selfID, Payload: json.RawMessage(mustMarshal(progressPayload{typedChars}))})` (`mustMarshal` is a one-line unexported helper: `json.Marshal` and panic on error, since marshaling these small, local, always-valid structs cannot realistically fail).
- The host's `Callbacks.OnProgress` handler: unmarshals `Progress.Payload` into `progressPayload`, then calls the same `applyProgress(Progress.PeerID, payload.TypedChars)` the host's own `SubmitProgress` call above uses — this is the single place the math happens, on whichever machine is hosting. `applyProgress` finds the matching `Racer` by `PeerID`, sets `Progress = clamp(float64(typedChars)/float64(len(State.Passage)), 0, 1)`; if `Progress >= 1` and `FinishedAtMs == 0`, sets `FinishedAtMs = time.Now().UnixMilli()` and `WPM = (float64(typedChars)/5) / time.Since(raceStartedAt).Minutes()` (`raceStartedAt` is a `time.Time` field on `Engine`, set when `Start()` is called); fires `OnChange`, then `Broadcast`s the full current `State` (JSON-encoded) to every subscriber of that lobby so every guest's `onEvent` above receives the up-to-date racer list. When every racer's `FinishedAtMs != 0`, set `Phase = PhaseFinished` first, then `Broadcast`, then `EndLobby` (closing everyone's subscription cleanly rather than leaving it open with nothing left to send). A guest's own `SubmitProgress` call never touches `State.Racers` directly — only `applyProgress` on whichever machine is host does, keeping the host the single source of truth exactly as the design calls for.
- `Leave()`: no-op if already `PhaseIdle`. Otherwise resets to `PhaseIdle`, calls `unsubscribe()` if set, and if hosting, `EndLobby`s the current lobby first so joined peers get a clean end rather than silently timing out (this only governs the *local* "I'm done" case, distinct from the *host crashed* case the SSE-close path already handles). Safe to call whether or not the engine is `enabled` (it's also the first step `Disable()` takes).

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/race/... -v`
Expected: PASS

- [ ] **Step 6: Write the failing test for the one-race-at-a-time rule (Global Constraint) and the stale-lobby-id guard (Review Focus)**

```go
func TestDeclinesSecondInviteWhileBusy(t *testing.T) {
    host := race.NewEngine("h1", "Host", "127.0.0.1", 48573)
    host.Enable()
    defer host.Disable()
    busy := race.NewEngine("b1", "Busy", "127.0.0.1", 48574)
    busy.Enable()
    defer busy.Disable()
    other := race.NewEngine("o1", "Other", "127.0.0.1", 48575)
    other.Enable()
    defer other.Disable()

    host.CreateLobby()
    host.Invite(discovery.Peer{ID: "b1", Name: "Busy", Addr: "127.0.0.1:48574"})
    waitFor(t, func() bool { return busy.State().Phase == race.PhaseLobby })

    other.CreateLobby()
    other.Invite(discovery.Peer{ID: "b1", Name: "Busy", Addr: "127.0.0.1:48574"})
    waitFor(t, func() bool {
        for _, r := range other.State().Racers {
            if r.PeerID == "b1" { return r.Status == "declined" }
        }
        return false
    })
    if busy.State().LobbyID != host.State().LobbyID {
        t.Fatal("the busy engine's original lobby must be unaffected by the second invite")
    }
}
```

- [ ] **Step 7: Run test, fix the implementation from Step 4 until it passes**

Run: `go test ./internal/race/... -v`
Expected: PASS

- [ ] **Step 7b: Write the failing test proving `NewEngine` alone opens no socket (Global Constraint: no network activity until explicitly enabled)**

```go
func TestNewEngineOpensNothing(t *testing.T) {
    e := race.NewEngine("h1", "Host", "127.0.0.1", 48576)
    if e.Enabled() {
        t.Fatal("a freshly constructed Engine must not be enabled")
    }
    l, err := net.Listen("tcp", "127.0.0.1:48576")
    if err != nil {
        t.Fatalf("port 48576 was already bound by NewEngine: %v", err)
    }
    l.Close()
    if id := e.CreateLobby(); id != "" {
        t.Fatal("CreateLobby must be a no-op while disabled")
    }
}

func TestEnableDisableIdempotent(t *testing.T) {
    e := race.NewEngine("h1", "Host", "127.0.0.1", 48577)
    if err := e.Enable(); err != nil { t.Fatal(err) }
    if err := e.Enable(); err != nil { t.Fatalf("second Enable must be a no-op, got %v", err) }
    e.Disable()
    e.Disable() // must not panic
}
```

- [ ] **Step 7c: Run tests, fix the implementation until both pass**

Run: `go test ./internal/race/... -v`
Expected: PASS

- [ ] **Step 8: Run `make check` and `make test`**

Run: `make check && make test`
Expected: both pass

- [ ] **Step 9: Commit**

```bash
git add internal/race
git commit -m "feat: add typing race engine"
```

---

## Task 5: `race` plugin (pill integration)

**Files:**
- Create: `internal/plugins/race.go`
- Test: `internal/plugins/race_test.go`

**Interfaces:**
- Consumes: `race.NewEngine`, `race.Phase`/`State`/`Racer`, `(*race.Engine).Enable`/`Disable`/`Enabled` (Task 4); `island.Host`, `island.Activity`, `island.View`, `island.PriorityAlert`/`PriorityStatus` (existing); `settings.Enabled` (existing).
- Produces:
  ```go
  func NewRace(selfID, selfName, selfAddr string, port int) *Race
  func (r *Race) Name() string
  func (r *Race) Run(ctx context.Context, h island.Host) error
  func (r *Race) Engine() *race.Engine
  ```
  `NewRace` performs no I/O (it just builds a `race.Engine` via `race.NewEngine`, which itself opens nothing — see Task 4). `(r *Race) Engine()` is what `internal/dbusapi/race.go` (Task 6) calls to reach `CreateLobby`/`Invite`/`Respond`/`Start`/`SubmitProgress`/`Leave`/`State`/`Discovery`, and it's always safe to call (never nil), even before `Run` has started or while the feature is disabled.

- [ ] **Step 1: Write the failing test for the pill summary text per phase**

Pure function, no `Host` needed — extract the summary-building into something independently testable:

```go
func TestRaceSummary(t *testing.T) {
    cases := []struct {
        s    race.State
        want string
    }{
        {race.State{Phase: race.PhaseLobby, Racers: []race.Racer{{Status: "accepted"}, {Status: "pending"}, {Status: "accepted"}}}, "Race: 2/3 ready"},
        {race.State{Phase: race.PhaseRacing, Racers: []race.Racer{{Progress: 1}, {Progress: 0.4}}}, "Racing — 70%"},
        {race.State{Phase: race.PhaseHostLeft}, "Race ended: host left"},
        {race.State{Phase: race.PhaseFinished}, "Race finished"},
    }
    for _, c := range cases {
        if got := raceSummary(c.s); got != c.want {
            t.Errorf("raceSummary(%+v) = %q, want %q", c.s, got, c.want)
        }
    }
}
```

(Average progress rounds to the nearest whole percent; `70%` above is `(1 + 0.4)/2 = 0.7`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/plugins/... -run TestRaceSummary -v`
Expected: FAIL (function does not exist)

- [ ] **Step 3: Implement `raceSummary(s race.State) string` and the rest of `internal/plugins/race.go`**

`NewRace(selfID, selfName, selfAddr string, port int) *Race`: constructs `race.NewEngine(selfID, selfName, selfAddr, port)`, stores it. Opens nothing (Task 4's `NewEngine` is I/O-free).

`Run(ctx, h)`:
- `h.HandleAction("race.accept", func() { r.eng.Respond(true) })`, `h.HandleAction("race.decline", func() { r.eng.Respond(false) })` — registered once, up front, independent of enabled state (a stale pending invite's Accept/Decline calling `Respond` on a disabled engine is already a no-op per Task 4).
- A `time.Ticker` firing once per second (this is the only polling in the plugin, and it only ever flips a boolean and toggles two long-lived objects, never doing per-tick work otherwise, so it stays well within the resource-limit Global Constraint) drives: compute `want := settings.Enabled("race") && !h.Presenting()` each tick; if `want && !r.eng.Enabled()`, call `r.eng.Enable()` (log and continue on error — e.g. the port is already in use — without retrying every single tick; back off to checking only every 10s after a failure); if `!want && r.eng.Enabled()`, call `r.eng.Disable()`. This means starting to present ends an in-progress race (the other side sees it as the ordinary "host left"/"host disconnected" case already built in Task 4) rather than merely hiding its pill — matching the anti-goal's literal wording ("no outgoing presence advertisement... while presenting") over mid-race continuity, which is the rarer case.
- `r.eng.OnChange(func(s race.State) { ... })`: if `!settings.Enabled("race")` or `h.Presenting()`, call `h.Clear(raceActivityID)` and return (Review Focus / anti-goal: no invite while presenting). Otherwise:
  - `PhaseIdle`: `h.Clear(raceActivityID)`.
  - `PhaseLobby` and not host (i.e. this is an incoming invite the user hasn't responded to): `h.Set(island.Activity{ID: raceActivityID, Priority: island.PriorityAlert, View: island.View{Kind: "race", Title: "Race invite", Subtitle: raceSummary(s), Icon: "input-keyboard-symbolic", Accent: "ok"}})` — no `Click` set, so tapping the pill falls through to `openDash('race')` once `KIND_TABS` is updated in Task 7.
  - `PhaseLobby` and host, or `PhaseRacing`: same `h.Set` call with `Priority: island.PriorityStatus` and `Subtitle: raceSummary(s)` (a live but low-frequency summary, matching the Global Constraint).
  - `PhaseFinished`, `PhaseHostLeft`: `h.Set` with `Priority: island.PriorityNotify`, `TTL: 10 * time.Second`, `Click: "notify.dismiss"`, `Subtitle: raceSummary(s)` (a one-shot notification, consistent with how other plugins report a terminal event — see `plugins/pomodoro.go`'s `alert` helper).
- Block on `select { case <-ctx.Done(): case <-ticker.C: ... }` in a loop until `ctx.Done()`, then `r.eng.Disable()` (idempotent, safe even if already disabled) and return `nil`.

`const raceActivityID = "race"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/plugins/... -run TestRaceSummary -v`
Expected: PASS

- [ ] **Step 5: Write the failing test confirming presenting suppresses the Activity**

Use a minimal in-package fake `island.Host` (fields: a `map[string]island.Activity` for `Set`/`Clear`, a `presenting bool`, no-op `HandleAction`) — write it as an unexported test helper type in `race_test.go` since no existing fake Host is exported from `internal/island` for reuse.

```go
func TestNoActivityWhilePresenting(t *testing.T) {
    t.Setenv("XDG_CONFIG_HOME", t.TempDir())
    h := &fakeHost{presenting: true}
    r := plugins.NewRace("h1", "Host", "127.0.0.1", 48581)
    r.Engine().Enable() // simulate a race already active before presenting started
    defer r.Engine().Disable()
    ctx, cancel := context.WithCancel(context.Background())
    go r.Run(ctx, h)
    defer cancel()
    r.Engine().CreateLobby()
    time.Sleep(200 * time.Millisecond) // give OnChange a moment to fire, if it's going to
    if _, ok := h.acts["race"]; ok {
        t.Fatal("must not set a pill Activity while presenting, even for a race the engine already had running")
    }
}
```

(Reuse the `waitFor` pattern from Task 4's test, redefined locally in this package's test file — these are small enough that sharing a helper package isn't worth the indirection yet.)

- [ ] **Step 6: Run test, adjust the `OnChange` handler from Step 3 until it passes**

Run: `go test ./internal/plugins/... -v`
Expected: PASS

- [ ] **Step 6b: Write the failing test proving `Run` enables/disables the engine as the `race` setting is toggled (Global Constraint: off by default, no network activity until opted in)**

```go
func TestRunTracksRaceSetting(t *testing.T) {
    t.Setenv("XDG_CONFIG_HOME", t.TempDir())
    if _, err := settings.Update([]byte(`{"features":{"race":false}}`)); err != nil {
        t.Fatal(err)
    }
    r := plugins.NewRace("h1", "Host", "127.0.0.1", 48582)
    h := &fakeHost{}
    ctx, cancel := context.WithCancel(context.Background())
    go r.Run(ctx, h)
    defer cancel()

    time.Sleep(1500 * time.Millisecond)
    if r.Engine().Enabled() {
        t.Fatal("must stay disabled while the race feature is off")
    }

    settings.Update([]byte(`{"features":{"race":true}}`))
    waitFor(t, func() bool { return r.Engine().Enabled() })

    settings.Update([]byte(`{"features":{"race":false}}`))
    waitFor(t, func() bool { return !r.Engine().Enabled() })
}
```

(`internal/plugins` is a different package from `internal/settings`, so this test only ever calls `settings`'s exported `Update` — never its unexported `mu`/`cur` — exactly like `usb_test.go`-style tests in this codebase already would. `race` already defaults to enabled per Task 1's `FeatureIDs` change, so the test starts by explicitly turning it off via `Update`, then flips it on and off again to prove `Run` tracks the live setting both ways.)

- [ ] **Step 6c: Run test, fix the implementation until it passes**

Run: `go test ./internal/plugins/... -v`
Expected: PASS

- [ ] **Step 7: Run `make check` and `make test`**

Run: `make check && make test`
Expected: both pass

- [ ] **Step 8: Commit**

```bash
git add internal/plugins/race.go internal/plugins/race_test.go
git commit -m "feat: bridge the race engine into the pill"
```

---

## Task 6: D-Bus surface

**Files:**
- Create: `internal/dbusapi/race.go`
- Modify: `internal/dbusapi/introspect.go`, `internal/dbusapi/service.go`
- Modify: `extension/dynamic-island@adamshannag.github.io/lib/dbus.js`
- Test: relies on the existing `internal/dbusapi/extension_test.go::TestExtensionInterfaceMatchesDaemon`

**Interfaces:**
- Consumes: `plugins.Race.Engine()` (Task 5); `discovery.Peer`/`race.State`/`race.Racer` (Tasks 2 and 4, JSON-marshaled directly as the D-Bus payloads).
- Produces (D-Bus methods, added to both XML files identically):
  - `RacePeers() (peers string, out)` → JSON array of `discovery.Peer`.
  - `RaceState() (state string, out)` → JSON `race.State`.
  - `RaceCreate() *dbus.Error` → `eng.CreateLobby()`, no return value needed (the extension re-reads `RaceState`).
  - `RaceInvite(peerId string) *dbus.Error` → looks up the peer in the latest `discovery.Peers()` by ID (the daemon, not the extension, must resolve ID → address) and calls `eng.Invite(peer)`; error if not found.
  - `RaceRespond(accept bool) *dbus.Error`.
  - `RaceStart() *dbus.Error`.
  - `RaceProgress(typedChars int) *dbus.Error` → `eng.SubmitProgress(int(typedChars))`.
  - `RaceLeave() *dbus.Error`.

- [ ] **Step 1: Add the `Race` field to `Deps`/`api` in `internal/dbusapi/service.go`**

Add `Race *plugins.Race` to the `Deps` struct and a matching `race *plugins.Race` field on `api`, assigned in `newAPI` the same way `a.notes = d.Notes` is. `main.go` (Task 9) always constructs a `plugins.Race` (it's I/O-free, per Task 5) and passes it in, so `a.race` is always non-nil — no fallback construction or nil guard needed here, unlike `notes.Open()`.

- [ ] **Step 2: Implement `internal/dbusapi/race.go`**

```go
package dbusapi

func (a *api) RacePeers() (string, *dbus.Error) {
    if d := a.race.Engine().Discovery(); d != nil {
        return toJSON(d.Peers())
    }
    return toJSON([]discovery.Peer{})
}

func (a *api) RaceState() (string, *dbus.Error) { return toJSON(a.race.Engine().State()) }

func (a *api) RaceCreate() *dbus.Error { a.race.Engine().CreateLobby(); return nil }

func (a *api) RaceInvite(peerId string) *dbus.Error {
    d := a.race.Engine().Discovery()
    if d == nil {
        return dbusErr(errors.New("LAN race is turned off"))
    }
    peer, ok := findPeer(d.Peers(), peerId)
    if !ok {
        return dbusErr(fmt.Errorf("unknown peer %q", peerId))
    }
    return dbusErr(a.race.Engine().Invite(peer))
}

func (a *api) RaceRespond(accept bool) *dbus.Error { return dbusErr(a.race.Engine().Respond(accept)) }

func (a *api) RaceStart() *dbus.Error { return dbusErr(a.race.Engine().Start()) }

func (a *api) RaceProgress(typedChars int32) *dbus.Error { return dbusErr(a.race.Engine().SubmitProgress(int(typedChars))) }

func (a *api) RaceLeave() *dbus.Error { a.race.Engine().Leave(); return nil }
```

(`findPeer(peers []discovery.Peer, id string) (discovery.Peer, bool)` is a small unexported helper this task also adds, a plain linear search.)

- [ ] **Step 3: Add the methods to `internal/dbusapi/introspect.go`**

Insert, following the existing method block's style:

```xml
<method name="RacePeers"><arg name="peers" type="s" direction="out"/></method>
<method name="RaceState"><arg name="state" type="s" direction="out"/></method>
<method name="RaceCreate"/>
<method name="RaceInvite"><arg name="peer_id" type="s" direction="in"/></method>
<method name="RaceRespond"><arg name="accept" type="b" direction="in"/></method>
<method name="RaceStart"/>
<method name="RaceProgress"><arg name="typed_chars" type="i" direction="in"/></method>
<method name="RaceLeave"/>
```

- [ ] **Step 4: Add the identical methods to `lib/dbus.js`'s `INTERFACE_XML`**

Same XML fragment, inserted in the existing `<node><interface>...` block.

- [ ] **Step 5: Run the interface-matching test**

Run: `go test ./internal/dbusapi/... -run TestExtensionInterfaceMatchesDaemon -v`
Expected: PASS

- [ ] **Step 6: Run `make check` and `make test`**

Run: `make check && make test`
Expected: both pass

- [ ] **Step 7: Commit**

```bash
git add internal/dbusapi extension/dynamic-island@adamshannag.github.io/lib/dbus.js
git commit -m "feat: expose the race engine over D-Bus"
```

---

## Task 7: Extension constants and pill click routing

**Files:**
- Modify: `extension/dynamic-island@adamshannag.github.io/lib/constants.js` (`FEATURES`, `TABS`, `SETTING_COLORS`)
- Modify: `extension/dynamic-island@adamshannag.github.io/island.js` (`KIND_TABS`)
- Test: `extension/dynamic-island@adamshannag.github.io/scripts/check.mjs` (run, not modified)

**Interfaces:**
- Consumes: the `"race"` feature/tab ids already registered in `settings.FeatureIDs`/`TabIDs` (Task 1).
- Produces: `FEATURES`/`TABS` entries the Settings page can toggle; `KIND_TABS.race === 'race'` so tapping a race-invite pill (which sets no `Click`, per Task 5) opens straight to the `race` dashboard tab.

Note on "off by default": like every other feature in this codebase (`usb`, `battery`, …), `race` defaults to *enabled* in `settings.Defaults()` — there's no separate "off by default" mechanism anywhere else to extend, and inventing one just for this feature would be inconsistent. The actual no-surprise-network-activity guarantee (the spec's real anti-goal) comes from Task 4/5's `Enable()`/`Disable()` split, not from the settings default — a user turning the `race` toggle off in Settings is what stops mDNS/HTTP, exactly like disabling any other feature already stops its plugin's behavior.

- [ ] **Step 1: Add the `race` entry to `FEATURES`, `race` tab to `TABS`, a colour to `SETTING_COLORS`, and `race: 'race'` to `KIND_TABS`**

In `lib/constants.js`:
```js
// FEATURES, appended:
['race', 'LAN typing race', 'Race other Dynamic Island users on your network', 'input-keyboard-symbolic'],
// TABS, appended:
['race', 'Race', 'input-keyboard-symbolic'],
// SETTING_COLORS, appended:
'input-keyboard-symbolic': '#ff9f0a',
```
In `island.js`: `const KIND_TABS = {agent: 'agents', task: 'activity', service: 'activity', race: 'race'};`

- [ ] **Step 2: Run the extension's static checks**

Run: `cd extension && npm run check`
Expected: `ok: 30 modules, 39 D-Bus methods` (or whatever the new counts are — confirm they increased from the pre-change baseline, since Task 6 added 8 D-Bus methods)

- [ ] **Step 3: Commit**

```bash
git add extension/dynamic-island@adamshannag.github.io/lib/constants.js extension/dynamic-island@adamshannag.github.io/island.js
git commit -m "feat: register the race feature/tab in the extension and route pill clicks to it"
```

---

## Task 8: `pages/race.js` dashboard page

**Files:**
- Create: `extension/dynamic-island@adamshannag.github.io/pages/race.js`
- Modify: `extension/dynamic-island@adamshannag.github.io/pages/index.js`
- Test: `extension/dynamic-island@adamshannag.github.io/scripts/check.mjs` (static check only — this file imports `gi://`-adjacent widgets and cannot run under `node --test`, consistent with every other page in this codebase)

**Interfaces:**
- Consumes: `Page` base class (`build`, `onShow`, `onHide`, `refresh`, `tick`, `this.call`/`this.fetch`/`this.refit`), widgets from `lib/widgets.js` (`column`, `group`, `label`, `pillButton`, `iconButton`, `EmptyState`, `fillList`), D-Bus methods from Task 6 (`RacePeers`, `RaceState`, `RaceCreate`, `RaceInvite`, `RaceRespond`, `RaceStart`, `RaceProgress`, `RaceLeave`).
- Produces: `RacePage` class, registered in `pages/index.js`'s `PAGES`.

- [ ] **Step 1: Implement `RacePage` in `pages/race.js`**

```js
export class RacePage extends Page {
    static id = 'race';
    static title = '';
    static autoHeight = false;
    static interval = 1000;

    build() { ... }
    onShow() { this.refresh(); return null; }
    refresh() { this.fetch('RaceState', [], (state) => this._render(state)); if (<idle>) this.fetch('RacePeers', [], (peers) => this._renderPeers(peers)); }
    tick() { if (<racing and this is a guest typing>) this._maybeSubmitProgress(); }
}
```

Four render states driven by `RaceState().Phase`, each a distinct child actor swapped into one container (mirroring how other multi-state pages like `pages/docker.js` swap an `EmptyState` for a list):
- **Idle**: the peer list (`fillList` over `RacePeers()`'s array, each row a name + a "Race" `pillButton` calling `this.call('RaceCreate')` then immediately `this.call('RaceInvite', [peer.id])` for that one peer — inviting one person starts a lobby the host can then invite more people into from the same idle-peer-list-turned-lobby-view). An `EmptyState` when `RacePeers()` is empty ("No one else found on this network yet").
- **Lobby** (host): the invite list with per-row accepted/pending/declined `badge`s, an "Invite more" control (re-show the peer list filtered to not-yet-invited peers), and a `pillButton` "Start race" calling `this.call('RaceStart')`.
- **Lobby** (guest, i.e. `!IsHost`): "Waiting for the host to start" plus Accept/Decline `pillButton`s calling `this.call('RaceRespond', [true])` / `[false]`.
- **Racing**: a `wrappingLabel` showing `State.Passage`, a `multilineEntry` (or plain `St.Entry` if multiline isn't appropriate for a single passage — use `searchEntry`'s underlying `St.Entry` construction as the simpler reference) capturing what the user types, a progress bar per `Racer` built from `column`/`label` rows showing `Math.round(progress*100)+'%'` and the racer's name, each updated via `setText` in place on every `tick`/`refresh` (not rebuilt, following the "signature-based diffing" rule). On every keystroke (`'text-changed'` on the entry, debounced to the page's 1-second `interval` via the existing `tick()` hook rather than firing a D-Bus call per keystroke) call `this.call('RaceProgress', [typedCharCount])`.
- **Finished / host-left**: a results summary (ranked by `FinishedAtMs`, or the "host left" message) plus a `pillButton` "Done" calling `this.call('RaceLeave')` which returns the page to Idle.

`onHide()`: if currently racing, do **not** call `RaceLeave` (leaving the dashboard open on another tab, or closing it, must not abandon an in-progress race — only the explicit "Done" button or the host-left/finished state should end it).

- [ ] **Step 2: Register the page**

In `pages/index.js`: `import {RacePage} from './race.js';` and append `RacePage` to `PAGES`.

- [ ] **Step 3: Run the extension's static checks**

Run: `cd extension && npm run check`
Expected: passes, with the module count increased by 1 from Task 7's run.

- [ ] **Step 4: Commit**

```bash
git add extension/dynamic-island@adamshannag.github.io/pages/race.js extension/dynamic-island@adamshannag.github.io/pages/index.js
git commit -m "feat: add the Race dashboard page"
```

---

## Task 9: Wire everything into `main.go`

**Files:**
- Modify: `cmd/dynamic-islandd/main.go`

**Interfaces:**
- Consumes: `identity.ID()`, `identity.Name()` (Task 1); `plugins.NewRace` (Task 5); `lobby.DefaultPort` (Task 3); `dbusapi.Deps.Race` (Task 6).

- [ ] **Step 1: Construct the identity and the race plugin in `main.go`, alongside the existing `clip`/`st`/`m`/`ctxw` construction**

```go
peerID, err := identity.ID()
if err != nil {
    log.Printf("peer identity: %v (using a temporary one)", err)
    peerID = identity.Ephemeral()
}
port := lobby.DefaultPort
if v := os.Getenv("ISLAND_RACE_PORT"); v != "" {
    if n, perr := strconv.Atoi(v); perr == nil {
        port = n
    }
}
racePlugin := plugins.NewRace(peerID, identity.Name(), lanAddr(), port)
```

The `ISLAND_RACE_PORT` override exists solely so Task 10 can run two daemons on one real machine during manual verification; it is not user-facing and does not need a flag, a config file entry, or documentation beyond this line.

`plugins.NewRace` is I/O-free (Task 5), so this always succeeds and `racePlugin` is never nil — no fallback/disable path needed here. Add `identity.Ephemeral() string` to Task 1's package (a random id generated the same way as `ID()`'s first-run case, but never written to disk) as the fallback when persisting fails, so a read-only filesystem degrades to "works this session, forgets next time" rather than disabling the feature outright.

Add a small unexported `lanAddr() string` helper in `main.go` (or `internal/discovery`, re-exported, if that reads more naturally once Task 2 exists — the implementer's call) that returns the first non-loopback IPv4 address from `net.InterfaceAddrs()`, or `"127.0.0.1"` if none is found: this is the address `race.Engine.Invite` embeds in the `HostAddr` it sends peers, so it must be the same address `discovery`'s `mdns.NewMDNSService` would resolve to for this host.

- [ ] **Step 2: Pass `racePlugin` into `dbusapi.Deps` and the plugin list**

```go
if err := dbusapi.Serve(dbusapi.Deps{
    Conn: conn, Manager: m, Clipboard: clip, Sites: st, Activity: ctxw,
    Race: racePlugin,
}); err != nil {
    log.Fatal(err)
}
```

and append `racePlugin` to the existing `all := []island.Plugin{...}` slice, unconditionally (same as every other plugin already in that slice) — the existing `off["race"]` / `settings.Enabled("race")` machinery (CLI `-disable` flag and the Settings toggle) is what actually controls whether it does anything, exactly like `usb`/`battery` already work.

- [ ] **Step 3: Build and smoke-test**

Run: `make build`
Expected: builds cleanly

Run: `./bin/dynamic-islandd &` then `gdbus call --session -d io.github.AdamShannag.DynamicIsland -o /io/github/AdamShannag/DynamicIsland -m io.github.AdamShannag.DynamicIsland.RaceState`
Expected: returns `('{"Phase":"idle", ...}',)` or similar, not an error

- [ ] **Step 4: Run the full suite**

Run: `make check && make test`
Expected: both pass

- [ ] **Step 5: Commit**

```bash
git add cmd/dynamic-islandd/main.go
git commit -m "feat: wire the race plugin into the daemon"
```

---

## Task 10: End-to-end verification with two daemons

**Files:** none (manual/scripted verification only; add nothing new unless this step surfaces a bug, in which case fix it in the file it belongs to and fold that fix into this task's commit)

- [ ] **Step 1: Run two daemons locally with distinct XDG dirs and race ports, each with the `race` feature forced on**

```sh
XDG_DATA_HOME=/tmp/race-a/data XDG_CONFIG_HOME=/tmp/race-a/config XDG_CACHE_HOME=/tmp/race-a/cache ./bin/dynamic-islandd &
XDG_DATA_HOME=/tmp/race-b/data XDG_CONFIG_HOME=/tmp/race-b/config XDG_CACHE_HOME=/tmp/race-b/cache ISLAND_RACE_PORT=54373 ./bin/dynamic-islandd &
```

(Daemon B uses `ISLAND_RACE_PORT` — added in Task 9 — since both would otherwise try to bind `lobby.DefaultPort` on this one real machine.)

- [ ] **Step 2: Drive the full flow over D-Bus with `gdbus call` against each daemon's bus, using the method names from Task 6**

Each daemon connects to the session bus under the same name (`io.github.AdamShannag.DynamicIsland`), so run each under its own `dbus-run-session` (same recipe as `CLAUDE.md`'s headless-GNOME-Shell testing section) to get two separate `DBUS_SESSION_BUS_ADDRESS` values to target with `gdbus call --address <addr> ...`.

Sequence: `RacePeers` on daemon A until daemon B's peer ID appears (confirms Task 2's discovery end to end) → `RaceCreate` + `RaceInvite <B's id>` on A → `RaceState` on B shows `Phase: "lobby"` → `RaceRespond true` on B → `RaceState` on A shows B `"accepted"` → `RaceStart` on A → `RaceState` on B shows `Phase: "racing"` and a non-empty `Passage` → `RaceProgress <len(passage)>` on B → `RaceState` on A shows B finished → both reach `Phase: "finished"`.

- [ ] **Step 3: Verify the host-left path**

Repeat through "racing," then kill daemon A's process. Within a few seconds, `RaceState` on B must report `Phase: "host_left"` (Review Focus — confirms Task 4/3's SSE-close detection actually works against a real process death, not just a clean `EndLobby` call).

- [ ] **Step 4: Verify in the real GNOME Shell extension**, using the headless-GNOME-Shell recipe from `CLAUDE.md`'s Testing section, symlinking the extension and enabling the `race` feature via `SetSettings`, then driving clicks/typing through the dashboard's `race` tab as described there (virtual pointer for clicks, and `Clutter`'s virtual keyboard device — `create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE)` — for typing into the passage entry). Confirm: the peer list renders, an invite reaches the other instance's pill as a tappable notification that opens straight to the `race` tab, Accept/Decline work, Start begins the race, typed progress updates the other side's progress bar, and finishing shows a result. Check both shells' logs for `JS ERROR` per the existing gotcha list.

- [ ] **Step 5: Fix anything Steps 1–4 surface**, committing each fix with a message describing the bug, not this verification task.

- [ ] **Step 6: Final full-suite run**

Run: `make check && make test`
Expected: both pass
