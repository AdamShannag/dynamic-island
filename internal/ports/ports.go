package ports

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/docker"
)

type Listener struct {
	Port        int    `json:"port"`
	Addr        string `json:"addr"`
	PID         int    `json:"pid,omitempty"`
	Process     string `json:"process,omitempty"`
	Cmd         string `json:"cmd,omitempty"`
	Container   string `json:"container,omitempty"`
	ContainerID string `json:"containerId,omitempty"`
}

var procRe = regexp.MustCompile(`\("([^"]+)",pid=(\d+)`)

func List(ctx context.Context) ([]Listener, error) {
	socks, err := Sockets(ctx)
	if err != nil {
		return nil, err
	}
	containers := map[int]docker.Container{}
	if list, err := docker.List(ctx); err == nil {
		for _, c := range list {
			for _, p := range strings.Split(c.Ports, ", ") {
				if n, err := strconv.Atoi(p); err == nil {
					containers[n] = c
				}
			}
		}
	}

	for i := range socks {
		if c, ok := containers[socks[i].Port]; ok {
			socks[i].Container, socks[i].ContainerID = c.Name, c.ID
		}
	}
	return socks, nil
}

func Sockets(ctx context.Context) ([]Listener, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ss", "-ltnpH").Output()
	if err != nil {
		return nil, fmt.Errorf("ss: %w", err)
	}
	seen := map[string]bool{}
	var res []Listener
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		local := f[3]
		i := strings.LastIndex(local, ":")
		if i < 0 {
			continue
		}
		port, err := strconv.Atoi(local[i+1:])
		if err != nil {
			continue
		}
		addr := strings.Trim(local[:i], "[]")
		if addr == "*" {
			addr = "0.0.0.0"
		}
		l := Listener{Port: port, Addr: addr}
		if m := procRe.FindStringSubmatch(line); m != nil {
			l.Process = m[1]
			l.PID, _ = strconv.Atoi(m[2])
			l.Cmd = cmdline(l.PID)
		}
		key := fmt.Sprintf("%d/%d", port, l.PID)
		if seen[key] {
			continue
		}
		seen[key] = true
		res = append(res, l)
	}
	sort.Slice(res, func(i, j int) bool { return res[i].Port < res[j].Port })
	return res, nil
}

func cmdline(pid int) string {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return ""
	}
	s := strings.TrimSpace(strings.ReplaceAll(string(b), "\x00", " "))
	if len(s) > 200 {
		s = s[:200] + "…"
	}
	return s
}

func Free(ctx context.Context, port int) (string, error) {
	list, err := List(ctx)
	if err != nil {
		return "", err
	}
	var done []string
	var errs []error
	stopped := map[string]bool{}
	for _, l := range list {
		if l.Port != port {
			continue
		}
		switch {
		case l.ContainerID != "":
			if stopped[l.ContainerID] {
				continue
			}
			stopped[l.ContainerID] = true
			if err := docker.Act(ctx, l.ContainerID, "stop"); err != nil {
				errs = append(errs, err)
			} else {
				done = append(done, "stopped container "+l.Container)
			}
		case l.PID > 1 && l.PID != os.Getpid():
			if err := terminate(l.PID); err != nil {
				errs = append(errs, fmt.Errorf("%s (pid %d): %w", l.Process, l.PID, err))
			} else {
				done = append(done, fmt.Sprintf("killed %s (pid %d)", l.Process, l.PID))
			}
		}
	}
	if len(done) == 0 && len(errs) == 0 {
		return "", fmt.Errorf("nothing you own is listening on port %d (root processes need sudo)", port)
	}
	return strings.Join(done, ", "), errors.Join(errs...)
}

func terminate(pid int) error {
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		return err
	}
	go func() {
		for i := 0; i < 30; i++ {
			time.Sleep(100 * time.Millisecond)
			if syscall.Kill(pid, 0) != nil {
				return
			}
		}
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}()
	return nil
}
