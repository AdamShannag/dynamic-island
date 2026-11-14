package plugins

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"go-island/internal/island"
	"go-island/internal/ports"
)

// Context makes the island aware of what you're doing: it watches your
// processes for dev tools (go, maven, gradle, npm, cargo, make, docker,
// pytest, IDE run configurations) and shows them with the app that launched
// them (GoLand, IntelliJ, VS Code, a terminal, a coding agent). Clicking
// focuses that app's window.
//
// Linux gives no way to read an unrelated process's exit status, so finished
// tasks are reported as "Finished", not passed/failed. (`island run` and the
// shell hook do know exit codes.)
type Context struct {
	tracked map[int]*tracked
	bootT   time.Time
	tick    int
}

func NewContext() *Context { return &Context{tracked: map[int]*tracked{}} }

func (c *Context) Name() string { return "context" }

type kind int

const (
	kindTask kind = iota // builds, tests, installs: show elapsed, report when done
	kindRun              // dev servers / run configs: show as a service while alive
)

type tracked struct {
	pid     int
	title   string
	kind    kind
	app     string
	ide     bool // launched from an IDE (completion is reported)
	project string
	start   time.Time
	focus   []int
	ports   []int
	shown   bool
}

type procInfo struct {
	pid, ppid int
	comm      string
	args      []string
	startTick uint64
}

const (
	scanEvery     = time.Second
	showAfter     = 1200 * time.Millisecond // ignore blips like `go version`
	reportAfter   = 3 * time.Second         // only report tasks that took a while
	portScanEvery = 3                       // scans
)

