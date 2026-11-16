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

	a, err := discovery.Start("peer-a", "Alice", 48551)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := discovery.Start("peer-b", "Bob", 48552)
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
	if found.ID != "peer-b" || found.Name != "Bob" || found.Addr == "" {
		t.Fatalf("did not discover peer-b in time: %+v", found)
	}
	for _, p := range a.Peers() {
		if p.ID == "peer-a" {
			t.Fatal("Peers() must not include self")
		}
	}
}
