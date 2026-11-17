package draw_test

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/draw"
	"github.com/AdamShannag/dynamic-island/internal/lobby"
)

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

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestHostNeverLeaksTheWordInWhatItBroadcasts(t *testing.T) {
	host := draw.NewEngine("h1", "Host")
	tr := newFakeTransport()
	players := []draw.Player{{PeerID: "h1", Name: "Host", Status: "accepted"}, {PeerID: "g1", Name: "Guest", Status: "accepted"}}
	if err := host.BeginHost("lobby1", players, map[string]string{"g1": "127.0.0.1:2"}, 0, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}
	if host.State().DrawerID != "h1" {
		t.Fatalf("drawer = %q, want the host to draw first", host.State().DrawerID)
	}
	if host.State().Word == "" {
		t.Fatal("the drawer's own State() must show the word")
	}

	tr.mu.Lock()
	last := tr.published[len(tr.published)-1]
	tr.mu.Unlock()
	var broadcast draw.State
	if err := json.Unmarshal(last, &broadcast); err != nil {
		t.Fatal(err)
	}
	if broadcast.Word != "" {
		t.Fatal("the broadcast payload must always redact the word, even when the host is drawing")
	}

	tr.mu.Lock()
	startPayload, ok := tr.started["127.0.0.1:2"]
	tr.mu.Unlock()
	if !ok {
		t.Fatal("expected a round-start sent to the guest")
	}
	var p struct{ Word string }
	_ = json.Unmarshal(startPayload, &p)
	if p.Word != "" {
		t.Fatal("a non-drawer must not receive the word in their own start payload")
	}
}

func TestDrawerLearnsTheWordFromTheirOwnStartPayload(t *testing.T) {
	g := draw.NewEngine("g1", "Guest")
	payload := mustJSON(t, map[string]any{
		"round": 1, "totalRounds": 2, "drawerId": "g1", "drawerName": "Guest",
		"word": "umbrella", "roundEndsAtMs": 0,
		"players": []draw.Player{{PeerID: "g1", Name: "Guest", Status: "accepted"}},
	})
	if err := g.BeginGuest("lobby1", "127.0.0.1:1", payload); err != nil {
		t.Fatal(err)
	}
	if g.State().Word != "umbrella" {
		t.Fatalf("the drawer must see their own word, got %q", g.State().Word)
	}
}

func TestApplyEventDoesNotOverwriteTheDrawersOwnKnownWord(t *testing.T) {
	g := draw.NewEngine("g1", "Guest")
	payload := mustJSON(t, map[string]any{
		"round": 1, "totalRounds": 2, "drawerId": "g1", "drawerName": "Guest",
		"word": "umbrella", "roundEndsAtMs": 0,
		"players": []draw.Player{{PeerID: "g1", Name: "Guest", Status: "accepted"}},
	})
	if err := g.BeginGuest("lobby1", "127.0.0.1:1", payload); err != nil {
		t.Fatal(err)
	}
	// A broadcast from the host always redacts Word, even for the drawer.
	g.ApplyEvent(mustJSON(t, draw.State{
		Phase: draw.PhaseDrawing, DrawerID: "g1", Word: "",
		Players: []draw.Player{{PeerID: "g1", Name: "Guest", Status: "accepted"}},
	}))
	if g.State().Word != "umbrella" {
		t.Fatalf("the drawer's own locally-learned word must survive a redacted broadcast, got %q", g.State().Word)
	}
}

func TestNonDrawerNeverSeesTheWord(t *testing.T) {
	g := draw.NewEngine("g1", "Guest")
	payload := mustJSON(t, map[string]any{
		"round": 1, "totalRounds": 2, "drawerId": "h1", "drawerName": "Host",
		"word": "", "roundEndsAtMs": 0,
		"players": []draw.Player{{PeerID: "h1", Name: "Host", Status: "accepted"}, {PeerID: "g1", Name: "Guest", Status: "accepted"}},
	})
	if err := g.BeginGuest("lobby1", "127.0.0.1:1", payload); err != nil {
		t.Fatal(err)
	}
	if g.State().Word != "" {
		t.Fatal("a non-drawer must never see the word")
	}
}

