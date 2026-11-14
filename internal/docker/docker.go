// Package docker wraps the docker CLI for the dashboard's Docker tab.
package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strings"
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
}

var hostPort = regexp.MustCompile(`:(\d+)->`)

// List returns running containers sorted by compose project, then name.
func List(ctx context.Context) ([]Container, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "ps", "--format", "{{json .}}").Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return nil, fmt.Errorf("%s", strings.TrimSpace(string(ee.Stderr)))
		}
		return nil, err
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
	sort.Slice(list, func(i, j int) bool {
		if list[i].Project != list[j].Project {
			return list[i].Project < list[j].Project
		}
		return list[i].Name < list[j].Name
	})
	return list, nil
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
