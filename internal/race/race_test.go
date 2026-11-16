package race_test

import (
	"net"
	"testing"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/discovery"
	"github.com/AdamShannag/dynamic-island/internal/race"
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

func TestHostStartRace(t *testing.T) {
	host := race.NewEngine("h1", "Host", "127.0.0.1", 48571)
	if err := host.Enable(); err != nil {
		t.Fatal(err)
	}
	defer host.Disable()
	guest := race.NewEngine("g1", "Guest", "127.0.0.1", 48572)
	if err := guest.Enable(); err != nil {
		t.Fatal(err)
	}
	defer guest.Disable()

	var guestStates []race.State
	guest.OnChange(func(s race.State) { guestStates = append(guestStates, s) })

	lobbyID := host.CreateLobby()
	if err := host.Invite(discovery.Peer{ID: "g1", Name: "Guest", Addr: "127.0.0.1:48572"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Phase == race.PhaseLobby })

	if err := guest.Respond(true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		for _, r := range host.State().Racers {
			if r.PeerID == "g1" && r.Status == "accepted" {
				return true
			}
		}
		return false
	})

	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Phase == race.PhaseRacing && guest.State().Passage != "" })

	passage := guest.State().Passage
	if err := guest.SubmitProgress(len(passage)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		for _, r := range host.State().Racers {
			if r.PeerID == "g1" && r.FinishedAtMs != 0 {
				return true
			}
		}
		return false
	})
	if lobbyID == "" {
		t.Fatal("empty lobby id")
	}
}

func TestDeclinesSecondInviteWhileBusy(t *testing.T) {
	host := race.NewEngine("h1", "Host", "127.0.0.1", 48573)
	host.Enable()
	defer host.Disable()
	busy := race.NewEngine("b1", "Busy", "127.0.0.1", 48574)
	busy.Enable()
	defer busy.Disable()
	other := race.NewEngine("o1", "Other", "127.0.0.1", 48575)
	other.Enable()
	defer other.Disable()

	host.CreateLobby()
	host.Invite(discovery.Peer{ID: "b1", Name: "Busy", Addr: "127.0.0.1:48574"})
	waitFor(t, func() bool { return busy.State().Phase == race.PhaseLobby })

	other.CreateLobby()
	other.Invite(discovery.Peer{ID: "b1", Name: "Busy", Addr: "127.0.0.1:48574"})
	waitFor(t, func() bool {
		for _, r := range other.State().Racers {
			if r.PeerID == "b1" {
				return r.Status == "declined"
			}
		}
		return false
	})
	if busy.State().LobbyID != host.State().LobbyID {
		t.Fatal("the busy engine's original lobby must be unaffected by the second invite")
	}
}

func TestNewEngineOpensNothing(t *testing.T) {
	e := race.NewEngine("h1", "Host", "127.0.0.1", 48576)
	if e.Enabled() {
		t.Fatal("a freshly constructed Engine must not be enabled")
	}
	l, err := net.Listen("tcp", "127.0.0.1:48576")
	if err != nil {
		t.Fatalf("port 48576 was already bound by NewEngine: %v", err)
	}
	l.Close()
	if id := e.CreateLobby(); id != "" {
		t.Fatal("CreateLobby must be a no-op while disabled")
	}
}

func TestEnableDisableIdempotent(t *testing.T) {
	e := race.NewEngine("h1", "Host", "127.0.0.1", 48577)
	if err := e.Enable(); err != nil {
		t.Fatal(err)
	}
	if err := e.Enable(); err != nil {
		t.Fatalf("second Enable must be a no-op, got %v", err)
	}
	e.Disable()
	e.Disable()
}
