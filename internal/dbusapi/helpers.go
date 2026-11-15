package dbusapi

import (
	"encoding/json"
	"time"

	"github.com/godbus/dbus/v5"

	"github.com/AdamShannag/dynamic-island/internal/island"
)

func dbusErr(err error) *dbus.Error {
	if err == nil {
		return nil
	}
	return dbus.MakeFailedError(err)
}

func toJSON(v any) (string, *dbus.Error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", dbusErr(err)
	}
	return string(b), nil
}

func resultJSON[T any](v T, err error) (string, *dbus.Error) {
	if err != nil {
		return "", dbusErr(err)
	}
	return toJSON(v)
}

func listJSON[T any](list []T, err error) (string, *dbus.Error) {
	if list == nil {
		list = []T{}
	}
	return resultJSON(list, err)
}

func (a *api) popup(id string, ttl time.Duration, v island.View) {
	v.Kind = "notify"
	if v.Click == "" {
		v.Click = "notify.dismiss"
	}
	a.m.Set(island.Activity{ID: id, Priority: island.PriorityNotify, TTL: ttl, View: v})
}
