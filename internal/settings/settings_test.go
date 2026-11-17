package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
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

func loadFile(t *testing.T, body string) Settings {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if err := os.MkdirAll(filepath.Dir(path()), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path(), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	cur = Defaults()
	mu.Unlock()
	if err := Load(); err != nil {
		t.Fatal(err)
	}
	return Get()
}

func TestMigrateBarToFavorites(t *testing.T) {
	cases := []struct {
		name, file, want string
	}{
		{"pins move first, then defaults top up", `{"accent":"green","bar":["home","inbox","docker","notes"]}`, "docker,notes,ports,clipboard,agents"},
		{"only home and inbox gives the defaults", `{"bar":["home","inbox"]}`, "docker,ports,clipboard,notes,agents"},
		{"unknown ids and duplicates are dropped", `{"bar":["home","bogus","play","play","ports"]}`, "play,ports,docker,clipboard,notes"},
		{"a never-edited home list is kept and topped up", `{"bar":["home","docker"],"home":{"favorites":["agents"]}}`, "agents,docker,ports,clipboard,notes"},
		{"no bar keeps defaults", `{"accent":"teal"}`, "docker,ports,clipboard,notes,agents"},
		{"an edited short list is never refilled", `{"bar":["home","docker"],"home":{"favorites":["agents"],"edited":true}}`, "agents"},
		{"an edited empty list stays empty", `{"home":{"favorites":[],"edited":true}}`, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := strings.Join(loadFile(t, c.file).Home.Favorites, ","); got != c.want {
				t.Fatalf("favorites = %s, want %s", got, c.want)
			}
		})
	}
}

func TestMigrationRunsOnceAndDropsBar(t *testing.T) {
	s := loadFile(t, `{"accent":"green","bar":["home","ports","agents"]}`)
	if s.Accent != "green" || strings.Join(s.Home.Favorites, ",") != "ports,agents,docker,clipboard,notes" || s.Home.Edited {
		t.Fatalf("migrated settings wrong: %+v", s)
	}
	b, err := os.ReadFile(path())
	if err != nil {
		t.Fatal(err)
	}
	var saved map[string]json.RawMessage
	if err := json.Unmarshal(b, &saved); err != nil {
		t.Fatal(err)
	}
	if _, ok := saved["bar"]; ok {
		t.Fatal("the migrated file must not keep the bar")
	}
	if _, ok := saved["home"]; !ok {
		t.Fatal("the migrated file must hold the favourites")
	}
}

func TestUserEditedFavoritesAreNeverRefilled(t *testing.T) {
	loadFile(t, `{"bar":["home","docker"]}`)
	for _, list := range []string{`["notes"]`, `[]`} {
		s, err := Update([]byte(`{"home":{"favorites":` + list + `}}`))
		if err != nil || !s.Home.Edited {
			t.Fatalf("an edit must mark the list: %v %+v", err, s.Home)
		}
		want := strings.Join(s.Home.Favorites, ",")
		mu.Lock()
		cur = Defaults()
		mu.Unlock()
		if err := Load(); err != nil {
			t.Fatal(err)
		}
		if got := strings.Join(Get().Home.Favorites, ","); got != want || !Get().Home.Edited {
			t.Fatalf("reload refilled an edited list: got %q, want %q", got, want)
		}
	}
}

func TestGlanceSettings(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	mu.Lock()
	cur = Defaults()
	mu.Unlock()
	if g := Get().Glance; g.Mode != "hover" || g.Delay != 400 {
		t.Fatalf("default glance = %+v", g)
	}
	s, err := Update([]byte(`{"glance":{"mode":"right-click","delay":250}}`))
	if err != nil || s.Glance.Mode != "right-click" || s.Glance.Delay != 250 {
		t.Fatalf("glance update = %+v, %v", s.Glance, err)
	}
	for _, bad := range []string{`{"glance":{"mode":"always"}}`, `{"glance":{"delay":50}}`, `{"glance":{"delay":5000}}`} {
		if _, err := Update([]byte(bad)); err == nil {
			t.Fatalf("%s must be rejected", bad)
		}
	}
	if s, err = Update([]byte(`{"glance":{"mode":"off"}}`)); err != nil || s.Glance.Delay != 250 {
		t.Fatalf("a mode-only patch must keep the delay: %+v %v", s.Glance, err)
	}
}

func TestSettingsCanBeAFavorite(t *testing.T) {
	if got := strings.Join(NormalizeFavorites([]string{"settings", "home", "inbox"}), ","); got != "settings,inbox" {
		t.Fatalf("favorites = %s", got)
	}
	if contains(TabIDs, SettingsTab) {
		t.Fatal("settings must not become a toggleable tab")
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
