package race

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/discovery"
	"github.com/AdamShannag/dynamic-island/internal/lobby"
)

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
	Status       string  `json:"status"`
	Progress     float64 `json:"progress"`
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

type progressPayload struct {
	TypedChars int `json:"typedChars"`
}

type Engine struct {
	selfID   string
	selfName string
	selfAddr string
	port     int

	mu            sync.Mutex
	state         State
	enabled       bool
	host          bool
	hostAddr      string
	peerAddrs     map[string]string
	unsubscribe   func()
	raceStartedAt time.Time
	onChange      func(State)

	disc   *discovery.Discovery
	server *lobby.Server

	notifyMu    sync.Mutex
	notifying   bool
	notifyQueue []State
}

func NewEngine(selfID, selfName, selfAddr string, port int) *Engine {
	return &Engine{
		selfID:   selfID,
		selfName: selfName,
		selfAddr: selfAddr,
		port:     port,
		state:    State{Phase: PhaseIdle},
	}
}

func (e *Engine) Enable() error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.enabled {
		return nil
	}

	disc, err := discovery.Start(e.selfID, e.selfName, e.port)
	if err != nil {
		return err
	}

	server := lobby.NewServer(e.port, lobby.Callbacks{
		OnInvite:   e.handleInvite,
		OnRespond:  e.handleRespond,
		OnStart:    e.handleStart,
		OnProgress: e.handleProgress,
	})
	go server.ListenAndServe()
	if !waitListening(e.port, 2*time.Second) {
		_ = disc.Close()
		_ = server.Close()
		return fmt.Errorf("race: lobby server did not start listening on port %d", e.port)
	}

	e.disc = disc
	e.server = server
	e.enabled = true
	return nil
}

func (e *Engine) Disable() {
	e.mu.Lock()
	if !e.enabled {
		e.mu.Unlock()
		return
	}
	e.mu.Unlock()

	e.Leave()

	e.mu.Lock()
	disc := e.disc
	server := e.server
	e.disc = nil
	e.server = nil
	e.enabled = false
	e.mu.Unlock()

	if disc != nil {
		_ = disc.Close()
	}
	if server != nil {
		_ = server.Close()
	}

	e.notify()
}

func (e *Engine) Enabled() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.enabled
}

func (e *Engine) Discovery() *discovery.Discovery {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.disc
}

func (e *Engine) OnChange(fn func(State)) {
	e.mu.Lock()
	e.onChange = fn
	e.mu.Unlock()
}

func (e *Engine) State() State {
	e.mu.Lock()
	defer e.mu.Unlock()
	return cloneState(e.state)
}

// notify delivers the current State to the registered OnChange callback.
//
// Callbacks must never run concurrently (two goroutines calling the same
// user callback at once is a data race on whatever the callback touches)
// and must never deadlock on reentrancy (a callback that calls back into
// the Engine, e.g. Leave(), triggers another notify() from the same
// goroutine before the first call has returned).
//
// To satisfy both, notify() is a single-flight queue: the first caller to
// find nothing in progress becomes the sole "notifier" for as long as there
// is work queued, invoking fn with no lock held; every other caller -
// whether a genuinely concurrent goroutine or the same goroutine calling
// back in reentrantly - just appends its snapshot and returns immediately,
// to be delivered by the in-progress notifier's next loop iteration.
func (e *Engine) notify() {
	e.mu.Lock()
	fn := e.onChange
	snap := cloneState(e.state)
	e.mu.Unlock()
	if fn == nil {
		return
	}

	e.notifyMu.Lock()
	if e.notifying {
		e.notifyQueue = append(e.notifyQueue, snap)
		e.notifyMu.Unlock()
		return
	}
	e.notifying = true
	e.notifyMu.Unlock()

	for {
		fn(snap)

		e.notifyMu.Lock()
		if len(e.notifyQueue) == 0 {
			e.notifying = false
			e.notifyMu.Unlock()
			return
		}
		snap = e.notifyQueue[0]
		e.notifyQueue = e.notifyQueue[1:]
		e.notifyMu.Unlock()
	}
}

func (e *Engine) CreateLobby() string {
	e.mu.Lock()
	if !e.enabled {
		e.mu.Unlock()
		return ""
	}
	id := randomLobbyID()
	e.host = true
	e.hostAddr = ""
	e.peerAddrs = make(map[string]string)
	e.state = State{
		LobbyID: id,
		IsHost:  true,
		Phase:   PhaseLobby,
		Racers: []Racer{
			{PeerID: e.selfID, Name: e.selfName, Status: "accepted"},
		},
	}
	e.mu.Unlock()
	e.notify()
	return id
}

