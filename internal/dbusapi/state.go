package dbusapi

import (
	"fmt"
	"time"

	"github.com/godbus/dbus/v5"

	"github.com/AdamShannag/dynamic-island/internal/island"
)

type task struct {
	title string
	start time.Time
}

func (a *api) GetState() (string, *dbus.Error) { return a.m.State(), nil }

func (a *api) Action(name string) *dbus.Error { return dbusErr(a.m.Action(name)) }

func (a *api) SetPresenting(on bool) *dbus.Error {
	a.m.SetPresenting(on)
	return nil
}

func (a *api) Open(tab string) *dbus.Error { return dbusErr(a.emit(signalOpenDashboard, tab)) }

func (a *api) Notify(title, body, icon, accent string, timeoutMs int32) (uint32, *dbus.Error) {
	if title == "" {
		return 0, dbusErr(fmt.Errorf("title is required"))
	}
	if icon == "" {
		icon = "dialog-information-symbolic"
	}
	ttl := time.Duration(timeoutMs) * time.Millisecond
	if timeoutMs <= 0 {
		ttl = 5 * time.Second
	}
	id := a.nextID.Add(1)
	a.popup(fmt.Sprintf("notify.%d", id), ttl, island.View{Title: title, Subtitle: body, Icon: icon, Accent: accent})
	return id, nil
}

func (a *api) TaskStart(title string) (uint32, *dbus.Error) {
	id := a.nextID.Add(1)
	now := time.Now()
	a.mu.Lock()
	a.tasks[id] = task{title, now}
	a.mu.Unlock()
	a.m.Set(island.Activity{
		ID:       fmt.Sprintf("task.%d", id),
		Priority: island.PriorityTask,
		TTL:      12 * time.Hour,
		View: island.View{
			Kind: "task", Title: title, Icon: "system-run-symbolic",
			StartedAt: island.UnixMs(now),
		},
	})
	return id, nil
}

func (a *api) TaskEnd(id uint32, exitCode int32) *dbus.Error {
	a.mu.Lock()
	t, ok := a.tasks[id]
	delete(a.tasks, id)
	a.mu.Unlock()
	if !ok {
		return dbusErr(fmt.Errorf("unknown task %d", id))
	}
	a.m.Clear(fmt.Sprintf("task.%d", id))

	took := island.FormatDuration(time.Since(t.start))
	v := island.View{Title: t.title}
	ttl := 6 * time.Second
	if exitCode == 0 {
		v.Icon, v.Accent, v.Subtitle = "emblem-ok-symbolic", "ok", "Succeeded in "+took
	} else {
		v.Icon, v.Accent = "dialog-error-symbolic", "error"
		v.Subtitle = fmt.Sprintf("Failed (exit %d) after %s", exitCode, took)
		ttl = 12 * time.Second
	}
	a.popup(fmt.Sprintf("notify.task.%d", id), ttl, v)
	return nil
}
