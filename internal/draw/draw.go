// Package draw is the drawing-telephone gameplay engine. Every player draws
// their own word at once, then everyone guesses someone else's finished
// drawing at once, and that guess becomes the next word to draw - repeated
// for TotalPasses passes, ending in a reveal of every word's full chain. It
// owns no lobby, discovery or transport of its own - internal/party hands it
// a roster and a shared lobby.Server-backed publish/send pair once a lobby's
// host picks draw and starts.
package draw

import (
	"encoding/json"
	"fmt"
	mrand "math/rand/v2"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/lobby"
)

type Phase string

const (
	PhaseIdle     Phase = "idle"
	PhaseDrawing  Phase = "drawing"
	PhaseGuessing Phase = "guessing"
	PhaseFinished Phase = "finished"
)

const (
	defaultDrawDuration  = 45 * time.Second
	defaultGuessDuration = 25 * time.Second
	defaultPasses        = 3
	maxPointsPerDrawing  = 4000
	maxGuessLen          = 120
)

type Player struct {
	PeerID string `json:"peerId"`
	Name   string `json:"name"`
	Status string `json:"status"`
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

// Entry is one link in a chain: either the word it started from (or a
// guess, which plays the same role for every pass after the first) or a
// drawing of whatever the previous entry was.
type Entry struct {
	PeerID  string   `json:"peerId"`
	Name    string   `json:"name"`
	Kind    string   `json:"kind"` // "word" | "drawing"
	Word    string   `json:"word,omitempty"`
	Strokes []Stroke `json:"strokes,omitempty"`
	Final   bool     `json:"final,omitempty"`
}

// Chain is one player's starting word and everything it turned into, in
// order. Only populated once the game has finished - exposing it mid-game
// would let a player see everyone else's in-progress chain.
type Chain struct {
	OwnerID   string  `json:"ownerId"`
	OwnerName string  `json:"ownerName"`
	Entries   []Entry `json:"entries"`
}

// PlayerStatus is safe to broadcast to everyone mid-step: it says who has
// submitted this step without revealing what they submitted.
type PlayerStatus struct {
	PeerID string `json:"peerId"`
	Name   string `json:"name"`
	Done   bool   `json:"done"`
}

// Prompt is what the local player must do right now. It is never broadcast
// - it is delivered to each player individually, the same way the old
// single-drawer game delivered the word only to its drawer.
type Prompt struct {
	Kind       string   `json:"kind"` // "word" | "drawing"
	Word       string   `json:"word,omitempty"`
	Strokes    []Stroke `json:"strokes,omitempty"`
	FromPeerID string   `json:"fromPeerId,omitempty"`
	FromName   string   `json:"fromName,omitempty"`
}

type State struct {
	Phase        Phase          `json:"phase"`
	Pass         int            `json:"pass"`
	TotalPasses  int            `json:"totalPasses"`
	PassEndsAtMs int64          `json:"passEndsAtMs"`
	Prompt       *Prompt        `json:"prompt,omitempty"`
	Waiting      []PlayerStatus `json:"waiting,omitempty"`
	Players      []Player       `json:"players"`
	Chains       []Chain        `json:"chains,omitempty"`
}

// turnPayload is what BeginHost/advanceStep send to each peer individually
// (over the same /start transport BeginGuest and HandleStart already share)
// to start a new step: the shared fields plus that one peer's own Prompt.
type turnPayload struct {
	Phase        Phase    `json:"phase"`
	Pass         int      `json:"pass"`
	TotalPasses  int      `json:"totalPasses"`
	PassEndsAtMs int64    `json:"passEndsAtMs"`
	Prompt       *Prompt  `json:"prompt,omitempty"`
	Players      []Player `json:"players"`
}

type submitPayload struct {
	Kind    string   `json:"kind"`
	Word    string   `json:"word,omitempty"`
	Strokes []Stroke `json:"strokes,omitempty"`
}

type rtEntry struct {
	peerID, name string
	kind         string
	word         string
	strokes      []Stroke
}

type rtChain struct {
	ownerID, ownerName string
	entries            []rtEntry
}

type Engine struct {
	selfID   string
	selfName string

	drawDuration  time.Duration
	guessDuration time.Duration

	mu        sync.Mutex
	state     State
	host      bool
	hostAddr  string
	lobbyID   string
	peerAddrs map[string]string

	chainOrder []string            // owner peerIDs, stable order
	chains     map[string]*rtChain // ownerID -> chain
	turnOf     map[string]string   // ownerID -> worker peerID assigned this step
	workerOf   map[string]string   // worker peerID -> ownerID (reverse of turnOf)
	done       map[string]bool     // worker peerID -> submitted this step
	pending    map[string]rtEntry  // ownerID -> the entry submitted for this step

	stepTimer *time.Timer
	onChange  func(State)

	publish   func(disband bool, lobbyID string, payload json.RawMessage)
	sendStart func(addr, lobbyID string, payload json.RawMessage) error
}

func NewEngine(selfID, selfName string) *Engine {
	return &Engine{
		selfID:        selfID,
		selfName:      selfName,
		drawDuration:  defaultDrawDuration,
		guessDuration: defaultGuessDuration,
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
	return cloneState(e.state)
}

func (e *Engine) notify() {
	e.mu.Lock()
	fn := e.onChange
	snap := cloneState(e.state)
	e.mu.Unlock()
	if fn != nil {
		fn(snap)
	}
}

// BeginHost starts a chain game for the host: players is the accepted
// roster, each getting their own starting word and owning one chain.
// peerAddrs resolves each non-self player's address. passes is the
// host-configured number of draw+guess cycles; below 1 falls back to the
// default.
func (e *Engine) BeginHost(lobbyID string, players []Player, peerAddrs map[string]string, passes int,
	publish func(bool, string, json.RawMessage), sendStart func(addr, lobbyID string, payload json.RawMessage) error) error {
	if len(players) < 2 {
		return fmt.Errorf("draw: needs at least 2 players")
	}
	if passes < 1 {
		passes = defaultPasses
	}

	e.mu.Lock()
	e.host = true
	e.hostAddr = ""
	e.lobbyID = lobbyID
	e.peerAddrs = peerAddrs
	e.publish = publish
	e.sendStart = sendStart

	chosen := pickWords(len(players))
	e.chainOrder = make([]string, len(players))
	e.chains = make(map[string]*rtChain, len(players))
	e.turnOf = make(map[string]string, len(players))
	e.workerOf = make(map[string]string, len(players))
	e.done = map[string]bool{}
	e.pending = map[string]rtEntry{}
	for i, p := range players {
		e.chainOrder[i] = p.PeerID
		e.chains[p.PeerID] = &rtChain{
			ownerID: p.PeerID, ownerName: p.Name,
			entries: []rtEntry{{peerID: p.PeerID, name: p.Name, kind: "word", word: chosen[i]}},
		}
		// Round 1's draw is always the owner drawing their own word -
		// reassignment only begins once there is a drawing to guess.
		e.turnOf[p.PeerID] = p.PeerID
		e.workerOf[p.PeerID] = p.PeerID
	}

	e.state = State{Phase: PhaseDrawing, Pass: 1, TotalPasses: passes, Players: clonePlayers(players)}
	e.state.PassEndsAtMs = time.Now().Add(e.drawDuration).UnixMilli()
	e.startStepTimerLocked(lobbyID, PhaseDrawing, e.drawDuration)
	e.mu.Unlock()

	e.sendTurnMessages(lobbyID)
	return nil
}

// BeginGuest starts a chain game for a guest once the host's first turn
// message arrives.
func (e *Engine) BeginGuest(lobbyID, hostAddr string, payload json.RawMessage) error {
	var p turnPayload
	if err := json.Unmarshal(payload, &p); err != nil || p.Phase == "" {
		return lobby.ErrRejected
	}
	e.mu.Lock()
	e.host = false
	e.hostAddr = hostAddr
	e.lobbyID = lobbyID
	e.state = State{
		Phase: p.Phase, Pass: p.Pass, TotalPasses: p.TotalPasses,
		PassEndsAtMs: p.PassEndsAtMs, Prompt: p.Prompt, Players: clonePlayers(p.Players),
	}
	e.mu.Unlock()
	e.notify()
	return nil
}

// HandleStart applies a mid-game turn message - the personalized push sent
// at the start of every pass's draw and guess steps.
func (e *Engine) HandleStart(payload json.RawMessage) error {
	var p turnPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return lobby.ErrRejected
	}
	e.mu.Lock()
	if e.host {
		e.mu.Unlock()
		return nil
	}
	e.state.Phase = p.Phase
	e.state.Pass = p.Pass
	e.state.TotalPasses = p.TotalPasses
	e.state.PassEndsAtMs = p.PassEndsAtMs
	e.state.Prompt = p.Prompt
	e.state.Players = clonePlayers(p.Players)
	e.state.Waiting = nil
	e.state.Chains = nil
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
	if idx < 0 {
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

	leavingID := r.PeerID
	e.removePlayerLocked(idx)
	delete(e.chains, leavingID)
	e.chainOrder = removeStr(e.chainOrder, leavingID)

	if len(e.state.Players) < 2 {
		if e.stepTimer != nil {
			e.stepTimer.Stop()
			e.stepTimer = nil
		}
		e.finishLocked()
		e.publishLocked()
		e.mu.Unlock()
		e.notify()
		return nil
	}

	if ownerID, assigned := e.workerOf[leavingID]; assigned {
		if !e.done[leavingID] {
			// Treat their unfinished turn as an immediate timeout so
			// whatever chain they were working on isn't left waiting on
			// someone who is gone.
			e.fillOneLocked(leavingID, ownerID)
		}
		delete(e.workerOf, leavingID)
		delete(e.turnOf, ownerID)
	}
	delete(e.done, leavingID)
	e.syncWaitingLocked()
	finished := e.allDoneLocked()
	lobbyID := e.lobbyID
	if !finished {
		e.publishLocked()
	}
	e.mu.Unlock()
	if finished {
		e.advanceStep(lobbyID)
		return nil
	}
	e.notify()
	return nil
}

func (e *Engine) SubmitDrawing(strokes []Stroke) error {
	return e.submit("drawing", capStrokes(cloneStrokes(strokes)), "")
}

func (e *Engine) SubmitGuess(text string) error {
	text = strings.TrimSpace(text)
	if text == "" {
		text = "…"
	}
	if len(text) > maxGuessLen {
		text = text[:maxGuessLen]
	}
	return e.submit("word", nil, text)
}

func (e *Engine) submit(kind string, strokes []Stroke, word string) error {
	e.mu.Lock()
	wantPhase := PhaseDrawing
	if kind == "word" {
		wantPhase = PhaseGuessing
	}
	if e.state.Phase != wantPhase {
		e.mu.Unlock()
		return fmt.Errorf("draw: not your turn")
	}
	host := e.host
	selfID := e.selfID
	hostAddr := e.hostAddr
	lobbyID := e.lobbyID
	e.mu.Unlock()

	if host {
		if !e.applySubmission(lobbyID, selfID, kind, strokes, word) {
			return fmt.Errorf("draw: not your turn")
		}
		return nil
	}
	return lobby.SendProgress(hostAddr, lobby.Progress{
		LobbyID: lobbyID,
		PeerID:  selfID,
		Payload: mustMarshal(submitPayload{Kind: kind, Strokes: strokes, Word: word}),
	})
}

func (e *Engine) HandleProgress(p lobby.Progress) error {
	var sp submitPayload
	if err := json.Unmarshal(p.Payload, &sp); err != nil {
		return lobby.ErrRejected
	}
	if !e.applySubmission(p.LobbyID, p.PeerID, sp.Kind, sp.Strokes, sp.Word) {
		return lobby.ErrClosed
	}
	return nil
}

func (e *Engine) applySubmission(lobbyID, peerID, kind string, strokes []Stroke, word string) bool {
	e.mu.Lock()
	wantPhase := PhaseDrawing
	if kind == "word" {
		wantPhase = PhaseGuessing
	}
	ownerID, assigned := e.workerOf[peerID]
	if !e.host || e.lobbyID != lobbyID || e.state.Phase != wantPhase || !assigned || e.done[peerID] {
		e.mu.Unlock()
		return false
	}
	e.pending[ownerID] = rtEntry{peerID: peerID, name: e.playerNameLocked(peerID), kind: kind, word: word, strokes: strokes}
	e.done[peerID] = true
	e.syncWaitingLocked()
	finished := e.allDoneLocked()
	if !finished {
		e.publishLocked()
	}
	e.mu.Unlock()
	if finished {
		e.advanceStep(lobbyID)
		return true
	}
	e.notify()
	return true
}

func (e *Engine) allDoneLocked() bool {
	return len(e.done) >= len(e.workerOf)
}

func (e *Engine) syncWaitingLocked() {
	waiting := make([]PlayerStatus, 0, len(e.workerOf))
	for workerID := range e.workerOf {
		waiting = append(waiting, PlayerStatus{PeerID: workerID, Name: e.playerNameLocked(workerID), Done: e.done[workerID]})
	}
	sort.Slice(waiting, func(i, j int) bool { return waiting[i].PeerID < waiting[j].PeerID })
	e.state.Waiting = waiting
}

// fillOneLocked synthesizes a blank entry for a worker who ran out of time
// (or left) without submitting, so the chain they were assigned keeps its
// structure instead of getting stuck one entry short.
func (e *Engine) fillOneLocked(workerID, ownerID string) {
	kind := "drawing"
	if e.state.Phase == PhaseGuessing {
		kind = "word"
	}
	entry := rtEntry{peerID: workerID, name: e.playerNameLocked(workerID), kind: kind}
	if kind == "word" {
		entry.word = "…"
	}
	e.pending[ownerID] = entry
	e.done[workerID] = true
}

func (e *Engine) fillMissingLocked() {
	for workerID, ownerID := range e.turnOf {
		if !e.done[workerID] {
			e.fillOneLocked(workerID, ownerID)
		}
	}
}

func (e *Engine) startStepTimerLocked(lobbyID string, phase Phase, d time.Duration) {
	e.stepTimer = time.AfterFunc(d, func() { e.expireStep(lobbyID, phase) })
}

func (e *Engine) expireStep(lobbyID string, phase Phase) {
	e.mu.Lock()
	if !e.host || e.lobbyID != lobbyID || e.state.Phase != phase {
		e.mu.Unlock()
		return
	}
	e.mu.Unlock()
	e.advanceStep(lobbyID)
}

// advanceStep commits whatever was submitted this step (filling in any
// stragglers), moves to the next phase or finishes the game, and - unless
// finished - pushes each player their next personalized turn.
func (e *Engine) advanceStep(lobbyID string) {
	e.mu.Lock()
	if !e.host || e.lobbyID != lobbyID {
		e.mu.Unlock()
		return
	}
	if e.stepTimer != nil {
		e.stepTimer.Stop()
		e.stepTimer = nil
	}
	e.fillMissingLocked()
	for ownerID, entry := range e.pending {
		if c := e.chains[ownerID]; c != nil {
			c.entries = append(c.entries, entry)
		}
	}
	e.pending = map[string]rtEntry{}
	e.done = map[string]bool{}

	finished := false
	switch e.state.Phase {
	case PhaseDrawing:
		e.reassignLocked()
		e.state.Phase = PhaseGuessing
		e.state.PassEndsAtMs = time.Now().Add(e.guessDuration).UnixMilli()
		e.startStepTimerLocked(lobbyID, PhaseGuessing, e.guessDuration)
	case PhaseGuessing:
		if e.state.Pass >= e.state.TotalPasses {
			e.finishLocked()
			finished = true
			e.publishLocked()
		} else {
			e.state.Pass++
			e.reassignLocked()
			e.state.Phase = PhaseDrawing
			e.state.PassEndsAtMs = time.Now().Add(e.drawDuration).UnixMilli()
			e.startStepTimerLocked(lobbyID, PhaseDrawing, e.drawDuration)
		}
	}
	e.mu.Unlock()
	if finished {
		e.notify()
		return
	}
	e.sendTurnMessages(lobbyID)
}

// reassignLocked picks, for every still-owned chain, a worker other than
// whoever contributed that chain's most recent entry. Every chain's most
// recent author is distinct (each step's assignment is a bijection over the
// active players), so a plain shuffle-and-swap-with-neighbour repair always
// terminates: a conflict at i can only be resolved by some order[j] with
// j != i, and since order is a permutation the only position holding
// avoid[i] is i itself, so any neighbour is automatically safe.
func (e *Engine) reassignLocked() {
	n := len(e.chainOrder)
	workers := make([]string, n)
	avoid := make([]string, n)
	for i, ownerID := range e.chainOrder {
		workers[i] = ownerID
		c := e.chains[ownerID]
		avoid[i] = c.entries[len(c.entries)-1].peerID
	}
	mrand.Shuffle(n, func(i, j int) { workers[i], workers[j] = workers[j], workers[i] })
	for i := range workers {
		if workers[i] != avoid[i] {
			continue
		}
		j := (i + 1) % n
		workers[i], workers[j] = workers[j], workers[i]
	}
	e.turnOf = make(map[string]string, n)
	e.workerOf = make(map[string]string, n)
	for i, ownerID := range e.chainOrder {
		e.turnOf[ownerID] = workers[i]
		e.workerOf[workers[i]] = ownerID
	}
}

func (e *Engine) buildPromptsLocked() map[string]*Prompt {
	out := make(map[string]*Prompt, len(e.turnOf))
	for ownerID, workerID := range e.turnOf {
		c := e.chains[ownerID]
		last := c.entries[len(c.entries)-1]
		if e.state.Phase == PhaseDrawing {
			out[workerID] = &Prompt{Kind: "word", Word: last.word}
		} else {
			out[workerID] = &Prompt{
				Kind: "drawing", Strokes: cloneStrokes(last.strokes),
				FromPeerID: last.peerID, FromName: last.name,
			}
		}
	}
	return out
}

// sendTurnMessages pushes each peer their own Prompt for the step already
// committed to e.state, applies the host's own Prompt directly, and
// publishes the shared (prompt-redacted) snapshot. Must be called without
// the lock held.
func (e *Engine) sendTurnMessages(lobbyID string) {
	e.mu.Lock()
	if !e.host || e.lobbyID != lobbyID {
		e.mu.Unlock()
		return
	}
	prompts := e.buildPromptsLocked()
	phase, pass, total, endsAt := e.state.Phase, e.state.Pass, e.state.TotalPasses, e.state.PassEndsAtMs
	players := clonePlayers(e.state.Players)
	peerAddrs := make(map[string]string, len(e.peerAddrs))
	for k, v := range e.peerAddrs {
		peerAddrs[k] = v
	}
	selfID := e.selfID
	sendStart := e.sendStart
	e.mu.Unlock()

	var wg sync.WaitGroup
	for peerID, addr := range peerAddrs {
		if peerID == selfID {
			continue
		}
		wg.Add(1)
		go func(peerID, addr string) {
			defer wg.Done()
			payload := turnPayload{
				Phase: phase, Pass: pass, TotalPasses: total, PassEndsAtMs: endsAt,
				Prompt: prompts[peerID], Players: players,
			}
			_ = sendStart(addr, lobbyID, mustMarshal(payload))
		}(peerID, addr)
	}
	wg.Wait()

	e.mu.Lock()
	if e.lobbyID == lobbyID {
		e.state.Prompt = prompts[selfID]
		e.publishLocked()
	}
	e.mu.Unlock()
	e.notify()
}

func (e *Engine) finishLocked() {
	e.state.Phase = PhaseFinished
	e.state.Prompt = nil
	chains := make([]Chain, len(e.chainOrder))
	for i, ownerID := range e.chainOrder {
		c := e.chains[ownerID]
		entries := make([]Entry, len(c.entries))
		for j, re := range c.entries {
			entries[j] = Entry{
				PeerID: re.peerID, Name: re.name, Kind: re.kind, Word: re.word,
				Strokes: cloneStrokes(re.strokes), Final: j == len(c.entries)-1,
			}
		}
		chains[i] = Chain{OwnerID: c.ownerID, OwnerName: c.ownerName, Entries: entries}
	}
	e.state.Chains = chains
}

func (e *Engine) publishLocked() {
	if !e.host || e.publish == nil {
		return
	}
	redacted := cloneState(e.state)
	redacted.Prompt = nil
	payload, err := json.Marshal(redacted)
	if err != nil {
		return
	}
	e.publish(false, e.lobbyID, payload)
}

// ApplyEvent absorbs a broadcast snapshot received over the shared lobby
// subscription, for a guest tracking the host's game. The host always
// redacts Prompt in what it broadcasts, so a player's own locally-learned
// prompt (from BeginGuest/HandleStart) must survive these snapshots.
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
	prompt := e.state.Prompt
	e.state.Phase = snap.Phase
	e.state.Pass = snap.Pass
	e.state.TotalPasses = snap.TotalPasses
	e.state.PassEndsAtMs = snap.PassEndsAtMs
	e.state.Waiting = snap.Waiting
	e.state.Players = clonePlayers(snap.Players)
	e.state.Chains = snap.Chains
	e.state.Prompt = prompt
	if snap.Phase == PhaseFinished {
		e.state.Prompt = nil
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
	if e.state.Phase != PhaseDrawing && e.state.Phase != PhaseGuessing {
		e.mu.Unlock()
		return
	}
	if e.host {
		e.publishDisbandLocked()
	}
	e.resetLocked()
	e.mu.Unlock()
	e.notify()
}

func (e *Engine) publishDisbandLocked() {
	if e.publish == nil {
		return
	}
	e.publish(true, e.lobbyID, mustMarshal(struct{}{}))
}

func (e *Engine) resetLocked() {
	if e.stepTimer != nil {
		e.stepTimer.Stop()
		e.stepTimer = nil
	}
	e.host = false
	e.hostAddr = ""
	e.lobbyID = ""
	e.peerAddrs = nil
	e.chainOrder = nil
	e.chains = nil
	e.turnOf = nil
	e.workerOf = nil
	e.done = nil
	e.pending = nil
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

func (e *Engine) playerNameLocked(peerID string) string {
	if i := e.playerIndexLocked(peerID); i >= 0 {
		return e.state.Players[i].Name
	}
	return ""
}

func (e *Engine) removePlayerLocked(i int) {
	delete(e.peerAddrs, e.state.Players[i].PeerID)
	e.state.Players = append(e.state.Players[:i:i], e.state.Players[i+1:]...)
}

func pickWords(n int) []string {
	available := append([]string(nil), words...)
	mrand.Shuffle(len(available), func(i, j int) { available[i], available[j] = available[j], available[i] })
	out := make([]string, n)
	for i := range out {
		out[i] = available[i%len(available)]
	}
	return out
}

func capStrokes(strokes []Stroke) []Stroke {
	total := 0
	for _, s := range strokes {
		total += len(s.Points)
	}
	for total > maxPointsPerDrawing && len(strokes) > 0 {
		total -= len(strokes[0].Points)
		strokes = strokes[1:]
	}
	return strokes
}

func removeStr(list []string, v string) []string {
	out := make([]string, 0, len(list))
	for _, x := range list {
		if x != v {
			out = append(out, x)
		}
	}
	return out
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
	s.Waiting = append([]PlayerStatus(nil), s.Waiting...)
	if s.Prompt != nil {
		p := *s.Prompt
		p.Strokes = cloneStrokes(s.Prompt.Strokes)
		s.Prompt = &p
	}
	if s.Chains != nil {
		chains := make([]Chain, len(s.Chains))
		for i, c := range s.Chains {
			entries := make([]Entry, len(c.Entries))
			for j, en := range c.Entries {
				en.Strokes = cloneStrokes(en.Strokes)
				entries[j] = en
			}
			c.Entries = entries
			chains[i] = c
		}
		s.Chains = chains
	}
	return s
}

func clonePlayers(in []Player) []Player {
	out := make([]Player, len(in))
	copy(out, in)
	return out
}

func cloneStrokes(in []Stroke) []Stroke {
	if in == nil {
		return nil
	}
	out := make([]Stroke, len(in))
	for i, s := range in {
		s.Points = append([]Point(nil), s.Points...)
		out[i] = s
	}
	return out
}
