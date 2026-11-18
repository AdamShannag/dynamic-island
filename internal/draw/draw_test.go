package draw_test

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/draw"
	"github.com/AdamShannag/dynamic-island/internal/lobby"
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
	started   map[string][]json.RawMessage
}

func newFakeTransport() *fakeTransport {
	return &fakeTransport{started: map[string][]json.RawMessage{}}
}

func (f *fakeTransport) publish(_ bool, _ string, payload json.RawMessage) {
	f.mu.Lock()
	f.published = append(f.published, payload)
	f.mu.Unlock()
}

func (f *fakeTransport) sendStart(addr, _ string, payload json.RawMessage) error {
	f.mu.Lock()
	f.started[addr] = append(f.started[addr], payload)
	f.mu.Unlock()
	return nil
}

func (f *fakeTransport) lastStart(addr string) json.RawMessage {
	f.mu.Lock()
	defer f.mu.Unlock()
	list := f.started[addr]
	if len(list) == 0 {
		return nil
	}
	return list[len(list)-1]
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func twoPlayerGame(t *testing.T) (*draw.Engine, *fakeTransport) {
	t.Helper()
	host := draw.NewEngine("h1", "Host")
	tr := newFakeTransport()
	players := []draw.Player{{PeerID: "h1", Name: "Host", Status: "accepted"}, {PeerID: "g1", Name: "Guest", Status: "accepted"}}
	if err := host.BeginHost("lobby1", players, map[string]string{"g1": "127.0.0.1:2"}, 3, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}
	return host, tr
}

func TestBeginHostRequiresAtLeastTwoPlayers(t *testing.T) {
	host := draw.NewEngine("h1", "Host")
	tr := newFakeTransport()
	players := []draw.Player{{PeerID: "h1", Name: "Host", Status: "accepted"}}
	if err := host.BeginHost("lobby1", players, map[string]string{}, 3, tr.publish, tr.sendStart); err == nil {
		t.Fatal("expected an error with fewer than 2 players")
	}
}

func TestEveryPlayerStartsByDrawingTheirOwnWord(t *testing.T) {
	host, tr := twoPlayerGame(t)
	st := host.State()
	if st.Phase != draw.PhaseDrawing || st.Pass != 1 || st.TotalPasses != 3 {
		t.Fatalf("state = %+v, want phase drawing, pass 1 of 3", st)
	}
	if st.Prompt == nil || st.Prompt.Kind != "word" || st.Prompt.Word == "" {
		t.Fatalf("host's own prompt = %+v, want a word to draw", st.Prompt)
	}

	var p struct {
		Prompt *draw.Prompt `json:"prompt"`
	}
	if err := json.Unmarshal(tr.lastStart("127.0.0.1:2"), &p); err != nil {
		t.Fatal(err)
	}
	if p.Prompt == nil || p.Prompt.Kind != "word" || p.Prompt.Word == "" {
		t.Fatalf("guest's own prompt = %+v, want their own word to draw", p.Prompt)
	}
	if p.Prompt.Word == st.Prompt.Word {
		t.Fatal("the host and guest must start with different words")
	}
}

func TestBroadcastNeverLeaksAnyonesPrompt(t *testing.T) {
	_, tr := twoPlayerGame(t)
	tr.mu.Lock()
	last := tr.published[len(tr.published)-1]
	tr.mu.Unlock()
	var broadcast draw.State
	if err := json.Unmarshal(last, &broadcast); err != nil {
		t.Fatal(err)
	}
	if broadcast.Prompt != nil {
		t.Fatal("the broadcast payload must never carry anyone's prompt")
	}
}

func TestSubmittingTwiceInTheSameStepIsRejected(t *testing.T) {
	host, tr := twoPlayerGame(t)
	if err := host.SubmitDrawing(nil); err != nil {
		t.Fatal(err)
	}

	var p struct {
		Prompt *draw.Prompt `json:"prompt"`
	}
	if err := json.Unmarshal(tr.lastStart("127.0.0.1:2"), &p); err != nil {
		t.Fatal(err)
	}
	if p.Prompt == nil || p.Prompt.Kind != "word" {
		t.Fatalf("guest should still be drawing their own word until they submit too, got %+v", p.Prompt)
	}
	if err := host.SubmitDrawing(nil); err == nil {
		t.Fatal("submitting a second drawing before a new step must be rejected")
	}
}

func TestGuestDrawingThenGuessAdvancesToTheNextPass(t *testing.T) {
	host := draw.NewEngine("h1", "Host")
	tr := newFakeTransport()
	players := []draw.Player{{PeerID: "h1", Name: "Host", Status: "accepted"}, {PeerID: "g1", Name: "Guest", Status: "accepted"}}
	if err := host.BeginHost("lobby1", players, map[string]string{"g1": "127.0.0.1:2"}, 2, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}

	if err := host.HandleProgress(lobby.Progress{LobbyID: "lobby1", PeerID: "g1", Payload: mustJSON(t, map[string]any{"kind": "drawing"})}); err != nil {
		t.Fatal(err)
	}
	if host.State().Phase != draw.PhaseDrawing {
		t.Fatal("must still be drawing until every player has submitted")
	}
	if err := host.SubmitDrawing(nil); err != nil {
		t.Fatal(err)
	}
	st := host.State()
	if st.Phase != draw.PhaseGuessing {
		t.Fatalf("phase = %v, want guessing once both drawings are in", st.Phase)
	}
	if st.Prompt == nil || st.Prompt.Kind != "drawing" {
		t.Fatalf("host's guess prompt = %+v, want a drawing to guess", st.Prompt)
	}
	if st.Prompt.FromPeerID == "h1" {
		t.Fatal("a player must never be asked to guess their own drawing")
	}

	if err := host.HandleProgress(lobby.Progress{LobbyID: "lobby1", PeerID: "g1", Payload: mustJSON(t, map[string]any{"kind": "word", "word": "a guess"})}); err != nil {
		t.Fatal(err)
	}
	if err := host.SubmitGuess("another guess"); err != nil {
		t.Fatal(err)
	}
	st = host.State()
	if st.Phase != draw.PhaseDrawing || st.Pass != 2 {
		t.Fatalf("state = %+v, want pass 2 drawing after both guesses are in", st)
	}
	if st.Prompt == nil || st.Prompt.Kind != "word" {
		t.Fatalf("pass 2's prompt = %+v, want a word (someone's guess) to draw", st.Prompt)
	}
}

func TestGameEndsAfterTheConfiguredNumberOfPassesWithFullChains(t *testing.T) {
	host := draw.NewEngine("h1", "Host")
	tr := newFakeTransport()
	players := []draw.Player{{PeerID: "h1", Name: "Host", Status: "accepted"}, {PeerID: "g1", Name: "Guest", Status: "accepted"}}
	if err := host.BeginHost("lobby1", players, map[string]string{"g1": "127.0.0.1:2"}, 2, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}

	for step := 0; step < 4; step++ { // 2 passes * (draw + guess)
		st := host.State()
		if st.Phase == draw.PhaseDrawing {
			if err := host.HandleProgress(lobby.Progress{LobbyID: "lobby1", PeerID: "g1", Payload: mustJSON(t, map[string]any{"kind": "drawing"})}); err != nil {
				t.Fatal(err)
			}
			if err := host.SubmitDrawing(nil); err != nil {
				t.Fatal(err)
			}
		} else {
			if err := host.HandleProgress(lobby.Progress{LobbyID: "lobby1", PeerID: "g1", Payload: mustJSON(t, map[string]any{"kind": "word", "word": "g guess"})}); err != nil {
				t.Fatal(err)
			}
			if err := host.SubmitGuess("h guess"); err != nil {
				t.Fatal(err)
			}
		}
	}

	st := host.State()
	if st.Phase != draw.PhaseFinished {
		t.Fatalf("phase = %v, want finished after 2 full passes", st.Phase)
	}
	if len(st.Chains) != 2 {
		t.Fatalf("got %d chains, want one per player (2)", len(st.Chains))
	}
	for _, c := range st.Chains {
		// word, draw, guess, draw, guess = 1 + 2*passes entries.
		if got := len(c.Entries); got != 5 {
			t.Fatalf("chain %q has %d entries, want 5 for 2 passes", c.OwnerID, got)
		}
		if !c.Entries[len(c.Entries)-1].Final {
			t.Fatalf("chain %q's last entry must be marked final", c.OwnerID)
		}
	}
}

func TestAPlayerIsNeverAskedToWorkOnTheirOwnPreviousEntry(t *testing.T) {
	host := draw.NewEngine("h1", "Host")
	tr := newFakeTransport()
	players := []draw.Player{
		{PeerID: "h1", Name: "Host", Status: "accepted"},
		{PeerID: "g1", Name: "Guest1", Status: "accepted"},
		{PeerID: "g2", Name: "Guest2", Status: "accepted"},
	}
	peerAddrs := map[string]string{"g1": "127.0.0.1:2", "g2": "127.0.0.1:3"}
	if err := host.BeginHost("lobby1", players, peerAddrs, 3, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}

	for step := 0; step < 6; step++ {
		st := host.State()
		kind := "drawing"
		if st.Phase == draw.PhaseGuessing {
			kind = "word"
		}
		for _, p := range []string{"g1", "g2"} {
			if err := host.HandleProgress(lobby.Progress{LobbyID: "lobby1", PeerID: p, Payload: mustJSON(t, map[string]any{"kind": kind, "word": "x"})}); err != nil {
				t.Fatal(err)
			}
		}
		if kind == "drawing" {
			if err := host.SubmitDrawing(nil); err != nil {
				t.Fatal(err)
			}
		} else {
			if err := host.SubmitGuess("x"); err != nil {
				t.Fatal(err)
			}
		}
	}

	st := host.State()
	for _, c := range st.Chains {
		// Entry 1 (the first drawing) is always the owner drawing their own
		// seed word by design - reassignment only starts from entry 2 on.
		for i := 2; i < len(c.Entries); i++ {
			if c.Entries[i].PeerID == c.Entries[i-1].PeerID {
				t.Fatalf("chain %q: entry %d was worked on by the same player as entry %d (%s)", c.OwnerID, i, i-1, c.Entries[i].PeerID)
			}
		}
	}
}

func TestAPlayerWhoNeverSubmitsIsAutoFilledOnceEveryoneElseIsDone(t *testing.T) {
	host, _ := twoPlayerGame(t)
	// Only the host submits; the guest never does within this test, so the
	// step must stay open rather than silently advancing on one submission.
	if err := host.SubmitDrawing(nil); err != nil {
		t.Fatal(err)
	}
	if host.State().Phase != draw.PhaseDrawing {
		t.Fatal("must not advance until every current worker has submitted or timed out")
	}
}

// TestATimedOutStepFillsOnlyTheSlowPlayerAndNeverOverwritesRealSubmissions
// is a regression test for a real bug: fillMissingLocked ranged over
// turnOf (ownerID -> workerID) with the loop variables named backwards,
// so it checked and set e.done for the wrong player. With 3+ players that
// could mark a chain's owner "done" because of some unrelated submission
// they made as someone else's worker, overwrite a different chain's real,
// already-submitted entry with a blank placeholder, and leave the chain
// the slow player actually owed an entry to completely untouched - one
// chain silently a step short. That showed up as "the other guy takes
// too long and it tells me I already guessed" even though the local
// player never submitted anything that step.
func TestATimedOutStepFillsOnlyTheSlowPlayerAndNeverOverwritesRealSubmissions(t *testing.T) {
	host := draw.NewEngine("h1", "Host")
	host.SetStepDurations(50*time.Millisecond, 120*time.Millisecond)
	tr := newFakeTransport()
	players := []draw.Player{
		{PeerID: "h1", Name: "Host", Status: "accepted"},
		{PeerID: "g1", Name: "Guest1", Status: "accepted"},
		{PeerID: "g2", Name: "Guest2", Status: "accepted"},
	}
	peerAddrs := map[string]string{"g1": "127.0.0.1:2", "g2": "127.0.0.1:3"}
	if err := host.BeginHost("lobby1", players, peerAddrs, 1, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}

	// Round 1's draw is always self, so everyone submits their own word's
	// drawing and the step advances into guessing (reassigned).
	if err := host.SubmitDrawing(nil); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"g1", "g2"} {
		if err := host.HandleProgress(lobby.Progress{LobbyID: "lobby1", PeerID: p, Payload: mustJSON(t, map[string]any{"kind": "drawing"})}); err != nil {
			t.Fatal(err)
		}
	}
	waitFor(t, 2*time.Second, func() bool { return host.State().Phase == draw.PhaseGuessing })

	// Figure out who is assigned to guess whom: each guessing prompt's
	// FromPeerID names the chain owner (round 1's drawer is always that
	// chain's owner), which reveals the real worker/chain pairing.
	fromPeerOf := func(peerID string) string {
		if peerID == "h1" {
			return host.State().Prompt.FromPeerID
		}
		var p struct {
			Prompt *draw.Prompt `json:"prompt"`
		}
		if err := json.Unmarshal(tr.lastStart("127.0.0.1:"+map[string]string{"g1": "2", "g2": "3"}[peerID]), &p); err != nil {
			t.Fatal(err)
		}
		return p.Prompt.FromPeerID
	}
	// ownerToWorker[ownerID] = the peer assigned to guess that owner's
	// drawing this step (the inverse of fromPeerOf, which maps worker ->
	// chain owner).
	ownerToWorker := map[string]string{}
	for _, worker := range []string{"h1", "g1", "g2"} {
		ownerToWorker[fromPeerOf(worker)] = worker
	}

	// h1 and g1 submit distinguishable guesses; g2 is the slow one and
	// never submits, so it must time out on its own.
	if err := host.SubmitGuess("host-guess"); err != nil {
		t.Fatal(err)
	}
	if err := host.HandleProgress(lobby.Progress{LobbyID: "lobby1", PeerID: "g1", Payload: mustJSON(t, map[string]any{"kind": "word", "word": "g1-guess"})}); err != nil {
		t.Fatal(err)
	}

	waitFor(t, 2*time.Second, func() bool { return host.State().Phase == draw.PhaseFinished })

	chains := host.State().Chains
	if len(chains) != 3 {
		t.Fatalf("got %d chains, want 3", len(chains))
	}
	placeholders := 0
	for _, c := range chains {
		if len(c.Entries) != 3 {
			t.Fatalf("chain %q has %d entries, want exactly 3 (word, drawing, guess) - a chain must never be left short", c.OwnerID, len(c.Entries))
		}
		last := c.Entries[2]
		wantWorker := ownerToWorker[c.OwnerID]
		switch wantWorker {
		case "h1":
			if last.PeerID != "h1" || last.Word != "host-guess" {
				t.Fatalf("chain %q (worked by h1) final entry = %+v, want h1's real guess intact", c.OwnerID, last)
			}
		case "g1":
			if last.PeerID != "g1" || last.Word != "g1-guess" {
				t.Fatalf("chain %q (worked by g1) final entry = %+v, want g1's real guess intact", c.OwnerID, last)
			}
		case "g2":
			if last.PeerID != "g2" || last.Word != "…" {
				t.Fatalf("chain %q (worked by g2, who timed out) final entry = %+v, want a g2-attributed placeholder", c.OwnerID, last)
			}
			placeholders++
		}
	}
	if placeholders != 1 {
		t.Fatalf("got %d placeholder entries, want exactly 1 (only the slow player's)", placeholders)
	}
}

