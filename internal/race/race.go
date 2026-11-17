// Package race is the typing-race gameplay engine. It owns no lobby,
// discovery or transport of its own - internal/party hands it a roster and
// a shared lobby.Server-backed publish/send pair once a lobby's host picks
// race and starts.
package race

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/AdamShannag/dynamic-island/internal/lobby"
)

type Phase string

const (
	PhaseIdle     Phase = "idle"
	PhaseRacing   Phase = "racing"
	PhaseFinished Phase = "finished"
)

const defaultRaceTimeout = 3 * time.Minute

type Racer struct {
	PeerID       string  `json:"peerId"`
	Name         string  `json:"name"`
	Status       string  `json:"status"`
	Progress     float64 `json:"progress"`
	FinishedAtMs int64   `json:"finishedAtMs"`
	WPM          float64 `json:"wpm"`
}

type State struct {
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

	raceTimeout time.Duration

	mu            sync.Mutex
	state         State
	host          bool
	hostAddr      string
	lobbyID       string
	peerAddrs     map[string]string
	raceTimer     *time.Timer
	raceStartedAt time.Time
	onChange      func(State)

	publish   func(disband bool, lobbyID string, payload json.RawMessage)
	sendStart func(addr, lobbyID string, payload json.RawMessage) error
}

func NewEngine(selfID, selfName string) *Engine {
	return &Engine{
		selfID:      selfID,
		selfName:    selfName,
		raceTimeout: defaultRaceTimeout,
		state:       State{Phase: PhaseIdle},
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

// BeginHost starts a race for the host: racers is the accepted roster,
// peerAddrs resolves each non-self racer's address for progress/start
// delivery, publish broadcasts state to the shared lobby, and sendStart
// delivers the initial passage to each guest.
func (e *Engine) BeginHost(lobbyID string, racers []Racer, peerAddrs map[string]string,
	publish func(bool, string, json.RawMessage), sendStart func(addr, lobbyID string, payload json.RawMessage) error) error {
	if len(racers) == 0 {
		return fmt.Errorf("race: no accepted racers")
	}
	passage := randomPassage()

	e.mu.Lock()
	e.host = true
	e.hostAddr = ""
	e.lobbyID = lobbyID
	e.peerAddrs = peerAddrs
	e.publish = publish
	e.sendStart = sendStart
	e.state = State{Phase: PhaseRacing, Passage: passage, Racers: cloneRacers(racers)}
	e.raceStartedAt = time.Now()
	e.raceTimer = time.AfterFunc(e.raceTimeout, func() { e.expire(lobbyID) })
	e.mu.Unlock()
	e.notify()

	var wg sync.WaitGroup
	for peerID, addr := range peerAddrs {
		if peerID == e.selfID {
			continue
		}
		wg.Add(1)
		go func(addr string) {
			defer wg.Done()
			_ = sendStart(addr, lobbyID, mustMarshal(passage))
		}(addr)
	}
	wg.Wait()

	e.mu.Lock()
	if e.lobbyID == lobbyID {
		e.publishLocked(false)
	}
	e.mu.Unlock()
	return nil
}

// BeginGuest starts a race for a guest once the host's initial start
// message arrives; payload is the engine-specific part already unwrapped
// by party.
func (e *Engine) BeginGuest(lobbyID, hostAddr string, payload json.RawMessage) error {
	var passage string
	if err := json.Unmarshal(payload, &passage); err != nil || passage == "" {
		return lobby.ErrRejected
	}
	e.mu.Lock()
	e.host = false
	e.hostAddr = hostAddr
	e.lobbyID = lobbyID
	e.state = State{Phase: PhaseRacing, Passage: passage}
	e.mu.Unlock()
	e.notify()
	return nil
}

// HandleStart exists so party's dispatch has one shape for both engines;
// race has no mid-game round transitions, so there is nothing to do once
// racing has already begun.
func (e *Engine) HandleStart(json.RawMessage) error { return nil }

func (e *Engine) expire(lobbyID string) {
	e.mu.Lock()
	if !e.host || e.lobbyID != lobbyID || e.state.Phase != PhaseRacing {
		e.mu.Unlock()
		return
	}
	e.endRaceLocked()
	e.mu.Unlock()
	e.notify()
}

func (e *Engine) HandleRespond(r lobby.Response) error {
	e.mu.Lock()
	idx := -1
	if e.host && e.lobbyID == r.LobbyID {
		idx = e.racerIndexLocked(r.PeerID)
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
	e.removeRacerLocked(idx)
	e.finishIfDoneLocked()
	e.mu.Unlock()
	e.notify()
	return nil
}

func (e *Engine) SubmitProgress(typedChars int) error {
	e.mu.Lock()
	if e.state.Phase != PhaseRacing {
		e.mu.Unlock()
		return fmt.Errorf("race: not racing")
	}
	host := e.host
	selfID := e.selfID
	hostAddr := e.hostAddr
	lobbyID := e.lobbyID
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

func (e *Engine) HandleProgress(p lobby.Progress) error {
	var payload progressPayload
	if err := json.Unmarshal(p.Payload, &payload); err != nil {
		return lobby.ErrRejected
	}
	if !e.applyProgress(p.LobbyID, p.PeerID, payload.TypedChars) {
		return lobby.ErrClosed
	}
	return nil
}

func (e *Engine) applyProgress(lobbyID, peerID string, typedChars int) bool {
	e.mu.Lock()
	idx := -1
	if e.host && e.lobbyID == lobbyID && e.state.Phase == PhaseRacing {
		idx = e.racerIndexLocked(peerID)
	}
	passageLen := utf8.RuneCountInString(e.state.Passage)
	if idx == -1 || passageLen == 0 {
		e.mu.Unlock()
		return false
	}

	typed := min(max(typedChars, 0), passageLen)
	e.state.Racers[idx].Progress = float64(typed) / float64(passageLen)
	if typed == passageLen && e.state.Racers[idx].FinishedAtMs == 0 {
		e.state.Racers[idx].FinishedAtMs = time.Now().UnixMilli()
		if minutes := time.Since(e.raceStartedAt).Minutes(); minutes > 0 {
			e.state.Racers[idx].WPM = (float64(typed) / 5) / minutes
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
	e.publishLocked(false)
}

func (e *Engine) publishLocked(disband bool) {
	if !e.host || e.publish == nil {
		return
	}
	payload, err := json.Marshal(e.state)
	if err != nil {
		return
	}
	e.publish(disband, e.lobbyID, payload)
}

// ApplyEvent absorbs a broadcast snapshot received over the shared lobby
// subscription, for a guest tracking the host's race.
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
	e.state.Racers = cloneRacers(snap.Racers)
	switch {
	case e.state.Phase == PhaseRacing && snap.Phase == PhaseFinished:
		e.state.Phase = PhaseFinished
	}
	e.mu.Unlock()
	e.notify()
}

// FinishedIfClosed reports whether the race should be treated as finished
// (rather than host-left) now that the shared subscription has closed.
func (e *Engine) FinishedIfClosed() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return allRacersFinished(e.state.Racers)
}

// Leave ends the engine's own participation in an in-progress race; the
// caller (party) is responsible for the lobby-level cleanup.
func (e *Engine) Leave() {
	e.mu.Lock()
	if e.state.Phase != PhaseRacing {
		e.mu.Unlock()
		return
	}
	if e.host {
		e.publishLocked(true)
	}
	e.resetLocked()
	e.mu.Unlock()
	e.notify()
}

func (e *Engine) resetLocked() {
	if e.raceTimer != nil {
		e.raceTimer.Stop()
		e.raceTimer = nil
	}
	e.host = false
	e.hostAddr = ""
	e.lobbyID = ""
	e.peerAddrs = nil
	e.publish = nil
	e.sendStart = nil
	e.state = State{Phase: PhaseIdle}
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

func cloneState(s State) State {
	s.Racers = cloneRacers(s.Racers)
	return s
}

func cloneRacers(in []Racer) []Racer {
	out := make([]Racer, len(in))
	copy(out, in)
	return out
}