func (e *Engine) Invite(peer discovery.Peer) error {
	e.mu.Lock()
	if !e.enabled {
		e.mu.Unlock()
		return fmt.Errorf("race: not enabled")
	}
	if !e.host {
		e.mu.Unlock()
		return fmt.Errorf("race: not hosting a lobby")
	}
	e.state.Racers = append(e.state.Racers, Racer{PeerID: peer.ID, Name: peer.Name, Status: "pending"})
	if e.peerAddrs == nil {
		e.peerAddrs = make(map[string]string)
	}
	e.peerAddrs[peer.ID] = peer.Addr
	lobbyID := e.state.LobbyID
	e.mu.Unlock()
	e.notify()

	return lobby.SendInvite(peer.Addr, lobby.Invite{
		LobbyID:  lobbyID,
		Kind:     "race",
		HostID:   e.selfID,
		HostName: e.selfName,
		HostAddr: fmt.Sprintf("%s:%d", e.selfAddr, e.port),
	})
}

func (e *Engine) handleInvite(inv lobby.Invite) {
	e.mu.Lock()
	if e.state.Phase != PhaseIdle {
		e.mu.Unlock()
		_ = lobby.SendRespond(inv.HostAddr, lobby.Response{
			LobbyID: inv.LobbyID, PeerID: e.selfID, PeerName: e.selfName, Accept: false,
		})
		return
	}
	e.host = false
	e.hostAddr = inv.HostAddr
	e.state = State{
		LobbyID: inv.LobbyID,
		IsHost:  false,
		Phase:   PhaseLobby,
		Racers: []Racer{
			{PeerID: inv.HostID, Name: inv.HostName, Status: "accepted"},
		},
	}
	e.mu.Unlock()
	e.notify()
}

func (e *Engine) Respond(accept bool) error {
	e.mu.Lock()
	if !e.enabled {
		e.mu.Unlock()
		return fmt.Errorf("race: not enabled")
	}
	if e.host || e.state.Phase != PhaseLobby {
		e.mu.Unlock()
		return fmt.Errorf("race: no pending invite to respond to")
	}
	lobbyID := e.state.LobbyID
	hostAddr := e.hostAddr
	if !accept {
		e.state = State{Phase: PhaseIdle}
	}
	e.mu.Unlock()
	if !accept {
		e.notify()
	}
	return lobby.SendRespond(hostAddr, lobby.Response{
		LobbyID: lobbyID, PeerID: e.selfID, PeerName: e.selfName, Accept: accept,
	})
}

func (e *Engine) handleRespond(r lobby.Response) {
	e.mu.Lock()
	if e.state.LobbyID != r.LobbyID {
		e.mu.Unlock()
		return
	}
	for i := range e.state.Racers {
		if e.state.Racers[i].PeerID == r.PeerID {
			if r.Accept {
				e.state.Racers[i].Status = "accepted"
			} else {
				e.state.Racers[i].Status = "declined"
			}
			break
		}
	}
	e.mu.Unlock()
	e.notify()
}

func (e *Engine) Start() error {
	e.mu.Lock()
	if !e.enabled {
		e.mu.Unlock()
		return fmt.Errorf("race: not enabled")
	}
	if !e.host || e.state.Phase != PhaseLobby {
		e.mu.Unlock()
		return fmt.Errorf("race: cannot start a race now")
	}
	passage := randomPassage()
	e.state.Phase = PhaseRacing
	e.state.Passage = passage
	e.raceStartedAt = time.Now()
	lobbyID := e.state.LobbyID

	type target struct{ addr string }
	targets := make([]target, 0, len(e.state.Racers))
	for _, r := range e.state.Racers {
		if r.PeerID == e.selfID || r.Status != "accepted" {
			continue
		}
		if addr, ok := e.peerAddrs[r.PeerID]; ok {
			targets = append(targets, target{addr})
		}
	}
	e.mu.Unlock()
	e.notify()

	payload := mustMarshal(passage)
	for _, t := range targets {
		_ = lobby.SendStart(t.addr, lobby.Start{LobbyID: lobbyID, Payload: payload})
	}
	return nil
}

func (e *Engine) handleStart(s lobby.Start) {
	e.mu.Lock()
	if e.state.LobbyID != s.LobbyID {
		e.mu.Unlock()
		return
	}
	var passage string
	if err := json.Unmarshal(s.Payload, &passage); err != nil {
		e.mu.Unlock()
		return
	}
	e.state.Phase = PhaseRacing
	e.state.Passage = passage
	hostAddr := e.hostAddr
	lobbyID := e.state.LobbyID
	e.mu.Unlock()
	e.notify()

	cancel := lobby.Subscribe(hostAddr, lobbyID, e.makeOnEvent(lobbyID), e.makeOnClosed(lobbyID))

	e.mu.Lock()
	e.unsubscribe = cancel
	e.mu.Unlock()
}

