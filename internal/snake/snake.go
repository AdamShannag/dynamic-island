// Package snake is the slither.io-style multiplayer gameplay engine. It owns
// no lobby, discovery or transport of its own - internal/party hands it a
// roster and a shared lobby.Server-backed publish/send pair once a lobby's
// host picks snake and starts.
package snake

import (
	"encoding/json"
	"fmt"
	"math"
	mrand "math/rand/v2"
	"sync"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/lobby"
)

type Phase string

const (
	PhaseIdle     Phase = "idle"
	PhasePlaying  Phase = "playing"
	PhaseFinished Phase = "finished"
)

const (
	// 30Hz keeps turning and collisions responsive: at 15Hz a mouse turn
	// could take up to ~66ms just to be picked up by the next tick, on top
	// of the input throttle, which read as sluggish.
	tickRate     = 30
	tickInterval = time.Second / tickRate
	// The viewport only ever shows a window a few hundred units wide, so a
	// world several times that lets players spend an entire short match
	// without ever coming within sight of anyone else. Sized so a couple of
	// players starting on opposite sides of the spawn circle cross paths
	// within a few seconds rather than wandering a mostly empty map.
	worldW         = 1200.0
	worldH         = 900.0
	moveSpeed      = 170.0
	segmentSpacing = moveSpeed / tickRate
	turnRate       = 3.6 * math.Pi

	startSegments = 20
	foodCount     = 30
	foodRadius    = 14.0
	// World units map 1:1 to screen pixels (the client applies no zoom), so
	// this has to track what's actually drawn to feel fair: a 6px head
	// radius plus a 9px-wide body line is an edge-to-edge touch at ~10.5
	// units between centers. The old 14 gave snakes an effectively 33%
	// wider hitbox than their rendered width, which is why collisions could
	// look like they happened with empty space in between.
	collisionRadius = 10.5
	growthPerFood   = segmentSpacing * 3
	// ~60 world units of neck, in segments at the current spacing - how far
	// the head must travel before its own body becomes collidable.
	selfCollisionSkip = 12
	deathFoodEvery    = 5
)

type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type Food struct {
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Value int     `json:"value"`
}

type Player struct {
	PeerID string `json:"peerId"`
	Name   string `json:"name"`
}

type SnakePlayer struct {
	PeerID string  `json:"peerId"`
	Name   string  `json:"name"`
	Alive  bool    `json:"alive"`
	Score  int     `json:"score"`
	Body   []Point `json:"body"`
}

type State struct {
	Phase   Phase         `json:"phase"`
	WorldW  float64       `json:"worldW"`
	WorldH  float64       `json:"worldH"`
	Food    []Food        `json:"food"`
	Players []SnakePlayer `json:"players"`
}

type inputPayload struct {
	Heading float64 `json:"heading"`
}

type runtimeSnake struct {
	peerID        string
	name          string
	alive         bool
	score         int
	heading       float64
	targetHeading float64
	length        float64
	body          []Point
}

type Engine struct {
	selfID   string
	selfName string

	mu        sync.Mutex
	state     State
	host      bool
	hostAddr  string
	lobbyID   string
	peerAddrs map[string]string
	snakes    []*runtimeSnake
	stopTick  chan struct{}
	onChange  func(State)

	publish   func(disband bool, lobbyID string, payload json.RawMessage)
	sendStart func(addr, lobbyID string, payload json.RawMessage) error
}

func NewEngine(selfID, selfName string) *Engine {
	return &Engine{
		selfID:   selfID,
		selfName: selfName,
		state:    State{Phase: PhaseIdle},
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

// BeginHost starts a match for the host: players is the accepted roster,
// peerAddrs resolves each non-self player's address for input/start
// delivery, publish broadcasts state to the shared lobby, and sendStart
// delivers the initial world snapshot to each guest.
func (e *Engine) BeginHost(lobbyID string, players []Player, peerAddrs map[string]string,
	publish func(bool, string, json.RawMessage), sendStart func(addr, lobbyID string, payload json.RawMessage) error) error {
	if len(players) == 0 {
		return fmt.Errorf("snake: no accepted players")
	}

	e.mu.Lock()
	e.host = true
	e.hostAddr = ""
	e.lobbyID = lobbyID
	e.peerAddrs = peerAddrs
	e.publish = publish
	e.sendStart = sendStart
	e.snakes = spawnSnakes(players)
	e.state = State{
		Phase:   PhasePlaying,
		WorldW:  worldW,
		WorldH:  worldH,
		Food:    spawnFood(),
		Players: snapshotPlayers(e.snakes),
	}
	stop := make(chan struct{})
	e.stopTick = stop
	snap := cloneState(e.state)
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
			sendWithRetry(sendStart, addr, lobbyID, mustMarshal(snap))
		}(addr)
	}
	wg.Wait()

	e.mu.Lock()
	if e.lobbyID == lobbyID {
		e.publishLocked(false)
	}
	e.mu.Unlock()

	go e.runTicks(lobbyID, stop)
	return nil
}

