// Package party owns the lobby phase shared by every LAN multiplayer game:
// one discovery+lobby listener, one invite/accept flow, one roster. Once the
// host picks a mode and starts, it hands the roster and the shared transport
// to that mode's engine (race or draw) and gets out of the way until the
// game ends or someone leaves.
package party

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"

	"github.com/AdamShannag/dynamic-island/internal/discovery"
	"github.com/AdamShannag/dynamic-island/internal/draw"
	"github.com/AdamShannag/dynamic-island/internal/lobby"
	"github.com/AdamShannag/dynamic-island/internal/race"
	"github.com/AdamShannag/dynamic-island/internal/snake"
)

type Phase string

const (
	PhaseIdle     Phase = "idle"
	PhaseLobby    Phase = "lobby"
	PhasePlaying  Phase = "playing"
	PhaseFinished Phase = "finished"
	PhaseHostLeft Phase = "host_left"
	PhaseMissed   Phase = "missed"
)

func (p Phase) free() bool {
	return p == PhaseIdle || p == PhaseFinished || p == PhaseHostLeft || p == PhaseMissed
}

type Mode string

const (
	ModeNone  Mode = ""
	ModeRace  Mode = "race"
	ModeDraw  Mode = "draw"
	ModeSnake Mode = "snake"
)

