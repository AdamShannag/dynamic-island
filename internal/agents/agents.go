// Package agents tracks coding-agent sessions (Claude Code) from their hook
// events and status-line feed, and mirrors them into the island:
//
//	working   ambient chip: "Claude · project", current tool, elapsed
//	approval  pops up (warn) until the next event
//	finished  short popup with cost/context when known
//	error     popup with the API error (StopFailure)
//
// Sources are documented interfaces only: hooks
// (https://code.claude.com/docs/en/hooks) and the status-line JSON
// (https://code.claude.com/docs/en/statusline). Transcripts are not parsed:
// their format is internal and changes between versions.
package agents

import (
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"go-island/internal/island"
)

const agentName = "Claude"

type Session struct {
	ID         string  `json:"id"`
	Agent      string  `json:"agent"`
	Project    string  `json:"project"`
	Cwd        string  `json:"cwd"`
	Title      string  `json:"title,omitempty"`
	State      string  `json:"state"` // ready | working | approval | done | error
	Detail     string  `json:"detail,omitempty"`
	TurnStart  int64   `json:"turnStart,omitempty"` // unix ms
	UpdatedAt  int64   `json:"updatedAt"`
	CostUSD    float64 `json:"costUsd,omitempty"`
	ContextPct float64 `json:"contextPct,omitempty"`
	Model      string  `json:"model,omitempty"`
	Focus      []int   `json:"focus,omitempty"`
}

type Tracker struct {
	mu       sync.Mutex
	h        island.Host
	sessions map[string]*Session
}

func NewTracker(h island.Host) *Tracker {
	return &Tracker{h: h, sessions: map[string]*Session{}}
}

type hookEvent struct {
	SessionID        string         `json:"session_id"`
	Cwd              string         `json:"cwd"`
	Event            string         `json:"hook_event_name"`
	ToolName         string         `json:"tool_name"`
	ToolInput        map[string]any `json:"tool_input"`
	Message          string         `json:"message"`
	NotificationType string         `json:"notification_type"`
	Error            string         `json:"error"`
	ErrorDetails     string         `json:"error_details"`
	LastAssistant    string         `json:"last_assistant_message"`
	SessionTitle     string         `json:"session_title"`
	AgentID          string         `json:"agent_id"` // set inside subagents
}

const (
	reportAfter = 5 * time.Second  // only announce turns that took a while
	staleAfter  = 15 * time.Minute // a "working" session with no events is presumed dead
)

