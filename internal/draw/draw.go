package draw

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	mrand "math/rand/v2"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/discovery"
	"github.com/AdamShannag/dynamic-island/internal/lobby"
)

type Phase string

const (
	PhaseIdle     Phase = "idle"
	PhaseLobby    Phase = "lobby"
	PhaseDrawing  Phase = "drawing"
	PhaseReveal   Phase = "reveal"
	PhaseFinished Phase = "finished"
	PhaseHostLeft Phase = "host_left"
	PhaseMissed   Phase = "missed"
)

const (
	defaultRoundDuration = 80 * time.Second
	revealDuration       = 4 * time.Second
	maxPointsPerRound    = 4000
)

func (p Phase) free() bool {
	return p == PhaseIdle || p == PhaseFinished || p == PhaseHostLeft || p == PhaseMissed
}

type Player struct {
	PeerID string `json:"peerId"`
	Name   string `json:"name"`
	Status string `json:"status"`
	Score  int    `json:"score"`
}

type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type Stroke struct {
	Points []Point `json:"points"`
	Color  string  `json:"color"`
	Width  float64 `json:"width"`
}

type ScoreDelta struct {
	PeerID string `json:"peerId"`
	Name   string `json:"name"`
	Points int    `json:"points"`
}

type RoundResult struct {
	Word   string       `json:"word"`
	Drawer string       `json:"drawer"`
	Deltas []ScoreDelta `json:"deltas"`
}

type State struct {
	LobbyID       string       `json:"lobbyId"`
	IsHost        bool         `json:"isHost"`
	Phase         Phase        `json:"phase"`
	Round         int          `json:"round"`
	TotalRounds   int          `json:"totalRounds"`
	DrawerID      string       `json:"drawerId"`
	DrawerName    string       `json:"drawerName"`
	Word          string       `json:"word"`
	RoundEndsAtMs int64        `json:"roundEndsAtMs"`
	Strokes       []Stroke     `json:"strokes"`
	Guessed       []string     `json:"guessed"`
	Players       []Player     `json:"players"`
	SelfID        string       `json:"selfId"`
	LastRound     *RoundResult `json:"lastRound,omitempty"`
}

type startPayload struct {
	Round         int      `json:"round"`
	TotalRounds   int      `json:"totalRounds"`
	DrawerID      string   `json:"drawerId"`
	DrawerName    string   `json:"drawerName"`
	Word          string   `json:"word"`
	RoundEndsAtMs int64    `json:"roundEndsAtMs"`
	Players       []Player `json:"players"`
}

type progressPayload struct {
	Type   string  `json:"type"`
	Stroke *Stroke `json:"stroke,omitempty"`
	Text   string  `json:"text,omitempty"`
}

type target struct {
	PeerID string
	Addr   string
}

type Engine struct {
	selfID   string
	selfName string
	selfAddr string
	port     int

	roundDuration time.Duration

	mu          sync.Mutex
	state       State
	enabled     bool
	addr        string
	host        bool
	hostAddr    string
	peerAddrs   map[string]string
	unsubscribe func()
	roundTimer  *time.Timer
	revealTimer *time.Timer
	drawOrder   []string
	usedWords   map[string]bool
	roundDeltas []ScoreDelta
	onChange    func(State)

	disc   *discovery.Discovery
	server *lobby.Server

	notifyMu      sync.Mutex
	notifying     bool
	notifyPending bool
}