type Player struct {
	PeerID string `json:"peerId"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

const (
	DefaultRounds = 3
	MinRounds     = 1
	MaxRounds     = 10
)

type State struct {
	LobbyID string   `json:"lobbyId"`
	IsHost  bool     `json:"isHost"`
	Phase   Phase    `json:"phase"`
	Mode    Mode     `json:"mode"`
	Rounds  int      `json:"rounds"`
	Players []Player `json:"players"`
	SelfID  string   `json:"selfId"`

	Race  *race.State  `json:"race,omitempty"`
	Draw  *draw.State  `json:"draw,omitempty"`
	Snake *snake.State `json:"snake,omitempty"`
}

func clampRounds(rounds int) int {
	switch {
	case rounds < MinRounds:
		return MinRounds
	case rounds > MaxRounds:
		return MaxRounds
	default:
		return rounds
	}
}

type broadcastEnvelope struct {
	Source  string          `json:"source"`
	Payload json.RawMessage `json:"payload"`
}

type startEnvelope struct {
	Mode    string          `json:"mode"`
	Payload json.RawMessage `json:"payload"`
}

type Engine struct {
	selfID   string
	selfName string
	selfAddr string
	port     int

	mu          sync.Mutex
	state       State
	enabled     bool
	addr        string
	host        bool
	hostAddr    string
	peerAddrs   map[string]string
	unsubscribe func()
	onChange    func(State)

	raceEng  *race.Engine
	drawEng  *draw.Engine
	snakeEng *snake.Engine

	disc   *discovery.Discovery
	server *lobby.Server

	notifyMu      sync.Mutex
	notifying     bool
	notifyPending bool
}

func NewEngine(selfID, selfName, selfAddr string, port int) *Engine {
	e := &Engine{
		selfID:   selfID,
		selfName: selfName,
		selfAddr: selfAddr,
		port:     port,
		state:    State{Phase: PhaseIdle},
		raceEng:  race.NewEngine(selfID, selfName),
		drawEng:  draw.NewEngine(selfID, selfName),
		snakeEng: snake.NewEngine(selfID, selfName),
	}
	e.raceEng.OnChange(func(s race.State) {
		e.mu.Lock()
		if e.state.Mode == ModeRace && e.state.Phase == PhasePlaying && s.Phase == race.PhaseFinished {
			e.state.Phase = PhaseFinished
		}
		e.mu.Unlock()
		e.notify()
	})
	e.drawEng.OnChange(func(s draw.State) {
		e.mu.Lock()
		if e.state.Mode == ModeDraw && e.state.Phase == PhasePlaying && s.Phase == draw.PhaseFinished {
			e.state.Phase = PhaseFinished
		}
		e.mu.Unlock()
		e.notify()
	})
	e.snakeEng.OnChange(func(s snake.State) {
		e.mu.Lock()
		if e.state.Mode == ModeSnake && e.state.Phase == PhasePlaying && s.Phase == snake.PhaseFinished {
			e.state.Phase = PhaseFinished
		}
		e.mu.Unlock()
		e.notify()
	})
	return e
}

func (e *Engine) RaceEngine() *race.Engine   { return e.raceEng }
func (e *Engine) DrawEngine() *draw.Engine   { return e.drawEng }
func (e *Engine) SnakeEngine() *snake.Engine { return e.snakeEng }

// SnakeInput submits the local player's own desired heading for the active
// snake match, routed through HandleInput's host/guest logic.
func (e *Engine) SnakeInput(heading float64) error {
	e.mu.Lock()
	selfID := e.selfID
	e.mu.Unlock()
	return e.snakeEng.HandleInput(selfID, heading)
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
	server := lobby.NewServer(e.port, lobby.Callbacks{
		OnInvite:   e.handleInvite,
		OnRespond:  e.handleRespond,
		OnStart:    e.handleStart,
		OnProgress: e.handleProgress,
	})
	if err := server.Listen(); err != nil {
		return fmt.Errorf("party: %w", err)
	}
	disc, err := discovery.Start(e.selfID, e.selfName, addr, e.port)
	if err != nil {
		_ = server.Close()
		return err
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

// State snapshots party's own fields and then, outside party's lock,
// attaches the active mode's gameplay state. Each sub-engine guards its own
// state with its own mutex, and that mutex is also taken while the
// sub-engine calls back into party (to publish over the shared lobby); if
// party's own lock were still held here across that call, a sub-engine's
// own tick loop publishing state could deadlock against this lookup.
func (e *Engine) State() State {
	e.mu.Lock()
	s := e.snapshotLocked()
	e.mu.Unlock()
	return e.attachModeState(s)
}

func (e *Engine) snapshotLocked() State {
	s := cloneState(e.state)
	s.SelfID = e.selfID
	return s
}

func (e *Engine) attachModeState(s State) State {
	switch s.Mode {
	case ModeRace:
		rs := e.raceEng.State()
		s.Race = &rs
	case ModeDraw:
		ds := e.drawEng.State()
		s.Draw = &ds
	case ModeSnake:
		ss := e.snakeEng.State()
		s.Snake = &ss
	}
	return s
}

func (e *Engine) notify() {
	e.notifyMu.Lock()
	if e.notifying {
		e.notifyPending = true
		e.notifyMu.Unlock()
		return
	}
	e.notifying = true
	e.notifyMu.Unlock()

	for {
		e.mu.Lock()
		fn := e.onChange
		snap := e.snapshotLocked()
		e.mu.Unlock()
		snap = e.attachModeState(snap)
		if fn != nil {
			fn(snap)
		}

		e.notifyMu.Lock()
		if !e.notifyPending {
			e.notifying = false
			e.notifyMu.Unlock()
			return
		}
		e.notifyPending = false
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
		Mode:    ModeRace,
		Rounds:  DefaultRounds,
		Players: []Player{
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
		return fmt.Errorf("party: not enabled")
	}
	if !e.host || e.state.Phase != PhaseLobby {
		e.mu.Unlock()
		return fmt.Errorf("party: not hosting a lobby")
	}
	if e.playerIndexLocked(peer.ID) >= 0 {
		e.mu.Unlock()
		return fmt.Errorf("party: %s is already in this lobby", peer.Name)
	}
	e.state.Players = append(e.state.Players, Player{PeerID: peer.ID, Name: peer.Name, Status: "pending"})
	e.peerAddrs[peer.ID] = peer.Addr
	lobbyID := e.state.LobbyID
	hostAddr := net.JoinHostPort(e.addr, strconv.Itoa(e.port))
	e.publishLobbyLocked()
	e.mu.Unlock()
	e.notify()

	err := lobby.SendInvite(peer.Addr, lobby.Invite{
		LobbyID:  lobbyID,
		Kind:     "party",
		HostID:   e.selfID,
		HostName: e.selfName,
		HostAddr: hostAddr,
	})
	if err != nil {
		e.mu.Lock()
		if e.host && e.state.LobbyID == lobbyID && e.state.Phase == PhaseLobby {
			if i := e.playerIndexLocked(peer.ID); i >= 0 && e.state.Players[i].Status == "pending" {
				e.removePlayerLocked(i)
				e.publishLobbyLocked()
			}
		}
		e.mu.Unlock()
		e.notify()
	}
	return err
}

func (e *Engine) handleInvite(inv lobby.Invite) error {
	if inv.Kind != "party" {
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
		Players: []Player{
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
		return fmt.Errorf("party: not enabled")
	}
	if e.host || e.state.Phase != PhaseLobby {
		e.mu.Unlock()
		return fmt.Errorf("party: no pending invite to respond to")
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
		return fmt.Errorf("party: already accepted")
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
	phase := e.state.Phase
	isHost := e.host
	lobbyID := e.state.LobbyID
	mode := e.state.Mode
	if phase == PhaseLobby {
		idx := -1
		if isHost && lobbyID == r.LobbyID {
			idx = e.playerIndexLocked(r.PeerID)
		}
		if idx <= 0 {
			e.mu.Unlock()
			return rejectAccept(r.Accept)
		}
		if r.Accept {
			e.state.Players[idx].Status = "accepted"
			e.peerAddrs[r.PeerID] = lobby.WithHost(e.peerAddrs[r.PeerID], r.RemoteIP)
		} else {
			e.state.Players[idx].Status = "declined"
		}
		e.publishLobbyLocked()
		e.mu.Unlock()
		e.notify()
		return nil
	}
	e.mu.Unlock()
	if phase != PhasePlaying || !isHost || lobbyID != r.LobbyID {
		return rejectAccept(r.Accept)
	}
	switch mode {
	case ModeRace:
		return e.raceEng.HandleRespond(r)
	case ModeDraw:
		return e.drawEng.HandleRespond(r)
	default:
		return rejectAccept(r.Accept)
	}
}

func rejectAccept(accept bool) error {
	if accept {
		return lobby.ErrClosed
	}
	return nil
}

// SetMode lets the host pick which game this lobby will play, before Start.
func (e *Engine) SetMode(mode Mode) error {
	e.mu.Lock()
	if !e.host || e.state.Phase != PhaseLobby {
		e.mu.Unlock()
		return fmt.Errorf("party: not hosting a lobby")
	}
	if mode != ModeRace && mode != ModeDraw && mode != ModeSnake {
		e.mu.Unlock()
		return fmt.Errorf("party: unknown mode %q", mode)
	}
	e.state.Mode = mode
	e.publishLobbyLocked()
	e.mu.Unlock()
	e.notify()
	return nil
}

// SetRounds lets the host configure how many rounds draw plays, before
// Start. Out-of-range values are clamped rather than rejected.
func (e *Engine) SetRounds(rounds int) error {
	e.mu.Lock()
	if !e.host || e.state.Phase != PhaseLobby {
		e.mu.Unlock()
		return fmt.Errorf("party: not hosting a lobby")
	}
	e.state.Rounds = clampRounds(rounds)
	e.publishLobbyLocked()
	e.mu.Unlock()
	e.notify()
	return nil
}

func (e *Engine) Start() error {
	e.mu.Lock()
	if !e.enabled {
		e.mu.Unlock()
		return fmt.Errorf("party: not enabled")
	}
	if !e.host || e.state.Phase != PhaseLobby {
		e.mu.Unlock()
		return fmt.Errorf("party: cannot start now")
	}
	mode := e.state.Mode
	if mode != ModeRace && mode != ModeDraw && mode != ModeSnake {
		e.mu.Unlock()
		return fmt.Errorf("party: pick a game before starting")
	}
	rounds := e.state.Rounds
	lobbyID := e.state.LobbyID
	accepted := make([]Player, 0, len(e.state.Players))
	peerAddrs := make(map[string]string, len(e.peerAddrs))
	for _, p := range e.state.Players {
		if p.Status != "accepted" {
			continue
		}
		accepted = append(accepted, p)
		if addr, ok := e.peerAddrs[p.PeerID]; ok {
			peerAddrs[p.PeerID] = addr
		}
	}
	publish := e.makePublisher(mode)
	sendStart := e.makeSender(mode)
	e.mu.Unlock()

	var err error
	switch mode {
	case ModeRace:
		racers := make([]race.Racer, len(accepted))
		for i, p := range accepted {
			racers[i] = race.Racer{PeerID: p.PeerID, Name: p.Name, Status: "accepted"}
		}
		err = e.raceEng.BeginHost(lobbyID, racers, peerAddrs, publish, sendStart)
	case ModeDraw:
		players := make([]draw.Player, len(accepted))
		for i, p := range accepted {
			players[i] = draw.Player{PeerID: p.PeerID, Name: p.Name, Status: "accepted"}
		}
		err = e.drawEng.BeginHost(lobbyID, players, peerAddrs, rounds, publish, sendStart)
	case ModeSnake:
		players := make([]snake.Player, len(accepted))
		for i, p := range accepted {
			players[i] = snake.Player{PeerID: p.PeerID, Name: p.Name}
		}
		err = e.snakeEng.BeginHost(lobbyID, players, peerAddrs, publish, sendStart)
	}
	if err != nil {
		return err
	}

	e.mu.Lock()
	if e.state.LobbyID == lobbyID {
		e.state.Phase = PhasePlaying
		e.host = true
	}
	e.mu.Unlock()
	e.notify()
	return nil
}

func (e *Engine) makePublisher(mode Mode) func(disband bool, lobbyID string, payload json.RawMessage) {
	return func(disband bool, lobbyID string, payload json.RawMessage) {
		e.mu.Lock()
		server := e.server
		e.mu.Unlock()
		if server == nil {
			return
		}
		b := mustMarshal(broadcastEnvelope{Source: string(mode), Payload: payload})
		if disband {
			server.EndLobby(lobbyID, b)
			return
		}
		server.Broadcast(lobbyID, b)
	}
}

func (e *Engine) makeSender(mode Mode) func(addr, lobbyID string, payload json.RawMessage) error {
	return func(addr, lobbyID string, payload json.RawMessage) error {
		env := startEnvelope{Mode: string(mode), Payload: payload}
		return lobby.SendStart(addr, lobby.Start{LobbyID: lobbyID, Payload: mustMarshal(env)})
	}
}

func (e *Engine) handleStart(s lobby.Start) error {
	var env startEnvelope
	if err := json.Unmarshal(s.Payload, &env); err != nil {
		return lobby.ErrRejected
	}
	e.mu.Lock()
	if e.host || e.state.LobbyID != s.LobbyID || e.unsubscribe == nil || !lobby.SameHost(e.hostAddr, s.RemoteIP) {
		e.mu.Unlock()
		return lobby.ErrClosed
	}
	phase := e.state.Phase
	mode := Mode(env.Mode)
	e.mu.Unlock()

	switch phase {
	case PhaseLobby:
		if mode != ModeRace && mode != ModeDraw && mode != ModeSnake {
			return lobby.ErrRejected
		}
		var err error
		switch mode {
		case ModeRace:
			err = e.raceEng.BeginGuest(s.LobbyID, e.hostAddr, env.Payload)
		case ModeDraw:
			err = e.drawEng.BeginGuest(s.LobbyID, e.hostAddr, env.Payload)
		case ModeSnake:
			err = e.snakeEng.BeginGuest(s.LobbyID, e.hostAddr, env.Payload)
		}
		if err != nil {
			return err
		}
		e.mu.Lock()
		if e.state.LobbyID == s.LobbyID {
			e.state.Mode = mode
			e.state.Phase = PhasePlaying
		}
		e.mu.Unlock()
		e.notify()
		return nil
	case PhasePlaying:
		e.mu.Lock()
		activeMode := e.state.Mode
		e.mu.Unlock()
		switch activeMode {
		case ModeRace:
			return e.raceEng.HandleStart(env.Payload)
		case ModeDraw:
			return e.drawEng.HandleStart(env.Payload)
		case ModeSnake:
			return e.snakeEng.HandleStart(env.Payload)
		}
		return nil
	default:
		return nil
	}
}

func (e *Engine) handleProgress(p lobby.Progress) error {
	e.mu.Lock()
	known := lobby.SameHost(e.peerAddrs[p.PeerID], p.RemoteIP)
	phase := e.state.Phase
	mode := e.state.Mode
	e.mu.Unlock()
	if !known || phase != PhasePlaying {
		return lobby.ErrClosed
	}
	switch mode {
	case ModeRace:
		return e.raceEng.HandleProgress(p)
	case ModeDraw:
		return e.drawEng.HandleProgress(p)
	case ModeSnake:
		var payload struct {
			Heading float64 `json:"heading"`
		}
		if err := json.Unmarshal(p.Payload, &payload); err != nil {
			return lobby.ErrRejected
		}
		return e.snakeEng.HandleInput(p.PeerID, payload.Heading)
	default:
		return lobby.ErrClosed
	}
}

func (e *Engine) makeOnEvent(lobbyID string) func(json.RawMessage) {
	return func(payload json.RawMessage) {
		var env broadcastEnvelope
		if err := json.Unmarshal(payload, &env); err != nil {
			return
		}
		e.mu.Lock()
		if e.host || e.state.LobbyID != lobbyID {
			e.mu.Unlock()
			return
		}
		e.mu.Unlock()
		switch env.Source {
		case "party":
			var snap State
			if err := json.Unmarshal(env.Payload, &snap); err != nil || snap.LobbyID != lobbyID {
				return
			}
			e.mu.Lock()
			if e.host || e.state.LobbyID != lobbyID {
				e.mu.Unlock()
				return
			}
			e.state.Players = clonePlayers(snap.Players)
			e.state.Mode = snap.Mode
			switch e.state.Phase {
			case PhaseLobby, PhaseFinished:
				e.state.Phase = snap.Phase
			}
			e.mu.Unlock()
			e.notify()
		case string(ModeRace):
			e.raceEng.ApplyEvent(env.Payload)
		case string(ModeDraw):
			e.drawEng.ApplyEvent(env.Payload)
		case string(ModeSnake):
			e.snakeEng.ApplyEvent(env.Payload)
		}
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
		phase := e.state.Phase
		mode := e.state.Mode
		e.mu.Unlock()
		switch {
		case phase == PhasePlaying && mode == ModeRace && e.raceEng.FinishedIfClosed():
			e.mu.Lock()
			e.state.Phase = PhaseFinished
			e.mu.Unlock()
		case phase == PhasePlaying && mode == ModeDraw && e.drawEng.FinishedIfClosed():
			e.mu.Lock()
			e.state.Phase = PhaseFinished
			e.mu.Unlock()
		case phase == PhasePlaying && mode == ModeSnake && e.snakeEng.FinishedIfClosed():
			e.mu.Lock()
			e.state.Phase = PhaseFinished
			e.mu.Unlock()
		case phase == PhaseLobby || phase == PhasePlaying:
			e.mu.Lock()
			e.state.Phase = PhaseHostLeft
			e.mu.Unlock()
		}
		e.notify()
	}
}

// Leave exits the current lobby or game entirely, returning to idle.
func (e *Engine) Leave() {
	e.mu.Lock()
	if e.state.Phase == PhaseIdle {
		e.mu.Unlock()
		return
	}
	phase := e.state.Phase
	mode := e.state.Mode
	isHost := e.host
	lobbyID := e.state.LobbyID
	hostAddr := e.hostAddr
	e.mu.Unlock()

	if phase == PhasePlaying {
		switch mode {
		case ModeRace:
			e.raceEng.Leave()
		case ModeDraw:
			e.drawEng.Leave()
		case ModeSnake:
			e.snakeEng.Leave()
		}
	}

	e.mu.Lock()
	if e.state.LobbyID != lobbyID || e.state.Phase == PhaseIdle {
		e.mu.Unlock()
		e.notify()
		return
	}
	tellHost := !isHost && (phase == PhaseLobby || phase == PhasePlaying)
	response := lobby.Response{LobbyID: lobbyID, PeerID: e.selfID, PeerName: e.selfName}
	if isHost && e.server != nil && phase == PhaseLobby {
		e.server.EndLobby(lobbyID, mustMarshal(broadcastEnvelope{Source: "party"}))
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

// Rematch returns a finished lobby to its lobby phase (same roster, same
// lobbyId) so the host can pick another mode and go again, instead of
// everyone having to re-invite from scratch. Mode defaults back to Race,
// the same as a brand new lobby, since the hero view always displays Race
// when asked to render an unset mode - leaving the real Mode at ModeNone
// here left Start disabled against what the lobby was visibly showing
// until the host touched the mode picker.
func (e *Engine) Rematch() error {
	e.mu.Lock()
	if !e.host || !e.state.Phase.free() || e.state.Phase == PhaseIdle {
		e.mu.Unlock()
		return fmt.Errorf("party: cannot start a rematch now")
	}
	for i := range e.state.Players {
		if e.state.Players[i].Status == "accepted" {
			continue
		}
	}
	e.state.Phase = PhaseLobby
	e.state.Mode = ModeRace
	e.publishLobbyLocked()
	e.mu.Unlock()
	e.notify()
	return nil
}

func (e *Engine) publishLobbyLocked() {
	if !e.host || e.server == nil {
		return
	}
	payload, err := json.Marshal(e.state)
	if err != nil {
		return
	}
	e.server.Broadcast(e.state.LobbyID, mustMarshal(broadcastEnvelope{Source: "party", Payload: payload}))
}

func (e *Engine) resetLocked() func() {
	unsub := e.unsubscribe
	e.unsubscribe = nil
	e.host = false
	e.hostAddr = ""
	e.peerAddrs = nil
	e.state = State{Phase: PhaseIdle}
	return unsub
}

func (e *Engine) playerIndexLocked(peerID string) int {
	for i, p := range e.state.Players {
		if p.PeerID == peerID {
			return i
		}
	}
	return -1
}

func (e *Engine) removePlayerLocked(i int) {
	delete(e.peerAddrs, e.state.Players[i].PeerID)
	e.state.Players = append(e.state.Players[:i:i], e.state.Players[i+1:]...)
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

func cloneState(s State) State {
	s.Players = clonePlayers(s.Players)
	return s
}

func clonePlayers(in []Player) []Player {
	out := make([]Player, len(in))
	copy(out, in)
	return out
}
