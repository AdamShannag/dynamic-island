package race

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
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
	PhaseMissed   Phase = "missed"
)

const defaultRaceTimeout = 3 * time.Minute

func (p Phase) free() bool {
	return p == PhaseIdle || p == PhaseFinished || p == PhaseHostLeft || p == PhaseMissed
}

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

	raceTimeout time.Duration

	mu            sync.Mutex
	state         State
	enabled       bool
	addr          string
	host          bool
	hostAddr      string
	peerAddrs     map[string]string
	unsubscribe   func()
	raceTimer     *time.Timer
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

		raceTimeout: defaultRaceTimeout,
		state:       State{Phase: PhaseIdle},
	}
}

func (e *Engine) Enable() error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.enabled {
		return nil
	}

	addr := e.selfAddr
	if addr == "" {
		addr = discovery.LocalIP()
	}
	disc, err := discovery.Start(e.selfID, e.selfName, addr, e.port)
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

	e.addr = addr
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
	if !e.enabled || !e.state.Phase.free() {
		e.mu.Unlock()
		return ""
	}
	unsub := e.resetLocked()
	id := randomLobbyID()
	e.host = true
	e.peerAddrs = make(map[string]string)
	e.state = State{
		LobbyID: id,
		IsHost:  true,
		Phase:   PhaseLobby,
		Racers: []Racer{
			{PeerID: e.selfID, Name: e.selfName, Status: "accepted"},
		},
	}
	e.server.OpenLobby(id)
	e.mu.Unlock()
	if unsub != nil {
		unsub()
	}
	e.notify()
	return id
}

func (e *Engine) Invite(peer discovery.Peer) error {
	e.mu.Lock()
	if !e.enabled {
		e.mu.Unlock()
		return fmt.Errorf("race: not enabled")
	}
	if !e.host || e.state.Phase != PhaseLobby {
		e.mu.Unlock()
		return fmt.Errorf("race: not hosting a lobby")
	}
	if e.racerIndexLocked(peer.ID) >= 0 {
		e.mu.Unlock()
		return fmt.Errorf("race: %s is already in this lobby", peer.Name)
	}
	e.state.Racers = append(e.state.Racers, Racer{PeerID: peer.ID, Name: peer.Name, Status: "pending"})
	e.peerAddrs[peer.ID] = peer.Addr
	lobbyID := e.state.LobbyID
	hostAddr := net.JoinHostPort(e.addr, strconv.Itoa(e.port))
	e.publishLocked(false)
	e.mu.Unlock()
	e.notify()

	err := lobby.SendInvite(peer.Addr, lobby.Invite{
		LobbyID:  lobbyID,
		Kind:     "race",
		HostID:   e.selfID,
		HostName: e.selfName,
		HostAddr: hostAddr,
	})
	if err != nil {
		e.mu.Lock()
		if e.host && e.state.LobbyID == lobbyID && e.state.Phase == PhaseLobby {
			if i := e.racerIndexLocked(peer.ID); i >= 0 && e.state.Racers[i].Status == "pending" {
				e.removeRacerLocked(i)
				e.publishLocked(false)
			}
		}
		e.mu.Unlock()
		e.notify()
	}
	return err
}

func (e *Engine) handleInvite(inv lobby.Invite) error {
	if inv.Kind != "race" {
		return lobby.ErrRejected
	}
	e.mu.Lock()
	if inv.HostID == e.selfID {
		e.mu.Unlock()
		return lobby.ErrRejected
	}
	if !e.state.Phase.free() {
		e.mu.Unlock()
		go func() {
			_ = lobby.SendRespond(inv.HostAddr, lobby.Response{
				LobbyID: inv.LobbyID, PeerID: e.selfID, PeerName: e.selfName, Accept: false,
			})
		}()
		return nil
	}
	unsub := e.resetLocked()
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
	if unsub != nil {
		unsub()
	}
	e.notify()
	return nil
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
	response := lobby.Response{LobbyID: lobbyID, PeerID: e.selfID, PeerName: e.selfName, Accept: accept}

	if !accept {
		unsub := e.resetLocked()
		e.mu.Unlock()
		if unsub != nil {
			unsub()
		}
		e.notify()
		if err := lobby.SendRespond(hostAddr, response); err != nil && !errors.Is(err, lobby.ErrClosed) {
			return err
		}
		return nil
	}

	if e.unsubscribe != nil {
		e.mu.Unlock()
		return fmt.Errorf("race: already accepted")
	}
	e.unsubscribe = lobby.Subscribe(hostAddr, lobbyID, e.makeOnEvent(lobbyID), e.makeOnClosed(lobbyID))
	e.mu.Unlock()

	err := lobby.SendRespond(hostAddr, response)
	if err == nil {
		return nil
	}
	e.mu.Lock()
	var unsub func()
	if !e.host && e.state.LobbyID == lobbyID && e.state.Phase == PhaseLobby {
		unsub = e.unsubscribe
		e.unsubscribe = nil
		if errors.Is(err, lobby.ErrClosed) {
			e.state.Phase = PhaseMissed
		} else {
			e.state.Phase = PhaseHostLeft
		}
	}
	e.mu.Unlock()
	if unsub != nil {
		unsub()
	}
	e.notify()
	return err
}