func NewEngine(selfID, selfName, selfAddr string, port int) *Engine {
	return &Engine{
		selfID:   selfID,
		selfName: selfName,
		selfAddr: selfAddr,
		port:     port,

		roundDuration: defaultRoundDuration,
		state:         State{Phase: PhaseIdle},
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
	server := lobby.NewServer(e.port, lobby.Callbacks{
		OnInvite:   e.handleInvite,
		OnRespond:  e.handleRespond,
		OnStart:    e.handleStart,
		OnProgress: e.handleProgress,
	})
	if err := server.Listen(); err != nil {
		return fmt.Errorf("draw: %w", err)
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

func (e *Engine) State() State {
	e.mu.Lock()
	defer e.mu.Unlock()
	s := cloneState(e.state)
	s.SelfID = e.selfID
	if s.DrawerID != e.selfID {
		s.Word = ""
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
		snap := cloneState(e.state)
		snap.SelfID = e.selfID
		if snap.DrawerID != e.selfID {
			snap.Word = ""
		}
		e.mu.Unlock()
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
		return fmt.Errorf("draw: not enabled")
	}
	if !e.host || e.state.Phase != PhaseLobby {
		e.mu.Unlock()
		return fmt.Errorf("draw: not hosting a lobby")
	}
	if e.playerIndexLocked(peer.ID) >= 0 {
		e.mu.Unlock()
		return fmt.Errorf("draw: %s is already in this lobby", peer.Name)
	}
	e.state.Players = append(e.state.Players, Player{PeerID: peer.ID, Name: peer.Name, Status: "pending"})
	e.peerAddrs[peer.ID] = peer.Addr
	lobbyID := e.state.LobbyID
	hostAddr := net.JoinHostPort(e.addr, strconv.Itoa(e.port))
	e.publishLocked()
	e.mu.Unlock()
	e.notify()

	err := lobby.SendInvite(peer.Addr, lobby.Invite{
		LobbyID:  lobbyID,
		Kind:     "draw",
		HostID:   e.selfID,
		HostName: e.selfName,
		HostAddr: hostAddr,
	})
	if err != nil {
		e.mu.Lock()
		if e.host && e.state.LobbyID == lobbyID && e.state.Phase == PhaseLobby {
			if i := e.playerIndexLocked(peer.ID); i >= 0 && e.state.Players[i].Status == "pending" {
				e.removePlayerLocked(i)
				e.publishLocked()
			}
		}
		e.mu.Unlock()
		e.notify()
	}
	return err
}

func (e *Engine) handleInvite(inv lobby.Invite) error {
	if inv.Kind != "draw" {
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
		return fmt.Errorf("draw: not enabled")
	}
	if e.host || e.state.Phase != PhaseLobby {
		e.mu.Unlock()
		return fmt.Errorf("draw: no pending invite to respond to")
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
		return fmt.Errorf("draw: already accepted")
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
		idx = e.playerIndexLocked(r.PeerID)
	}
	if idx <= 0 {
		e.mu.Unlock()
		return rejectAccept(r.Accept)
	}
	switch e.state.Phase {
	case PhaseLobby:
		if r.Accept {
			e.state.Players[idx].Status = "accepted"
			e.peerAddrs[r.PeerID] = lobby.WithHost(e.peerAddrs[r.PeerID], r.RemoteIP)
		} else {
			e.state.Players[idx].Status = "declined"
		}
		e.publishLocked()
	case PhaseDrawing, PhaseReveal:
		if r.Accept {
			e.mu.Unlock()
			return nil
		}
		leavingDrawer := e.state.Players[idx].PeerID == e.state.DrawerID
		e.removePlayerLocked(idx)
		switch {
		case leavingDrawer && e.state.Phase == PhaseDrawing:
			e.endRoundLocked()
		case e.state.Phase == PhaseDrawing:
			e.maybeEndRoundLocked()
		default:
			e.publishLocked()
		}
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
		return fmt.Errorf("draw: not enabled")
	}
	if !e.host || e.state.Phase != PhaseLobby {
		e.mu.Unlock()
		return fmt.Errorf("draw: cannot start now")
	}
	lobbyID := e.state.LobbyID

	players := make([]Player, 0, len(e.state.Players))
	order := make([]string, 0, len(e.state.Players))
	for _, p := range e.state.Players {
		if p.Status != "accepted" {
			delete(e.peerAddrs, p.PeerID)
			continue
		}
		p.Score = 0
		players = append(players, p)
		order = append(order, p.PeerID)
	}
	if len(players) == 0 {
		e.mu.Unlock()
		return fmt.Errorf("draw: no accepted players")
	}
	e.state.Players = players
	e.drawOrder = order
	e.usedWords = map[string]bool{}
	e.roundDeltas = nil

	round := 1
	drawerID := order[0]
	drawerName := players[0].Name
	word := e.pickWordLocked()
	endsAt := time.Now().Add(e.roundDuration).UnixMilli()

	e.state.Phase = PhaseDrawing
	e.state.Round = round
	e.state.TotalRounds = len(players)
	e.state.DrawerID = drawerID
	e.state.DrawerName = drawerName
	e.state.Word = word
	e.state.Strokes = nil
	e.state.Guessed = nil
	e.state.LastRound = nil
	e.state.RoundEndsAtMs = endsAt

	total := e.state.TotalRounds
	playersCopy := clonePlayers(e.state.Players)
	targets := e.sendTargetsLocked()
	e.roundTimer = time.AfterFunc(e.roundDuration, func() { e.expireRound(lobbyID, round) })
	e.mu.Unlock()
	e.notify()

	e.sendRoundStarts(targets, lobbyID, round, total, drawerID, drawerName, word, endsAt, playersCopy)

	e.mu.Lock()
	if e.host && e.state.LobbyID == lobbyID {
		e.publishLocked()
	}
	e.mu.Unlock()
	return nil
}

func (e *Engine) sendTargetsLocked() []target {
	out := make([]target, 0, len(e.state.Players))
	for _, p := range e.state.Players {
		if p.PeerID == e.selfID {
			continue
		}
		if addr, ok := e.peerAddrs[p.PeerID]; ok {
			out = append(out, target{PeerID: p.PeerID, Addr: addr})
		}
	}
	return out
}

func (e *Engine) sendRoundStarts(targets []target, lobbyID string, round, total int, drawerID, drawerName, word string, endsAt int64, players []Player) {
	var wg sync.WaitGroup
	for _, tg := range targets {
		wg.Add(1)
		go func(tg target) {
			defer wg.Done()
			w := ""
			if tg.PeerID == drawerID {
				w = word
			}
			payload := startPayload{
				Round: round, TotalRounds: total, DrawerID: drawerID, DrawerName: drawerName,
				Word: w, RoundEndsAtMs: endsAt, Players: players,
			}
			_ = lobby.SendStart(tg.Addr, lobby.Start{LobbyID: lobbyID, Payload: mustMarshal(payload)})
		}(tg)
	}
	wg.Wait()
}

func (e *Engine) handleStart(s lobby.Start) error {
	var p startPayload
	if err := json.Unmarshal(s.Payload, &p); err != nil {
		return lobby.ErrRejected
	}
	e.mu.Lock()
	if e.host || e.state.LobbyID != s.LobbyID || e.unsubscribe == nil || !lobby.SameHost(e.hostAddr, s.RemoteIP) {
		e.mu.Unlock()
		return lobby.ErrClosed
	}
	if e.state.Phase != PhaseLobby && e.state.Phase != PhaseDrawing && e.state.Phase != PhaseReveal {
		e.mu.Unlock()
		return nil
	}
	e.state.Phase = PhaseDrawing
	e.state.Round = p.Round
	e.state.TotalRounds = p.TotalRounds
	e.state.DrawerID = p.DrawerID
	e.state.DrawerName = p.DrawerName
	e.state.Word = p.Word
	e.state.RoundEndsAtMs = p.RoundEndsAtMs
	e.state.Players = clonePlayers(p.Players)
	e.state.Strokes = nil
	e.state.Guessed = nil
	e.state.LastRound = nil
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
		word := snap.Word
		if e.state.DrawerID == e.selfID && e.state.Word != "" {
			word = e.state.Word
		}
		e.state.Word = word
		e.state.Strokes = cloneStrokes(snap.Strokes)
		e.state.Guessed = append([]string(nil), snap.Guessed...)
		e.state.Players = clonePlayers(snap.Players)
		e.state.LastRound = snap.LastRound
		switch {
		case e.state.Phase == PhaseDrawing && snap.Phase == PhaseReveal:
			e.state.Phase = PhaseReveal
		case (e.state.Phase == PhaseDrawing || e.state.Phase == PhaseReveal) && snap.Phase == PhaseFinished:
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
		if e.state.Phase == PhaseLobby || e.state.Phase == PhaseDrawing || e.state.Phase == PhaseReveal {
			e.state.Phase = PhaseHostLeft
		}
		e.mu.Unlock()
		e.notify()
	}
}

func (e *Engine) SubmitStroke(stroke Stroke) error {
	e.mu.Lock()
	if !e.enabled {
		e.mu.Unlock()
		return fmt.Errorf("draw: not enabled")
	}
	if e.state.Phase != PhaseDrawing {
		e.mu.Unlock()
		return fmt.Errorf("draw: not drawing")
	}
	if e.state.DrawerID != e.selfID {
		e.mu.Unlock()
		return fmt.Errorf("draw: not your turn to draw")
	}
	host := e.host
	selfID := e.selfID
	hostAddr := e.hostAddr
	lobbyID := e.state.LobbyID
	e.mu.Unlock()

	if host {
		e.applyStroke(lobbyID, selfID, stroke)
		return nil
	}
	return lobby.SendProgress(hostAddr, lobby.Progress{
		LobbyID: lobbyID,
		PeerID:  selfID,
		Payload: mustMarshal(progressPayload{Type: "stroke", Stroke: &stroke}),
	})
}

func (e *Engine) SubmitGuess(text string) error {
	e.mu.Lock()
	if !e.enabled {
		e.mu.Unlock()
		return fmt.Errorf("draw: not enabled")
	}
	if e.state.Phase != PhaseDrawing {
		e.mu.Unlock()
		return fmt.Errorf("draw: not drawing")
	}
	host := e.host
	selfID := e.selfID
	hostAddr := e.hostAddr
	lobbyID := e.state.LobbyID
	e.mu.Unlock()

	if host {
		e.applyGuess(lobbyID, selfID, text)
		return nil
	}
	return lobby.SendProgress(hostAddr, lobby.Progress{
		LobbyID: lobbyID,
		PeerID:  selfID,
		Payload: mustMarshal(progressPayload{Type: "guess", Text: text}),
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
	if !known {
		return lobby.ErrClosed
	}
	switch payload.Type {
	case "stroke":
		if payload.Stroke == nil || !e.applyStroke(p.LobbyID, p.PeerID, *payload.Stroke) {
			return lobby.ErrClosed
		}
	case "guess":
		e.applyGuess(p.LobbyID, p.PeerID, payload.Text)
	default:
		return lobby.ErrRejected
	}
	return nil
}

func (e *Engine) applyStroke(lobbyID, peerID string, stroke Stroke) bool {
	e.mu.Lock()
	if !e.host || e.state.LobbyID != lobbyID || e.state.Phase != PhaseDrawing || e.state.DrawerID != peerID {
		e.mu.Unlock()
		return false
	}
	e.state.Strokes = append(e.state.Strokes, stroke)
	e.capStrokesLocked()
	e.publishLocked()
	e.mu.Unlock()
	e.notify()
	return true
}

func (e *Engine) capStrokesLocked() {
	total := 0
	for _, s := range e.state.Strokes {
		total += len(s.Points)
	}
	for total > maxPointsPerRound && len(e.state.Strokes) > 0 {
		total -= len(e.state.Strokes[0].Points)
		e.state.Strokes = e.state.Strokes[1:]
	}
}

func (e *Engine) applyGuess(lobbyID, peerID, text string) bool {
	e.mu.Lock()
	eligible := e.host && e.state.LobbyID == lobbyID && e.state.Phase == PhaseDrawing &&
		peerID != e.state.DrawerID && !containsStr(e.state.Guessed, peerID)
	if !eligible {
		e.mu.Unlock()
		return false
	}
	norm := normalizeGuess(text)
	if norm == "" || norm != normalizeGuess(e.state.Word) {
		e.mu.Unlock()
		return false
	}
	rank := len(e.state.Guessed) + 1
	pts := scoreForRank(rank)
	e.addScoreLocked(peerID, pts)
	e.state.Guessed = append(e.state.Guessed, peerID)
	e.roundDeltas = append(e.roundDeltas, e.scoreDeltaLocked(peerID, pts))
	e.maybeEndRoundLocked()
	e.mu.Unlock()
	e.notify()
	return true
}

func (e *Engine) maybeEndRoundLocked() {
	nonDrawers := 0
	for _, p := range e.state.Players {
		if p.PeerID != e.state.DrawerID {
			nonDrawers++
		}
	}
	if nonDrawers > 0 && len(e.state.Guessed) >= nonDrawers {
		e.endRoundLocked()
	}
}

func (e *Engine) expireRound(lobbyID string, round int) {
	e.mu.Lock()
	if !e.host || e.state.LobbyID != lobbyID || e.state.Phase != PhaseDrawing || e.state.Round != round {
		e.mu.Unlock()
		return
	}
	e.endRoundLocked()
	e.mu.Unlock()
	e.notify()
}

func (e *Engine) endRoundLocked() {
	if e.roundTimer != nil {
		e.roundTimer.Stop()
		e.roundTimer = nil
	}
	if len(e.roundDeltas) > 0 {
		const drawerBonus = 1
		e.addScoreLocked(e.state.DrawerID, drawerBonus)
		e.roundDeltas = append(e.roundDeltas, e.scoreDeltaLocked(e.state.DrawerID, drawerBonus))
	}
	e.state.LastRound = &RoundResult{Word: e.state.Word, Drawer: e.state.DrawerID, Deltas: e.roundDeltas}
	e.roundDeltas = nil

	if e.state.Round >= e.state.TotalRounds || len(e.state.Players) == 0 {
		e.state.Phase = PhaseFinished
		e.publishLocked()
		return
	}
	e.state.Phase = PhaseReveal
	e.publishLocked()
	lobbyID := e.state.LobbyID
	e.revealTimer = time.AfterFunc(revealDuration, func() { e.advanceRound(lobbyID) })
}

func (e *Engine) advanceRound(lobbyID string) {
	e.mu.Lock()
	if !e.host || e.state.LobbyID != lobbyID || e.state.Phase != PhaseReveal {
		e.mu.Unlock()
		return
	}
	round := e.state.Round + 1
	drawerID, ok := e.nextDrawerLocked(round)
	if !ok {
		e.state.Phase = PhaseFinished
		e.publishLocked()
		e.mu.Unlock()
		e.notify()
		return
	}
	drawerName := e.playerNameLocked(drawerID)
	word := e.pickWordLocked()
	endsAt := time.Now().Add(e.roundDuration).UnixMilli()

	e.state.Round = round
	e.state.DrawerID = drawerID
	e.state.DrawerName = drawerName
	e.state.Word = word
	e.state.Strokes = nil
	e.state.Guessed = nil
	e.state.LastRound = nil
	e.state.Phase = PhaseDrawing
	e.state.RoundEndsAtMs = endsAt

	total := e.state.TotalRounds
	players := clonePlayers(e.state.Players)
	targets := e.sendTargetsLocked()
	e.roundTimer = time.AfterFunc(e.roundDuration, func() { e.expireRound(lobbyID, round) })
	e.mu.Unlock()
	e.notify()

	e.sendRoundStarts(targets, lobbyID, round, total, drawerID, drawerName, word, endsAt, players)

	e.mu.Lock()
	if e.host && e.state.LobbyID == lobbyID {
		e.publishLocked()
	}
	e.mu.Unlock()
}

func (e *Engine) nextDrawerLocked(round int) (string, bool) {
	for i := round - 1; i >= 0 && i < len(e.drawOrder); i++ {
		id := e.drawOrder[i]
		if e.playerIndexLocked(id) >= 0 {
			return id, true
		}
	}
	return "", false
}

func (e *Engine) pickWordLocked() string {
	available := make([]string, 0, len(words))
	for _, w := range words {
		if !e.usedWords[w] {
			available = append(available, w)
		}
	}
	if len(available) == 0 {
		e.usedWords = map[string]bool{}
		available = words
	}
	w := available[mrand.IntN(len(available))]
	if e.usedWords == nil {
		e.usedWords = map[string]bool{}
	}
	e.usedWords[w] = true
	return w
}

func (e *Engine) addScoreLocked(peerID string, pts int) {
	for i := range e.state.Players {
		if e.state.Players[i].PeerID == peerID {
			e.state.Players[i].Score += pts
			return
		}
	}
}

func (e *Engine) scoreDeltaLocked(peerID string, pts int) ScoreDelta {
	return ScoreDelta{PeerID: peerID, Name: e.playerNameLocked(peerID), Points: pts}
}

func (e *Engine) playerNameLocked(peerID string) string {
	if i := e.playerIndexLocked(peerID); i >= 0 {
		return e.state.Players[i].Name
	}
	return ""
}

func scoreForRank(rank int) int {
	switch rank {
	case 1:
		return 3
	case 2:
		return 2
	default:
		return 1
	}
}

func normalizeGuess(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

func containsStr(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func (e *Engine) publishLocked() {
	if !e.host || e.server == nil {
		return
	}
	redacted := cloneState(e.state)
	redacted.Word = ""
	payload, err := json.Marshal(redacted)
	if err != nil {
		return
	}
	if redacted.Phase == PhaseFinished {
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
	tellHost := !e.host && (e.state.Phase == PhaseLobby || e.state.Phase == PhaseDrawing || e.state.Phase == PhaseReveal)
	response := lobby.Response{LobbyID: e.state.LobbyID, PeerID: e.selfID, PeerName: e.selfName}
	hostAddr := e.hostAddr
	if e.host && e.server != nil && (e.state.Phase == PhaseLobby || e.state.Phase == PhaseDrawing || e.state.Phase == PhaseReveal) {
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
	if e.roundTimer != nil {
		e.roundTimer.Stop()
		e.roundTimer = nil
	}
	if e.revealTimer != nil {
		e.revealTimer.Stop()
		e.revealTimer = nil
	}
	e.host = false
	e.hostAddr = ""
	e.peerAddrs = nil
	e.drawOrder = nil
	e.usedWords = nil
	e.roundDeltas = nil
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
	s.Strokes = cloneStrokes(s.Strokes)
	s.Guessed = append([]string(nil), s.Guessed...)
	if s.LastRound != nil {
		lr := *s.LastRound
		lr.Deltas = append([]ScoreDelta(nil), s.LastRound.Deltas...)
		s.LastRound = &lr
	}
	return s
}

func clonePlayers(in []Player) []Player {
	out := make([]Player, len(in))
	copy(out, in)
	return out
}

func cloneStrokes(in []Stroke) []Stroke {
	out := make([]Stroke, len(in))
	for i, s := range in {
		s.Points = append([]Point(nil), s.Points...)
		out[i] = s
	}
	return out
}
