package identity_test

import (
	"os"
	"testing"

	"github.com/AdamShannag/dynamic-island/internal/identity"
)

func TestIDPersistsAcrossCalls(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	first, err := identity.ID()
	if err != nil || first == "" {
		t.Fatalf("ID() = %q, %v", first, err)
	}
	second, err := identity.ID()
	if err != nil || second != first {
		t.Fatalf("ID() not stable: %q then %q", first, second)
	}
}

func TestIDUniquePerDataDir(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	a, _ := identity.ID()
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	b, _ := identity.ID()
	if a == b {
		t.Fatal("expected different IDs for different data dirs")
	}
}

func TestEphemeralNeverPersists(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dir)
	a := identity.Ephemeral()
	b := identity.Ephemeral()
	if a == "" || a == b {
		t.Fatalf("Ephemeral() should return fresh non-empty ids, got %q and %q", a, b)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatalf("Ephemeral() must not write to disk, found: %v", entries)
	}
}