func (e *Engine) handleRespond(r lobby.Response) error {
	e.mu.Lock()
	idx := -1
	if e.host && e.state.LobbyID == r.LobbyID {
		idx = e.racerIndexLocked(r.PeerID)
	}
	if idx <= 0 {
		e.mu.Unlock()
		return rejectAccept(r.Accept)
	}
	switch e.state.Phase {
	case PhaseLobby:
		if r.Accept {
			e.state.Racers[idx].Status = "accepted"
			e.peerAddrs[r.PeerID] = lobby.WithHost(e.peerAddrs[r.PeerID], r.RemoteIP)
		} else {
			e.state.Racers[idx].Status = "declined"
		}
		e.publishLocked(false)
	case PhaseRacing:
		if r.Accept {
			e.mu.Unlock()
			return nil
		}
		e.removeRacerLocked(idx)
		e.finishIfDoneLocked()
	default:
		e.mu.Unlock()
		return rejectAccept(r.Accept)
	}
	e.mu.Unlock()
	e.notify()
	return nil
}

func rejectAccept(accept bool) error {
	if accept {
		return lobby.ErrClosed
	}
	return nil
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
	lobbyID := e.state.LobbyID

	racers := make([]Racer, 0, len(e.state.Racers))
	targets := make([]string, 0, len(e.state.Racers))
	for _, r := range e.state.Racers {
		if r.Status != "accepted" {
			delete(e.peerAddrs, r.PeerID)
			continue
		}
		racers = append(racers, r)
		if addr, ok := e.peerAddrs[r.PeerID]; ok && r.PeerID != e.selfID {
			targets = append(targets, addr)
		}
	}
	e.state.Racers = racers
	e.state.Phase = PhaseRacing
	e.state.Passage = passage
	e.raceStartedAt = time.Now()
	e.raceTimer = time.AfterFunc(e.raceTimeout, func() { e.expire(lobbyID) })
	e.mu.Unlock()
	e.notify()

	payload := mustMarshal(passage)
	for _, addr := range targets {
		_ = lobby.SendStart(addr, lobby.Start{LobbyID: lobbyID, Payload: payload})
	}

	e.mu.Lock()
	if e.host && e.state.LobbyID == lobbyID {
		e.publishLocked(false)
	}
	e.mu.Unlock()
	return nil
}

func (e *Engine) expire(lobbyID string) {
	e.mu.Lock()
	if !e.host || e.state.LobbyID != lobbyID || e.state.Phase != PhaseRacing {
		e.mu.Unlock()
		return
	}
	e.endRaceLocked()
	e.mu.Unlock()
	e.notify()
}

func (e *Engine) handleStart(s lobby.Start) error {
	var passage string
	if err := json.Unmarshal(s.Payload, &passage); err != nil || passage == "" {
		return lobby.ErrRejected
	}
	e.mu.Lock()
	if e.host || e.state.LobbyID != s.LobbyID || e.unsubscribe == nil || !lobby.SameHost(e.hostAddr, s.RemoteIP) {
		e.mu.Unlock()
		return lobby.ErrClosed
	}
	if e.state.Phase != PhaseLobby {
		e.mu.Unlock()
		return nil
	}
	e.state.Phase = PhaseRacing
	e.state.Passage = passage
	e.mu.Unlock()
	e.notify()
	return nil
}

func (e *Engine) makeOnEvent(lobbyID string) func(json.RawMessage) {
	return func(payload json.RawMessage) {
		var snap State
		if err := json.Unmarshal(payload, &snap); err != nil || snap.LobbyID != lobbyID {
			return
		}
		e.mu.Lock()
		if e.host || e.state.LobbyID != lobbyID {
			e.mu.Unlock()
			return
		}
		e.state.Racers = cloneRacers(snap.Racers)
		switch {
		case e.state.Phase == PhaseLobby && snap.Phase == PhaseRacing && snap.Passage != "":
			e.state.Phase = PhaseRacing
			e.state.Passage = snap.Passage
		case e.state.Phase == PhaseRacing && snap.Phase == PhaseFinished:
			e.state.Phase = PhaseFinished
		}
		e.mu.Unlock()
		e.notify()
	}
}

