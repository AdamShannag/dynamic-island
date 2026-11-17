package discovery_test

import (
	"testing"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/discovery"
)

func TestDiscoveryFindsPeerNotSelf(t *testing.T) {
	if testing.Short() {
		t.Skip("needs multicast")
	}

	a, err := discovery.Start("peer-a", "Alice", "127.0.0.1", 48551)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := discovery.Start("peer-b", "Bob", "127.0.0.2", 48552)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()

	var found discovery.Peer
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, p := range a.Peers() {
			if p.ID == "peer-b" {
				found = p
			}
		}
		if found.ID != "" {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if found.ID != "peer-b" || found.Name != "Bob" || found.Addr != "127.0.0.2:48552" {
		t.Fatalf("did not discover peer-b in time: %+v", found)
	}
	for _, p := range a.Peers() {
		if p.ID == "peer-a" {
			t.Fatal("Peers() must not include self")
		}
	}
}

func TestDiscoveryCollapsesAnotherInstanceOnTheSameHost(t *testing.T) {
	if testing.Short() {
		t.Skip("needs multicast")
	}

	// Two different identities (e.g. a real install and a dev/nested one)
	// advertising from the same host should look like one peer to others,
	// and like nobody at all to themselves.
	real, err := discovery.Start("real-id", "Real", "127.0.0.3", 48553)
	if err != nil {
		t.Fatal(err)
	}
	defer real.Close()
	dev, err := discovery.Start("dev-id", "Dev", "127.0.0.3", 48554)
	if err != nil {
		t.Fatal(err)
	}
	defer dev.Close()
	other, err := discovery.Start("other-id", "Other", "127.0.0.4", 48555)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()

	countOfInterest := func(peers []discovery.Peer) int {
		n := 0
		for _, p := range peers {
			if p.ID == "real-id" || p.ID == "dev-id" {
				n++
			}
		}
		return n
	}

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if countOfInterest(other.Peers()) > 0 {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}

	if n := countOfInterest(other.Peers()); n != 1 {
		t.Fatalf("expected exactly one of real-id/dev-id visible to another host, got %d: %+v", n, other.Peers())
	}
	for _, p := range real.Peers() {
		if p.ID == "dev-id" {
			t.Fatal("a second instance on the same host must not appear as a peer to itself")
		}
	}
}