// BeginGuest starts a match for a guest once the host's initial world
// snapshot arrives.
func (e *Engine) BeginGuest(lobbyID, hostAddr string, payload json.RawMessage) error {
	var snap State
	if err := json.Unmarshal(payload, &snap); err != nil || snap.Phase == "" {
		return lobby.ErrRejected
	}
	e.mu.Lock()
	e.host = false
	e.hostAddr = hostAddr
	e.lobbyID = lobbyID
	e.state = snap
	e.mu.Unlock()
	e.notify()
	return nil
}

// HandleStart exists so party's dispatch has one shape for every engine;
// snake has no mid-game round transitions, so there is nothing to do once
// the match has already begun.
func (e *Engine) HandleStart(json.RawMessage) error { return nil }

// HandleInput submits peerID's desired heading, in radians. When the local
// engine is host, this applies directly, whether peerID is the host's own
// selfID or a remote peer's id already authenticated by party's progress
// handling. When the local engine is a guest, peerID must be the guest's own
// selfID, and the heading is relayed to the host over the shared progress
// channel rather than applied locally (the host is authoritative).
func (e *Engine) HandleInput(peerID string, heading float64) error {
	e.mu.Lock()
	if e.state.Phase != PhasePlaying {
		e.mu.Unlock()
		return fmt.Errorf("snake: not playing")
	}
	host := e.host
	selfID := e.selfID
	hostAddr := e.hostAddr
	lobbyID := e.lobbyID
	e.mu.Unlock()

	if host {
		return e.applyInput(lobbyID, peerID, heading)
	}
	if peerID != selfID {
		return fmt.Errorf("snake: guest cannot submit input for another peer")
	}
	return lobby.SendProgress(hostAddr, lobby.Progress{
		LobbyID: lobbyID,
		PeerID:  selfID,
		Payload: mustMarshal(inputPayload{Heading: heading}),
	})
}

func (e *Engine) applyInput(lobbyID, peerID string, heading float64) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.host || e.lobbyID != lobbyID || e.state.Phase != PhasePlaying {
		return fmt.Errorf("snake: not playing")
	}
	for _, s := range e.snakes {
		if s.peerID == peerID {
			s.targetHeading = heading
			return nil
		}
	}
	return fmt.Errorf("snake: unknown player %q", peerID)
}

func (e *Engine) runTicks(lobbyID string, stop chan struct{}) {
	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			if !e.tick(lobbyID) {
				return
			}
		}
	}
}

func (e *Engine) tick(lobbyID string) bool {
	e.mu.Lock()
	if !e.host || e.lobbyID != lobbyID || e.state.Phase != PhasePlaying {
		e.mu.Unlock()
		return false
	}
	finished := e.stepLocked()
	e.publishLocked(false)
	e.mu.Unlock()
	e.notify()
	return !finished
}

func (e *Engine) stepLocked() bool {
	dt := tickInterval.Seconds()
	for _, s := range e.snakes {
		if !s.alive {
			continue
		}
		s.heading = turnToward(s.heading, s.targetHeading, turnRate*dt)
		head := s.body[0]
		next := Point{
			X: head.X + math.Cos(s.heading)*segmentSpacing,
			Y: head.Y + math.Sin(s.heading)*segmentSpacing,
		}
		s.body = append([]Point{next}, s.body...)
		if maxPoints := int(s.length/segmentSpacing) + 1; len(s.body) > maxPoints {
			s.body = s.body[:maxPoints]
		}
	}

	for _, s := range e.snakes {
		if !s.alive {
			continue
		}
		head := s.body[0]
		if head.X < 0 || head.X > worldW || head.Y < 0 || head.Y > worldH {
			e.killLocked(s)
			continue
		}
		for i := range e.state.Food {
			f := &e.state.Food[i]
			if dist(head, Point{X: f.X, Y: f.Y}) <= foodRadius {
				s.length += growthPerFood
				s.score += f.Value
				*f = randomFood()
			}
		}
		if !s.alive {
			continue
		}
		e.checkCollisionsLocked(s)
	}

	e.state.Players = snapshotPlayers(e.snakes)

	alive := 0
	for _, s := range e.snakes {
		if s.alive {
			alive++
		}
	}
	if alive == 0 || (len(e.snakes) > 1 && alive <= 1) {
		e.finishLocked()
		return true
	}
	return false
}

func (e *Engine) checkCollisionsLocked(s *runtimeSnake) {
	head := s.body[0]
	for _, other := range e.snakes {
		if other == s || !other.alive {
			continue
		}
		for _, bp := range other.body {
			if dist(head, bp) <= collisionRadius {
				e.killLocked(s)
				return
			}
		}
	}
	if len(s.body) <= selfCollisionSkip+1 {
		return
	}
	for _, bp := range s.body[selfCollisionSkip:] {
		if dist(head, bp) <= collisionRadius {
			e.killLocked(s)
			return
		}
	}
}

