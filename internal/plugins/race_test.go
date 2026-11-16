package plugins

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/island"
	"github.com/AdamShannag/dynamic-island/internal/race"
	"github.com/AdamShannag/dynamic-island/internal/settings"
)

type fakeHost struct {
	mu         sync.Mutex
	acts       map[string]island.Activity
	presenting bool
}

func (h *fakeHost) Set(a island.Activity) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.acts == nil {
		h.acts = map[string]island.Activity{}
	}
	h.acts[a.ID] = a
}

func (h *fakeHost) Clear(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.acts, id)
}

func (h *fakeHost) ClearPrefix(prefix string) {}

func (h *fakeHost) HandleAction(name string, fn func()) {}

func (h *fakeHost) Presenting() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.presenting
}

func (h *fakeHost) activity(id string) (island.Activity, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	a, ok := h.acts[id]
	return a, ok
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("condition not met within deadline")
}

func TestRaceSummary(t *testing.T) {
	cases := []struct {
		s    race.State
		want string
	}{
		{race.State{Phase: race.PhaseLobby, Racers: []race.Racer{{Status: "accepted"}, {Status: "pending"}, {Status: "accepted"}}}, "Race: 2/3 ready"},
		{race.State{Phase: race.PhaseRacing, Racers: []race.Racer{{Progress: 1}, {Progress: 0.4}}}, "Racing — 70%"},
		{race.State{Phase: race.PhaseHostLeft}, "Race ended: host left"},
		{race.State{Phase: race.PhaseFinished}, "Race finished"},
		{race.State{Phase: race.PhaseMissed}, "Race already started"},
	}
	for _, c := range cases {
		if got := raceSummary(c.s); got != c.want {
			t.Errorf("raceSummary(%+v) = %q, want %q", c.s, got, c.want)
		}
	}
}

func TestNoActivityWhilePresenting(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	h := &fakeHost{presenting: true}
	r := NewRace("h1", "Host", "127.0.0.1", 18620)
	r.Engine().Enable() // simulate a race already active before presenting started
	defer r.Engine().Disable()
	ctx, cancel := context.WithCancel(context.Background())
	go r.Run(ctx, h)
	defer cancel()
	r.Engine().CreateLobby()
	time.Sleep(200 * time.Millisecond) // give OnChange a moment to fire, if it's going to
	if _, ok := h.activity("race"); ok {
		t.Fatal("must not set a pill Activity while presenting, even for a race the engine already had running")
	}
}

func TestRunTracksRaceSetting(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if _, err := settings.Update([]byte(`{"features":{"race":false}}`)); err != nil {
		t.Fatal(err)
	}
	r := NewRace("h1", "Host", "127.0.0.1", 18621)
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