func (c *Context) Run(ctx context.Context, h island.Host) error {
	c.bootT = bootTime()
	defer h.ClearPrefix("ctx.")
	t := time.NewTicker(scanEvery)
	defer t.Stop()
	for {
		c.scan(h)
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

func (c *Context) scan(h island.Host) {
	c.tick++
	procs := readProcs()
	seen := map[int]bool{}
	for _, p := range procs {
		title, k, ok := classify(p, procs)
		if !ok {
			continue
		}
		if hasAncestor(p, procs, "island") {
			continue // `island run` already shows it
		}
		seen[p.pid] = true
		if c.tracked[p.pid] == nil {
			t := &tracked{pid: p.pid, title: title, kind: k, start: c.startTime(p), project: projectOf(p.pid)}
			t.app, t.ide, t.focus = launcher(p, procs)
			c.tracked[p.pid] = t
		}
	}

	// Ports for long-running processes (and their children, e.g. `go run`).
	if c.tick%portScanEvery == 1 {
		c.updatePorts(procs)
	}

	for pid, t := range c.tracked {
		id := fmt.Sprintf("ctx.%d", pid)
		if !seen[pid] {
			delete(c.tracked, pid)
			h.Clear(id)
			took := time.Since(t.start)
			// Report IDE-launched tasks. Terminal commands are reported by the
			// shell hook (with the exit code); agents run lots of commands, so
			// their individual completions would just be noise.
			if t.kind == kindTask && t.shown && t.ide && took >= reportAfter {
				h.Set(island.Activity{
					ID: "notify.ctx." + strconv.Itoa(pid), Priority: island.PriorityNotify, TTL: 5 * time.Second,
					View: island.View{
						Kind: "notify", Title: "Finished " + t.title,
						Subtitle: joinNonEmpty(" · ", t.project, island.FormatDuration(took), t.app),
						Icon:     "object-select-symbolic", Click: "notify.dismiss", Focus: t.focus,
					},
				})
			}
			continue
		}
		if time.Since(t.start) < showAfter {
			continue
		}
		t.shown = true
		h.Set(c.activity(id, t))
	}
}

func (c *Context) activity(id string, t *tracked) island.Activity {
	v := island.View{
		Title:     t.title,
		Subtitle:  joinNonEmpty(" · ", t.project, t.app),
		Focus:     t.focus,
		StartedAt: island.UnixMs(t.start),
	}
	prio := island.PriorityTask
	if t.kind == kindRun {
		v.Kind, v.Icon, v.StartedAt = "service", "network-server-symbolic", 0
		if len(t.ports) > 0 {
			ps := make([]string, len(t.ports))
			for i, p := range t.ports {
				ps[i] = ":" + strconv.Itoa(p)
			}
			v.Trailing = strings.Join(ps, " ")
			v.URL = "http://localhost:" + strconv.Itoa(t.ports[0])
		}
		prio = island.PriorityService
	} else {
		v.Kind, v.Icon = "task", "system-run-symbolic"
	}
	return island.Activity{ID: id, Priority: prio, View: v}
}

func (c *Context) updatePorts(procs map[int]*procInfo) {
	var runs []*tracked
	for _, t := range c.tracked {
		if t.kind == kindRun {
			runs = append(runs, t)
		}
	}
	if len(runs) == 0 {
		return
	}
	socks, err := ports.Sockets(context.Background())
	if err != nil {
		return
	}
	for _, t := range runs {
		t.ports = t.ports[:0]
		seen := map[int]bool{}
		for _, s := range socks {
			if s.PID != 0 && !seen[s.Port] && (s.PID == t.pid || hasAncestorPID(procs[s.PID], procs, t.pid)) {
				seen[s.Port] = true
				t.ports = append(t.ports, s.Port)
			}
		}
	}
}

// ---------- classification ----------

var goTaskCmds = map[string]bool{"build": true, "test": true, "mod": true, "generate": true, "install": true, "vet": true, "get": true, "work": true}
var mavenRunGoals = []string{"spring-boot:run", "quarkus:dev", "jetty:run", "tomcat7:run", "exec:java"}
var gradleRunTasks = []string{"bootRun", "run", "quarkusDev", "appRun"}

// classify decides whether a process is a dev command worth showing.
func classify(p *procInfo, procs map[int]*procInfo) (string, kind, bool) {
	if len(p.args) == 0 {
		return "", 0, false
	}
	base := filepath.Base(p.args[0])
	words := func(from int, n int) []string {
		var out []string
		for _, a := range p.args[min(from, len(p.args)):] {
			if strings.HasPrefix(a, "-") {
				continue
			}
			out = append(out, a)
			if len(out) == n {
				break
			}
		}
		return out
	}
	// A wrapper's child repeats the work (e.g. `go run` → compiled binary,
	// `npm run dev` → node vite); only the outermost tool counts.
	if parent := procs[p.ppid]; parent != nil {
		if _, _, ok := classifyShallow(parent); ok {
			return "", 0, false
		}
	}
	return classifyArgs(p, base, words)
}

func classifyShallow(p *procInfo) (string, kind, bool) {
	if len(p.args) == 0 {
		return "", 0, false
	}
	base := filepath.Base(p.args[0])
	words := func(from int, n int) []string {
		var out []string
		for _, a := range p.args[min(from, len(p.args)):] {
			if !strings.HasPrefix(a, "-") {
				out = append(out, a)
				if len(out) == n {
					break
				}
			}
		}
		return out
	}
	return classifyArgs(p, base, words)
}

func classifyArgs(p *procInfo, base string, words func(int, int) []string) (string, kind, bool) {
	args := p.args
	switch base {
	case "go":
		w := words(1, 3)
		if len(w) == 0 {
			return "", 0, false
		}
		if w[0] == "run" {
			return "go run " + strings.Join(w[1:], " "), kindRun, true
		}
		if goTaskCmds[w[0]] {
			return "go " + strings.Join(w, " "), kindTask, true
		}
	case "cargo":
		w := words(1, 2)
		if len(w) > 0 {
			switch w[0] {
			case "run":
				return "cargo run", kindRun, true
			case "build", "test", "check", "clippy", "install", "bench":
				return "cargo " + strings.Join(w, " "), kindTask, true
			}
		}
	case "make":
		return strings.TrimSpace("make " + strings.Join(words(1, 2), " ")), kindTask, true
	case "docker":
		w := words(1, 2)
		switch {
		case len(w) > 0 && (w[0] == "build" || w[0] == "push" || w[0] == "pull"):
			return "docker " + w[0], kindTask, true // later words may be flag values
		case len(w) > 1 && w[0] == "compose" && (w[1] == "build" || w[1] == "pull"):
			return "docker compose " + w[1], kindTask, true
		}
	case "pytest":
		return "pytest", kindTask, true
	case "uvicorn", "gunicorn", "flask":
		return base, kindRun, true
	case "npm", "pnpm", "yarn", "bun", "npx":
		return jsTool(base, words(1, 2))
	case "node":
		if len(args) > 1 {
			if tool := filepath.Base(args[1]); tool == "npm" || tool == "npm-cli.js" || tool == "pnpm" || tool == "pnpm.cjs" || tool == "yarn" || tool == "yarn.js" {
				return jsTool(strings.TrimSuffix(strings.TrimSuffix(tool, ".cjs"), ".js"), words(2, 2))
			}
		}
	case "python", "python3":
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "-m pytest"):
			return "pytest", kindTask, true
		case strings.Contains(joined, "manage.py runserver"):
			return "django runserver", kindRun, true
		case strings.Contains(joined, "-m uvicorn"):
			return "uvicorn", kindRun, true
		}
	case "java":
		return javaTool(args)
	}
	// Binaries started by a JetBrains Go run configuration.
	if strings.HasPrefix(base, "___") && strings.Contains(base, "go_build") {
		name := base[strings.LastIndex(base, "_")+1:]
		return "run " + name, kindRun, true
	}
	return "", 0, false
}

