package draw_test

import (
	"fmt"
	"testing"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/discovery"
	"github.com/AdamShannag/dynamic-island/internal/draw"
)

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

func newHostGuest(t *testing.T, hostPort, guestPort int) (*draw.Engine, *draw.Engine) {
	t.Helper()
	host := draw.NewEngine("h1", "Host", "127.0.0.1", hostPort)
	if err := host.Enable(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(host.Disable)
	guest := draw.NewEngine("g1", "Guest", "127.0.0.1", guestPort)
	if err := guest.Enable(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(guest.Disable)
	host.SetRoundDuration(10 * time.Second)
	guest.SetRoundDuration(10 * time.Second)
	return host, guest
}

func startGame(t *testing.T, host, guest *draw.Engine, hostPort, guestPort int) {
	t.Helper()
	host.CreateLobby()
	if err := host.Invite(discovery.Peer{ID: "g1", Name: "Guest", Addr: fmt.Sprintf("127.0.0.1:%d", guestPort)}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Phase == draw.PhaseLobby })
	if err := guest.Respond(true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		for _, p := range host.State().Players {
			if p.PeerID == "g1" && p.Status == "accepted" {
				return true
			}
		}
		return false
	})
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Phase == draw.PhaseDrawing })
}

func TestNewEngineOpensNothing(t *testing.T) {
	e := draw.NewEngine("h1", "Host", "127.0.0.1", 48671)
	if e.Enabled() {
		t.Fatal("a freshly constructed Engine must not be enabled")
	}
	if id := e.CreateLobby(); id != "" {
		t.Fatal("CreateLobby must be a no-op while disabled")
	}
}

func TestEnableDisableIdempotent(t *testing.T) {
	e := draw.NewEngine("h1", "Host", "127.0.0.1", 48672)
	if err := e.Enable(); err != nil {
		t.Fatal(err)
	}
	if err := e.Enable(); err != nil {
		t.Fatalf("second Enable must be a no-op, got %v", err)
	}
	e.Disable()
	e.Disable()
}

func TestLobbyInviteAndStart(t *testing.T) {
	host, guest := newHostGuest(t, 48673, 48674)
	startGame(t, host, guest, 48673, 48674)

	hs := host.State()
	if hs.TotalRounds != 2 {
		t.Fatalf("expected 2 total rounds for 2 players, got %d", hs.TotalRounds)
	}
	if hs.DrawerID != "h1" {
		t.Fatalf("host should draw first, got drawer %q", hs.DrawerID)
	}
	if hs.Word == "" {
		t.Fatal("host (the drawer) must know the word")
	}
}

func TestNonDrawerNeverSeesWord(t *testing.T) {
	host, guest := newHostGuest(t, 48675, 48676)
	startGame(t, host, guest, 48675, 48676)

	hs := host.State()
	gs := guest.State()
	if gs.Word != "" {
		t.Fatalf("guest is not the drawer but sees word %q", gs.Word)
	}
	if hs.Word == "" {
		t.Fatal("host is the drawer and must know the word")
	}

	// Submit a few strokes from the drawer (host) and confirm the guest still never
	// receives the word, even though state keeps flowing between them.
	for i := 0; i < 3; i++ {
		if err := host.SubmitStroke(draw.Stroke{Points: []draw.Point{{X: 0.1, Y: 0.1}, {X: 0.2, Y: 0.2}}, Color: "#fff", Width: 2}); err != nil {
			t.Fatal(err)
		}
	}
	waitFor(t, func() bool { return len(guest.State().Strokes) == 3 })
	if guest.State().Word != "" {
		t.Fatal("guest must still not know the word after receiving stroke broadcasts")
	}
}

func TestCorrectGuessScoresAndEndsRound(t *testing.T) {
	host, guest := newHostGuest(t, 48677, 48678)
	startGame(t, host, guest, 48677, 48678)

	word := host.State().Word
	if err := guest.SubmitGuess(word); err != nil {
		t.Fatal(err)
	}
	// Only non-drawer (guest) in this 2-player game, so the round should end
	// immediately once they guess correctly.
	waitFor(t, func() bool { return host.State().Phase == draw.PhaseReveal })

	hs := host.State()
	if hs.LastRound == nil {
		t.Fatal("expected LastRound to be populated after the round ends")
	}
	if hs.LastRound.Word != word {
		t.Fatalf("LastRound.Word = %q, want %q", hs.LastRound.Word, word)
	}
	var guestScore, hostScore int
	for _, p := range hs.Players {
		if p.PeerID == "g1" {
			guestScore = p.Score
		}
		if p.PeerID == "h1" {
			hostScore = p.Score
		}
	}
	if guestScore != 3 {
		t.Fatalf("first correct guesser should score 3, got %d", guestScore)
	}
	if hostScore != 1 {
		t.Fatalf("drawer should get a bonus point when someone guesses, got %d", hostScore)
	}

	waitFor(t, func() bool { return guest.State().Phase == draw.PhaseReveal })
	if guest.State().LastRound == nil || guest.State().LastRound.Word != word {
		t.Fatal("guest must see the revealed word in LastRound after the round ends")
	}
}

