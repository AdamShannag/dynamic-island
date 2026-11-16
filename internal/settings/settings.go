package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/AdamShannag/dynamic-island/internal/paths"
)

type Settings struct {
	Accent      string          `json:"accent"`
	Surface     string          `json:"surface"`
	DisplayName string          `json:"displayName"`
	Tabs        map[string]bool `json:"tabs"`
	Features    map[string]bool `json:"features"`
}

var (
	Accents      = []string{"blue", "purple", "pink", "orange", "green", "teal", "graphite"}
	Surfaces     = []string{"black", "graphite"}
	TabIDs       = []string{"inbox", "activity", "agents", "docker", "ports", "clipboard", "transform", "notes", "search", "race"}
	FeatureIDs   = []string{"face", "osd", "hideBanners", "mediaPill", "mirrorNotifications", "clipboardHistory", "usb", "battery", "race"}
	offByDefault = map[string]bool{"race": true}
)

func Defaults() Settings {
	s := Settings{Accent: "blue", Surface: "black", Tabs: map[string]bool{}, Features: map[string]bool{}}
	for _, t := range TabIDs {
		s.Tabs[t] = true
	}
	for _, f := range FeatureIDs {
		s.Features[f] = !offByDefault[f]
	}
	return s
}

const maxDisplayName = 40

var (
	mu  sync.RWMutex
	cur = Defaults()
)

func path() string {
	return paths.ConfigFile("settings.json")
}

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

func Get() Settings {
	mu.RLock()
	defer mu.RUnlock()
	return clone(cur)
}

func Enabled(feature string) bool {
	mu.RLock()
	defer mu.RUnlock()
	v, ok := cur.Features[feature]
	if !ok {
		return !offByDefault[feature]
	}
	return v
}

func TabOn(tab string) bool {
	mu.RLock()
	defer mu.RUnlock()
	v, ok := cur.Tabs[tab]
	return !ok || v
}

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
		Accent      *string         `json:"accent"`
		Surface     *string         `json:"surface"`
		DisplayName *string         `json:"displayName"`
		Tabs        map[string]bool `json:"tabs"`
		Features    map[string]bool `json:"features"`
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
	if p.DisplayName != nil {
		name := strings.TrimSpace(*p.DisplayName)
		if utf8.RuneCountInString(name) > maxDisplayName {
			return base, fmt.Errorf("display name longer than %d characters", maxDisplayName)
		}
		base.DisplayName = name
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
