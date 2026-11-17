package snake_test

import (
	"encoding/json"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/snake"
)

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not met within deadline")
}

type fakeTransport struct {
	mu        sync.Mutex
	published []json.RawMessage
	started   map[string]json.RawMessage
}

func newFakeTransport() *fakeTransport {
	return &fakeTransport{started: map[string]json.RawMessage{}}
}

func (f *fakeTransport) publish(_ bool, _ string, payload json.RawMessage) {
	f.mu.Lock()
	f.published = append(f.published, payload)
	f.mu.Unlock()
}

func (f *fakeTransport) sendStart(addr, _ string, payload json.RawMessage) error {
	f.mu.Lock()
	f.started[addr] = payload
	f.mu.Unlock()
	return nil
}

func playerByID(s snake.State, id string) (snake.SnakePlayer, bool) {
	for _, p := range s.Players {
		if p.PeerID == id {
			return p, true
		}
	}
	return snake.SnakePlayer{}, false
}

func headingTo(from, to snake.Point) float64 {
	return math.Atan2(to.Y-from.Y, to.X-from.X)
}

func nearestFood(head snake.Point, food []snake.Food) snake.Point {
	best := snake.Point{X: food[0].X, Y: food[0].Y}
	bestDist := math.Hypot(best.X-head.X, best.Y-head.Y)
	for _, f := range food[1:] {
		p := snake.Point{X: f.X, Y: f.Y}
		if d := math.Hypot(p.X-head.X, p.Y-head.Y); d < bestDist {
			bestDist = d
			best = p
		}
	}
	return best
}

func TestBeginHostRequiresAtLeastOnePlayer(t *testing.T) {
	host := snake.NewEngine("h1", "Host")
	tr := newFakeTransport()
	if err := host.BeginHost("lobby1", nil, nil, tr.publish, tr.sendStart); err == nil {
		t.Fatal("expected an error with no accepted players")
	}
}

func TestBeginHostSendsTheWorldSnapshotToEveryGuest(t *testing.T) {
	host := snake.NewEngine("h1", "Host")
	tr := newFakeTransport()
	players := []snake.Player{{PeerID: "h1", Name: "Host"}, {PeerID: "g1", Name: "Guest"}}
	peerAddrs := map[string]string{"h1": "127.0.0.1:1", "g1": "127.0.0.1:2"}
	if err := host.BeginHost("lobby1", players, peerAddrs, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}
	if host.State().Phase != snake.PhasePlaying {
		t.Fatalf("phase = %v, want playing", host.State().Phase)
	}
	if _, ok := tr.started["127.0.0.1:2"]; !ok {
		t.Fatal("expected a start message sent to the guest")
	}
	if _, ok := tr.started["127.0.0.1:1"]; ok {
		t.Fatal("the host must not send itself a start message")
	}
}

func TestSoloSnakeMovesForwardAndGrowsAfterEatingFood(t *testing.T) {
	host := snake.NewEngine("h1", "Host")
	tr := newFakeTransport()
	players := []snake.Player{{PeerID: "h1", Name: "Host"}}
	if err := host.BeginHost("lobby1", players, map[string]string{}, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}

	p0, ok := playerByID(host.State(), "h1")
	if !ok || len(p0.Body) == 0 {
		t.Fatal("expected the host's snake to have a body")
	}
	head0 := p0.Body[0]

	waitFor(t, 5*time.Second, func() bool {
		p, ok := playerByID(host.State(), "h1")
		return ok && len(p.Body) > 0 && (p.Body[0].X != head0.X || p.Body[0].Y != head0.Y)
	})

	// Re-target the nearest food every poll, not just once from head0: with
	// 50 randomly placed pellets the one nearest the start can occasionally
	// be far enough that chasing a single fixed point risks missing a short
	// deadline, which made this test genuinely flaky under -race. Always
	// steering toward whatever is currently closest converges quickly and
	// deterministically regardless of the random layout.
	var bodyLenAtEat int
	waitFor(t, 15*time.Second, func() bool {
		s := host.State()
		p, ok := playerByID(s, "h1")
		if !ok || len(p.Body) == 0 {
			return false
		}
		if p.Score > 0 {
			bodyLenAtEat = len(p.Body)
			return true
		}
		target := nearestFood(p.Body[0], s.Food)
		_ = host.HandleInput("h1", headingTo(p.Body[0], target))
		return false
	})

	waitFor(t, 2*time.Second, func() bool {
		p, _ := playerByID(host.State(), "h1")
		return len(p.Body) > bodyLenAtEat
	})
}

