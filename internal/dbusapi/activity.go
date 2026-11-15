package dbusapi

import "github.com/godbus/dbus/v5"

func (a *api) SystemStats() (string, *dbus.Error) { return toJSON(a.sys.Sample()) }

func (a *api) ActivityList() (string, *dbus.Error) {
	if a.ctxw == nil {
		return "[]", nil
	}
	return toJSON(a.ctxw.List())
}
