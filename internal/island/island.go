// Package island holds the daemon's state machine: plugins post Activities,
// the Manager picks the most important one and publishes it as the View the
// UI should render.
package island

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// View is exactly what the UI renders. It is serialized to JSON and sent
// over D-Bus, so keep it flat and UI-agnostic. Live values (timers, media
// position) are sent as timestamps so the UI ticks locally without the
// daemon emitting a signal every second.
type View struct {
	Kind      string  `json:"kind"` // idle | media | battery | notify | task | timer | ci
	Title     string  `json:"title,omitempty"`
	Subtitle  string  `json:"subtitle,omitempty"`
	Icon      string  `json:"icon,omitempty"`      // freedesktop icon name
	Art       string  `json:"art,omitempty"`       // local image path
	Accent    string  `json:"accent,omitempty"`    // "" | ok | warn | error
	Trailing  string  `json:"trailing,omitempty"`  // short text on the right
	Click     string  `json:"click,omitempty"`     // action fired when the pill is clicked
	EndsAt    int64   `json:"endsAt,omitempty"`    // unix ms; UI shows a countdown
	StartedAt int64   `json:"startedAt,omitempty"` // unix ms; UI shows elapsed time
	Playing   bool    `json:"playing,omitempty"`
	Timing    *Timing `json:"timing,omitempty"`
	Focus     []int   `json:"focus,omitempty"`  // pids; clicking focuses the first with a window
	Swatch    string  `json:"swatch,omitempty"` // a colour to show in place of the icon
	URL       string  `json:"url,omitempty"`    // clicking opens this in the browser
	// Mirrored desktop notifications: clicking activates the original
	// (like clicking GNOME's banner); App/DesktopEntry identify the sender.
	Mirror       bool     `json:"mirror,omitempty"`
	App          string   `json:"app,omitempty"`
	DesktopEntry string   `json:"desktopEntry,omitempty"`
	Actions      []string `json:"actions,omitempty"` // action names the UI may offer
}

// Timing describes media playback so the UI can draw a live progress bar.
type Timing struct {
	Length   float64 `json:"length"`   // seconds
	Position float64 `json:"position"` // seconds, as of At
	At       int64   `json:"at"`       // unix ms
	Rate     float64 `json:"rate"`
}

// UnixMs is a helper for View timestamps.
func UnixMs(t time.Time) int64 { return t.UnixMilli() }

// FormatDuration renders 1h02m, 3m05s or 42s.
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

// Activity is a plugin's request to occupy the island.
type Activity struct {
	ID       string        // unique per activity; re-Set with the same ID replaces it
	Priority int           // higher wins; ties go to the most recent
	View     View          //
	TTL      time.Duration // 0 = until cleared
}

// Common priorities so plugins agree on ordering.
const (
	PriorityService = 9  // running dev servers (below media)
	PriorityAmbient = 10 // long-lived background state (media)
	PriorityAgent   = 12 // a coding agent working
	PriorityTimer   = 15 // pomodoro
	PriorityTask    = 20 // a running `island run` command
	PriorityStatus  = 30 // short status blips (charging)
	PriorityAlert   = 40 // warnings (low battery)
	PriorityNotify  = 50 // explicit user notifications
)

// Host is what plugins get to talk to the island.
type Host interface {
	Set(a Activity)
	Clear(id string)
	ClearPrefix(prefix string)
	// HandleAction registers fn for an action name sent by the UI (e.g. "media.next").
	HandleAction(name string, fn func())
	// Presenting reports whether screen-sharing privacy mode is on; plugins
	// should not surface personal content while it is.
	Presenting() bool
}

// Plugin is one island feature. Run blocks until ctx is done; returning an
// error makes the daemon restart it after a backoff.
type Plugin interface {
	Name() string
	Run(ctx context.Context, h Host) error
}

type entry struct {
	Activity
	seq   uint64
	timer *time.Timer
}

// Manager implements Host and tracks the current View.
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

// OnChange sets the callback fired (under lock, in order) whenever the View changes.
func (m *Manager) OnChange(fn func(stateJSON string)) {
	m.mu.Lock()
	m.onChange = fn
	m.mu.Unlock()
}

// State returns the current View as JSON.
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

// SetPresenting toggles privacy mode; turning it on drops personal popups.
func (m *Manager) SetPresenting(on bool) {
	m.mu.Lock()
	m.presenting = on
	m.mu.Unlock()
	if on {
		m.ClearPrefix("notify.mirror.")
	}
}

// Action runs a registered action handler asynchronously.
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

// recompute must be called with mu held.
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
