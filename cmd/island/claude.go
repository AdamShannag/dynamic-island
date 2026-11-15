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

	"github.com/AdamShannag/dynamic-island/internal/dbusapi"
	"github.com/AdamShannag/dynamic-island/internal/paths"

	"github.com/godbus/dbus/v5"
)

func claudeCmd(args []string) int {
	if len(args) == 0 {
		usage()
	}
	switch args[0] {
	case "hook":
		claudeHook()
		return 0
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

func send(method string, args ...any) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return
	}
	defer conn.Close()
	obj := conn.Object(dbusapi.BusName, dbusapi.Path)
	obj.Go(dbusapi.Iface+"."+method, dbus.FlagNoReplyExpected, nil, args...)
}

func claudeHook() {
	data, err := io.ReadAll(io.LimitReader(os.Stdin, 4<<20))
	if err != nil || len(data) == 0 {
		return
	}
	send("AgentEvent", string(data), ancestors())
}

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
	return paths.DataFile("claude-statusline.orig.json")
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
		backup := settingsPath() + ".bak-dynamic-island-" + time.Now().Format("20060102-150405")
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

func selfPath() (string, error) {
	return os.Executable()
}

func isOurCommand(cmd, marker string) bool {
	i := strings.Index(cmd, marker)
	if i <= 0 {
		return false
	}
	bin := strings.Trim(strings.TrimSpace(cmd[:i]), "'\"")
	return strings.Contains(filepath.Base(bin), "island")
}

func claudeInstall() error {
	self, err := selfPath()
	if err != nil {
		return err
	}
	if err := paths.Migrate(); err != nil {
		fmt.Fprintln(os.Stderr, "island: migrating data:", err)
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

	sl, _ := s["statusLine"].(map[string]any)
	if c, _ := sl["command"].(string); sl != nil && isOurCommand(c, statusMarker) {
		sl["command"] = self + c[strings.Index(c, statusMarker):]
	} else {
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
	if err := paths.Migrate(); err != nil {
		fmt.Fprintln(os.Stderr, "island: migrating data:", err)
	}
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
	if sl, _ := s["statusLine"].(map[string]any); sl != nil && isOurCommand(fmt.Sprint(sl["command"]), statusMarker) {
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
				if c, _ := hm["command"].(string); isOurCommand(c, hookMarker) {
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
