package race_test

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/discovery"
	"github.com/AdamShannag/dynamic-island/internal/lobby"
	"github.com/AdamShannag/dynamic-island/internal/race"
)

func engine(t *testing.T, id string, port int) *race.Engine {
	t.Helper()
	e := race.NewEngine(id, id, "127.0.0.1", port)
	if err := e.Enable(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.Disable)
	return e
}

func peer(id string, port int) discovery.Peer {
	return discovery.Peer{ID: id, Name: id, Addr: "127.0.0.1:" + itoa(port)}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func racer(e *race.Engine, id string) (race.Racer, bool) {
	for _, r := range e.State().Racers {
		if r.PeerID == id {
			return r, true
		}
	}
	return race.Racer{}, false
}

func statusIs(e *race.Engine, id, status string) func() bool {
	return func() bool {
		r, ok := racer(e, id)
		return ok && r.Status == status
	}
}

func lobbyWith(t *testing.T, host *race.Engine, guests map[string]int) {
	t.Helper()
	if host.CreateLobby() == "" {
		t.Fatal("CreateLobby failed")
	}
	for id, port := range guests {
		if err := host.Invite(peer(id, port)); err != nil {
			t.Fatal(err)
		}
	}
}

func finishRace(t *testing.T, host *race.Engine, guests ...*race.Engine) {
	t.Helper()
	passage := host.State().Passage
	if err := host.SubmitProgress(len(passage)); err != nil {
		t.Fatal(err)
	}
	for _, g := range guests {
		waitFor(t, func() bool { return g.State().Phase == race.PhaseRacing })
		if err := g.SubmitProgress(len(passage)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDeclinedInviteeDoesNotBlockFinish(t *testing.T) {
	host := engine(t, "h1", 18585)
	g1 := engine(t, "g1", 18586)
	g2 := engine(t, "g2", 18587)
	lobbyWith(t, host, map[string]int{"g1": 18586, "g2": 18587})
	waitFor(t, func() bool { return g1.State().Phase == race.PhaseLobby && g2.State().Phase == race.PhaseLobby })

	if err := g1.Respond(true); err != nil {
		t.Fatal(err)
	}
	if err := g2.Respond(false); err != nil {
		t.Fatal(err)
	}
	waitFor(t, statusIs(host, "g1", "accepted"))
	waitFor(t, statusIs(host, "g2", "declined"))

	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	finishRace(t, host, g1)
	waitFor(t, func() bool { return host.State().Phase == race.PhaseFinished })
	waitFor(t, func() bool { return g1.State().Phase == race.PhaseFinished })
	if _, ok := racer(host, "g2"); ok {
		t.Fatal("a declined invitee must not be part of the race")
	}
}

func TestUnansweredInviteeDoesNotBlockFinish(t *testing.T) {
	host := engine(t, "h1", 18588)
	g1 := engine(t, "g1", 18589)
	g2 := engine(t, "g2", 18590)
	lobbyWith(t, host, map[string]int{"g1": 18589, "g2": 18590})
	waitFor(t, func() bool { return g1.State().Phase == race.PhaseLobby && g2.State().Phase == race.PhaseLobby })

	if err := g1.Respond(true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, statusIs(host, "g1", "accepted"))
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	finishRace(t, host, g1)
	waitFor(t, func() bool { return host.State().Phase == race.PhaseFinished })
	if n := len(host.State().Racers); n != 2 {
		t.Fatalf("racers = %d, want only the host and the accepted guest", n)
	}
}

func TestGuestDetectsHostLeavingDuringLobby(t *testing.T) {
	host := race.NewEngine("h1", "h1", "127.0.0.1", 18591)
	if err := host.Enable(); err != nil {
		t.Fatal(err)
	}
	defer host.Disable()
	guest := engine(t, "g1", 18592)
	lobbyWith(t, host, map[string]int{"g1": 18592})
	waitFor(t, func() bool { return guest.State().Phase == race.PhaseLobby })
	if err := guest.Respond(true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, statusIs(host, "g1", "accepted"))

	host.Disable()
	waitFor(t, func() bool { return guest.State().Phase == race.PhaseHostLeft })
}

func TestCreateLobbyIsNoOpWhileBusy(t *testing.T) {
	host := engine(t, "h1", 18593)
	first := host.CreateLobby()
	if first == "" {
		t.Fatal("first CreateLobby failed")
	}
	if id := host.CreateLobby(); id != "" {
		t.Fatalf("second CreateLobby returned %q, want a no-op", id)
	}
	if host.State().LobbyID != first {
		t.Fatal("second CreateLobby must not replace the open lobby")
	}
}

func TestInviteGuards(t *testing.T) {
	host := engine(t, "h1", 18594)
	guest := engine(t, "g1", 18595)
	lobbyWith(t, host, map[string]int{"g1": 18595})
	if err := host.Invite(peer("g1", 18595)); err == nil {
		t.Fatal("inviting the same peer twice must fail")
	}
	if n := len(host.State().Racers); n != 2 {
		t.Fatalf("racers = %d after a duplicate invite, want 2", n)
	}
	waitFor(t, func() bool { return guest.State().Phase == race.PhaseLobby })
	if err := guest.Respond(true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, statusIs(host, "g1", "accepted"))
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	if err := host.Invite(peer("g9", 18599)); err == nil {
		t.Fatal("inviting mid-race must fail")
	}
	if _, ok := racer(host, "g9"); ok {
		t.Fatal("a mid-race invite must not add a racer")
	}
}

func TestStartAndProgressIgnoredOutsideTheirPhase(t *testing.T) {
	host := engine(t, "h1", 18596)
	guest := engine(t, "g1", 18597)

	_ = lobby.SendStart("127.0.0.1:18597", lobby.Start{LobbyID: "nope", Payload: json.RawMessage(`"x"`)})
	if guest.State().Phase != race.PhaseIdle {
		t.Fatal("an idle guest must ignore /start")
	}

	id := host.CreateLobby()
	if err := host.Invite(peer("g1", 18597)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Phase == race.PhaseLobby })
	if err := guest.Respond(true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, statusIs(host, "g1", "accepted"))

	_ = lobby.SendProgress("127.0.0.1:18596", lobby.Progress{LobbyID: id, PeerID: "g1", Payload: json.RawMessage(`{"typedChars":5}`)})
	time.Sleep(100 * time.Millisecond)
	if r, _ := racer(host, "g1"); r.Progress != 0 {
		t.Fatal("progress must be ignored while still in the lobby")
	}

	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Phase == race.PhaseRacing })
	passage := guest.State().Passage
	_ = lobby.SendStart("127.0.0.1:18597", lobby.Start{LobbyID: id, Payload: json.RawMessage(`"a different passage"`)})
	time.Sleep(100 * time.Millisecond)
	if guest.State().Passage != passage {
		t.Fatal("a duplicate /start must be ignored once racing")
	}
}

func acceptedLobby(t *testing.T, host *race.Engine, guests map[string]int, engines ...*race.Engine) {
	t.Helper()
	lobbyWith(t, host, guests)
	for _, g := range engines {
		waitFor(t, func() bool { return g.State().Phase == race.PhaseLobby })
		if err := g.Respond(true); err != nil {
			t.Fatal(err)
		}
	}
	for id := range guests {
		waitFor(t, statusIs(host, id, "accepted"))
	}
}

func TestRaceTimesOut(t *testing.T) {
	host := engine(t, "h1", 18600)
	host.SetRaceTimeout(500 * time.Millisecond)
	guest := engine(t, "g1", 18601)
	acceptedLobby(t, host, map[string]int{"g1": 18601}, guest)
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Phase == race.PhaseRacing })
	if err := host.SubmitProgress(len(host.State().Passage)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return host.State().Phase == race.PhaseFinished })
	waitFor(t, func() bool { return guest.State().Phase == race.PhaseFinished })
	if r, _ := racer(host, "g1"); r.FinishedAtMs != 0 {
		t.Fatal("the guest never finished, so it must be ranked as did-not-finish")
	}
}

