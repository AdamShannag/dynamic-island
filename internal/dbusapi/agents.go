package dbusapi

import "github.com/godbus/dbus/v5"

func (a *api) AgentEvent(event string, focus []int32) *dbus.Error {
	pids := make([]int, len(focus))
	for i, p := range focus {
		pids[i] = int(p)
	}
	return dbusErr(a.agents.HookEvent([]byte(event), pids))
}

func (a *api) AgentStatus(status string) *dbus.Error { return dbusErr(a.agents.Status([]byte(status))) }

func (a *api) AgentsList() (string, *dbus.Error) { return toJSON(a.agents.List()) }
