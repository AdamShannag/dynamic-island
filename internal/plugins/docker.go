package plugins

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"time"

	"go-island/internal/island"
)

// Docker alerts when a container crashes (non-zero exit that wasn't a
// `docker stop`/`kill`), turns unhealthy, or gets OOM-killed.
type Docker struct{ seq int }

func NewDocker() *Docker { return &Docker{} }

func (d *Docker) Name() string { return "docker" }

type dockerEvent struct {
	Action string `json:"Action"`
	Actor  struct {
		Attributes map[string]string `json:"Attributes"`
	} `json:"Actor"`
}

func (d *Docker) Run(ctx context.Context, h island.Host) error {
	if _, err := exec.LookPath("docker"); err != nil {
		log.Printf("docker: CLI not found; plugin idle")
		<-ctx.Done()
		return nil
	}
	cmd := exec.CommandContext(ctx, "docker", "events", "--format", "{{json .}}",
		"--filter", "type=container",
		"--filter", "event=die", "--filter", "event=kill",
		"--filter", "event=oom", "--filter", "event=health_status")
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	killed := map[string]time.Time{} // container -> when it was deliberately killed/stopped
	sc := bufio.NewScanner(out)
	for sc.Scan() {
		var ev dockerEvent
		if json.Unmarshal(sc.Bytes(), &ev) != nil {
			continue
		}
		name := ev.Actor.Attributes["name"]
		var title, sub string
		switch {
		case ev.Action == "kill":
			killed[name] = time.Now()
			continue
		case ev.Action == "die":
			code := ev.Actor.Attributes["exitCode"]
			t, wasKilled := killed[name]
			delete(killed, name)
			if code == "0" || (wasKilled && time.Since(t) < 30*time.Second) {
				continue
			}
			title, sub = "Container crashed", fmt.Sprintf("%s · exit %s", name, code)
		case ev.Action == "oom":
			title, sub = "Container out of memory", name
		case strings.HasPrefix(ev.Action, "health_status") && strings.HasSuffix(ev.Action, "unhealthy"):
			title, sub = "Container unhealthy", name
		default:
			continue
		}
		d.seq++
		h.Set(island.Activity{
			ID: fmt.Sprintf("notify.docker.%d", d.seq), Priority: island.PriorityAlert, TTL: 12 * time.Second,
			View: island.View{Kind: "notify", Title: title, Subtitle: sub, Trailing: "docker",
				Icon: "dialog-error-symbolic", Accent: "error", Click: "notify.dismiss"},
		})
	}
	if err := cmd.Wait(); err != nil && ctx.Err() == nil {
		return fmt.Errorf("docker events: %w", err)
	}
	if ctx.Err() == nil {
		return fmt.Errorf("docker events stream ended")
	}
	return nil
}
