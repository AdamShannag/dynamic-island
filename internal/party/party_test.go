package party_test

import (
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

func TestDrawEndToEndKeepsTheWordSecretFromTheGuesser(t *testing.T) {
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
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	// The host draws first (join order), so the guest is the guesser here.
	waitFor(t, func() bool { return guest.State().Draw != nil && guest.State().Draw.DrawerID != "" })

	if guest.State().Draw.Word != "" {
		t.Fatal("the guesser must never receive the word")
	}
	if host.State().Draw.Word == "" {
		t.Fatal("the drawer (host) must know the word")
	}

	if err := guest.DrawEngine().SubmitGuess(host.State().Draw.Word); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		return host.State().Draw != nil && len(host.State().Draw.Guessed) == 1
	})
	if guest.State().Draw.Word != "" {
		t.Fatal("the guesser must still never learn the word, even after a correct guess broadcast")
	}
}

func TestPartyPhaseTransitionsToFinishedAndSupportsARematch(t *testing.T) {
	host := engine(t, "h1", 19015)
	host.CreateLobby()
	if err := host.SetMode(party.ModeRace); err != nil {
		t.Fatal(err)
	}
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	if host.State().Phase != party.PhasePlaying {
		t.Fatalf("phase = %v, want playing", host.State().Phase)
	}
	passageLen := len([]rune(host.State().Race.Passage))
	if err := host.RaceEngine().SubmitProgress(passageLen); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return host.State().Phase == party.PhaseFinished })

	if err := host.Rematch(); err != nil {
		t.Fatalf("Rematch after finishing must succeed, got: %v", err)
	}
	if host.State().Phase != party.PhaseLobby || host.State().Mode != party.ModeNone {
		t.Fatalf("got %+v, want back in the lobby with no mode selected", host.State())
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