func (e *Engine) makeOnEvent(lobbyID string) func(json.RawMessage) {
	return func(payload json.RawMessage) {
		var snap State
		if err := json.Unmarshal(payload, &snap); err != nil {
			return
		}
		e.mu.Lock()
		if e.state.LobbyID != lobbyID {
			e.mu.Unlock()
			return
		}
		e.state.Racers = cloneRacers(snap.Racers)
		e.mu.Unlock()
		e.notify()
	}
}

func (e *Engine) makeOnClosed(lobbyID string) func(error) {
	return func(error) {
		e.mu.Lock()
		if e.state.LobbyID != lobbyID {
			e.mu.Unlock()
			return
		}
		if allRacersFinished(e.state.Racers) {
			e.state.Phase = PhaseFinished
		} else {
			e.state.Phase = PhaseHostLeft
		}
		e.mu.Unlock()
		e.notify()
	}
}

func (e *Engine) SubmitProgress(typedChars int) error {
	e.mu.Lock()
	if !e.enabled {
		e.mu.Unlock()
		return fmt.Errorf("race: not enabled")
	}
	if e.state.Phase != PhaseRacing {
		e.mu.Unlock()
		return fmt.Errorf("race: not racing")
	}
	host := e.host
	selfID := e.selfID
	hostAddr := e.hostAddr
	lobbyID := e.state.LobbyID
	e.mu.Unlock()

	if host {
		e.applyProgress(selfID, typedChars)
		return nil
	}
	return lobby.SendProgress(hostAddr, lobby.Progress{
		LobbyID: lobbyID,
		PeerID:  selfID,
		Payload: mustMarshal(progressPayload{TypedChars: typedChars}),
	})
}

func (e *Engine) handleProgress(p lobby.Progress) {
	e.mu.Lock()
	if !e.host || e.state.LobbyID != p.LobbyID {
		e.mu.Unlock()
		return
	}
	e.mu.Unlock()

	var payload progressPayload
	if err := json.Unmarshal(p.Payload, &payload); err != nil {
		return
	}
	e.applyProgress(p.PeerID, payload.TypedChars)
}

func (e *Engine) applyProgress(peerID string, typedChars int) {
	e.mu.Lock()
	idx := -1
	for i, r := range e.state.Racers {
		if r.PeerID == peerID {
			idx = i
			break
		}
	}
	if idx == -1 || len(e.state.Passage) == 0 {
		e.mu.Unlock()
		return
	}

	progress := clamp(float64(typedChars)/float64(len(e.state.Passage)), 0, 1)
	e.state.Racers[idx].Progress = progress
	if progress >= 1 && e.state.Racers[idx].FinishedAtMs == 0 {
		e.state.Racers[idx].FinishedAtMs = time.Now().UnixMilli()
		if minutes := time.Since(e.raceStartedAt).Minutes(); minutes > 0 {
			e.state.Racers[idx].WPM = (float64(typedChars) / 5) / minutes
		}
	}

	allFinished := allRacersFinished(e.state.Racers)
	if allFinished {
		e.state.Phase = PhaseFinished
	}

	snap := cloneState(e.state)
	lobbyID := e.state.LobbyID
	server := e.server
	e.mu.Unlock()

	e.notify()

	if server == nil {
		return
	}
	if payload, err := json.Marshal(snap); err == nil {
		server.Broadcast(lobbyID, payload)
		if allFinished {
			server.EndLobby(lobbyID, payload)
		}
	}
}

func (e *Engine) Leave() {
	e.mu.Lock()
	if e.state.Phase == PhaseIdle {
		e.mu.Unlock()
		return
	}
	unsub := e.unsubscribe
	e.unsubscribe = nil
	wasHost := e.host
	lobbyID := e.state.LobbyID
	server := e.server
	e.host = false
	e.hostAddr = ""
	e.peerAddrs = nil
	e.state = State{Phase: PhaseIdle}
	e.mu.Unlock()

	if unsub != nil {
		unsub()
	}
	if wasHost && server != nil {
		server.EndLobby(lobbyID, json.RawMessage(`{}`))
	}
	e.notify()
}

func waitListening(port int, timeout time.Duration) bool {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 50*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return false
}

func randomLobbyID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func mustMarshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func allRacersFinished(racers []Racer) bool {
	if len(racers) == 0 {
		return false
	}
	for _, r := range racers {
		if r.FinishedAtMs == 0 {
			return false
		}
	}
	return true
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func cloneState(s State) State {
	s.Racers = cloneRacers(s.Racers)
	return s
}

func cloneRacers(in []Racer) []Racer {
	out := make([]Racer, len(in))
	copy(out, in)
	return out
}