func (e *Engine) makeOnClosed(lobbyID string) func(error) {
	return func(error) {
		e.mu.Lock()
		if e.host || e.state.LobbyID != lobbyID {
			e.mu.Unlock()
			return
		}
		e.unsubscribe = nil
		switch {
		case e.state.Phase == PhaseRacing && allRacersFinished(e.state.Racers):
			e.state.Phase = PhaseFinished
		case e.state.Phase == PhaseLobby || e.state.Phase == PhaseRacing:
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
		e.applyProgress(lobbyID, selfID, typedChars)
		return nil
	}
	return lobby.SendProgress(hostAddr, lobby.Progress{
		LobbyID: lobbyID,
		PeerID:  selfID,
		Payload: mustMarshal(progressPayload{TypedChars: typedChars}),
	})
}

func (e *Engine) handleProgress(p lobby.Progress) error {
	var payload progressPayload
	if err := json.Unmarshal(p.Payload, &payload); err != nil {
		return lobby.ErrRejected
	}
	e.mu.Lock()
	known := lobby.SameHost(e.peerAddrs[p.PeerID], p.RemoteIP)
	e.mu.Unlock()
	if !known || !e.applyProgress(p.LobbyID, p.PeerID, payload.TypedChars) {
		return lobby.ErrClosed
	}
	return nil
}

func (e *Engine) applyProgress(lobbyID, peerID string, typedChars int) bool {
	e.mu.Lock()
	idx := -1
	if e.host && e.state.LobbyID == lobbyID && e.state.Phase == PhaseRacing {
		idx = e.racerIndexLocked(peerID)
	}
	if idx == -1 || len(e.state.Passage) == 0 {
		e.mu.Unlock()
		return false
	}

	progress := clamp(float64(typedChars)/float64(len(e.state.Passage)), 0, 1)
	e.state.Racers[idx].Progress = progress
	if progress >= 1 && e.state.Racers[idx].FinishedAtMs == 0 {
		e.state.Racers[idx].FinishedAtMs = time.Now().UnixMilli()
		if minutes := time.Since(e.raceStartedAt).Minutes(); minutes > 0 {
			e.state.Racers[idx].WPM = (float64(typedChars) / 5) / minutes
		}
	}
	e.finishIfDoneLocked()
	e.mu.Unlock()
	e.notify()
	return true
}

func (e *Engine) finishIfDoneLocked() {
	if allRacersFinished(e.state.Racers) {
		e.endRaceLocked()
		return
	}
	e.publishLocked(false)
}

func (e *Engine) endRaceLocked() {
	e.state.Phase = PhaseFinished
	if e.raceTimer != nil {
		e.raceTimer.Stop()
		e.raceTimer = nil
	}
	e.publishLocked(true)
}

func (e *Engine) publishLocked(end bool) {
	if !e.host || e.server == nil {
		return
	}
	payload, err := json.Marshal(e.state)
	if err != nil {
		return
	}
	if end {
		e.server.EndLobby(e.state.LobbyID, payload)
		return
	}
	e.server.Broadcast(e.state.LobbyID, payload)
}

func (e *Engine) Leave() {
	e.mu.Lock()
	if e.state.Phase == PhaseIdle {
		e.mu.Unlock()
		return
	}
	tellHost := !e.host && (e.state.Phase == PhaseLobby || e.state.Phase == PhaseRacing)
	response := lobby.Response{LobbyID: e.state.LobbyID, PeerID: e.selfID, PeerName: e.selfName}
	hostAddr := e.hostAddr
	if e.host && e.server != nil && (e.state.Phase == PhaseLobby || e.state.Phase == PhaseRacing) {
		e.server.EndLobby(e.state.LobbyID, json.RawMessage(`{}`))
	}
	unsub := e.resetLocked()
	e.mu.Unlock()

	if unsub != nil {
		unsub()
	}
	if tellHost {
		go func() { _ = lobby.SendRespond(hostAddr, response) }()
	}
	e.notify()
}

func (e *Engine) resetLocked() func() {
	unsub := e.unsubscribe
	e.unsubscribe = nil
	if e.raceTimer != nil {
		e.raceTimer.Stop()
		e.raceTimer = nil
	}
	e.host = false
	e.hostAddr = ""
	e.peerAddrs = nil
	e.state = State{Phase: PhaseIdle}
	return unsub
}

func (e *Engine) racerIndexLocked(peerID string) int {
	for i, r := range e.state.Racers {
		if r.PeerID == peerID {
			return i
		}
	}
	return -1
}

func (e *Engine) removeRacerLocked(i int) {
	delete(e.peerAddrs, e.state.Racers[i].PeerID)
	e.state.Racers = append(e.state.Racers[:i:i], e.state.Racers[i+1:]...)
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
