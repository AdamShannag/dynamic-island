package discovery

import "testing"

func TestPeersIsSortedRegardlessOfMapIterationOrder(t *testing.T) {
	d := &Discovery{peers: map[string]Peer{
		"zeta":  {ID: "zeta", Name: "Zeta"},
		"alpha": {ID: "alpha", Name: "Alpha"},
		"mid":   {ID: "mid", Name: "Mid"},
	}}

	var firstOrder []string
	for i := 0; i < 20; i++ {
		got := d.Peers()
		order := make([]string, len(got))
		for j, p := range got {
			order[j] = p.ID
		}
		if firstOrder == nil {
			firstOrder = order
		} else if !equalOrder(firstOrder, order) {
			t.Fatalf("Peers() order changed between calls: %v vs %v", firstOrder, order)
		}
	}
	want := []string{"alpha", "mid", "zeta"}
	if !equalOrder(firstOrder, want) {
		t.Fatalf("Peers() order = %v, want %v", firstOrder, want)
	}
}

func equalOrder(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