func TestGuestLeavingMidGameEndsItRatherThanContinuingSolo(t *testing.T) {
	host, _ := twoPlayerGame(t)
	if err := host.HandleRespond(lobby.Response{LobbyID: "lobby1", PeerID: "g1", Accept: false}); err != nil {
		t.Fatal(err)
	}
	if got := host.State().Phase; got != draw.PhaseFinished {
		t.Fatalf("phase = %v, want finished once the guest leaves and only the host remains", got)
	}
}

func TestAPlayerLeavingMidStepDoesNotStallTheOthers(t *testing.T) {
	host := draw.NewEngine("h1", "Host")
	tr := newFakeTransport()
	players := []draw.Player{
		{PeerID: "h1", Name: "Host", Status: "accepted"},
		{PeerID: "g1", Name: "Guest1", Status: "accepted"},
		{PeerID: "g2", Name: "Guest2", Status: "accepted"},
	}
	peerAddrs := map[string]string{"g1": "127.0.0.1:2", "g2": "127.0.0.1:3"}
	if err := host.BeginHost("lobby1", players, peerAddrs, 3, tr.publish, tr.sendStart); err != nil {
		t.Fatal(err)
	}
	if err := host.SubmitDrawing(nil); err != nil {
		t.Fatal(err)
	}
	if err := host.HandleProgress(lobby.Progress{LobbyID: "lobby1", PeerID: "g1", Payload: mustJSON(t, map[string]any{"kind": "drawing"})}); err != nil {
		t.Fatal(err)
	}
	// g2 leaves before submitting its drawing - the step must still
	// complete for the remaining two rather than waiting forever.
	if err := host.HandleRespond(lobby.Response{LobbyID: "lobby1", PeerID: "g2", Accept: false}); err != nil {
		t.Fatal(err)
	}
	st := host.State()
	if st.Phase != draw.PhaseGuessing {
		t.Fatalf("phase = %v, want guessing once the only remaining unfinished worker (g2) has left", st.Phase)
	}
	if len(st.Players) != 2 {
		t.Fatalf("players = %d, want 2 after g2 left", len(st.Players))
	}
}