func TestCorrectGuessScoresByRankAndEndsRoundWhenEveryoneHasGuessed(t *testing.T) {
	host := draw.NewEngine("h1", "Host")
	tr := newFakeTransport()
	players := []draw.Player{{PeerID: "h1", Name: "Host", Status: "accepted"}, {PeerID: "g1", Name: "Guest", Status: "accepted"}}
	if err := host.BeginHost("lobby1", players, map[string]string{"g1": "127.0.0.1:2"}, 0, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}
	word := host.State().Word
	if err := host.HandleProgress(lobby.Progress{LobbyID: "lobby1", PeerID: "g1", Payload: mustJSON(t, map[string]string{"type": "guess", "text": word})}); err != nil {
		t.Fatal(err)
	}
	st := host.State()
	if st.Phase != draw.PhaseReveal && st.Phase != draw.PhaseFinished {
		t.Fatalf("the only non-drawer guessing correctly must end the round, got phase %v", st.Phase)
	}
	if st.LastRound == nil || len(st.LastRound.Deltas) == 0 {
		t.Fatal("expected a scored round result")
	}
	foundGuesser := false
	for _, d := range st.LastRound.Deltas {
		if d.PeerID == "g1" {
			foundGuesser = true
			if d.Points != 3 {
				t.Fatalf("first correct guesser should score 3, got %d", d.Points)
			}
		}
	}
	if !foundGuesser {
		t.Fatal("expected a score delta for the guesser")
	}
}

func TestWrongGuessDoesNotScoreOrEndTheRound(t *testing.T) {
	host := draw.NewEngine("h1", "Host")
	tr := newFakeTransport()
	players := []draw.Player{{PeerID: "h1", Name: "Host", Status: "accepted"}, {PeerID: "g1", Name: "Guest", Status: "accepted"}}
	if err := host.BeginHost("lobby1", players, map[string]string{"g1": "127.0.0.1:2"}, 0, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}
	if err := host.HandleProgress(lobby.Progress{LobbyID: "lobby1", PeerID: "g1", Payload: mustJSON(t, map[string]string{"type": "guess", "text": "definitely wrong"})}); err != nil {
		t.Fatal(err)
	}
	if host.State().Phase != draw.PhaseDrawing {
		t.Fatalf("phase = %v, want still drawing after a wrong guess", host.State().Phase)
	}
	if len(host.State().Guessed) != 0 {
		t.Fatal("a wrong guess must not be recorded as a correct guesser")
	}
}

func TestDrawerCannotGuessTheirOwnWord(t *testing.T) {
	host := draw.NewEngine("h1", "Host")
	tr := newFakeTransport()
	players := []draw.Player{{PeerID: "h1", Name: "Host", Status: "accepted"}, {PeerID: "g1", Name: "Guest", Status: "accepted"}}
	if err := host.BeginHost("lobby1", players, map[string]string{"g1": "127.0.0.1:2"}, 0, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}
	word := host.State().Word
	if err := host.HandleProgress(lobby.Progress{LobbyID: "lobby1", PeerID: "h1", Payload: mustJSON(t, map[string]string{"type": "guess", "text": word})}); err != nil {
		t.Fatal(err)
	}
	if len(host.State().Guessed) != 0 {
		t.Fatal("the drawer guessing their own word must not score")
	}
}

