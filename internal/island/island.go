package island

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

type View struct {
	Kind         string   `json:"kind"`
	Title        string   `json:"title,omitempty"`
	Subtitle     string   `json:"subtitle,omitempty"`
	Icon         string   `json:"icon,omitempty"`
	Art          string   `json:"art,omitempty"`
	Accent       string   `json:"accent,omitempty"`
	Trailing     string   `json:"trailing,omitempty"`
	Click        string   `json:"click,omitempty"`
	EndsAt       int64    `json:"endsAt,omitempty"`
	StartedAt    int64    `json:"startedAt,omitempty"`
	Playing      bool     `json:"playing,omitempty"`
	Timing       *Timing  `json:"timing,omitempty"`
	Focus        []int    `json:"focus,omitempty"`
	Swatch       string   `json:"swatch,omitempty"`
	URL          string   `json:"url,omitempty"`
	Mirror       bool     `json:"mirror,omitempty"`
	App          string   `json:"app,omitempty"`
	DesktopEntry string   `json:"desktopEntry,omitempty"`
	Actions      []string `json:"actions,omitempty"`
}

type Timing struct {
	Length   float64 `json:"length"`
	Position float64 `json:"position"`
	At       int64   `json:"at"`
	Rate     float64 `json:"rate"`
}

func UnixMs(t time.Time) int64 { return t.UnixMilli() }

func FormatDuration(d time.Duration) string {
	d = d.Round(time.Second)
	h, m, s := int(d.Hours()), int(d.Minutes())%60, int(d.Seconds())%60
	switch {
	case h > 0:
		return fmt.Sprintf("%dh%02dm", h, m)
	case m > 0:
		return fmt.Sprintf("%dm%02ds", m, s)
	}
	return fmt.Sprintf("%ds", s)
}

type Activity struct {
	ID       string
	Priority int
	View     View
	TTL      time.Duration
}

const (
	PriorityService = 9
	PriorityAmbient = 10
	PriorityAgent   = 12
	PriorityTimer   = 15
	PriorityTask    = 20
	PriorityStatus  = 30
	PriorityAlert   = 40
	PriorityNotify  = 50
)

type Host interface {
	Set(a Activity)
	Clear(id string)
	ClearPrefix(prefix string)
	HandleAction(name string, fn func())
	Presenting() bool
}

type Plugin interface {
	Name() string
	Run(ctx context.Context, h Host) error
}

type entry struct {
	Activity
	seq   uint64
	timer *time.Timer
}

type Manager struct {
	mu         sync.Mutex
	presenting bool
	acts       map[string]*entry
	actions    map[string]func()
	seq        uint64
	current    string
	onChange   func(stateJSON string)
}

func NewManager() *Manager {
	m := &Manager{acts: map[string]*entry{}, actions: map[string]func(){}}
	m.current = mustJSON(View{Kind: "idle"})
	return m
}

func (m *Manager) OnChange(fn func(stateJSON string)) {
	m.mu.Lock()
	m.onChange = fn
	m.mu.Unlock()
}

func (m *Manager) State() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.current
}

func (m *Manager) Set(a Activity) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if old, ok := m.acts[a.ID]; ok && old.timer != nil {
		old.timer.Stop()
	}
	m.seq++
	e := &entry{Activity: a, seq: m.seq}
	if a.TTL > 0 {
		id, seq := a.ID, e.seq
		e.timer = time.AfterFunc(a.TTL, func() { m.expire(id, seq) })
	}
	m.acts[a.ID] = e
	m.recompute()
}

func (m *Manager) Clear(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.remove(id)
	m.recompute()
}

func (m *Manager) ClearPrefix(prefix string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id := range m.acts {
		if strings.HasPrefix(id, prefix) {
			m.remove(id)
		}
	}
	m.recompute()
}

func (m *Manager) HandleAction(name string, fn func()) {
	m.mu.Lock()
	m.actions[name] = fn
	m.mu.Unlock()
}

func (m *Manager) Presenting() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.presenting
}

func (m *Manager) SetPresenting(on bool) {
	m.mu.Lock()
	m.presenting = on
	m.mu.Unlock()
	if on {
		m.ClearPrefix("notify.mirror.")
	}
}

func (m *Manager) Action(name string) error {
	m.mu.Lock()
	fn, ok := m.actions[name]
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("unknown action %q", name)
	}
	go fn()
	return nil
}

func (m *Manager) expire(id string, seq uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.acts[id]; ok && e.seq == seq {
		delete(m.acts, id)
		m.recompute()
	}
}

func (m *Manager) remove(id string) {
	if e, ok := m.acts[id]; ok {
		if e.timer != nil {
			e.timer.Stop()
		}
		delete(m.acts, id)
	}
}

func (m *Manager) recompute() {
	var best *entry
	for _, e := range m.acts {
		if best == nil || e.Priority > best.Priority ||
			(e.Priority == best.Priority && e.seq > best.seq) {
			best = e
		}
	}
	v := View{Kind: "idle"}
	if best != nil {
		v = best.View
	}
	s := mustJSON(v)
	if s == m.current {
		return
	}
	m.current = s
	if m.onChange != nil {
		m.onChange(s)
	}
}

func mustJSON(v View) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}