func TestLateAcceptIsToldTheRaceStarted(t *testing.T) {
	host := engine(t, "h1", 18602)
	g1 := engine(t, "g1", 18603)
	g2 := engine(t, "g2", 18604)
	lobbyWith(t, host, map[string]int{"g1": 18603, "g2": 18604})
	waitFor(t, func() bool { return g1.State().Phase == race.PhaseLobby && g2.State().Phase == race.PhaseLobby })
	if err := g1.Respond(true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, statusIs(host, "g1", "accepted"))
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	if err := g2.Respond(true); err == nil {
		t.Fatal("accepting after the race started must fail")
	}
	waitFor(t, func() bool { return g2.State().Phase == race.PhaseMissed })
	if _, ok := racer(host, "g2"); ok {
		t.Fatal("a late accept must not join the running race")
	}
}

func TestGuestLeavingMidRaceDoesNotBlockFinish(t *testing.T) {
	host := engine(t, "h1", 18605)
	g1 := engine(t, "g1", 18606)
	g2 := engine(t, "g2", 18607)
	acceptedLobby(t, host, map[string]int{"g1": 18606, "g2": 18607}, g1, g2)
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return g2.State().Phase == race.PhaseRacing })
	g2.Leave()
	waitFor(t, func() bool { _, ok := racer(host, "g2"); return !ok })
	finishRace(t, host, g1)
	waitFor(t, func() bool { return host.State().Phase == race.PhaseFinished })
}

