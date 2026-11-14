package clipboard

import (
	"path/filepath"
	"testing"
)

func TestStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c.json")
	s, _ := Open(path)
	s.Add("a")
	s.Add("b")
	s.Add("a") // moves to top, keeps id
	l := s.List()
	if len(l) != 2 || l[0].Text != "a" || l[0].ID != 1 {
		t.Fatalf("dedupe/move-to-top failed: %+v", l)
	}
	s.SetPinned(2, true)
	s.Clear()
	l = s.List()
	if len(l) != 1 || l[0].Text != "b" {
		t.Fatalf("clear should keep pinned only: %+v", l)
	}
	s.Add("c")
	r, err := Open(path) // reload from disk
	if err != nil {
		t.Fatal(err)
	}
	l = r.List()
	if len(l) != 2 || l[0].Text != "b" || !l[0].Pinned || l[1].Text != "c" {
		t.Fatalf("persist failed: %+v", l)
	}
	r.Add("d")
	if r.List()[1].ID != 4 {
		t.Fatalf("ids should continue after reload: %+v", r.List())
	}
}