func jsTool(tool string, w []string) (string, kind, bool) {
	if tool == "npm-cli" {
		tool = "npm"
	}
	if len(w) == 0 {
		return "", 0, false
	}
	title := tool + " " + strings.Join(w, " ")
	script := w[len(w)-1]
	if w[0] == "run" || w[0] == "start" || w[0] == "dev" {
		switch script {
		case "dev", "start", "serve", "preview", "watch":
			return title, kindRun, true
		}
	}
	switch w[0] {
	case "install", "i", "ci", "add", "build", "test", "run", "exec", "update", "upgrade":
		return title, kindTask, true
	}
	return "", 0, false
}

func javaTool(args []string) (string, kind, bool) {
	for i, a := range args {
		switch a {
		case "org.codehaus.plexus.classworlds.launcher.Launcher", "org.codehaus.classworlds.Launcher":
			goals := nonFlags(args[i+1:], 3)
			title := strings.TrimSpace("mvn " + strings.Join(goals, " "))
			for _, g := range goals {
				for _, r := range mavenRunGoals {
					if g == r {
						return title, kindRun, true
					}
				}
			}
			return title, kindTask, true
		case "org.gradle.wrapper.GradleWrapperMain", "org.gradle.launcher.GradleMain":
			tasks := nonFlags(args[i+1:], 3)
			title := strings.TrimSpace("gradle " + strings.Join(tasks, " "))
			for _, t := range tasks {
				for _, r := range gradleRunTasks {
					if strings.HasSuffix(t, r) {
						return title, kindRun, true
					}
				}
			}
			return title, kindTask, true
		}
	}
	// A JetBrains run configuration: the IDE injects idea_rt.jar.
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "idea_rt.jar") {
		main := ""
		skip := false
		for _, a := range args[1:] {
			if skip {
				skip = false
				continue
			}
			if a == "-classpath" || a == "-cp" || a == "-p" || a == "--module-path" {
				skip = true
				continue
			}
			if !strings.HasPrefix(a, "-") {
				main = a
				break
			}
		}
		if main != "" {
			if i := strings.LastIndex(main, "."); i >= 0 && !strings.HasSuffix(main, ".jar") {
				main = main[i+1:]
			}
			return "run " + strings.TrimSuffix(filepath.Base(main), ".jar"), kindRun, true
		}
	}
	return "", 0, false
}

func nonFlags(args []string, n int) []string {
	var out []string
	for _, a := range args {
		if !strings.HasPrefix(a, "-") {
			out = append(out, a)
			if len(out) == n {
				break
			}
		}
	}
	return out
}

// ---------- launcher / ancestry ----------

