// Package draw is the drawing-and-guessing gameplay engine. It owns no
// lobby, discovery or transport of its own - internal/party hands it a
// roster and a shared lobby.Server-backed publish/send pair once a lobby's
// host picks draw and starts.
package draw

import (
	"encoding/json"
	"fmt"
	mrand "math/rand/v2"
	"strings"
	"sync"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/lobby"
)

type Phase string

const (
	PhaseIdle     Phase = "idle"
	PhaseDrawing  Phase = "drawing"
	PhaseReveal   Phase = "reveal"
	PhaseFinished Phase = "finished"
)

const (
	defaultRoundDuration = 80 * time.Second
	revealDuration       = 4 * time.Second
	maxPointsPerRound    = 4000
)

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

type Engine struct {
	selfID   string
	selfName string

	roundDuration time.Duration

	mu          sync.Mutex
	state       State
	host        bool
	hostAddr    string
	lobbyID     string
	peerAddrs   map[string]string
	roundTimer  *time.Timer
	revealTimer *time.Timer
	drawOrder   []string
	usedWords   map[string]bool
	roundDeltas []ScoreDelta
	onChange    func(State)

	publish   func(end bool, lobbyID string, payload json.RawMessage)
	sendStart func(addr, lobbyID string, payload json.RawMessage) error
}

func NewEngine(selfID, selfName string) *Engine {
	return &Engine{
		selfID:        selfID,
		selfName:      selfName,
		roundDuration: defaultRoundDuration,
		state:         State{Phase: PhaseIdle},
	}
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
	if s.DrawerID != e.selfID {
		s.Word = ""
	}
	return s
}

func (e *Engine) notify() {
	e.mu.Lock()
	fn := e.onChange
	snap := cloneState(e.state)
	if snap.DrawerID != e.selfID {
		snap.Word = ""
	}
	e.mu.Unlock()
	if fn != nil {
		fn(snap)
	}
}

// BeginHost starts a drawing game for the host: players is the accepted
// roster in turn order, peerAddrs resolves each non-self player's address.
func (e *Engine) BeginHost(lobbyID string, players []Player, peerAddrs map[string]string,
	publish func(bool, string, json.RawMessage), sendStart func(addr, lobbyID string, payload json.RawMessage) error) error {
	if len(players) == 0 {
		return fmt.Errorf("draw: no accepted players")
	}
	order := make([]string, len(players))
	for i, p := range players {
		order[i] = p.PeerID
		players[i].Score = 0
	}

	e.mu.Lock()
	e.host = true
	e.hostAddr = ""
	e.lobbyID = lobbyID
	e.peerAddrs = peerAddrs
	e.publish = publish
	e.sendStart = sendStart
	e.drawOrder = order
	e.usedWords = map[string]bool{}
	e.roundDeltas = nil

	round := 1
	drawerID := order[0]
	drawerName := players[0].Name
	word := e.pickWordLocked()
	endsAt := time.Now().Add(e.roundDuration).UnixMilli()

	e.state = State{
		Phase: PhaseDrawing, Round: round, TotalRounds: len(players),
		DrawerID: drawerID, DrawerName: drawerName, Word: word,
		RoundEndsAtMs: endsAt, Players: clonePlayers(players),
	}
	playersCopy := clonePlayers(e.state.Players)
	e.roundTimer = time.AfterFunc(e.roundDuration, func() { e.expireRound(lobbyID, round) })
	e.mu.Unlock()
	e.notify()

	e.sendRoundStarts(peerAddrs, lobbyID, round, len(players), drawerID, drawerName, word, endsAt, playersCopy)

	e.mu.Lock()
	if e.lobbyID == lobbyID {
		e.publishLocked()
	}
	e.mu.Unlock()
	return nil
}

func (e *Engine) sendRoundStarts(peerAddrs map[string]string, lobbyID string, round, total int, drawerID, drawerName, word string, endsAt int64, players []Player) {
	var wg sync.WaitGroup
	for peerID, addr := range peerAddrs {
		if peerID == e.selfID {
			continue
		}
		wg.Add(1)
		go func(peerID, addr string) {
			defer wg.Done()
			w := ""
			if peerID == drawerID {
				w = word
			}
			payload := startPayload{
				Round: round, TotalRounds: total, DrawerID: drawerID, DrawerName: drawerName,
				Word: w, RoundEndsAtMs: endsAt, Players: players,
			}
			_ = e.sendStart(addr, lobbyID, mustMarshal(payload))
		}(peerID, addr)
	}
	wg.Wait()
}

