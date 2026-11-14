// Package dbusapi exposes the island Manager on the session bus as
// org.goisland.Island. The GNOME extension and the CLI are its clients.
package dbusapi

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/godbus/dbus/v5"
	"github.com/godbus/dbus/v5/introspect"

	"go-island/internal/clipboard"
	"go-island/internal/docker"
	"go-island/internal/island"
	"go-island/internal/ports"
	"go-island/internal/sites"
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
    <method name="DockerList">
      <arg name="containers" type="s" direction="out"/>
    </method>
    <method name="DockerAction">
      <arg name="id" type="s" direction="in"/>
      <arg name="op" type="s" direction="in"/>
    </method>
    <method name="PortsList">
      <arg name="listeners" type="s" direction="out"/>
    </method>
    <method name="PortFree">
      <arg name="port" type="u" direction="in"/>
      <arg name="summary" type="s" direction="out"/>
    </method>
    <method name="SitesList">
      <arg name="sites" type="s" direction="out"/>
    </method>
    <method name="SiteAdd">
      <arg name="url" type="s" direction="in"/>
      <arg name="name" type="s" direction="in"/>
    </method>
    <method name="SiteRemove">
      <arg name="id" type="u" direction="in"/>
    </method>
    <method name="ClipboardAdd">
      <arg name="text" type="s" direction="in"/>
    </method>
    <method name="ClipboardList">
      <arg name="items" type="s" direction="out"/>
    </method>
    <method name="ClipboardDelete">
      <arg name="id" type="u" direction="in"/>
    </method>
    <method name="ClipboardPin">
      <arg name="id" type="u" direction="in"/>
      <arg name="pinned" type="b" direction="in"/>
    </method>
    <method name="ClipboardClear"/>
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

	clip  *clipboard.Store
	sites *sites.Store
}

func (a *api) SitesList() (string, *dbus.Error) { return toJSON(a.sites.List()) }
func (a *api) SiteRemove(id uint32) *dbus.Error { return dbusErr(a.sites.Remove(id)) }
func (a *api) SiteAdd(url, name string) *dbus.Error {
	_, err := a.sites.Add(url, name)
	return dbusErr(err)
}

func dbusErr(err error) *dbus.Error {
	if err == nil {
		return nil
	}
	return dbus.MakeFailedError(err)
}

func toJSON(v any) (string, *dbus.Error) {
	b, err := json.Marshal(v)
	return string(b), dbusErr(err)
}

func (a *api) DockerList() (string, *dbus.Error) {
	list, err := docker.List(context.Background())
	if err != nil {
		return "", dbusErr(err)
	}
	if list == nil {
		list = []docker.Container{}
	}
	return toJSON(list)
}

func (a *api) DockerAction(id, op string) *dbus.Error {
	return dbusErr(docker.Act(context.Background(), id, op))
}

func (a *api) PortsList() (string, *dbus.Error) {
	list, err := ports.List(context.Background())
	if err != nil {
		return "", dbusErr(err)
	}
	if list == nil {
		list = []ports.Listener{}
	}
	return toJSON(list)
}

// PortFree kills whatever listens on port and pops the island with the result.
func (a *api) PortFree(port uint32) (string, *dbus.Error) {
	summary, err := ports.Free(context.Background(), int(port))
	v := island.View{Kind: "notify", Title: fmt.Sprintf("Port %d freed", port), Subtitle: summary,
		Icon: "emblem-ok-symbolic", Accent: "ok", Click: "notify.dismiss"}
	if err != nil {
		v.Title, v.Icon, v.Accent = fmt.Sprintf("Port %d", port), "dialog-error-symbolic", "error"
		v.Subtitle = strings.TrimPrefix(summary+"; "+err.Error(), "; ")
	}
	a.m.Set(island.Activity{ID: fmt.Sprintf("notify.port.%d", port), Priority: island.PriorityNotify,
		TTL: 6 * time.Second, View: v})
	return summary, dbusErr(err)
}

func (a *api) ClipboardAdd(text string) *dbus.Error  { return dbusErr(a.clip.Add(text)) }
func (a *api) ClipboardList() (string, *dbus.Error)  { return toJSON(a.clip.List()) }
func (a *api) ClipboardDelete(id uint32) *dbus.Error { return dbusErr(a.clip.Delete(id)) }
func (a *api) ClipboardClear() *dbus.Error           { return dbusErr(a.clip.Clear()) }
func (a *api) ClipboardPin(id uint32, pinned bool) *dbus.Error {
	return dbusErr(a.clip.SetPinned(id, pinned))
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
func Serve(conn *dbus.Conn, m *island.Manager, clip *clipboard.Store, st *sites.Store) error {
	a := &api{m: m, tasks: map[uint32]task{}, clip: clip, sites: st}
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