var apps = []struct{ comm, name string }{
	{"claude", "Claude Code"},
	{"goland", "GoLand"}, {"idea", "IntelliJ IDEA"}, {"webstorm", "WebStorm"}, {"pycharm", "PyCharm"},
	{"clion", "CLion"}, {"rider", "Rider"}, {"rustrover", "RustRover"}, {"phpstorm", "PhpStorm"},
	{"code", "VS Code"}, {"cursor", "Cursor"}, {"zed", "Zed"}, {"zed-editor", "Zed"},
	{"gnome-terminal-", "Terminal"}, {"ptyxis", "Terminal"}, {"kgx", "Console"}, {"kitty", "Kitty"},
	{"alacritty", "Alacritty"}, {"wezterm-gui", "WezTerm"}, {"konsole", "Konsole"}, {"tilix", "Tilix"},
	{"terminator", "Terminator"}, {"ghostty", "Ghostty"}, {"warp", "Warp"},
}

var ideComms = map[string]bool{
	"goland": true, "idea": true, "webstorm": true, "pycharm": true, "clion": true, "rider": true,
	"rustrover": true, "phpstorm": true, "code": true, "cursor": true, "zed": true, "zed-editor": true,
}

// launcher finds the nearest app ancestor and returns its name, whether it
// is an IDE, and every ancestor pid (the UI focuses the first with a window).
func launcher(p *procInfo, procs map[int]*procInfo) (string, bool, []int) {
	name, ide := "", false
	var chain []int
	cur := procs[p.ppid]
	for i := 0; cur != nil && i < 40; i++ {
		chain = append(chain, cur.pid)
		if name == "" {
			for _, a := range apps {
				if cur.comm == a.comm {
					name, ide = a.name, ideComms[a.comm]
				}
			}
		}
		cur = procs[cur.ppid]
	}
	return name, ide, chain
}

func hasAncestor(p *procInfo, procs map[int]*procInfo, comm string) bool {
	for cur, i := procs[p.ppid], 0; cur != nil && i < 40; cur, i = procs[cur.ppid], i+1 {
		if cur.comm == comm {
			return true
		}
	}
	return false
}

func hasAncestorPID(p *procInfo, procs map[int]*procInfo, pid int) bool {
	for i := 0; p != nil && i < 40; p, i = procs[p.ppid], i+1 {
		if p.ppid == pid {
			return true
		}
	}
	return false
}

func projectOf(pid int) string {
	cwd, err := os.Readlink(fmt.Sprintf("/proc/%d/cwd", pid))
	if err != nil || cwd == "/" || cwd == os.Getenv("HOME") {
		return ""
	}
	return filepath.Base(cwd)
}

func joinNonEmpty(sep string, parts ...string) string {
	var out []string
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, sep)
}

// ---------- /proc ----------

// readProcs reads this user's processes: pid, ppid, comm, argv, start time.
func readProcs() map[int]*procInfo {
	out := map[int]*procInfo{}
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return out
	}
	uid := uint32(os.Getuid())
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		dir := "/proc/" + e.Name()
		if st, err := os.Stat(dir); err != nil || st.Sys().(*syscall.Stat_t).Uid != uid {
			continue
		}
		stat, err := os.ReadFile(dir + "/stat")
		if err != nil {
			continue
		}
		// comm is in parens and may contain spaces; fields follow the last ')'.
		s := string(stat)
		l, r := strings.IndexByte(s, '('), strings.LastIndexByte(s, ')')
		if l < 0 || r < l {
			continue
		}
		fields := strings.Fields(s[r+1:])
		if len(fields) < 20 {
			continue
		}
		ppid, _ := strconv.Atoi(fields[1])
		startTick, _ := strconv.ParseUint(fields[19], 10, 64)
		cmd, _ := os.ReadFile(dir + "/cmdline")
		args := strings.Split(strings.TrimRight(string(cmd), "\x00"), "\x00")
		if len(args) == 1 && args[0] == "" {
			args = nil
		}
		out[pid] = &procInfo{pid: pid, ppid: ppid, comm: s[l+1 : r], args: args, startTick: startTick}
	}
	return out
}

const clkTck = 100 // USER_HZ; 100 on all mainstream Linux builds

func (c *Context) startTime(p *procInfo) time.Time {
	if c.bootT.IsZero() {
		return time.Now()
	}
	return c.bootT.Add(time.Duration(p.startTick) * time.Second / clkTck)
}

func bootTime() time.Time {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return time.Time{}
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "btime "); ok {
			if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
				return time.Unix(n, 0)
			}
		}
	}
	return time.Time{}
}
