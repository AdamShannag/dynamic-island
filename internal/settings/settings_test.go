package settings

import (
	"testing"
)

func TestUpdate(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	mu.Lock()
	cur = Defaults()
	mu.Unlock()
	s, err := Update([]byte(`{"accent":"purple","tabs":{"docker":false,"home":false},"features":{"usb":false,"bogus":true}}`))
	if err != nil {
		t.Fatal(err)
	}
	if s.Accent != "purple" || s.Tabs["docker"] || !s.Tabs["ports"] || Enabled("usb") || !Enabled("face") {
		t.Fatalf("merge wrong: %+v", s)
	}
	if _, ok := s.Tabs["home"]; ok {
		t.Fatal("home must not be toggleable")
	}
	if _, err := Update([]byte(`{"accent":"neon"}`)); err == nil {
		t.Fatal("expected invalid accent error")
	}
	// round-trip through disk
	mu.Lock()
	cur = Defaults()
	mu.Unlock()
	if err := Load(); err != nil || Get().Accent != "purple" || Get().Tabs["docker"] {
		t.Fatalf("reload failed: %v %+v", err, Get())
	}
}
