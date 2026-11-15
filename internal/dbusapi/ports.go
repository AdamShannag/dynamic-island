package dbusapi

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/godbus/dbus/v5"

	"github.com/AdamShannag/dynamic-island/internal/island"
	"github.com/AdamShannag/dynamic-island/internal/ports"
)

func (a *api) PortsList() (string, *dbus.Error) {
	return listJSON(ports.List(context.Background()))
}

func (a *api) PortFree(port uint32) (string, *dbus.Error) {
	summary, err := ports.Free(context.Background(), int(port))
	v := island.View{Title: fmt.Sprintf("Port %d freed", port), Subtitle: summary, Icon: "emblem-ok-symbolic", Accent: "ok"}
	if err != nil {
		v.Title, v.Icon, v.Accent = fmt.Sprintf("Port %d", port), "dialog-error-symbolic", "error"
		v.Subtitle = strings.TrimPrefix(summary+"; "+err.Error(), "; ")
	}
	a.popup(fmt.Sprintf("notify.port.%d", port), 6*time.Second, v)
	return summary, dbusErr(err)
}
