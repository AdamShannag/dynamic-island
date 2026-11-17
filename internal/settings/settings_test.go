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
	if !TabOn("play") {
		t.Fatal("play tab id must be registered and default on")
	}
}

func TestPlayFeatureOffByDefault(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	mu.Lock()
	cur = Defaults()
	mu.Unlock()
	if Enabled("play") || Defaults().Features["play"] {
		t.Fatal("play opens a network listener, so it must stay off until the user opts in")
	}
	if !Enabled("usb") {
		t.Fatal("other features still default on")
	}
	mu.Lock()
	delete(cur.Features, "play")
	mu.Unlock()
	if Enabled("play") {
		t.Fatal("a missing play key must read as off")
	}
	if _, err := Update([]byte(`{"features":{"play":true}}`)); err != nil || !Enabled("play") {
		t.Fatalf("opting in must turn play on: %v", err)
	}
}

func TestNormalizeBar(t *testing.T) {
	cases := []struct {
		in, want []string
	}{
		{nil, []string{"home"}},
		{[]string{"docker"}, []string{"home", "docker"}},
		{[]string{"notes", "home", "bogus", "notes", "inbox"}, []string{"home", "notes", "inbox"}},
		{[]string{"inbox", "docker", "ports", "notes", "play"}, []string{"home", "inbox", "docker", "ports"}},
	}
	for _, c := range cases {
		if got := NormalizeBar(c.in); strings.Join(got, ",") != strings.Join(c.want, ",") {
			t.Errorf("NormalizeBar(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestUpdateBar(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	mu.Lock()
	cur = Defaults()
	mu.Unlock()
	if got := strings.Join(Get().Bar, ","); got != "home,inbox,notes" {
		t.Fatalf("default bar = %s", got)
	}
	s, err := Update([]byte(`{"bar":["docker","docker","nope","ports","agents","play"]}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(s.Bar, ","); got != "home,docker,ports,agents" {
		t.Fatalf("bar = %s", got)
	}
	if s, err = Update([]byte(`{"accent":"green"}`)); err != nil || strings.Join(s.Bar, ",") != "home,docker,ports,agents" {
		t.Fatalf("an unrelated patch must keep the bar: %v %v", s.Bar, err)
	}
	s.Bar[1] = "mutated"
	if Get().Bar[1] != "docker" {
		t.Fatal("Get must return a copy of the bar")
	}
	mu.Lock()
	cur = Defaults()
	mu.Unlock()
	if err := Load(); err != nil || strings.Join(Get().Bar, ",") != "home,docker,ports,agents" {
		t.Fatalf("reload failed: %v %v", err, Get().Bar)
	}
}

func TestUpdateFavorites(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	mu.Lock()
	cur = Defaults()
	mu.Unlock()
	if got := strings.Join(Get().Home.Favorites, ","); got != "docker,ports,clipboard,notes,agents" {
		t.Fatalf("default favorites = %s", got)
	}
	s, err := Update([]byte(`{"home":{"favorites":["notes","home","notes","nope","inbox","play","search","activity","docker"]}}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(s.Home.Favorites, ","); got != "notes,inbox,play,search,activity" {
		t.Fatalf("favorites = %s", got)
	}
	if s, err = Update([]byte(`{"home":{}}`)); err != nil || len(s.Home.Favorites) != 5 {
		t.Fatalf("a patch without favorites must keep them: %v %v", s.Home.Favorites, err)
	}
	if s, err = Update([]byte(`{"home":{"favorites":[]}}`)); err != nil || s.Home.Favorites == nil || len(s.Home.Favorites) != 0 {
		t.Fatalf("an empty list must clear favorites: %v %v", s.Home.Favorites, err)
	}
	s.Home.Favorites = append(s.Home.Favorites, "mutated")
	if len(Get().Home.Favorites) != 0 {
		t.Fatal("Get must return a copy of the favorites")
	}
	if _, err = Update([]byte(`{"home":{"favorites":["agents","ports"]}}`)); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	cur = Defaults()
	mu.Unlock()
	if err := Load(); err != nil || strings.Join(Get().Home.Favorites, ",") != "agents,ports" {
		t.Fatalf("reload failed: %v %v", err, Get().Home.Favorites)
	}
}
