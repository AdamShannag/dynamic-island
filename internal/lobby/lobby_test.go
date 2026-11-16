package lobby_test

import (
	"encoding/json"
	"errors"
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
	go invitee.ListenAndServe()
	defer invitee.Close()
	time.Sleep(50 * time.Millisecond)

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
	s := lobby.NewServer(48568, lobby.Callbacks{
		OnInvite:  func(inv lobby.Invite) error { invites <- inv; return nil },
		OnRespond: func(r lobby.Response) error { responses <- r; return nil },
	})
	go s.ListenAndServe()
	defer s.Close()
	time.Sleep(50 * time.Millisecond)

	if err := lobby.SendInvite("127.0.0.1:48568", lobby.Invite{
		LobbyID: "l1", Kind: "race", HostID: "h1", HostAddr: "10.9.9.9:4000",
	}); err != nil {
		t.Fatal(err)
	}
	if inv := <-invites; inv.HostAddr != "127.0.0.1:4000" {
		t.Fatalf("HostAddr = %q, want the connection's IP with the claimed port", inv.HostAddr)
	}
	if err := lobby.SendRespond("127.0.0.1:48568", lobby.Response{LobbyID: "l1", PeerID: "p1"}); err != nil {
		t.Fatal(err)
	}
	if r := <-responses; r.RemoteIP != "127.0.0.1" {
		t.Fatalf("RemoteIP = %q", r.RemoteIP)
	}
	if err := lobby.SendInvite("127.0.0.1:48568", lobby.Invite{
		LobbyID: "l1", Kind: "race", HostID: "h1", HostAddr: "no-port",
	}); err == nil {
		t.Fatal("an invite without a usable host port must be rejected")
	}
}

func TestServerRejectsBadBody(t *testing.T) {
	called := false
	s := lobby.NewServer(48562, lobby.Callbacks{OnInvite: func(lobby.Invite) error { called = true; return nil }})
	go s.ListenAndServe()
	defer s.Close()
	time.Sleep(50 * time.Millisecond)

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
	go s.ListenAndServe()
	defer s.Close()
	time.Sleep(50 * time.Millisecond)
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
	go s.ListenAndServe()
	defer s.Close()
	time.Sleep(50 * time.Millisecond)
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
	s := lobby.NewServer(48565, lobby.Callbacks{})
	go s.ListenAndServe()
	defer s.Close()
	time.Sleep(50 * time.Millisecond)

	closedErr := make(chan error, 1)
	cancel := lobby.Subscribe("127.0.0.1:48565", "missing", func(json.RawMessage) {}, func(err error) { closedErr <- err })
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
	s := lobby.NewServer(48566, lobby.Callbacks{
		OnRespond: func(lobby.Response) error { return lobby.ErrClosed },
		OnStart:   func(lobby.Start) error { return lobby.ErrRejected },
	})
	go s.ListenAndServe()
	defer s.Close()
	time.Sleep(50 * time.Millisecond)

	err := lobby.SendRespond("127.0.0.1:48566", lobby.Response{LobbyID: "l1", PeerID: "p1", Accept: true})
	if !errors.Is(err, lobby.ErrClosed) {
		t.Fatalf("respond err = %v, want ErrClosed", err)
	}
	if err := lobby.SendStart("127.0.0.1:48566", lobby.Start{LobbyID: "l1"}); err == nil || errors.Is(err, lobby.ErrClosed) {
		t.Fatalf("start err = %v, want a plain rejection", err)
	}
}

func TestNoOnClosedAfterCancel(t *testing.T) {
	s := lobby.NewServer(48567, lobby.Callbacks{})
	go s.ListenAndServe()
	defer s.Close()
	time.Sleep(50 * time.Millisecond)
	s.OpenLobby("l1")

	var closed atomic.Bool
	cancel := lobby.Subscribe("127.0.0.1:48567", "l1", func(json.RawMessage) {}, func(error) { closed.Store(true) })
	time.Sleep(50 * time.Millisecond)
	cancel()
	time.Sleep(100 * time.Millisecond)
	if closed.Load() {
		t.Fatal("onClosed must not fire for a subscription the caller cancelled")
	}
}
