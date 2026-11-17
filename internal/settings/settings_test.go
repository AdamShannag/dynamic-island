package settings

import (
	"strings"
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
	mu.Lock()
	cur = Defaults()
	mu.Unlock()
	if err := Load(); err != nil || Get().Accent != "purple" || Get().Tabs["docker"] {
		t.Fatalf("reload failed: %v %+v", err, Get())
	}
}

func TestUpdateDisplayName(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	mu.Lock()
	cur = Defaults()
	mu.Unlock()
	s, err := Update([]byte(`{"displayName":"Adam"}`))
	if err != nil || s.DisplayName != "Adam" {
		t.Fatalf("got %+v, %v", s, err)
	}
	if _, err := Update([]byte(`{"displayName":"` + strings.Repeat("x", 41) + `"}`)); err == nil {
		t.Fatal("expected error for an over-long display name")
	}
	if !TabOn("race") {
		t.Fatal("race tab id must be registered and default on")
	}
}

func TestRaceFeatureOffByDefault(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	mu.Lock()
	cur = Defaults()
	mu.Unlock()
	if Enabled("race") || Defaults().Features["race"] {
		t.Fatal("race opens a network listener, so it must stay off until the user opts in")
	}
	if !Enabled("usb") {
		t.Fatal("other features still default on")
	}
	mu.Lock()
	delete(cur.Features, "race")
	mu.Unlock()
	if Enabled("race") {
		t.Fatal("a missing race key must read as off")
	}
	if _, err := Update([]byte(`{"features":{"race":true}}`)); err != nil || !Enabled("race") {
		t.Fatalf("opting in must turn race on: %v", err)
	}
}

func TestDrawFeatureOffByDefault(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	mu.Lock()
	cur = Defaults()
	mu.Unlock()
	if !TabOn("draw") {
		t.Fatal("draw tab id must be registered and default on")
	}
	if Enabled("draw") || Defaults().Features["draw"] {
		t.Fatal("draw opens a network listener, so it must stay off until the user opts in")
	}
	mu.Lock()
	delete(cur.Features, "draw")
	mu.Unlock()
	if Enabled("draw") {
		t.Fatal("a missing draw key must read as off")
	}
	if _, err := Update([]byte(`{"features":{"draw":true}}`)); err != nil || !Enabled("draw") {
		t.Fatalf("opting in must turn draw on: %v", err)
	}
}
