package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/godbus/dbus/v5"
)

// island claude hook | statusline [-- CMD...] | install | uninstall
func claudeCmd(args []string) int {
	if len(args) == 0 {
		usage()
	}
	switch args[0] {
	case "hook":
		claudeHook()
		return 0 // never disturb Claude Code, whatever happens
	case "statusline":
		return claudeStatusline(args[1:])
	case "install":
		return report(claudeInstall())
	case "uninstall":
		return report(claudeUninstall())
	}
	usage()
	return 2
}

func report(err error) int {
	if err != nil {
		fmt.Fprintln(os.Stderr, "island:", err)
		return 1
	}
	return 0
}

// send fires a method call without waiting for a reply (hooks must be fast).
func send(method string, args ...any) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return
	}
	defer conn.Close()
	obj := conn.Object("org.goisland.Island", "/org/goisland/Island")
	obj.Go("org.goisland.Island."+method, dbus.FlagNoReplyExpected, nil, args...)
}

func claudeHook() {
	data, err := io.ReadAll(io.LimitReader(os.Stdin, 4<<20))
	if err != nil || len(data) == 0 {
		return
	}
	send("AgentEvent", string(data), ancestors())
}

// claudeStatusline forwards the status-line JSON to the island, then runs
// the user's own status-line command (if any) with the same input.
func claudeStatusline(args []string) int {
	data, _ := io.ReadAll(io.LimitReader(os.Stdin, 4<<20))
	if len(data) > 0 {
		send("AgentStatus", string(data))
	}
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	if len(args) == 0 {
		return 0
	}
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Stdin = strings.NewReader(string(data))
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode()
		}
		return 1
	}
	return 0
}

// ancestors returns this process's ancestor pids (Claude → shell → terminal…),
// so the UI can focus the window the session lives in.
func ancestors() []int32 {
	var out []int32
	pid := os.Getppid()
	for i := 0; pid > 1 && i < 40; i++ {
		out = append(out, int32(pid))
		b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if err != nil {
			break
		}
		s := string(b)
		f := strings.Fields(s[strings.LastIndexByte(s, ')')+1:])
		if len(f) < 2 {
			break
		}
		pid, _ = strconv.Atoi(f[1])
	}
	return out
}

// ---------- install / uninstall ----------

var hookEvents = []string{
	"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
	"PermissionRequest", "Notification", "Stop", "StopFailure", "SessionEnd",
}

var toolEvents = map[string]bool{"PreToolUse": true, "PostToolUse": true, "PostToolUseFailure": true, "PermissionRequest": true}

const hookMarker = " claude hook"
const statusMarker = " claude statusline"

func settingsPath() string {
	return filepath.Join(os.Getenv("HOME"), ".claude", "settings.json")
}

func origStatusPath() string {
	return filepath.Join(os.Getenv("HOME"), ".local", "share", "go-island", "claude-statusline.orig.json")
}

func loadSettings() (map[string]any, []byte, error) {
	raw, err := os.ReadFile(settingsPath())
	if errors.Is(err, os.ErrNotExist) {
		return map[string]any{}, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	var s map[string]any
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, nil, fmt.Errorf("%s is not valid JSON: %w", settingsPath(), err)
	}
	return s, raw, nil
}

func saveSettings(s map[string]any, previous []byte) error {
	if previous != nil {
		backup := settingsPath() + ".bak-goisland-" + time.Now().Format("20060102-150405")
		if err := os.WriteFile(backup, previous, 0o600); err != nil {
			return err
		}
		fmt.Println("backup:", backup)
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(settingsPath()), 0o700); err != nil {
		return err
	}
	tmp := settingsPath() + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, settingsPath())
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func claudeInstall() error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	s, prev, err := loadSettings()
	if err != nil {
		return err
	}
	hooks, _ := s["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	removeOurHooks(hooks)
	hookCmd := self + hookMarker
	for _, ev := range hookEvents {
		group := map[string]any{"hooks": []any{map[string]any{"type": "command", "command": hookCmd, "timeout": 5}}}
		if toolEvents[ev] {
			group["matcher"] = "*"
		}
		list, _ := hooks[ev].([]any)
		hooks[ev] = append(list, group)
	}
	s["hooks"] = hooks

	// Wrap the existing status line so it keeps working unchanged.
	if sl, _ := s["statusLine"].(map[string]any); sl == nil || !strings.Contains(fmt.Sprint(sl["command"]), statusMarker) {
		cmd := self + statusMarker
		if sl != nil {
			orig, _ := json.Marshal(sl)
			if err := os.MkdirAll(filepath.Dir(origStatusPath()), 0o700); err != nil {
				return err
			}
			if err := os.WriteFile(origStatusPath(), orig, 0o600); err != nil {
				return err
			}
			if c, _ := sl["command"].(string); c != "" {
				cmd += " -- sh -c " + shellQuote(c)
			}
		} else {
			sl = map[string]any{"type": "command"}
		}
		sl["command"] = cmd
		s["statusLine"] = sl
	}
	if err := saveSettings(s, prev); err != nil {
		return err
	}
	fmt.Println("Claude Code integration installed. New and resumed sessions report to the island.")
	return nil
}

func claudeUninstall() error {
	s, prev, err := loadSettings()
	if err != nil || prev == nil {
		return err
	}
	if hooks, _ := s["hooks"].(map[string]any); hooks != nil {
		removeOurHooks(hooks)
		if len(hooks) == 0 {
			delete(s, "hooks")
		}
	}
	if sl, _ := s["statusLine"].(map[string]any); sl != nil && strings.Contains(fmt.Sprint(sl["command"]), statusMarker) {
		var orig map[string]any
		if b, err := os.ReadFile(origStatusPath()); err == nil && json.Unmarshal(b, &orig) == nil {
			s["statusLine"] = orig
		} else {
			delete(s, "statusLine")
		}
	}
	if err := saveSettings(s, prev); err != nil {
		return err
	}
	_ = os.Remove(origStatusPath())
	fmt.Println("Claude Code integration removed.")
	return nil
}

// removeOurHooks drops island hook handlers, leaving everything else intact.
func removeOurHooks(hooks map[string]any) {
	for ev, v := range hooks {
		groups, _ := v.([]any)
		var kept []any
		for _, g := range groups {
			gm, _ := g.(map[string]any)
			hs, _ := gm["hooks"].([]any)
			var keptH []any
			for _, h := range hs {
				hm, _ := h.(map[string]any)
				if c, _ := hm["command"].(string); strings.Contains(c, hookMarker) && strings.Contains(c, "island") {
					continue
				}
				keptH = append(keptH, h)
			}
			if len(keptH) > 0 {
				gm["hooks"] = keptH
				kept = append(kept, gm)
			}
		}
		if len(kept) > 0 {
			hooks[ev] = kept
		} else {
			delete(hooks, ev)
		}
	}
}