func TestStrokesAreCappedPerRound(t *testing.T) {
	host := draw.NewEngine("h1", "Host")
	tr := newFakeTransport()
	players := []draw.Player{{PeerID: "h1", Name: "Host", Status: "accepted"}}
	if err := host.BeginHost("lobby1", players, map[string]string{}, 0, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 50; i++ {
		pts := make([]draw.Point, 200)
		if err := host.SubmitStroke(draw.Stroke{Points: pts, Color: "#000", Width: 2}); err != nil {
			t.Fatal(err)
		}
	}
	total := 0
	for _, s := range host.State().Strokes {
		total += len(s.Points)
	}
	if total > 4000 {
		t.Fatalf("stroke points = %d, want capped at 4000", total)
	}
}

func TestOnlyTheDrawerCanSubmitAStroke(t *testing.T) {
	g := draw.NewEngine("g1", "Guest")
	payload := mustJSON(t, map[string]any{
		"round": 1, "totalRounds": 1, "drawerId": "h1", "drawerName": "Host",
		"players": []draw.Player{{PeerID: "h1", Name: "Host", Status: "accepted"}, {PeerID: "g1", Name: "Guest", Status: "accepted"}},
	})
	if err := g.BeginGuest("lobby1", "127.0.0.1:1", payload); err != nil {
		t.Fatal(err)
	}
	if err := g.SubmitStroke(draw.Stroke{Points: []draw.Point{{X: 0, Y: 0}}}); err == nil {
		t.Fatal("a non-drawer must not be able to submit a stroke")
	}
}

// TestRoundsConfiguredAboveThePlayerCountActuallyPlayAllOfThem is a
// regression test for a real bug: nextDrawerLocked scanned drawOrder
// starting at round-1 without wrapping, so once round exceeded the player
// count it fell straight off the end of the slice and finished the game
// early - with 2 players, any host-configured round count above 2 was
// silently ignored and the game always ended after exactly one turn each.
func TestRoundsConfiguredAboveThePlayerCountActuallyPlayAllOfThem(t *testing.T) {
	host := draw.NewEngine("h1", "Host")
	tr := newFakeTransport()
	players := []draw.Player{{PeerID: "h1", Name: "Host", Status: "accepted"}, {PeerID: "g1", Name: "Guest", Status: "accepted"}}
	if err := host.BeginHost("lobby1", players, map[string]string{"g1": "127.0.0.1:2"}, 4, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}
	if got := host.State().TotalRounds; got != 4 {
		t.Fatalf("TotalRounds = %d, want 4", got)
	}

	wordFor := func(drawerIsHost bool) string {
		if drawerIsHost {
			return host.State().Word
		}
		tr.mu.Lock()
		defer tr.mu.Unlock()
		var sp struct {
			Word string `json:"word"`
		}
		if err := json.Unmarshal(tr.started["127.0.0.1:2"], &sp); err != nil {
			t.Fatal(err)
		}
		return sp.Word
	}

	for round := 1; round <= 4; round++ {
		st := host.State()
		if st.Round != round || st.Phase != draw.PhaseDrawing {
			t.Fatalf("round %d: phase/round = %v/%d, want drawing/%d", round, st.Phase, st.Round, round)
		}
		drawerIsHost := st.DrawerID == "h1"
		nonDrawer := "g1"
		if !drawerIsHost {
			nonDrawer = "h1"
		}
		word := wordFor(drawerIsHost)
		if word == "" {
			t.Fatalf("round %d: could not determine the word", round)
		}
		if err := host.HandleProgress(lobby.Progress{LobbyID: "lobby1", PeerID: nonDrawer, Payload: mustJSON(t, map[string]string{"type": "guess", "text": word})}); err != nil {
			t.Fatal(err)
		}
		if round < 4 {
			deadline := time.Now().Add(6 * time.Second)
			for host.State().Phase != draw.PhaseDrawing && time.Now().Before(deadline) {
				time.Sleep(50 * time.Millisecond)
			}
			if host.State().Phase != draw.PhaseDrawing {
				t.Fatalf("round %d: never advanced to the next round (stuck at phase %v)", round, host.State().Phase)
			}
		}
	}

	if got := host.State().Phase; got != draw.PhaseFinished {
		t.Fatalf("phase after round 4 = %v, want finished", got)
	}
}
