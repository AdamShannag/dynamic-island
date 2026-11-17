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
		{"pins move, home and inbox dropped", `{"accent":"green","bar":["home","inbox","docker","notes"]}`, "docker,notes"},
		{"only home and inbox falls back to defaults", `{"bar":["home","inbox"]}`, "docker,ports,clipboard,notes,agents"},
		{"unknown ids are dropped", `{"bar":["home","bogus","play","play"]}`, "play"},
		{"an existing home key wins", `{"bar":["home","docker"],"home":{"favorites":["agents"]}}`, "agents"},
		{"no bar keeps defaults", `{"accent":"teal"}`, "docker,ports,clipboard,notes,agents"},
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
	if s.Accent != "green" || strings.Join(s.Home.Favorites, ",") != "ports,agents" {
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
	if _, err := Update([]byte(`{"home":{"favorites":["notes"]}}`)); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	cur = Defaults()
	mu.Unlock()
	if err := Load(); err != nil || strings.Join(Get().Home.Favorites, ",") != "notes" {
		t.Fatalf("a second load must not migrate again: %v %v", err, Get().Home.Favorites)
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
