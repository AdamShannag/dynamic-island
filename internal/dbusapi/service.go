package dbusapi

import (
	"fmt"
	"log"
	"sync"
	"sync/atomic"

	"github.com/godbus/dbus/v5"
	"github.com/godbus/dbus/v5/introspect"

	"github.com/AdamShannag/dynamic-island/internal/agents"
	"github.com/AdamShannag/dynamic-island/internal/clipboard"
	"github.com/AdamShannag/dynamic-island/internal/island"
	"github.com/AdamShannag/dynamic-island/internal/notes"
	"github.com/AdamShannag/dynamic-island/internal/plugins"
	"github.com/AdamShannag/dynamic-island/internal/sites"
	"github.com/AdamShannag/dynamic-island/internal/sysmon"
)

const (
	BusName = "io.github.AdamShannag.DynamicIsland"
	Path    = dbus.ObjectPath("/io/github/AdamShannag/DynamicIsland")
	Iface   = "io.github.AdamShannag.DynamicIsland"
)

const (
	signalStateChanged    = "StateChanged"
	signalSettingsChanged = "SettingsChanged"
	signalOpenDashboard   = "OpenDashboard"
	signalColorPicked     = "ColorPicked"
)

type Deps struct {
	Conn      *dbus.Conn
	Manager   *island.Manager
	Clipboard *clipboard.Store
	Sites     *sites.Store
	Activity  *plugins.Context
	Notes     *notes.Store
	Agents    *agents.Tracker
	System    *sysmon.Monitor
}

type api struct {
	conn   *dbus.Conn
	m      *island.Manager
	clip   *clipboard.Store
	sites  *sites.Store
	ctxw   *plugins.Context
	notes  *notes.Store
	agents *agents.Tracker
	sys    *sysmon.Monitor

	nextID atomic.Uint32
	mu     sync.Mutex
	tasks  map[uint32]task
}

func newAPI(d Deps) *api {
	a := &api{
		conn:   d.Conn,
		m:      d.Manager,
		clip:   d.Clipboard,
		sites:  d.Sites,
		ctxw:   d.Activity,
		notes:  d.Notes,
		agents: d.Agents,
		sys:    d.System,
		tasks:  map[uint32]task{},
	}
	if a.notes == nil {
		n, err := notes.Open()
		if err != nil {
			log.Printf("notes: %v", err)
		}
		a.notes = n
	}
	if a.agents == nil {
		a.agents = agents.NewTracker(a.m)
	}
	if a.sys == nil {
		a.sys = sysmon.New()
	}
	return a
}

func Serve(d Deps) error {
	if d.Conn == nil || d.Manager == nil {
		return fmt.Errorf("dbusapi: Conn and Manager are required")
	}
	a := newAPI(d)
	a.m.HandleAction("notify.dismiss", func() { a.m.ClearPrefix("notify.") })

	if err := a.export(); err != nil {
		return err
	}
	if err := a.claimName(); err != nil {
		return err
	}
	a.m.OnChange(func(state string) {
		if err := a.emit(signalStateChanged, state); err != nil {
			log.Printf("emit %s: %v", signalStateChanged, err)
		}
	})
	return nil
}

func (a *api) export() error {
	if err := a.conn.Export(a, Path, Iface); err != nil {
		return err
	}
	return a.conn.Export(introspect.Introspectable(introXML), Path, "org.freedesktop.DBus.Introspectable")
}

func (a *api) claimName() error {
	reply, err := a.conn.RequestName(BusName, dbus.NameFlagDoNotQueue)
	if err != nil {
		return err
	}
	if reply != dbus.RequestNameReplyPrimaryOwner {
		return fmt.Errorf("%s is already owned (is another dynamic-islandd running?)", BusName)
	}
	return nil
}

func (a *api) emit(signal string, args ...any) error {
	return a.conn.Emit(Path, Iface+"."+signal, args...)
}