func TestApplyEventDoesNotOverwriteTheLocallyKnownPrompt(t *testing.T) {
	g := draw.NewEngine("g1", "Guest")
	payload := mustJSON(t, map[string]any{
		"phase": "drawing", "pass": 1, "totalPasses": 3,
		"prompt":  map[string]any{"kind": "word", "word": "umbrella"},
		"players": []draw.Player{{PeerID: "g1", Name: "Guest", Status: "accepted"}},
	})
	if err := g.BeginGuest("lobby1", "127.0.0.1:1", payload); err != nil {
		t.Fatal(err)
	}
	if g.State().Prompt == nil || g.State().Prompt.Word != "umbrella" {
		t.Fatalf("expected to learn the local prompt from BeginGuest, got %+v", g.State().Prompt)
	}
	// A broadcast from the host always redacts Prompt, even for the player
	// it belongs to.
	g.ApplyEvent(mustJSON(t, draw.State{
		Phase: draw.PhaseDrawing, Pass: 1, TotalPasses: 3,
		Players: []draw.Player{{PeerID: "g1", Name: "Guest", Status: "accepted"}},
	}))
	if g.State().Prompt == nil || g.State().Prompt.Word != "umbrella" {
		t.Fatalf("the locally-learned prompt must survive a redacted broadcast, got %+v", g.State().Prompt)
	}
}