func TestRoundAdvancesToNextDrawer(t *testing.T) {
	host, guest := newHostGuest(t, 48679, 48680)
	startGame(t, host, guest, 48679, 48680)

	word := host.State().Word
	if err := guest.SubmitGuess(word); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return host.State().Phase == draw.PhaseDrawing && host.State().Round == 2 })

	hs := host.State()
	if hs.DrawerID != "g1" {
		t.Fatalf("round 2 should be drawn by the guest, got drawer %q", hs.DrawerID)
	}
	if hs.Word != "" {
		t.Fatal("host is not the drawer this round and must not know the word")
	}
	waitFor(t, func() bool { return guest.State().Phase == draw.PhaseDrawing && guest.State().Round == 2 })
	if guest.State().Word == "" {
		t.Fatal("guest is the drawer this round and must know the word")
	}

	if err := guest.SubmitStroke(draw.Stroke{Points: []draw.Point{{X: 0.5, Y: 0.5}}, Color: "#000", Width: 3}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(host.State().Strokes) == 1 })
}

func TestGameFinishesAfterAllRounds(t *testing.T) {
	host, guest := newHostGuest(t, 48681, 48682)
	startGame(t, host, guest, 48681, 48682)

	if err := guest.SubmitGuess(host.State().Word); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return host.State().Round == 2 && host.State().Phase == draw.PhaseDrawing })

	drawerWord := host.State().Word
	if drawerWord == "" {
		drawerWord = guest.State().Word
	}
	if err := host.SubmitGuess(drawerWord); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return host.State().Phase == draw.PhaseFinished })
	waitFor(t, func() bool { return guest.State().Phase == draw.PhaseFinished })
}

func TestDeclinesSecondInviteWhileBusy(t *testing.T) {
	host := draw.NewEngine("h1", "Host", "127.0.0.1", 48683)
	host.Enable()
	defer host.Disable()
	busy := draw.NewEngine("b1", "Busy", "127.0.0.1", 48684)
	busy.Enable()
	defer busy.Disable()
	other := draw.NewEngine("o1", "Other", "127.0.0.1", 48685)
	other.Enable()
	defer other.Disable()

	host.CreateLobby()
	host.Invite(discovery.Peer{ID: "b1", Name: "Busy", Addr: "127.0.0.1:48684"})
	waitFor(t, func() bool { return busy.State().Phase == draw.PhaseLobby })

	other.CreateLobby()
	other.Invite(discovery.Peer{ID: "b1", Name: "Busy", Addr: "127.0.0.1:48684"})
	waitFor(t, func() bool {
		for _, p := range other.State().Players {
			if p.PeerID == "b1" {
				return p.Status == "declined"
			}
		}
		return false
	})
}

func TestHostLeaveEndsGuestGame(t *testing.T) {
	host, guest := newHostGuest(t, 48686, 48687)
	startGame(t, host, guest, 48686, 48687)

	host.Leave()
	waitFor(t, func() bool { return guest.State().Phase == draw.PhaseHostLeft })
}

func TestRoundTimeoutEndsRoundWithNoGuesses(t *testing.T) {
	host, guest := newHostGuest(t, 48688, 48689)
	host.SetRoundDuration(300 * time.Millisecond)
	guest.SetRoundDuration(300 * time.Millisecond)
	startGame(t, host, guest, 48688, 48689)

	waitFor(t, func() bool { return host.State().Phase == draw.PhaseReveal })
	hs := host.State()
	if hs.LastRound == nil {
		t.Fatal("expected a LastRound even when nobody guessed")
	}
	for _, d := range hs.LastRound.Deltas {
		if d.PeerID == "h1" {
			t.Fatal("drawer must not get a bonus point when nobody guessed correctly")
		}
	}
}
