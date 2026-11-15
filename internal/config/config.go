package config

import (
	"encoding/json"
	"errors"
	"os"

	"github.com/AdamShannag/dynamic-island/internal/paths"
)

type Config struct {
	Disable []string `json:"disable"`

	Notifications struct {
		Enabled    *bool    `json:"enabled"`
		IgnoreApps []string `json:"ignoreApps"`
	} `json:"notifications"`

	Pomodoro struct {
		FocusMinutes int `json:"focusMinutes"`
		BreakMinutes int `json:"breakMinutes"`
	} `json:"pomodoro"`
}

func Path() string {
	return paths.ConfigFile("config.json")
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
