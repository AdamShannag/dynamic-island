// Package settings holds the user's island preferences (theme, visible
// tabs, features) in ~/.config/go-island/settings.json. The daemon owns
// them so features it runs (notification mirroring, clipboard history,
// USB/battery popups) switch off at the source; the extension mirrors
// them for everything visual.
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

type Settings struct {
	Accent   string          `json:"accent"`
	Surface  string          `json:"surface"`
	Tabs     map[string]bool `json:"tabs"`
	Features map[string]bool `json:"features"`
}

var (
	Accents  = []string{"blue", "purple", "pink", "orange", "green", "teal", "graphite"}
	Surfaces = []string{"black", "graphite"}
	// Home is always shown, so it isn't listed.
	TabIDs     = []string{"activity", "agents", "docker", "ports", "clipboard", "transform", "notes", "search"}
	FeatureIDs = []string{"face", "osd", "hideBanners", "mediaPill", "mirrorNotifications", "clipboardHistory", "usb", "battery"}
)

func Defaults() Settings {
	s := Settings{Accent: "blue", Surface: "black", Tabs: map[string]bool{}, Features: map[string]bool{}}
	for _, t := range TabIDs {
		s.Tabs[t] = true
	}
	for _, f := range FeatureIDs {
		s.Features[f] = true
	}
	return s
}

var (
	mu  sync.RWMutex
	cur = Defaults()
)

func path() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(dir, "go-island", "settings.json")
}

// Load reads the settings file (missing file = defaults).
func Load() error {
	b, err := os.ReadFile(path())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	mu.Lock()
	defer mu.Unlock()
	merged, err := merge(Defaults(), b)
	if err != nil {
		return err
	}
	cur = merged
	return nil
}

// Get returns a copy of the current settings.
func Get() Settings {
	mu.RLock()
	defer mu.RUnlock()
	return clone(cur)
}

// Enabled reports whether a feature is on (unknown features default on).
func Enabled(feature string) bool {
	mu.RLock()
	defer mu.RUnlock()
	v, ok := cur.Features[feature]
	return !ok || v
}

// Update merges a partial JSON patch, validates, saves and returns the result.
func Update(patch []byte) (Settings, error) {
	mu.Lock()
	defer mu.Unlock()
	next, err := merge(clone(cur), patch)
	if err != nil {
		return Settings{}, err
	}
	if err := save(next); err != nil {
		return Settings{}, err
	}
	cur = next
	return clone(next), nil
}

func merge(base Settings, patch []byte) (Settings, error) {
	var p struct {
		Accent   *string         `json:"accent"`
		Surface  *string         `json:"surface"`
		Tabs     map[string]bool `json:"tabs"`
		Features map[string]bool `json:"features"`
	}
	if err := json.Unmarshal(patch, &p); err != nil {
		return base, fmt.Errorf("invalid settings: %w", err)
	}
	if p.Accent != nil {
		if !contains(Accents, *p.Accent) {
			return base, fmt.Errorf("unknown accent %q", *p.Accent)
		}
		base.Accent = *p.Accent
	}
	if p.Surface != nil {
		if !contains(Surfaces, *p.Surface) {
			return base, fmt.Errorf("unknown surface %q", *p.Surface)
		}
		base.Surface = *p.Surface
	}
	for k, v := range p.Tabs {
		if contains(TabIDs, k) {
			base.Tabs[k] = v
		}
	}
	for k, v := range p.Features {
		if contains(FeatureIDs, k) {
			base.Features[k] = v
		}
	}
	return base, nil
}

func save(s Settings) error {
	if err := os.MkdirAll(filepath.Dir(path()), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path())
}

func clone(s Settings) Settings {
	c := s
	c.Tabs, c.Features = map[string]bool{}, map[string]bool{}
	for k, v := range s.Tabs {
		c.Tabs[k] = v
	}
	for k, v := range s.Features {
		c.Features[k] = v
	}
	return c
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
