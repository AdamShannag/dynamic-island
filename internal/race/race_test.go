package race_test

import (
	"net"
	"sync"
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

func TestGuestPhaseFinishedOnCleanRaceEnd(t *testing.T) {
	host := race.NewEngine("h1", "Host", "127.0.0.1", 18581)
	if err := host.Enable(); err != nil {
		t.Fatal(err)
	}
	defer host.Disable()
	guest := race.NewEngine("g1", "Guest", "127.0.0.1", 18582)
	if err := guest.Enable(); err != nil {
		t.Fatal(err)
	}
	defer guest.Disable()

	host.CreateLobby()
	if err := host.Invite(discovery.Peer{ID: "g1", Name: "Guest", Addr: "127.0.0.1:18582"}); err != nil {
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
	if err := host.SubmitProgress(len(passage)); err != nil {
		t.Fatal(err)
	}
	if err := guest.SubmitProgress(len(passage)); err != nil {
		t.Fatal(err)
	}

	waitFor(t, func() bool { return guest.State().Phase == race.PhaseFinished })

	for _, r := range guest.State().Racers {
		if r.FinishedAtMs == 0 {
			t.Fatalf("expected racer %s to be finished in the guest's view, got %+v", r.PeerID, r)
		}
	}
}

func TestEnableConcurrentIsSafe(t *testing.T) {
	e := race.NewEngine("h1", "Host", "127.0.0.1", 18583)
	defer e.Disable()

	var wg sync.WaitGroup
	errs := make(chan error, 5)
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := e.Enable(); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent Enable() returned an error: %v", err)
	}

	if !e.Enabled() {
		t.Fatal("engine should be enabled after concurrent Enable() calls")
	}
	if id := e.CreateLobby(); id == "" {
		t.Fatal("CreateLobby should work after concurrent Enable() calls settle")
	}
}

func TestOnChangeReentrantLeaveDoesNotDeadlock(t *testing.T) {
	e := race.NewEngine("h1", "Host", "127.0.0.1", 18584)
	if err := e.Enable(); err != nil {
		t.Fatal(err)
	}
	defer e.Disable()

	done := make(chan struct{})
	e.OnChange(func(s race.State) {
		if s.Phase == race.PhaseLobby {
			e.Leave()
			close(done)
		}
	})

	e.CreateLobby()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("reentrant Leave() call from inside OnChange appears to have deadlocked")
	}

	waitFor(t, func() bool { return e.State().Phase == race.PhaseIdle })
}
