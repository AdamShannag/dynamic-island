package lobby_test

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/lobby"
)

func TestInviteRespondRoundTrip(t *testing.T) {
	var got lobby.Invite
	invited := make(chan struct{})
	invitee := lobby.NewServer(48561, lobby.Callbacks{
		OnInvite: func(inv lobby.Invite) error { got = inv; close(invited); return nil },
	})
	if err := invitee.Listen(); err != nil {
		t.Fatal(err)
	}
	defer invitee.Close()

	err := lobby.SendInvite("127.0.0.1:48561", lobby.Invite{
		LobbyID: "l1", Kind: "race", HostID: "h1", HostName: "Host", HostAddr: "127.0.0.1:48560",
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-invited:
	case <-time.After(2 * time.Second):
		t.Fatal("OnInvite never called")
	}
	if got.LobbyID != "l1" || got.Kind != "race" {
		t.Fatalf("got %+v", got)
	}
}

func TestInboundAddressesComeFromTheConnection(t *testing.T) {
	invites := make(chan lobby.Invite, 1)
	responses := make(chan lobby.Response, 1)
	s := lobby.NewServer(18633, lobby.Callbacks{
		OnInvite:  func(inv lobby.Invite) error { invites <- inv; return nil },
		OnRespond: func(r lobby.Response) error { responses <- r; return nil },
	})
	if err := s.Listen(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	if err := lobby.SendInvite("127.0.0.1:18633", lobby.Invite{
		LobbyID: "l1", Kind: "race", HostID: "h1", HostAddr: "10.9.9.9:4000",
	}); err != nil {
		t.Fatal(err)
	}
	if inv := <-invites; inv.HostAddr != "127.0.0.1:4000" {
		t.Fatalf("HostAddr = %q, want the connection's IP with the claimed port", inv.HostAddr)
	}
	if err := lobby.SendRespond("127.0.0.1:18633", lobby.Response{LobbyID: "l1", PeerID: "p1"}); err != nil {
		t.Fatal(err)
	}
	if r := <-responses; r.RemoteIP != "127.0.0.1" {
		t.Fatalf("RemoteIP = %q", r.RemoteIP)
	}
	if err := lobby.SendInvite("127.0.0.1:18633", lobby.Invite{
		LobbyID: "l1", Kind: "race", HostID: "h1", HostAddr: "no-port",
	}); err == nil {
		t.Fatal("an invite without a usable host port must be rejected")
	}
}

func TestServerRejectsBadBody(t *testing.T) {
	called := false
	s := lobby.NewServer(48562, lobby.Callbacks{OnInvite: func(lobby.Invite) error { called = true; return nil }})
	if err := s.Listen(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	resp, err := http.Post("http://127.0.0.1:48562/invite", "application/json", strings.NewReader("not json"))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	if called {
		t.Fatal("OnInvite must not be called for a malformed body")
	}

	huge := strings.NewReader(strings.Repeat("a", 1<<20))
	resp2, err := http.Post("http://127.0.0.1:48562/invite", "application/json", huge)
	if err != nil {
		t.Fatal(err)
	}
	if resp2.StatusCode != http.StatusBadRequest {
		t.Fatalf("oversized body status = %d, want 400", resp2.StatusCode)
	}
}

func TestSubscribeReceivesBroadcastAndClose(t *testing.T) {
	s := lobby.NewServer(48563, lobby.Callbacks{})
	if err := s.Listen(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.OpenLobby("l1")

	events := make(chan json.RawMessage, 4)
	closedErr := make(chan error, 1)
	cancel := lobby.Subscribe("127.0.0.1:48563", "l1",
		func(p json.RawMessage) { events <- p },
		func(err error) { closedErr <- err })
	defer cancel()
	time.Sleep(50 * time.Millisecond)

	s.Broadcast("l1", json.RawMessage(`{"n":1}`))
	select {
	case got := <-events:
		if string(got) != `{"n":1}` {
			t.Fatalf("got %s", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("event never received")
	}

	s.EndLobby("l1", json.RawMessage(`{"ended":true}`))
	select {
	case <-closedErr:
	case <-time.After(2 * time.Second):
		t.Fatal("onClosed never called after EndLobby")
	}
}

func TestBroadcastDuringEndLobbyDoesNotPanic(t *testing.T) {
	s := lobby.NewServer(48564, lobby.Callbacks{})
	if err := s.Listen(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.OpenLobby("l1")

	cancel := lobby.Subscribe("127.0.0.1:48564", "l1",
		func(json.RawMessage) {},
		func(error) {})
	defer cancel()
	time.Sleep(50 * time.Millisecond)

	var wg sync.WaitGroup
	var panicked atomic.Bool
	stop := make(chan struct{})

	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				if recover() != nil {
					panicked.Store(true)
				}
			}()
			for {
				select {
				case <-stop:
					return
				default:
					s.Broadcast("l1", json.RawMessage(`{"n":1}`))
				}
			}
		}()
	}

	go func() {
		time.Sleep(2 * time.Millisecond)
		s.EndLobby("l1", json.RawMessage(`{"ended":true}`))
	}()

	time.Sleep(30 * time.Millisecond)
	close(stop)
	wg.Wait()

	if panicked.Load() {
		t.Fatal("Broadcast panicked racing EndLobby")
	}
}

func TestSubscribeToUnknownLobbyCloses(t *testing.T) {
	s := lobby.NewServer(18630, lobby.Callbacks{})
	if err := s.Listen(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	closedErr := make(chan error, 1)
	cancel := lobby.Subscribe("127.0.0.1:18630", "missing", func(json.RawMessage) {}, func(err error) { closedErr <- err })
	defer cancel()
	select {
	case err := <-closedErr:
		if err == nil {
			t.Fatal("expected an error for a lobby that is not open")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("subscribing to a lobby that is not open must close at once")
	}
}

func TestCallbackErrorsMapToStatus(t *testing.T) {
	s := lobby.NewServer(18631, lobby.Callbacks{
		OnRespond: func(lobby.Response) error { return lobby.ErrClosed },
		OnStart:   func(lobby.Start) error { return lobby.ErrRejected },
	})
	if err := s.Listen(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	err := lobby.SendRespond("127.0.0.1:18631", lobby.Response{LobbyID: "l1", PeerID: "p1", Accept: true})
	if !errors.Is(err, lobby.ErrClosed) {
		t.Fatalf("respond err = %v, want ErrClosed", err)
	}
	if err := lobby.SendStart("127.0.0.1:18631", lobby.Start{LobbyID: "l1"}); err == nil || errors.Is(err, lobby.ErrClosed) {
		t.Fatalf("start err = %v, want a plain rejection", err)
	}
}

func TestNoOnClosedAfterCancel(t *testing.T) {
	s := lobby.NewServer(18632, lobby.Callbacks{})
	if err := s.Listen(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.OpenLobby("l1")

	var closed atomic.Bool
	cancel := lobby.Subscribe("127.0.0.1:18632", "l1", func(json.RawMessage) {}, func(error) { closed.Store(true) })
	time.Sleep(50 * time.Millisecond)
	cancel()
	time.Sleep(100 * time.Millisecond)
	if closed.Load() {
		t.Fatal("onClosed must not fire for a subscription the caller cancelled")
	}
}

func TestSendTimesOutOnASilentPeer(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:18634")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			defer conn.Close()
		}
	}()

	start := time.Now()
	err = lobby.SendInvite("127.0.0.1:18634", lobby.Invite{LobbyID: "l1", Kind: "race", HostID: "h1", HostAddr: "127.0.0.1:1"})
	if err == nil {
		t.Fatal("a peer that never answers must produce an error")
	}
	if d := time.Since(start); d > 6*time.Second {
		t.Fatalf("send took %s, want a short timeout", d)
	}
}

func TestServerRejectsBadShapes(t *testing.T) {
	var calls atomic.Int32
	s := lobby.NewServer(18635, lobby.Callbacks{
		OnInvite:  func(lobby.Invite) error { calls.Add(1); return nil },
		OnRespond: func(lobby.Response) error { calls.Add(1); return nil },
	})
	if err := s.Listen(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ok := lobby.Invite{LobbyID: "l1", Kind: "race", HostID: "h1", HostName: "Host", HostAddr: "127.0.0.1:1"}
	bad := []lobby.Invite{
		{LobbyID: "", Kind: "race", HostID: "h1", HostAddr: "127.0.0.1:1"},
		{LobbyID: "l1", Kind: "", HostID: "h1", HostAddr: "127.0.0.1:1"},
		{LobbyID: "l1", Kind: "race", HostID: "", HostAddr: "127.0.0.1:1"},
		{LobbyID: "l1", Kind: "race", HostID: "h1", HostName: strings.Repeat("x", 101), HostAddr: "127.0.0.1:1"},
		{LobbyID: strings.Repeat("x", 65), Kind: "race", HostID: "h1", HostAddr: "127.0.0.1:1"},
	}
	for _, inv := range bad {
		if err := lobby.SendInvite("127.0.0.1:18635", inv); err == nil {
			t.Errorf("invite %+v was accepted", inv)
		}
	}
	if err := lobby.SendRespond("127.0.0.1:18635", lobby.Response{LobbyID: "l1", PeerID: "p1", PeerName: strings.Repeat("x", 101)}); err == nil {
		t.Error("an over-long peer name was accepted")
	}
	if calls.Load() != 0 {
		t.Fatalf("callbacks ran %d times for invalid input", calls.Load())
	}
	if err := lobby.SendInvite("127.0.0.1:18635", ok); err != nil || calls.Load() != 1 {
		t.Fatalf("a valid invite failed: %v", err)
	}
}

func TestSubscriberCap(t *testing.T) {
	s := lobby.NewServer(18637, lobby.Callbacks{})
	if err := s.Listen(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.OpenLobby("l1")

	var closed atomic.Int32
	for i := 0; i < 32; i++ {
		cancel := lobby.Subscribe("127.0.0.1:18637", "l1", func(json.RawMessage) {}, func(error) { closed.Add(1) })
		defer cancel()
	}
	time.Sleep(200 * time.Millisecond)
	if closed.Load() != 0 {
		t.Fatalf("%d of the first 32 subscribers were refused", closed.Load())
	}
	extra := make(chan error, 1)
	cancel := lobby.Subscribe("127.0.0.1:18637", "l1", func(json.RawMessage) {}, func(err error) { extra <- err })
	defer cancel()
	select {
	case <-extra:
	case <-time.After(2 * time.Second):
		t.Fatal("the 33rd subscriber must be refused")
	}
}

func TestListenReportsATakenPort(t *testing.T) {
	ln, err := net.Listen("tcp", ":18636")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if err := lobby.NewServer(18636, lobby.Callbacks{}).Listen(); err == nil {
		t.Fatal("Listen must fail when another process holds the port")
	}
}
