package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readClaudeSettings(t *testing.T) map[string]any {
	t.Helper()
	b, err := os.ReadFile(settingsPath())
	if err != nil {
		t.Fatal(err)
	}
	var s map[string]any
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestClaudeInstallReplacesLegacyHooks(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", "")
	legacy := map[string]any{
		"hooks": map[string]any{
			"Stop": []any{
				map[string]any{"hooks": []any{map[string]any{"type": "command", "command": "/old/bin/island claude hook"}}},
				map[string]any{"hooks": []any{map[string]any{"type": "command", "command": "other-tool hook"}}},
			},
		},
		"statusLine": map[string]any{"type": "command", "command": "/old/bin/island claude statusline -- sh -c 'echo hi'"},
	}
	b, _ := json.Marshal(legacy)
	if err := os.MkdirAll(filepath.Dir(settingsPath()), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settingsPath(), b, 0o600); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 2; i++ {
		if err := claudeInstall(); err != nil {
			t.Fatal(err)
		}
	}
	self, _ := os.Executable()
	s := readClaudeSettings(t)
	hooks := s["hooks"].(map[string]any)
	for _, ev := range hookEvents {
		var ours int
		for _, g := range hooks[ev].([]any) {
			for _, h := range g.(map[string]any)["hooks"].([]any) {
				c := h.(map[string]any)["command"].(string)
				if strings.Contains(c, "/old/bin/") {
					t.Errorf("%s: legacy hook kept: %s", ev, c)
				}
				if c == self+hookMarker {
					ours++
				}
			}
		}
		if ours != 1 {
			t.Errorf("%s: %d island hooks, want 1", ev, ours)
		}
	}
	if n := len(hooks["Stop"].([]any)); n != 2 {
		t.Errorf("Stop groups = %d, want 2 (other tool kept)", n)
	}
	want := self + statusMarker + " -- sh -c 'echo hi'"
	if got := s["statusLine"].(map[string]any)["command"]; got != want {
		t.Errorf("statusLine = %q, want %q", got, want)
	}
	matches, _ := filepath.Glob(settingsPath() + ".bak-dynamic-island-*")
	if len(matches) == 0 {
		t.Error("no backup written")
	}

	if err := claudeUninstall(); err != nil {
		t.Fatal(err)
	}
	s = readClaudeSettings(t)
	if _, ok := s["statusLine"]; ok {
		t.Errorf("statusLine left behind: %v", s["statusLine"])
	}
	if n := len(s["hooks"].(map[string]any)["Stop"].([]any)); n != 1 {
		t.Errorf("Stop groups after uninstall = %d, want 1", n)
	}
}
