// Package dbusapi exposes the island Manager on the session bus as
// org.goisland.Island. The GNOME extension and the CLI are its clients.
package dbusapi

import (
	"fmt"
	"sync/atomic"
	"time"

	"github.com/godbus/dbus/v5"
	"github.com/godbus/dbus/v5/introspect"

	"go-island/internal/island"
)

const (
	BusName = "org.goisland.Island"
	Path    = dbus.ObjectPath("/org/goisland/Island")
	Iface   = "org.goisland.Island"
)

const introXML = `
<node>
  <interface name="` + Iface + `">
    <method name="GetState">
      <arg name="state" type="s" direction="out"/>
    </method>
    <method name="Action">
      <arg name="name" type="s" direction="in"/>
    </method>
    <method name="Notify">
      <arg name="title" type="s" direction="in"/>
      <arg name="body" type="s" direction="in"/>
      <arg name="icon" type="s" direction="in"/>
      <arg name="timeout_ms" type="i" direction="in"/>
      <arg name="id" type="u" direction="out"/>
    </method>
    <signal name="StateChanged">
      <arg name="state" type="s"/>
    </signal>
  </interface>` + introspect.IntrospectDeclarationString + `</node>`

// api's exported methods are exactly the D-Bus methods (godbus exports all of them).
type api struct {
	m      *island.Manager
	nextID atomic.Uint32
}

func (a *api) GetState() (string, *dbus.Error) { return a.m.State(), nil }

func (a *api) Action(name string) *dbus.Error {
	if err := a.m.Action(name); err != nil {
		return dbus.MakeFailedError(err)
	}
	return nil
}

func (a *api) Notify(title, body, icon string, timeoutMs int32) (uint32, *dbus.Error) {
	if title == "" {
		return 0, dbus.MakeFailedError(fmt.Errorf("title is required"))
	}
	if icon == "" {
		icon = "dialog-information-symbolic"
	}
	ttl := time.Duration(timeoutMs) * time.Millisecond
	if timeoutMs <= 0 {
		ttl = 5 * time.Second
	}
	id := a.nextID.Add(1)
	a.m.Set(island.Activity{
		ID:       fmt.Sprintf("notify.%d", id),
		Priority: island.PriorityNotify,
		TTL:      ttl,
		View: island.View{
			Kind: "notify", Title: title, Subtitle: body, Icon: icon,
			Actions: []string{"notify.dismiss"},
		},
	})
	return id, nil
}

// Serve claims the bus name, exports the API and wires StateChanged signals.
func Serve(conn *dbus.Conn, m *island.Manager) error {
	a := &api{m: m}
	m.HandleAction("notify.dismiss", func() { m.ClearPrefix("notify.") })

	if err := conn.Export(a, Path, Iface); err != nil {
		return err
	}
	if err := conn.Export(introspect.Introspectable(introXML), Path,
		"org.freedesktop.DBus.Introspectable"); err != nil {
		return err
	}
	reply, err := conn.RequestName(BusName, dbus.NameFlagDoNotQueue)
	if err != nil {
		return err
	}
	if reply != dbus.RequestNameReplyPrimaryOwner {
		return fmt.Errorf("%s is already owned (is another islandd running?)", BusName)
	}
	m.OnChange(func(state string) {
		if err := conn.Emit(Path, Iface+".StateChanged", state); err != nil {
			fmt.Println("emit:", err)
		}
	})
	return nil
}
