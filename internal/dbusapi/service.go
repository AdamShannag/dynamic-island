// Package dbusapi exposes the island Manager on the session bus as
// org.goisland.Island. The GNOME extension and the CLI are its clients.
package dbusapi

import (
	"fmt"
	"sync"
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
      <arg name="accent" type="s" direction="in"/>
      <arg name="timeout_ms" type="i" direction="in"/>
      <arg name="id" type="u" direction="out"/>
    </method>
    <method name="TaskStart">
      <arg name="title" type="s" direction="in"/>
      <arg name="id" type="u" direction="out"/>
    </method>
    <method name="TaskEnd">
      <arg name="id" type="u" direction="in"/>
      <arg name="exit_code" type="i" direction="in"/>
    </method>
    <signal name="StateChanged">
      <arg name="state" type="s"/>
    </signal>
  </interface>` + introspect.IntrospectDeclarationString + `</node>`

type task struct {
	title string
	start time.Time
}

// api's exported methods are exactly the D-Bus methods (godbus exports all of them).
type api struct {
	m      *island.Manager
	nextID atomic.Uint32

	mu    sync.Mutex
	tasks map[uint32]task
}

func (a *api) GetState() (string, *dbus.Error) { return a.m.State(), nil }

func (a *api) Action(name string) *dbus.Error {
	if err := a.m.Action(name); err != nil {
		return dbus.MakeFailedError(err)
	}
	return nil
}

func (a *api) Notify(title, body, icon, accent string, timeoutMs int32) (uint32, *dbus.Error) {
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
			Kind: "notify", Title: title, Subtitle: body, Icon: icon, Accent: accent,
			Click: "notify.dismiss",
		},
	})
	return id, nil
}

// TaskStart shows a running command (used by `island run`).
func (a *api) TaskStart(title string) (uint32, *dbus.Error) {
	id := a.nextID.Add(1)
	now := time.Now()
	a.mu.Lock()
	a.tasks[id] = task{title, now}
	a.mu.Unlock()
	a.m.Set(island.Activity{
		ID:       fmt.Sprintf("task.%d", id),
		Priority: island.PriorityTask,
		TTL:      12 * time.Hour, // safety net if the client dies without TaskEnd
		View: island.View{
			Kind: "task", Title: title, Icon: "system-run-symbolic",
			StartedAt: island.UnixMs(now),
		},
	})
	return id, nil
}

// TaskEnd replaces the running task with a short success/failure result.
func (a *api) TaskEnd(id uint32, exitCode int32) *dbus.Error {
	a.mu.Lock()
	t, ok := a.tasks[id]
	delete(a.tasks, id)
	a.mu.Unlock()
	if !ok {
		return dbus.MakeFailedError(fmt.Errorf("unknown task %d", id))
	}
	a.m.Clear(fmt.Sprintf("task.%d", id))

	took := island.FormatDuration(time.Since(t.start))
	v := island.View{Kind: "notify", Title: t.title, Click: "notify.dismiss"}
	ttl := 6 * time.Second
	if exitCode == 0 {
		v.Icon, v.Accent, v.Subtitle = "emblem-ok-symbolic", "ok", "Succeeded in "+took
	} else {
		v.Icon, v.Accent = "dialog-error-symbolic", "error"
		v.Subtitle = fmt.Sprintf("Failed (exit %d) after %s", exitCode, took)
		ttl = 12 * time.Second
	}
	a.m.Set(island.Activity{
		ID: fmt.Sprintf("notify.task.%d", id), Priority: island.PriorityNotify, TTL: ttl, View: v,
	})
	return nil
}

// Serve claims the bus name, exports the API and wires StateChanged signals.
func Serve(conn *dbus.Conn, m *island.Manager) error {
	a := &api{m: m, tasks: map[uint32]task{}}
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
