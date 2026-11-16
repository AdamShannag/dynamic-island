package lobby_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/lobby"
)

func TestInviteRespondRoundTrip(t *testing.T) {
	var got lobby.Invite
	invited := make(chan struct{})
	invitee := lobby.NewServer(48561, lobby.Callbacks{
		OnInvite: func(inv lobby.Invite) { got = inv; close(invited) },
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

func TestServerRejectsBadBody(t *testing.T) {
	called := false
	s := lobby.NewServer(48562, lobby.Callbacks{OnInvite: func(lobby.Invite) { called = true }})
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
