package dbusapi

import "github.com/godbus/dbus/v5"

func (a *api) NotesList() (string, *dbus.Error) { return toJSON(a.notes.List()) }

func (a *api) NoteCreate() (string, *dbus.Error) { return resultJSON(a.notes.Create()) }

func (a *api) NoteSave(id uint32, text string) *dbus.Error { return dbusErr(a.notes.Save(id, text)) }

func (a *api) NotePin(id uint32, pinned bool) *dbus.Error { return dbusErr(a.notes.Pin(id, pinned)) }

func (a *api) NoteDelete(id uint32) *dbus.Error { return dbusErr(a.notes.Delete(id)) }
