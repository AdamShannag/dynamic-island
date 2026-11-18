package party_test

import (
	"math"
	"testing"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/discovery"
	"github.com/AdamShannag/dynamic-island/internal/party"
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

func engine(t *testing.T, id string, port int) *party.Engine {
	t.Helper()
	e := party.NewEngine(id, id, "127.0.0.1", port)
	if err := e.Enable(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.Disable)
	return e
}

func peer(id string, port int) discovery.Peer {
	return discovery.Peer{ID: id, Name: id, Addr: "127.0.0.1:" + portStr(port)}
}

func portStr(n int) string {
	const digits = "0123456789"
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{digits[n%10]}, b...)
		n /= 10
	}
	return string(b)
}

func playerStatus(s party.State, id string) (string, bool) {
	for _, p := range s.Players {
		if p.PeerID == id {
			return p.Status, true
		}
	}
	return "", false
}

func TestCreateLobbyIsNoOpWhileBusy(t *testing.T) {
	host := engine(t, "h1", 19001)
	first := host.CreateLobby()
	if first == "" {
		t.Fatal("first CreateLobby failed")
	}
	if id := host.CreateLobby(); id != "" {
		t.Fatalf("second CreateLobby returned %q, want a no-op", id)
	}
}

func TestStartRequiresAModeFirst(t *testing.T) {
	host := engine(t, "h1", 19002)
	host.CreateLobby()
	if err := host.Start(); err == nil {
		t.Fatal("Start without a mode selected must fail")
	}
	if err := host.SetMode(party.ModeRace); err != nil {
		t.Fatal(err)
	}
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	if host.State().Phase != party.PhasePlaying || host.State().Mode != party.ModeRace {
		t.Fatalf("got %+v", host.State())
	}
}

func TestDeclinedInviteeDoesNotJoinTheGame(t *testing.T) {
	host := engine(t, "h1", 19003)
	g1 := engine(t, "g1", 19004)
	g2 := engine(t, "g2", 19005)
	host.CreateLobby()
	if err := host.Invite(peer("g1", 19004)); err != nil {
		t.Fatal(err)
	}
	if err := host.Invite(peer("g2", 19005)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return g1.State().Phase == party.PhaseLobby && g2.State().Phase == party.PhaseLobby })
	if err := g1.Respond(true); err != nil {
		t.Fatal(err)
	}
	if err := g2.Respond(false); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { s, ok := playerStatus(host.State(), "g1"); return ok && s == "accepted" })
	waitFor(t, func() bool { s, ok := playerStatus(host.State(), "g2"); return ok && s == "declined" })

	if err := host.SetMode(party.ModeRace); err != nil {
		t.Fatal(err)
	}
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	if host.State().Race == nil {
		t.Fatal("expected race gameplay state once playing")
	}
	for _, r := range host.State().Race.Racers {
		if r.PeerID == "g2" {
			t.Fatal("a declined invitee must not be part of the race")
		}
	}
}

func TestGuestDetectsHostLeavingDuringLobby(t *testing.T) {
	host := engine(t, "h1", 19006)
	guest := engine(t, "g1", 19007)
	host.CreateLobby()
	if err := host.Invite(peer("g1", 19007)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Phase == party.PhaseLobby })
	if err := guest.Respond(true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { s, ok := playerStatus(host.State(), "g1"); return ok && s == "accepted" })

	host.Disable()
	waitFor(t, func() bool { return guest.State().Phase == party.PhaseHostLeft })
}

func TestRaceEndToEndOverRealHTTP(t *testing.T) {
	host := engine(t, "h1", 19008)
	guest := engine(t, "g1", 19009)
	host.CreateLobby()
	if err := host.Invite(peer("g1", 19009)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Phase == party.PhaseLobby })
	if err := guest.Respond(true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { s, ok := playerStatus(host.State(), "g1"); return ok && s == "accepted" })

	if err := host.SetMode(party.ModeRace); err != nil {
		t.Fatal(err)
	}
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Race != nil && guest.State().Race.Passage != "" })

	passage := guest.State().Race.Passage
	if err := guest.RaceEngine().SubmitProgress(len([]rune(passage))); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		if host.State().Race == nil {
			return false
		}
		for _, r := range host.State().Race.Racers {
			if r.PeerID == "g1" && r.FinishedAtMs != 0 {
				return true
			}
		}
		return false
	})
}