// BeginGuest starts a drawing game for a guest once the host's initial
// round-start message arrives.
func (e *Engine) BeginGuest(lobbyID, hostAddr string, payload json.RawMessage) error {
	var p startPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return lobby.ErrRejected
	}
	e.mu.Lock()
	e.host = false
	e.hostAddr = hostAddr
	e.lobbyID = lobbyID
	e.state = State{
		Phase: PhaseDrawing, Round: p.Round, TotalRounds: p.TotalRounds,
		DrawerID: p.DrawerID, DrawerName: p.DrawerName, Word: p.Word,
		RoundEndsAtMs: p.RoundEndsAtMs, Players: clonePlayers(p.Players),
	}
	e.mu.Unlock()
	e.notify()
	return nil
}

// HandleStart applies a mid-game round-transition start message (the only
// kind draw ever receives once gameplay has begun).
func (e *Engine) HandleStart(payload json.RawMessage) error {
	var p startPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return lobby.ErrRejected
	}
	e.mu.Lock()
	if e.host {
		e.mu.Unlock()
		return nil
	}
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
	e.state.Phase = PhaseDrawing
	e.mu.Unlock()
	e.notify()
	return nil
}

func (e *Engine) HandleRespond(r lobby.Response) error {
	e.mu.Lock()
	idx := -1
	if e.host && e.lobbyID == r.LobbyID {
		idx = e.playerIndexLocked(r.PeerID)
	}
	if idx <= 0 {
		e.mu.Unlock()
		if r.Accept {
			return lobby.ErrClosed
		}
		return nil
	}
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
	e.mu.Unlock()
	e.notify()
	return nil
}

func (e *Engine) SubmitStroke(stroke Stroke) error {
	e.mu.Lock()
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
	lobbyID := e.lobbyID
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
	if e.state.Phase != PhaseDrawing {
		e.mu.Unlock()
		return fmt.Errorf("draw: not drawing")
	}
	host := e.host
	selfID := e.selfID
	hostAddr := e.hostAddr
	lobbyID := e.lobbyID
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

func (e *Engine) HandleProgress(p lobby.Progress) error {
	var payload progressPayload
	if err := json.Unmarshal(p.Payload, &payload); err != nil {
		return lobby.ErrRejected
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
	if !e.host || e.lobbyID != lobbyID || e.state.Phase != PhaseDrawing || e.state.DrawerID != peerID {
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
	eligible := e.host && e.lobbyID == lobbyID && e.state.Phase == PhaseDrawing &&
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
	if !e.host || e.lobbyID != lobbyID || e.state.Phase != PhaseDrawing || e.state.Round != round {
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
	lobbyID := e.lobbyID
	e.revealTimer = time.AfterFunc(revealDuration, func() { e.advanceRound(lobbyID) })
}

func (e *Engine) advanceRound(lobbyID string) {
	e.mu.Lock()
	if !e.host || e.lobbyID != lobbyID || e.state.Phase != PhaseReveal {
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
	peerAddrs := make(map[string]string, len(e.peerAddrs))
	for k, v := range e.peerAddrs {
		peerAddrs[k] = v
	}
	e.roundTimer = time.AfterFunc(e.roundDuration, func() { e.expireRound(lobbyID, round) })
	e.mu.Unlock()
	e.notify()

	e.sendRoundStarts(peerAddrs, lobbyID, round, total, drawerID, drawerName, word, endsAt, players)

	e.mu.Lock()
	if e.lobbyID == lobbyID {
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
	if !e.host || e.publish == nil {
		return
	}
	redacted := cloneState(e.state)
	redacted.Word = ""
	payload, err := json.Marshal(redacted)
	if err != nil {
		return
	}
	e.publish(redacted.Phase == PhaseFinished, e.lobbyID, payload)
}

// ApplyEvent absorbs a broadcast snapshot received over the shared lobby
// subscription, for a guest tracking the host's game. The host always
// redacts Word in what it broadcasts, so a drawer's own locally-learned
// word (from BeginGuest/HandleStart) must survive these snapshots.
func (e *Engine) ApplyEvent(payload json.RawMessage) {
	var snap State
	if err := json.Unmarshal(payload, &snap); err != nil {
		return
	}
	e.mu.Lock()
	if e.host {
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

// FinishedIfClosed reports whether the game should be treated as finished
// (rather than host-left) now that the shared subscription has closed.
func (e *Engine) FinishedIfClosed() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.state.Phase == PhaseFinished
}

// Leave ends the engine's own participation in an in-progress game; the
// caller (party) is responsible for the lobby-level cleanup.
func (e *Engine) Leave() {
	e.mu.Lock()
	if e.state.Phase != PhaseDrawing && e.state.Phase != PhaseReveal {
		e.mu.Unlock()
		return
	}
	if e.host {
		e.publish(true, e.lobbyID, mustMarshal(struct{}{}))
	}
	e.resetLocked()
	e.mu.Unlock()
	e.notify()
}

func (e *Engine) resetLocked() {
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
	e.lobbyID = ""
	e.peerAddrs = nil
	e.drawOrder = nil
	e.usedWords = nil
	e.roundDeltas = nil
	e.publish = nil
	e.sendStart = nil
	e.state = State{Phase: PhaseIdle}
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
