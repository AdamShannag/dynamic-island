// Package config loads ~/.config/go-island/config.json. Every field is
// optional; a missing file means defaults.
package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type Config struct {
	Disable []string `json:"disable"` // plugin names

	Notifications struct {
		Enabled    *bool    `json:"enabled"` // default true
		IgnoreApps []string `json:"ignoreApps"`
	} `json:"notifications"`

	Pomodoro struct {
		FocusMinutes int `json:"focusMinutes"` // default 25
		BreakMinutes int `json:"breakMinutes"` // default 5
	} `json:"pomodoro"`

	GitHub struct {
		Repos           []string `json:"repos"`           // owner/name
		OnlyMine        bool     `json:"onlyMine"`        // only runs triggered by you
		IntervalSeconds int      `json:"intervalSeconds"` // default 60
	} `json:"github"`
}

func Path() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(dir, "go-island", "config.json")
}

func Load() (Config, error) {
	var c Config
	b, err := os.ReadFile(Path())
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	return c, json.Unmarshal(b, &c)
}
