package dbusapi

import (
	"github.com/godbus/dbus/v5"

	"github.com/AdamShannag/dynamic-island/internal/inbox"
)

func (a *api) InboxList() (string, *dbus.Error) { return toJSON(inbox.List()) }

func (a *api) InboxRemove(id uint32) *dbus.Error {
	inbox.Remove(id)
	return nil
}

func (a *api) InboxClear() *dbus.Error {
	inbox.Clear()
	return nil
}