func TestCollisionMarksTheOtherSnakeDeadAndDropsFood(t *testing.T) {
	host := snake.NewEngine("h1", "Host")
	tr := newFakeTransport()
	players := []snake.Player{{PeerID: "h1", Name: "Host"}, {PeerID: "g1", Name: "Guest"}}
	if err := host.BeginHost("lobby1", players, map[string]string{"g1": "127.0.0.1:1"}, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}

	st := host.State()
	h1, _ := playerByID(st, "h1")
	g1, _ := playerByID(st, "g1")
	foodBefore := len(st.Food)

	if err := host.HandleInput("h1", headingTo(h1.Body[0], g1.Body[0])); err != nil {
		t.Fatal(err)
	}
	if err := host.HandleInput("g1", headingTo(g1.Body[0], h1.Body[0])); err != nil {
		t.Fatal(err)
	}

	waitFor(t, 10*time.Second, func() bool {
		st := host.State()
		a, _ := playerByID(st, "h1")
		b, _ := playerByID(st, "g1")
		return !a.Alive || !b.Alive
	})

	st = host.State()
	a, _ := playerByID(st, "h1")
	b, _ := playerByID(st, "g1")
	if a.Alive && b.Alive {
		t.Fatal("expected one of the colliding snakes to die")
	}
	if len(st.Food) <= foodBefore {
		t.Fatalf("expected the collision to drop extra food, before=%d after=%d", foodBefore, len(st.Food))
	}
}

func TestMatchFinishesAfterTheConfiguredDuration(t *testing.T) {
	host := snake.NewEngine("h1", "Host")
	host.SetMatchDuration(150 * time.Millisecond)
	tr := newFakeTransport()
	players := []snake.Player{{PeerID: "h1", Name: "Host"}}
	if err := host.BeginHost("lobby1", players, map[string]string{}, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 3*time.Second, func() bool { return host.State().Phase == snake.PhaseFinished })
}

func TestLastSnakeStandingEndsTheMatchEarly(t *testing.T) {
	host := snake.NewEngine("h1", "Host")
	host.SetMatchDuration(time.Minute)
	tr := newFakeTransport()
	players := []snake.Player{{PeerID: "h1", Name: "Host"}, {PeerID: "g1", Name: "Guest"}}
	if err := host.BeginHost("lobby1", players, map[string]string{"g1": "127.0.0.1:1"}, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}

	st := host.State()
	g, _ := playerByID(st, "g1")
	wallHeading := 0.0
	if g.Body[0].X < st.WorldW/2 {
		wallHeading = math.Pi
	}
	if err := host.HandleInput("g1", wallHeading); err != nil {
		t.Fatal(err)
	}

	waitFor(t, 15*time.Second, func() bool { return host.State().Phase == snake.PhaseFinished })

	st = host.State()
	h, _ := playerByID(st, "h1")
	if !h.Alive {
		t.Fatal("the surviving snake should still be marked alive when the match ends early")
	}
}

func TestApplyEventIgnoredOnTheHost(t *testing.T) {
	host := snake.NewEngine("h1", "Host")
	tr := newFakeTransport()
	players := []snake.Player{{PeerID: "h1", Name: "Host"}}
	if err := host.BeginHost("lobby1", players, map[string]string{}, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}
	before := host.State()
	b, _ := json.Marshal(snake.State{Phase: snake.PhaseFinished})
	host.ApplyEvent(b)
	if host.State().Phase != before.Phase {
		t.Fatal("ApplyEvent must be a no-op on the host, which is authoritative over its own state")
	}
}

func TestLeaveDuringMatchResetsToIdle(t *testing.T) {
	g := snake.NewEngine("g1", "Guest")
	payload, _ := json.Marshal(snake.State{Phase: snake.PhasePlaying, WorldW: 2400, WorldH: 1800})
	if err := g.BeginGuest("lobby1", "127.0.0.1:1", payload); err != nil {
		t.Fatal(err)
	}
	g.Leave()
	if g.State().Phase != snake.PhaseIdle {
		t.Fatalf("phase = %v, want idle after Leave", g.State().Phase)
	}
}