func TestDrawEndToEndKeepsEachPlayersPromptSecretFromTheOther(t *testing.T) {
	host := engine(t, "h1", 19010)
	guest := engine(t, "g1", 19011)
	host.CreateLobby()
	if err := host.Invite(peer("g1", 19011)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Phase == party.PhaseLobby })
	if err := guest.Respond(true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { s, ok := playerStatus(host.State(), "g1"); return ok && s == "accepted" })

	if err := host.SetMode(party.ModeDraw); err != nil {
		t.Fatal(err)
	}
	if err := host.SetRounds(1); err != nil {
		t.Fatal(err)
	}
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	// Both players draw their own word at once.
	waitFor(t, func() bool { return guest.State().Draw != nil && guest.State().Draw.Prompt != nil })

	hostWord := host.State().Draw.Prompt.Word
	guestWord := guest.State().Draw.Prompt.Word
	if hostWord == "" || guestWord == "" {
		t.Fatal("both players must know their own word to draw")
	}
	if hostWord == guestWord {
		t.Fatal("the two players must not be given the same starting word")
	}

	if err := host.DrawEngine().SubmitDrawing(nil); err != nil {
		t.Fatal(err)
	}
	if err := guest.DrawEngine().SubmitDrawing(nil); err != nil {
		t.Fatal(err)
	}
	// Now guessing: each must be shown the other's drawing, never their own.
	waitFor(t, func() bool {
		return host.State().Draw != nil && host.State().Draw.Prompt != nil && host.State().Draw.Prompt.Kind == "drawing"
	})
	if host.State().Draw.Prompt.FromPeerID != "g1" {
		t.Fatalf("host should be guessing the guest's drawing, got from %q", host.State().Draw.Prompt.FromPeerID)
	}
	if guest.State().Draw.Prompt.FromPeerID != "h1" {
		t.Fatalf("guest should be guessing the host's drawing, got from %q", guest.State().Draw.Prompt.FromPeerID)
	}

	if err := host.DrawEngine().SubmitGuess("a guess"); err != nil {
		t.Fatal(err)
	}
	if err := guest.DrawEngine().SubmitGuess("another guess"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return host.State().Phase == party.PhaseFinished })
	waitFor(t, func() bool { return guest.State().Phase == party.PhaseFinished })
	if len(host.State().Draw.Chains) != 2 {
		t.Fatalf("got %d chains at the end, want one per player", len(host.State().Draw.Chains))
	}
}

func TestPartyPhaseTransitionsToFinishedAndSupportsARematch(t *testing.T) {
	host := engine(t, "h1", 19015)
	guest := engine(t, "g1", 19016)
	host.CreateLobby()
	if err := host.Invite(peer("g1", 19016)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Phase == party.PhaseLobby })
	if err := guest.Respond(true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { s, ok := playerStatus(host.State(), "g1"); return ok && s == "accepted" })

	if err := host.SetMode(party.ModeRace); err != nil {
		t.Fatal(err)
	}
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	if host.State().Phase != party.PhasePlaying {
		t.Fatalf("phase = %v, want playing", host.State().Phase)
	}
	waitFor(t, func() bool { return guest.State().Race != nil && guest.State().Race.Passage != "" })

	passageLen := len([]rune(host.State().Race.Passage))
	if err := host.RaceEngine().SubmitProgress(passageLen); err != nil {
		t.Fatal(err)
	}
	if err := guest.RaceEngine().SubmitProgress(passageLen); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return host.State().Phase == party.PhaseFinished })

	// A finished round must not tear down the lobby's pub/sub channel: the
	// guest should learn the game finished over the still-open subscription
	// (not by having it closed out from under it), and the host's lobby
	// server must still be able to reach the guest afterward.
	waitFor(t, func() bool { return guest.State().Phase == party.PhaseFinished })

	if err := host.Rematch(); err != nil {
		t.Fatalf("Rematch after finishing must succeed, got: %v", err)
	}
	if host.State().Phase != party.PhaseLobby || host.State().Mode != party.ModeNone {
		t.Fatalf("got %+v, want back in the lobby with no mode selected", host.State())
	}

	// This only succeeds if (a) the guest's lobby subscription survived the
	// round ending, so the rematch broadcast can even reach it, and (b) the
	// guest's phase-gating lets a "party" snapshot move it out of
	// PhaseFinished back into PhaseLobby.
	waitFor(t, func() bool { return guest.State().Phase == party.PhaseLobby })
	if guest.State().Mode != party.ModeNone {
		t.Fatalf("got %+v, want the guest's mode reset by the rematch too", guest.State())
	}
}