func (e *Engine) killLocked(s *runtimeSnake) {
	s.alive = false
	for i := 0; i < len(s.body); i += deathFoodEvery {
		p := s.body[i]
		e.state.Food = append(e.state.Food, Food{X: p.X, Y: p.Y, Value: 1})
	}
}

func (e *Engine) finishLocked() {
	e.state.Phase = PhaseFinished
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
// subscription, for a guest tracking the host's match.
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
	e.state = snap
	e.mu.Unlock()
	e.notify()
}

// FinishedIfClosed reports whether the match should be treated as finished
// (rather than host-left) now that the shared subscription has closed.
func (e *Engine) FinishedIfClosed() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.state.Phase == PhaseFinished
}

// Leave ends the engine's own participation in an in-progress match; the
// caller (party) is responsible for the lobby-level cleanup.
func (e *Engine) Leave() {
	e.mu.Lock()
	if e.state.Phase != PhasePlaying {
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
	if e.stopTick != nil {
		close(e.stopTick)
		e.stopTick = nil
	}
	e.host = false
	e.hostAddr = ""
	e.lobbyID = ""
	e.peerAddrs = nil
	e.snakes = nil
	e.publish = nil
	e.sendStart = nil
	e.state = State{Phase: PhaseIdle}
}

func spawnSnakes(players []Player) []*runtimeSnake {
	out := make([]*runtimeSnake, len(players))
	n := len(players)
	cx, cy := worldW/2, worldH/2
	radius := math.Min(worldW, worldH) * 0.25
	for i, p := range players {
		angle := 2 * math.Pi * float64(i) / float64(n)
		hx := cx + radius*math.Cos(angle)
		hy := cy + radius*math.Sin(angle)
		heading := angle + math.Pi
		length := float64(startSegments) * segmentSpacing
		body := make([]Point, startSegments)
		for j := 0; j < startSegments; j++ {
			d := float64(j) * segmentSpacing
			body[j] = Point{X: hx - math.Cos(heading)*d, Y: hy - math.Sin(heading)*d}
		}
		out[i] = &runtimeSnake{
			peerID: p.PeerID, name: p.Name, alive: true,
			heading: heading, targetHeading: heading,
			length: length, body: body,
		}
	}
	return out
}

func spawnFood() []Food {
	out := make([]Food, foodCount)
	for i := range out {
		out[i] = randomFood()
	}
	return out
}

func randomFood() Food {
	return Food{X: mrand.Float64() * worldW, Y: mrand.Float64() * worldH, Value: 1}
}

func turnToward(current, target, maxDelta float64) float64 {
	diff := normalizeAngle(target - current)
	switch {
	case diff > maxDelta:
		diff = maxDelta
	case diff < -maxDelta:
		diff = -maxDelta
	}
	return normalizeAngle(current + diff)
}

func normalizeAngle(a float64) float64 {
	for a > math.Pi {
		a -= 2 * math.Pi
	}
	for a < -math.Pi {
		a += 2 * math.Pi
	}
	return a
}

func dist(a, b Point) float64 {
	return math.Hypot(a.X-b.X, a.Y-b.Y)
}

func mustMarshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

var sendStartRetryDelays = []time.Duration{150 * time.Millisecond, 400 * time.Millisecond}

// sendWithRetry tries sendStart up to len(sendStartRetryDelays)+1 times,
// pausing briefly between attempts, before giving up silently (the same
// best-effort contract the caller already had) - a transient LAN drop of
// the one-time initial snapshot otherwise left a guest's snake stuck on
// nothing forever.
func sendWithRetry(sendStart func(addr, lobbyID string, payload json.RawMessage) error, addr, lobbyID string, payload json.RawMessage) {
	if sendStart(addr, lobbyID, payload) == nil {
		return
	}
	for _, delay := range sendStartRetryDelays {
		time.Sleep(delay)
		if sendStart(addr, lobbyID, payload) == nil {
			return
		}
	}
}

func snapshotPlayers(snakes []*runtimeSnake) []SnakePlayer {
	out := make([]SnakePlayer, len(snakes))
	for i, s := range snakes {
		out[i] = SnakePlayer{PeerID: s.peerID, Name: s.name, Alive: s.alive, Score: s.score, Body: clonePoints(s.body)}
	}
	return out
}

func cloneState(s State) State {
	s.Food = append([]Food(nil), s.Food...)
	s.Players = clonePlayers(s.Players)
	return s
}

func clonePlayers(in []SnakePlayer) []SnakePlayer {
	out := make([]SnakePlayer, len(in))
	for i, p := range in {
		p.Body = clonePoints(p.Body)
		out[i] = p
	}
	return out
}

func clonePoints(in []Point) []Point {
	return append([]Point(nil), in...)
}