func TestInviteAcceptedFromTerminalPhase(t *testing.T) {
	host := engine(t, "h1", 18608)
	guest := engine(t, "g1", 18609)
	other := engine(t, "o1", 18610)
	acceptedLobby(t, host, map[string]int{"g1": 18609}, guest)
	host.Leave()
	waitFor(t, func() bool { return guest.State().Phase == race.PhaseHostLeft })

	id := other.CreateLobby()
	if err := other.Invite(peer("g1", 18609)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Phase == race.PhaseLobby && guest.State().LobbyID == id })
	if r, _ := racer(other, "g1"); r.Status != "pending" {
		t.Fatalf("status = %q, a guest sitting on a stale result must not auto-decline", r.Status)
	}
}

func TestProgressFromAnotherAddressIsIgnored(t *testing.T) {
	host := engine(t, "h1", 18611)
	guest := engine(t, "g1", 18612)
	acceptedLobby(t, host, map[string]int{"g1": 18612}, guest)
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	spoof := &http.Client{Transport: &http.Transport{DialContext: (&net.Dialer{
		LocalAddr: &net.TCPAddr{IP: net.ParseIP("127.0.0.2")},
	}).DialContext}}
	body, _ := json.Marshal(lobby.Progress{LobbyID: host.State().LobbyID, PeerID: "g1", Payload: json.RawMessage(`{"typedChars":9999}`)})
	resp, err := spoof.Post("http://127.0.0.1:18611/progress", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409 for progress claiming another peer's id", resp.StatusCode)
	}
	if r, _ := racer(host, "g1"); r.Progress != 0 {
		t.Fatal("spoofed progress must not move the racer")
	}
}

func TestStartDoesNotWaitOnASlowGuest(t *testing.T) {
	host := engine(t, "h1", 18613)
	fast := engine(t, "g1", 18614)

	release := make(chan struct{})
	defer close(release)
	slow := &http.Server{Addr: "127.0.0.1:18615", Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			<-release
		}
	})}
	go slow.ListenAndServe()
	defer slow.Close()
	time.Sleep(50 * time.Millisecond)

	id := host.CreateLobby()
	if err := host.Invite(peer("slow", 18615)); err != nil {
		t.Fatal(err)
	}
	if err := lobby.SendRespond("127.0.0.1:18613", lobby.Response{LobbyID: id, PeerID: "slow", Accept: true}); err != nil {
		t.Fatal(err)
	}
	if err := host.Invite(peer("g1", 18614)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return fast.State().Phase == race.PhaseLobby })
	if err := fast.Respond(true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, statusIs(host, "g1", "accepted"))

	go host.Start()
	deadline := time.Now().Add(time.Second)
	for fast.State().Phase != race.PhaseRacing {
		if time.Now().After(deadline) {
			t.Fatal("a guest that answers quickly must not wait behind a slow one")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestEnableFailsWhenThePortIsTaken(t *testing.T) {
	ln, err := net.Listen("tcp", ":18616")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	e := race.NewEngine("h1", "h1", "127.0.0.1", 18616)
	if err := e.Enable(); err == nil {
		e.Disable()
		t.Fatal("Enable must report a port held by another process")
	}
	if e.Enabled() {
		t.Fatal("a failed Enable must leave the engine disabled")
	}
}

func TestBogusProgressIsClampedToThePassage(t *testing.T) {
	host := engine(t, "h1", 18617)
	guest := engine(t, "g1", 18618)
	acceptedLobby(t, host, map[string]int{"g1": 18618}, guest)
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return guest.State().Phase == race.PhaseRacing })
	passage := guest.State().Passage
	if err := guest.SubmitProgress(1 << 30); err != nil {
		t.Fatal(err)
	}
	if err := host.SubmitProgress(len(passage)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return host.State().Phase == race.PhaseFinished })
	g, _ := racer(host, "g1")
	h, _ := racer(host, "h1")
	if g.Progress != 1 || g.WPM > h.WPM*2+1 {
		t.Fatalf("guest progress %v wpm %v (host wpm %v): a huge count must not inflate WPM", g.Progress, g.WPM, h.WPM)
	}
}

func TestNotifyDeliversOnlyTheLatestQueuedState(t *testing.T) {
	e := engine(t, "h1", 18619)
	release := make(chan struct{})
	var mu sync.Mutex
	var got []race.State
	e.OnChange(func(s race.State) {
		mu.Lock()
		first := len(got) == 0
		got = append(got, s)
		mu.Unlock()
		if first {
			<-release
		}
	})

	go e.CreateLobby()
	waitFor(t, func() bool { mu.Lock(); defer mu.Unlock(); return len(got) == 1 })
	e.Leave()
	second := e.CreateLobby()
	close(release)

	waitFor(t, func() bool { mu.Lock(); defer mu.Unlock(); return len(got) >= 2 })
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 2 {
		t.Fatalf("delivered %d states, want the blocked one plus only the latest", len(got))
	}
	if last := got[len(got)-1]; last.LobbyID != second || last.Phase != race.PhaseLobby {
		t.Fatalf("last delivered state = %+v, want the current lobby %s", last, second)
	}
}