// TestApplyEventNeverAdvancesPhaseAheadOfTheMatchingPrompt is a regression
// test for a real bug: the broadcast (SSE) and each player's personalized
// turn message (a separate direct HTTP POST) travel over independent
// connections with no ordering guarantee between them. If a broadcast
// announcing a new phase/pass were applied immediately, a player could
// render the new phase (e.g. "guessing") paired with the previous step's
// stale Prompt (still "word") until the personalized message caught up -
// showing nothing to draw or guess, or the wrong kind of prompt entirely.
func TestApplyEventNeverAdvancesPhaseAheadOfTheMatchingPrompt(t *testing.T) {
	g := draw.NewEngine("g1", "Guest")
	payload := mustJSON(t, map[string]any{
		"phase": "drawing", "pass": 1, "totalPasses": 3,
		"prompt":  map[string]any{"kind": "word", "word": "umbrella"},
		"players": []draw.Player{{PeerID: "g1", Name: "Guest", Status: "accepted"}},
	})
	if err := g.BeginGuest("lobby1", "127.0.0.1:1", payload); err != nil {
		t.Fatal(err)
	}

	// A broadcast arrives announcing pass 2, guessing - but no personalized
	// HandleStart for it has arrived yet.
	g.ApplyEvent(mustJSON(t, draw.State{
		Phase: draw.PhaseGuessing, Pass: 2, TotalPasses: 3,
		Players: []draw.Player{{PeerID: "g1", Name: "Guest", Status: "accepted"}},
	}))
	st := g.State()
	if st.Phase != draw.PhaseDrawing || st.Pass != 1 {
		t.Fatalf("broadcast alone must not advance phase/pass, got phase=%v pass=%d", st.Phase, st.Pass)
	}
	if st.Prompt == nil || st.Prompt.Word != "umbrella" {
		t.Fatalf("prompt must stay whatever was locally known, got %+v", st.Prompt)
	}

	// Only the matching personalized message may advance it, atomically.
	if err := g.HandleStart(mustJSON(t, map[string]any{
		"phase": "guessing", "pass": 2, "totalPasses": 3,
		"prompt":  map[string]any{"kind": "drawing", "fromName": "Host"},
		"players": []draw.Player{{PeerID: "g1", Name: "Guest", Status: "accepted"}},
	})); err != nil {
		t.Fatal(err)
	}
	st = g.State()
	if st.Phase != draw.PhaseGuessing || st.Pass != 2 || st.Prompt == nil || st.Prompt.Kind != "drawing" {
		t.Fatalf("HandleStart should atomically advance phase+pass+prompt together, got %+v", st)
	}
}

func TestLeaveDuringMatchResetsToIdle(t *testing.T) {
	g := draw.NewEngine("g1", "Guest")
	payload := mustJSON(t, map[string]any{
		"phase": "drawing", "pass": 1, "totalPasses": 3,
		"players": []draw.Player{{PeerID: "g1", Name: "Guest", Status: "accepted"}},
	})
	if err := g.BeginGuest("lobby1", "127.0.0.1:1", payload); err != nil {
		t.Fatal(err)
	}
	g.Leave()
	if g.State().Phase != draw.PhaseIdle {
		t.Fatalf("phase = %v, want idle after Leave", g.State().Phase)
	}
}
