package dbusapi

import (
	"context"

	"github.com/godbus/dbus/v5"

	"github.com/AdamShannag/dynamic-island/internal/docker"
)

func (a *api) DockerList() (string, *dbus.Error) {
	return listJSON(docker.List(context.Background()))
}

func (a *api) DockerLogs(id string, lines int32) (string, *dbus.Error) {
	out, err := docker.Logs(context.Background(), id, int(lines))
	return out, dbusErr(err)
}

func (a *api) DockerAction(id, op string) *dbus.Error {
	return dbusErr(docker.Act(context.Background(), id, op))
}
