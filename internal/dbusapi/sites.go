package dbusapi

import "github.com/godbus/dbus/v5"

func (a *api) SitesList() (string, *dbus.Error) { return toJSON(a.sites.List()) }

func (a *api) SiteAdd(url, name string) *dbus.Error {
	_, err := a.sites.Add(url, name)
	return dbusErr(err)
}

func (a *api) SiteRemove(id uint32) *dbus.Error { return dbusErr(a.sites.Remove(id)) }
