package dbusapi

import (
	"github.com/godbus/dbus/v5"

	"github.com/AdamShannag/dynamic-island/internal/settings"
)

func (a *api) ClipboardAdd(text string) *dbus.Error {
	if a.m.Presenting() || !settings.Enabled("clipboardHistory") {
		return nil
	}
	return dbusErr(a.clip.Add(text))
}

func (a *api) ClipboardList() (string, *dbus.Error) { return toJSON(a.clip.List()) }

func (a *api) ClipboardDelete(id uint32) *dbus.Error { return dbusErr(a.clip.Delete(id)) }

func (a *api) ClipboardPin(id uint32, pinned bool) *dbus.Error {
	return dbusErr(a.clip.SetPinned(id, pinned))
}

func (a *api) ClipboardClear() *dbus.Error { return dbusErr(a.clip.Clear()) }
