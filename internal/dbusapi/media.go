package dbusapi

import "github.com/godbus/dbus/v5"

func (a *api) MediaLastPlayer() (string, *dbus.Error) {
	if a.media == nil {
		return "", nil
	}
	return a.media.LastPlayer(), nil
}
