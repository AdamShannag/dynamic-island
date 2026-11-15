package dbusapi

import (
	"log"

	"github.com/godbus/dbus/v5"

	"github.com/AdamShannag/dynamic-island/internal/settings"
)

func (a *api) GetSettings() (string, *dbus.Error) { return toJSON(settings.Get()) }

func (a *api) SetSettings(patch string) (string, *dbus.Error) {
	out, derr := resultJSON(settings.Update([]byte(patch)))
	if derr != nil {
		return "", derr
	}
	if err := a.emit(signalSettingsChanged, out); err != nil {
		log.Printf("emit %s: %v", signalSettingsChanged, err)
	}
	return out, nil
}
