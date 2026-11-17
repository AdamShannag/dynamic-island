package ports

import (
	"os"
	"testing"
)

func TestOwnedBy(t *testing.T) {
	if !ownedBy(os.Getpid(), os.Getuid()) {
		t.Fatal("our own process must count as ours")
	}
	if ownedBy(os.Getpid(), os.Getuid()+1) {
		t.Fatal("another uid must not own our process")
	}
	if ownedBy(0, os.Getuid()) || ownedBy(-1, os.Getuid()) {
		t.Fatal("an unknown pid is never ours")
	}
	if os.Getuid() != 0 && ownedBy(1, os.Getuid()) {
		t.Fatal("init belongs to root")
	}
}