// HookEvent ingests one Claude Code hook payload. focus is the hook
// process's ancestor pids (agent → shell → terminal/IDE).
func (t *Tracker) HookEvent(raw []byte, focus []int) error {
	var ev hookEvent
	if err := json.Unmarshal(raw, &ev); err != nil {
		return err
	}
	if ev.SessionID == "" {
		return fmt.Errorf("missing session_id")
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	s := t.session(ev.SessionID, ev.Cwd)
	if len(focus) > 0 {
		s.Focus = focus
	}
	if ev.SessionTitle != "" {
		s.Title = ev.SessionTitle
	}
	now := time.Now()
	s.UpdatedAt = now.UnixMilli()

	switch ev.Event {
	case "SessionStart":
		s.State = "ready"
	case "UserPromptSubmit":
		s.State, s.Detail, s.TurnStart = "working", "Thinking…", now.UnixMilli()
	case "PreToolUse", "PostToolUse", "PostToolUseFailure":
		if ev.AgentID != "" && ev.Event != "PreToolUse" {
			break // subagent chatter: keep the parent's detail
		}
		if s.State != "working" {
			s.State = "working"
			if s.TurnStart == 0 {
				s.TurnStart = now.UnixMilli()
			}
		}
		if ev.Event == "PreToolUse" {
			s.Detail = toolSummary(ev.ToolName, ev.ToolInput)
		}
	case "PermissionRequest":
		s.State, s.Detail = "approval", toolSummary(ev.ToolName, ev.ToolInput)
	case "Notification":
		switch ev.NotificationType {
		case "permission_prompt", "agent_needs_input", "elicitation_dialog", "elicitation_url_dialog":
			s.State = "approval"
			if s.Detail == "" || ev.NotificationType != "permission_prompt" {
				s.Detail = ev.Message
			}
		default:
			return nil // idle prompts etc.: the Stop popup already said it's done
		}
	case "Stop":
		if ev.AgentID != "" {
			return nil
		}
		took := time.Duration(0)
		if s.TurnStart > 0 {
			took = now.Sub(time.UnixMilli(s.TurnStart))
		}
		s.State, s.Detail, s.TurnStart = "done", firstLine(ev.LastAssistant, 140), 0
		t.h.Clear("agent." + s.ID)
		if took >= reportAfter {
			t.popup(s, "finished · "+s.Project, s.Detail, "emblem-ok-symbolic", "ok", 8*time.Second, took)
		}
		return nil
	case "StopFailure":
		msg := ev.ErrorDetails
		if msg == "" {
			msg = strings.ReplaceAll(ev.Error, "_", " ")
		}
		s.State, s.Detail, s.TurnStart = "error", msg, 0
		t.h.Clear("agent." + s.ID)
		t.popup(s, "hit an error · "+s.Project, msg, "dialog-error-symbolic", "error", 20*time.Second, 0)
		return nil
	case "SessionEnd":
		delete(t.sessions, s.ID)
		t.h.Clear("agent." + s.ID)
		return nil
	default:
		return nil
	}
	t.publish(s)
	return nil
}

type statusLine struct {
	SessionID string `json:"session_id"`
	Cwd       string `json:"cwd"`
	Model     struct {
		DisplayName string `json:"display_name"`
	} `json:"model"`
	Cost struct {
		TotalCostUSD float64 `json:"total_cost_usd"`
	} `json:"cost"`
	ContextWindow struct {
		UsedPercentage *float64 `json:"used_percentage"`
	} `json:"context_window"`
}

// Status ingests the status-line JSON (cost, context usage, model).
func (t *Tracker) Status(raw []byte) error {
	var st statusLine
	if err := json.Unmarshal(raw, &st); err != nil {
		return err
	}
	if st.SessionID == "" {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.session(st.SessionID, st.Cwd)
	s.CostUSD = st.Cost.TotalCostUSD
	s.Model = st.Model.DisplayName
	if st.ContextWindow.UsedPercentage != nil {
		s.ContextPct = *st.ContextWindow.UsedPercentage
	}
	if s.State == "working" || s.State == "approval" {
		t.publish(s)
	}
	return nil
}

func (t *Tracker) List() []Session {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]Session, 0, len(t.sessions))
	for _, s := range t.sessions {
		if s.State == "working" && time.Since(time.UnixMilli(s.UpdatedAt)) > staleAfter {
			s.State, s.Detail = "ready", ""
		}
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out
}

func (t *Tracker) session(id, cwd string) *Session {
	s := t.sessions[id]
	if s == nil {
		s = &Session{ID: id, Agent: agentName, State: "ready"}
		t.sessions[id] = s
	}
	if cwd != "" {
		s.Cwd, s.Project = cwd, filepath.Base(cwd)
	}
	return s
}

// publish mirrors a session into the island. Only an approval request
// takes the pill; "working" is shown in the Agents tab only.
func (t *Tracker) publish(s *Session) {
	v := island.View{
		Kind:      "agent",
		Title:     agentName + " · " + s.Project,
		Subtitle:  s.Detail,
		Icon:      "agent",
		StartedAt: s.TurnStart,
		Focus:     s.Focus,
	}
	prio := island.PriorityAgent
	if s.State == "approval" {
		v.Title, v.Accent, v.Icon, v.StartedAt = agentName+" needs approval", "warn", "dialog-question-symbolic", 0
		v.Trailing = s.Project
		prio = island.PriorityAlert
	} else {
		t.h.Clear("agent." + s.ID)
		return
	}
	t.h.Set(island.Activity{ID: "agent." + s.ID, Priority: prio, TTL: staleAfter, View: v})
}

func (t *Tracker) popup(s *Session, title, body, icon, accent string, ttl, took time.Duration) {
	var meta []string
	if took > 0 {
		meta = append(meta, island.FormatDuration(took))
	}
	if s.CostUSD > 0 {
		meta = append(meta, fmt.Sprintf("$%.2f", s.CostUSD))
	}
	t.h.Set(island.Activity{
		ID: "notify.agent." + s.ID, Priority: island.PriorityNotify, TTL: ttl,
		View: island.View{
			Kind: "notify", Title: agentName + " " + title, Subtitle: body, Icon: icon, Accent: accent,
			Trailing: strings.Join(meta, " · "), Click: "notify.dismiss", Focus: s.Focus,
		},
	})
}

func toolSummary(tool string, in map[string]any) string {
	str := func(k string) string { v, _ := in[k].(string); return v }
	switch tool {
	case "Bash":
		return "$ " + firstLine(str("command"), 90)
	case "Edit", "MultiEdit", "Write", "NotebookEdit":
		p := str("file_path")
		if p == "" {
			p = str("notebook_path")
		}
		return "Editing " + filepath.Base(p)
	case "Read":
		return "Reading " + filepath.Base(str("file_path"))
	case "Grep":
		return "Searching for " + firstLine(str("pattern"), 60)
	case "Glob":
		return "Finding " + str("pattern")
	case "WebFetch":
		if u, err := url.Parse(str("url")); err == nil && u.Host != "" {
			return "Reading " + u.Host
		}
		return "Fetching a page"
	case "WebSearch":
		return "Searching the web"
	case "Task", "Agent":
		if d := str("description"); d != "" {
			return "Subagent: " + firstLine(d, 70)
		}
		return "Running a subagent"
	}
	if i := strings.LastIndex(tool, "__"); i >= 0 { // mcp__server__tool
		tool = tool[i+2:]
	}
	return strings.ReplaceAll(tool, "_", " ")
}

func firstLine(s string, max int) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > max {
		s = string(r[:max-1]) + "…"
	}
	return s
}
