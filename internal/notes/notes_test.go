package notes

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNotes(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dir)
	os.MkdirAll(filepath.Join(dir, "go-island"), 0o700)
	os.WriteFile(filepath.Join(dir, "go-island", "notes.md"), []byte("old scratchpad"), 0o600)

	s, err := Open()
	if err != nil {
		t.Fatal(err)
	}
	l := s.List()
	if len(l) != 1 || l[0].Text != "old scratchpad" {
		t.Fatalf("legacy import failed: %+v", l)
	}
	n, _ := s.Create()
	s.Save(n.ID, "Groceries\nmilk")
	s.Pin(1, true)
	l = s.List()
	if l[0].ID != 1 || !l[0].Pinned || l[1].Text != "Groceries\nmilk" {
		t.Fatalf("order/pin wrong: %+v", l)
	}
	s.Delete(1)
	r, _ := Open() // reload from disk
	if l := r.List(); len(l) != 1 || l[0].ID != n.ID {
		t.Fatalf("persist failed: %+v", l)
	}
	if c, _ := r.Create(); c.ID <= n.ID {
		t.Fatal("ids must keep increasing after reload")
	}
}