func TestHostLeavingMidGameStillDisbandsTheLobby(t *testing.T) {
	host := engine(t, "h1", 19017)
	guest := engine(t, "g1", 19018)
	host.CreateLobby()
	if err := host.Invite(peer("g1", 19018)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Phase == party.PhaseLobby })
	if err := guest.Respond(true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { s, ok := playerStatus(host.State(), "g1"); return ok && s == "accepted" })

	if err := host.SetMode(party.ModeRace); err != nil {
		t.Fatal(err)
	}
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Race != nil && guest.State().Race.Passage != "" })

	// Unlike a round finishing on its own, the host explicitly leaving
	// mid-game must still tear the lobby down for the guest.
	host.Leave()
	waitFor(t, func() bool { return guest.State().Phase == party.PhaseHostLeft })
}

func TestSnakeEndToEndOverRealHTTP(t *testing.T) {
	host := engine(t, "h1", 19019)
	guest := engine(t, "g1", 19020)
	host.CreateLobby()
	if err := host.Invite(peer("g1", 19020)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Phase == party.PhaseLobby })
	if err := guest.Respond(true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { s, ok := playerStatus(host.State(), "g1"); return ok && s == "accepted" })

	if err := host.SetMode(party.ModeSnake); err != nil {
		t.Fatal(err)
	}
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Snake != nil && len(guest.State().Snake.Players) == 2 })
	if host.State().Snake == nil || len(host.State().Snake.Players) != 2 {
		t.Fatal("expected the host to also see both snake players")
	}

	guestHead := func(s party.State) (float64, float64, bool) {
		if s.Snake == nil {
			return 0, 0, false
		}
		for _, p := range s.Snake.Players {
			if p.PeerID == "g1" && len(p.Body) > 0 {
				return p.Body[0].X, p.Body[0].Y, true
			}
		}
		return 0, 0, false
	}

	x0, y0, ok := guestHead(guest.State())
	if !ok {
		t.Fatal("expected the guest's own snake to have a body")
	}

	// The host applies its own input directly, since it is authoritative.
	if err := host.SnakeEngine().HandleInput("h1", 0); err != nil {
		t.Fatal(err)
	}

	// The guest steers over its own HTTP progress call to the host; the
	// resulting movement must come back down the guest's still-open lobby
	// subscription as a broadcast, not be applied locally.
	if err := guest.SnakeEngine().HandleInput("g1", math.Pi/4); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		x, y, ok := guestHead(guest.State())
		return ok && (x != x0 || y != y0)
	})

	hx0, hy0, ok := guestHead(host.State())
	if !ok {
		t.Fatal("expected the host to also track the guest's snake")
	}
	waitFor(t, func() bool {
		x, y, ok := guestHead(host.State())
		return ok && (x != hx0 || y != hy0)
	})

	if host.State().Phase != party.PhasePlaying || guest.State().Phase != party.PhasePlaying {
		t.Fatal("the match must still be playing while snakes are simply moving around")
	}
}

func TestLateAcceptIsToldTheGameStarted(t *testing.T) {
	host := engine(t, "h1", 19012)
	g1 := engine(t, "g1", 19013)
	g2 := engine(t, "g2", 19014)
	host.CreateLobby()
	if err := host.Invite(peer("g1", 19013)); err != nil {
		t.Fatal(err)
	}
	if err := host.Invite(peer("g2", 19014)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return g1.State().Phase == party.PhaseLobby && g2.State().Phase == party.PhaseLobby })
	if err := g1.Respond(true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { s, ok := playerStatus(host.State(), "g1"); return ok && s == "accepted" })
	if err := host.SetMode(party.ModeRace); err != nil {
		t.Fatal(err)
	}
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	if err := g2.Respond(true); err == nil {
		t.Fatal("accepting after the game started must fail")
	}
	waitFor(t, func() bool { return g2.State().Phase == party.PhaseMissed })
}
