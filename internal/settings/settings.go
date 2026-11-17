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
	Home        Home            `json:"home"`
}

type Home struct {
	Favorites []string `json:"favorites"`
}

const (
	HomeTab     = "home"
	SettingsTab = "settings"

	FavoritesMax = 5
)

var (
	Accents      = []string{"blue", "purple", "pink", "orange", "green", "teal", "graphite"}
	Surfaces     = []string{"black", "graphite"}
	TabIDs       = []string{"inbox", "activity", "agents", "docker", "ports", "clipboard", "transform", "notes", "search", "play"}
	FeatureIDs   = []string{"face", "osd", "hideBanners", "mediaPill", "mirrorNotifications", "clipboardHistory", "usb", "battery", "play", "transparentPanel"}
	offByDefault = map[string]bool{"play": true}
	FavoriteIDs  = append(append([]string{}, TabIDs...), SettingsTab)

	DefaultFavorites = []string{"docker", "ports", "clipboard", "notes", "agents"}
)

func Defaults() Settings {
	s := Settings{Accent: "blue", Surface: "black", Tabs: map[string]bool{}, Features: map[string]bool{}, Home: Home{Favorites: NormalizeFavorites(DefaultFavorites)}}
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
	bar, ok := legacyBar(b)
	if ok {
		merged.Home.Favorites = favoritesFromBar(bar)
		if err := save(merged); err != nil {
			return fmt.Errorf("migrate bar to favorites: %w", err)
		}
	}
	cur = merged
	return nil
}

func legacyBar(b []byte) ([]string, bool) {
	var keys map[string]json.RawMessage
	if json.Unmarshal(b, &keys) != nil {
		return nil, false
	}
	raw, hasBar := keys["bar"]
	if _, hasHome := keys["home"]; !hasBar || hasHome {
		return nil, false
	}
	var bar []string
	_ = json.Unmarshal(raw, &bar)
	return bar, true
}

func favoritesFromBar(bar []string) []string {
	var ids []string
	for _, id := range bar {
		if id != HomeTab && id != "inbox" {
			ids = append(ids, id)
		}
	}
	favs := NormalizeFavorites(ids)
	if len(favs) == 0 {
		return NormalizeFavorites(DefaultFavorites)
	}
	return favs
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
		Home        *struct {
			Favorites []string `json:"favorites"`
		} `json:"home"`
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
	if p.Home != nil && p.Home.Favorites != nil {
		base.Home.Favorites = NormalizeFavorites(p.Home.Favorites)
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

func NormalizeFavorites(ids []string) []string {
	out := []string{}
	for _, id := range ids {
		if len(out) == FavoritesMax {
			break
		}
		if contains(FavoriteIDs, id) && !contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}

func clone(s Settings) Settings {
	c := s
	c.Tabs, c.Features = map[string]bool{}, map[string]bool{}
	c.Home.Favorites = append([]string{}, s.Home.Favorites...)
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
