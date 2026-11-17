package race_test

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/lobby"
	"github.com/AdamShannag/dynamic-island/internal/race"
)

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
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

func (f *fakeTransport) last() race.State {
	f.mu.Lock()
	defer f.mu.Unlock()
	var s race.State
	_ = json.Unmarshal(f.published[len(f.published)-1], &s)
	return s
}

func racer(s race.State, id string) (race.Racer, bool) {
	for _, r := range s.Racers {
		if r.PeerID == id {
			return r, true
		}
	}
	return race.Racer{}, false
}

func TestBeginHostSendsStartToEveryGuest(t *testing.T) {
	host := race.NewEngine("h1", "Host")
	tr := newFakeTransport()
	racers := []race.Racer{{PeerID: "h1", Name: "Host", Status: "accepted"}, {PeerID: "g1", Name: "Guest", Status: "accepted"}}
	peerAddrs := map[string]string{"h1": "127.0.0.1:1", "g1": "127.0.0.1:2"}
	if err := host.BeginHost("lobby1", racers, peerAddrs, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}
	if host.State().Phase != race.PhaseRacing {
		t.Fatalf("phase = %v, want racing", host.State().Phase)
	}
	if _, ok := tr.started["127.0.0.1:2"]; !ok {
		t.Fatal("expected a start message sent to the guest")
	}
	if _, ok := tr.started["127.0.0.1:1"]; ok {
		t.Fatal("the host must not send itself a start message")
	}
}

func TestBeginHostRequiresAtLeastOneRacer(t *testing.T) {
	host := race.NewEngine("h1", "Host")
	tr := newFakeTransport()
	if err := host.BeginHost("lobby1", nil, nil, tr.publish, tr.sendStart); err == nil {
		t.Fatal("expected an error with no accepted racers")
	}
}

func TestBeginGuestLearnsThePassage(t *testing.T) {
	g := race.NewEngine("g1", "Guest")
	payload, _ := json.Marshal("a short passage")
	if err := g.BeginGuest("lobby1", "127.0.0.1:1", payload); err != nil {
		t.Fatal(err)
	}
	if g.State().Passage != "a short passage" || g.State().Phase != race.PhaseRacing {
		t.Fatalf("got %+v", g.State())
	}
}

func TestApplyProgressClampsToThePassageLength(t *testing.T) {
	host := race.NewEngine("h1", "Host")
	tr := newFakeTransport()
	racers := []race.Racer{{PeerID: "h1", Name: "Host", Status: "accepted"}, {PeerID: "g1", Name: "Guest", Status: "accepted"}}
	if err := host.BeginHost("lobby1", racers, map[string]string{}, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}
	passageLen := len([]rune(host.State().Passage))

	if err := host.HandleProgress(lobby.Progress{LobbyID: "lobby1", PeerID: "g1", Payload: mustJSON(t, map[string]int{"typedChars": 1 << 30})}); err != nil {
		t.Fatal(err)
	}
	r, ok := racer(host.State(), "g1")
	if !ok || r.Progress != 1 {
		t.Fatalf("a huge typedChars count must clamp to 100%% progress, got %+v", r)
	}
	if r.FinishedAtMs == 0 {
		t.Fatal("reaching the full passage length must mark the racer finished")
	}
	_ = passageLen
}

func TestFinishingEveryRacerEndsTheRace(t *testing.T) {
	host := race.NewEngine("h1", "Host")
	tr := newFakeTransport()
	racers := []race.Racer{{PeerID: "h1", Name: "Host", Status: "accepted"}}
	if err := host.BeginHost("lobby1", racers, map[string]string{}, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}
	passageLen := len([]rune(host.State().Passage))
	if err := host.SubmitProgress(passageLen); err != nil {
		t.Fatal(err)
	}
	if host.State().Phase != race.PhaseFinished {
		t.Fatalf("phase = %v, want finished once the only racer is done", host.State().Phase)
	}
}

func TestApplyEventIgnoredOnTheHost(t *testing.T) {
	host := race.NewEngine("h1", "Host")
	tr := newFakeTransport()
	racers := []race.Racer{{PeerID: "h1", Name: "Host", Status: "accepted"}}
	if err := host.BeginHost("lobby1", racers, map[string]string{}, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}
	before := host.State()
	host.ApplyEvent(mustJSON(t, race.State{Phase: race.PhaseFinished}))
	if host.State().Phase != before.Phase {
		t.Fatal("ApplyEvent must be a no-op on the host, which is authoritative over its own state")
	}
}

func TestLeaveDuringRaceResetsToIdle(t *testing.T) {
	g := race.NewEngine("g1", "Guest")
	payload, _ := json.Marshal("passage")
	if err := g.BeginGuest("lobby1", "127.0.0.1:1", payload); err != nil {
		t.Fatal(err)
	}
	g.Leave()
	if g.State().Phase != race.PhaseIdle {
		t.Fatalf("phase = %v, want idle after Leave", g.State().Phase)
	}
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
