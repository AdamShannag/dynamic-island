// Package docker wraps the docker CLI for the dashboard's Docker tab.
package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Container struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Image   string `json:"image"`
	State   string `json:"state"`  // running, restarting, ...
	Status  string `json:"status"` // "Up 3 hours (healthy)"
	Ports   string `json:"ports"`  // published host ports, "4222, 8222"
	Project string `json:"project"`
	Stats   *Stats `json:"stats,omitempty"`
}

var hostPort = regexp.MustCompile(`:(\d+)->`)

// List returns running containers sorted by compose project, then name.
func List(ctx context.Context) ([]Container, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "ps", "--format", "{{json .}}").Output()
	if err != nil {
		return nil, classify(err)
	}
	var list []Container
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var raw struct{ ID, Names, Image, State, Status, Ports, Labels string }
		if json.Unmarshal(sc.Bytes(), &raw) != nil {
			continue
		}
		c := Container{ID: raw.ID, Name: raw.Names, Image: raw.Image, State: raw.State, Status: raw.Status}
		seen := map[string]bool{}
		var ports []string
		for _, m := range hostPort.FindAllStringSubmatch(raw.Ports, -1) {
			if !seen[m[1]] {
				seen[m[1]] = true
				ports = append(ports, m[1])
			}
		}
		c.Ports = strings.Join(ports, ", ")
		for _, l := range strings.Split(raw.Labels, ",") {
			if v, ok := strings.CutPrefix(l, "com.docker.compose.project="); ok {
				c.Project = v
			}
		}
		list = append(list, c)
	}
	live := stats.get()
	for i := range list {
		if st, ok := live[list[i].ID]; ok {
			list[i].Stats = &st
		}
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Project != list[j].Project {
			return list[i].Project < list[j].Project
		}
		return list[i].Name < list[j].Name
	})
	return list, nil
}

// Errors the UI can explain. The message is a stable code prefix the
// extension maps to friendly text, followed by the raw detail.
const (
	ErrNotInstalled = "docker-not-installed"
	ErrNotRunning   = "docker-not-running"
	ErrPermission   = "docker-permission"
)

func classify(err error) error {
	if errors.Is(err, exec.ErrNotFound) {
		return fmt.Errorf("%s: docker CLI not found", ErrNotInstalled)
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		msg := strings.TrimSpace(string(ee.Stderr))
		switch low := strings.ToLower(msg); {
		case strings.Contains(low, "permission denied"):
			return fmt.Errorf("%s: %s", ErrPermission, msg)
		case strings.Contains(low, "cannot connect to the docker daemon"), strings.Contains(low, "is the docker daemon running"),
			strings.Contains(low, "no such file or directory"), strings.Contains(low, "connection refused"):
			return fmt.Errorf("%s: %s", ErrNotRunning, msg)
		}
		return fmt.Errorf("%s", msg)
	}
	return err
}

// Act runs start, stop or restart on a container.
func Act(ctx context.Context, id, op string) error {
	switch op {
	case "start", "stop", "restart":
	default:
		return fmt.Errorf("unsupported op %q", op)
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "docker", op, id).CombinedOutput(); err != nil {
		return fmt.Errorf("docker %s: %s", op, strings.TrimSpace(string(out)))
	}
	return nil
}

// ---------- live stats ----------

// Stats is a container's latest resource usage.
type Stats struct {
	CPU    float64 `json:"cpu"`    // percent of one core × cores (docker's CPUPerc)
	Mem    string  `json:"mem"`    // "128MiB"
	MemPct float64 `json:"memPct"` // percent of the limit
}

// statsStream keeps one `docker stats` process running while someone is
// looking (the Docker tab polls List), and stops it after a quiet period.
type statsStream struct {
	mu       sync.Mutex
	byID     map[string]Stats
	lastUsed time.Time
	running  bool
}

var stats = &statsStream{byID: map[string]Stats{}}

const statsIdleStop = 20 * time.Second

var ansi = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)

func (s *statsStream) get() map[string]Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastUsed = time.Now()
	if !s.running {
		s.running = true
		go s.run()
	}
	out := make(map[string]Stats, len(s.byID))
	for k, v := range s.byID {
		out[k] = v
	}
	return out
}

func (s *statsStream) run() {
	defer func() {
		s.mu.Lock()
		s.running = false
		s.byID = map[string]Stats{}
		s.mu.Unlock()
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", "stats", "--format", "{{json .}}")
	out, err := cmd.StdoutPipe()
	if err != nil || cmd.Start() != nil {
		return
	}
	go func() { // stop once nobody has asked for a while
		for range time.Tick(5 * time.Second) {
			s.mu.Lock()
			idle := time.Since(s.lastUsed) > statsIdleStop
			s.mu.Unlock()
			if idle {
				cancel()
				return
			}
		}
	}()
	sc := bufio.NewScanner(out)
	for sc.Scan() {
		line := ansi.ReplaceAllString(sc.Text(), "")
		i := strings.IndexByte(line, '{')
		if i < 0 {
			continue
		}
		var raw struct{ ID, CPUPerc, MemUsage, MemPerc string }
		if json.Unmarshal([]byte(line[i:]), &raw) != nil || raw.ID == "" {
			continue
		}
		st := Stats{
			CPU:    pct(raw.CPUPerc),
			MemPct: pct(raw.MemPerc),
			Mem:    strings.TrimSpace(strings.SplitN(raw.MemUsage, "/", 2)[0]),
		}
		s.mu.Lock()
		s.byID[raw.ID] = st
		s.mu.Unlock()
	}
	_ = cmd.Wait()
}

func pct(s string) float64 {
	v, _ := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(s), "%"), 64)
	return v
}

// ---------- logs ----------

// Logs returns the last n lines of a container's output (stdout+stderr).
func Logs(ctx context.Context, id string, n int) (string, error) {
	if n <= 0 || n > 1000 {
		n = 50
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "logs", "--tail", strconv.Itoa(n), id).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("docker logs: %s", strings.TrimSpace(string(out)))
	}
	if len(out) > 256<<10 {
		out = out[len(out)-256<<10:]
	}
	return strings.ToValidUTF8(ansi.ReplaceAllString(string(out), ""), "�"), nil
}
