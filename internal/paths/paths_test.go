package paths

import (
	"os"
	"path/filepath"
	"testing"
)

func setHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_CACHE_HOME", "")
	return home
}

func TestDefaults(t *testing.T) {
	home := setHome(t)
	cases := map[string]string{
		Data():   filepath.Join(home, ".local", "share", AppName),
		Config(): filepath.Join(home, ".config", AppName),
		Cache():  filepath.Join(home, ".cache", AppName),
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("got %s, want %s", got, want)
		}
	}
}

func TestXDGOverrides(t *testing.T) {
	setHome(t)
	x := t.TempDir()
	t.Setenv("XDG_DATA_HOME", filepath.Join(x, "d"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(x, "c"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(x, "k"))
	if Data() != filepath.Join(x, "d", AppName) || Config() != filepath.Join(x, "c", AppName) || Cache() != filepath.Join(x, "k", AppName) {
		t.Fatalf("XDG overrides ignored: %s %s %s", Data(), Config(), Cache())
	}
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestMigrateMovesLegacyDirs(t *testing.T) {
	home := setHome(t)
	write(t, filepath.Join(home, ".local", "share", legacyName, "notes.json"), "notes")
	write(t, filepath.Join(home, ".config", legacyName, "settings.json"), "settings")
	write(t, filepath.Join(home, ".cache", legacyName, "art", "x"), "art")

	if err := Migrate(); err != nil {
		t.Fatal(err)
	}
	if got := read(t, DataFile("notes.json")); got != "notes" {
		t.Errorf("data: %q", got)
	}
	if got := read(t, ConfigFile("settings.json")); got != "settings" {
		t.Errorf("config: %q", got)
	}
	if got := read(t, CacheFile("art", "x")); got != "art" {
		t.Errorf("cache: %q", got)
	}
	if _, err := os.Stat(filepath.Join(home, ".config", legacyName)); !os.IsNotExist(err) {
		t.Errorf("legacy config dir still present: %v", err)
	}
	if err := Migrate(); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
}

func TestMigrateKeepsExistingNewDir(t *testing.T) {
	home := setHome(t)
	write(t, filepath.Join(home, ".config", legacyName, "settings.json"), "old")
	write(t, ConfigFile("settings.json"), "new")

	if err := Migrate(); err != nil {
		t.Fatal(err)
	}
	if got := read(t, ConfigFile("settings.json")); got != "new" {
		t.Errorf("new dir overwritten: %q", got)
	}
	if got := read(t, filepath.Join(home, ".config", legacyName, "settings.json")); got != "old" {
		t.Errorf("legacy dir touched: %q", got)
	}
}

func TestMigrateHonoursXDG(t *testing.T) {
	setHome(t)
	x := t.TempDir()
	t.Setenv("XDG_DATA_HOME", x)
	write(t, filepath.Join(x, legacyName, "clipboard.json"), "clip")
	if err := Migrate(); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(x, AppName, "clipboard.json")); got != "clip" {
		t.Errorf("got %q", got)
	}
}

func TestMigrateNoLegacy(t *testing.T) {
	setHome(t)
	if err := Migrate(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(Data()); !os.IsNotExist(err) {
		t.Errorf("migrate created data dir without legacy: %v", err)
	}
}
