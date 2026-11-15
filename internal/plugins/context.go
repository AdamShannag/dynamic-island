package plugins

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/island"
	"github.com/AdamShannag/dynamic-island/internal/ports"
)

type Context struct {
	mu      sync.Mutex
	tracked map[int]*tracked
	bootT   time.Time
	tick    int

	procs   map[int]*procInfo
	notMine map[int]bool
}

func NewContext() *Context {
	return &Context{tracked: map[int]*tracked{}, procs: map[int]*procInfo{}, notMine: map[int]bool{}}
}

const (
	fullScanEvery = 15
	youngFor      = 5 * time.Second
)

func (c *Context) Name() string { return "context" }

type kind int

const (
	kindTask kind = iota
	kindRun
)

type tracked struct {
	pid     int
	title   string
	kind    kind
	app     string
	ide     bool
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

	classified bool
	title      string
	kind       kind
	match      bool
}

const (
	scanEvery     = time.Second
	showAfter     = 1200 * time.Millisecond
	reportAfter   = 3 * time.Second
	portScanEvery = 3
)

func (c *Context) Run(ctx context.Context, h island.Host) error {
	c.bootT = bootTime()
	t := time.NewTicker(scanEvery)
	defer t.Stop()
	for {
		c.scan()
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

func (c *Context) scan() {
	c.tick++
	procs := c.refreshProcs()
	seen := map[int]bool{}
	for _, p := range procs {
		if !p.classified {
			p.title, p.kind, p.match = classify(p, procs)
			p.classified = true
		}
		if !p.match || hasAncestor(p, procs, "island") {
			continue
		}
		seen[p.pid] = true
		if c.tracked[p.pid] == nil {
			t := &tracked{pid: p.pid, title: p.title, kind: p.kind, start: c.startTime(p), project: projectOf(p.pid)}
			t.app, t.ide, t.focus = launcher(p, procs)
			c.mu.Lock()
			c.tracked[p.pid] = t
			c.mu.Unlock()
		}
	}

	if c.tick%portScanEvery == 1 {
		c.updatePorts(procs)
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	for pid, t := range c.tracked {
		if !seen[pid] {
			delete(c.tracked, pid)
			continue
		}
		if time.Since(t.start) >= showAfter {
			t.shown = true
		}
	}
}

type Item struct {
	PID       int    `json:"pid"`
	Title     string `json:"title"`
	Kind      string `json:"kind"`
	State     string `json:"state"`
	App       string `json:"app,omitempty"`
	Project   string `json:"project,omitempty"`
	StartedAt int64  `json:"startedAt"`
	Ports     []int  `json:"ports,omitempty"`
	Focus     []int  `json:"focus,omitempty"`
}

func (c *Context) List() []Item {
	c.mu.Lock()
	defer c.mu.Unlock()
	item := func(t *tracked, state string) Item {
		it := Item{
			PID: t.pid, Title: t.title, Kind: "task", State: state, App: t.app, Project: t.project,
			StartedAt: island.UnixMs(t.start), Ports: append([]int(nil), t.ports...), Focus: t.focus,
		}
		if t.kind == kindRun {
			it.Kind = "service"
		}
		return it
	}
	out := []Item{}
	for _, t := range c.tracked {
		if t.shown {
			out = append(out, item(t, "running"))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt > out[j].StartedAt })
	return out
}

func (c *Context) updatePorts(procs map[int]*procInfo) {
	var runs []*tracked
	c.mu.Lock()
	for _, t := range c.tracked {
		if t.kind == kindRun {
			runs = append(runs, t)
		}
	}
	c.mu.Unlock()
	if len(runs) == 0 {
		return
	}
	socks, err := ports.Sockets(context.Background())
	if err != nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
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

var goTaskCmds = map[string]bool{"build": true, "test": true, "mod": true, "generate": true, "install": true, "vet": true, "get": true, "work": true}
var mavenRunGoals = []string{"spring-boot:run", "quarkus:dev", "jetty:run", "tomcat7:run", "exec:java"}
var gradleRunTasks = []string{"bootRun", "run", "quarkusDev", "appRun"}

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
		var targets []string
		for i := 1; i < len(args) && len(targets) < 2; i++ {
			switch a := args[i]; {
			case a == "-C" || a == "-f" || a == "--directory" || a == "--file":
				i++
			case !strings.HasPrefix(a, "-") && !strings.Contains(a, "="):
				targets = append(targets, a)
			}
		}
		return strings.TrimSpace("make " + strings.Join(targets, " ")), kindTask, true
	case "docker":
		w := words(1, 2)
		switch {
		case len(w) > 0 && (w[0] == "build" || w[0] == "push" || w[0] == "pull"):
			return "docker " + w[0], kindTask, true
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

func (c *Context) refreshProcs() map[int]*procInfo {
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return c.procs
	}
	full := c.tick%fullScanEvery == 1
	uid := uint32(os.Getuid())
	alive := make(map[int]bool, len(ents))
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		alive[pid] = true
		if !full {
			if c.notMine[pid] {
				continue
			}
			if p := c.procs[pid]; p != nil && time.Since(c.startTime(p)) > youngFor {
				continue
			}
		}
		info, mine := readProc(pid, uid)
		if !mine {
			c.notMine[pid] = true
			delete(c.procs, pid)
			continue
		}
		if info == nil {
			continue
		}
		if old := c.procs[pid]; old != nil && old.startTick == info.startTick && equalArgs(old.args, info.args) {
			continue
		}
		c.procs[pid] = info
		for _, q := range c.procs {
			if q.ppid == pid {
				q.classified = false
			}
		}
	}
	for pid := range c.procs {
		if !alive[pid] {
			delete(c.procs, pid)
		}
	}
	for pid := range c.notMine {
		if !alive[pid] {
			delete(c.notMine, pid)
		}
	}
	return c.procs
}

func readProc(pid int, uid uint32) (*procInfo, bool) {
	dir := "/proc/" + strconv.Itoa(pid)
	st, err := os.Stat(dir)
	if err != nil {
		return nil, true
	}
	if st.Sys().(*syscall.Stat_t).Uid != uid {
		return nil, false
	}
	stat, err := os.ReadFile(dir + "/stat")
	if err != nil {
		return nil, true
	}
	s := string(stat)
	l, r := strings.IndexByte(s, '('), strings.LastIndexByte(s, ')')
	if l < 0 || r < l {
		return nil, true
	}
	fields := strings.Fields(s[r+1:])
	if len(fields) < 20 {
		return nil, true
	}
	ppid, _ := strconv.Atoi(fields[1])
	startTick, _ := strconv.ParseUint(fields[19], 10, 64)
	cmd, _ := os.ReadFile(dir + "/cmdline")
	args := strings.Split(strings.TrimRight(string(cmd), "\x00"), "\x00")
	if len(args) == 1 && args[0] == "" {
		args = nil
	}
	return &procInfo{pid: pid, ppid: ppid, comm: s[l+1 : r], args: args, startTick: startTick}, true
}

func equalArgs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

const clkTck = 100

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
