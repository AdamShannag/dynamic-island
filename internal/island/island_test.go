package island

import (
	"strings"
	"testing"
	"time"
)

func TestPriorityAndExpiry(t *testing.T) {
	m := NewManager()
	m.Set(Activity{ID: "media", Priority: PriorityAmbient, View: View{Kind: "media", Title: "song"}})
	if !strings.Contains(m.State(), `"song"`) {
		t.Fatalf("want media, got %s", m.State())
	}
	m.Set(Activity{ID: "n", Priority: PriorityNotify, TTL: 30 * time.Millisecond, View: View{Kind: "notify", Title: "hi"}})
	if !strings.Contains(m.State(), `"notify"`) {
		t.Fatalf("notify should win, got %s", m.State())
	}
	time.Sleep(60 * time.Millisecond)
	if !strings.Contains(m.State(), `"song"`) {
		t.Fatalf("should fall back to media after TTL, got %s", m.State())
	}
	m.Clear("media")
	if m.State() != `{"kind":"idle"}` {
		t.Fatalf("want idle, got %s", m.State())
	}
}

func TestReSetRearmsTTL(t *testing.T) {
	m := NewManager()
	m.Set(Activity{ID: "a", Priority: 1, TTL: 30 * time.Millisecond, View: View{Kind: "notify", Title: "1"}})
	time.Sleep(20 * time.Millisecond)
	m.Set(Activity{ID: "a", Priority: 1, TTL: 30 * time.Millisecond, View: View{Kind: "notify", Title: "2"}})
	time.Sleep(20 * time.Millisecond)
	if !strings.Contains(m.State(), `"2"`) {
		t.Fatalf("old timer expired the replacement: %s", m.State())
	}
}
