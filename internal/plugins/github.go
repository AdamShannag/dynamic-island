package plugins

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"go-island/internal/island"
)

// GitHub watches GitHub Actions runs (via the `gh` CLI) for the configured
// repos: a background chip while runs are in progress, and an alert when
// one finishes. Clicking opens the run in the browser.
type GitHub struct {
	repos    []string
	onlyMine bool
	interval time.Duration

	mu         sync.Mutex
	doneURL    string
	runningURL string
}

func NewGitHub(repos []string, onlyMine bool, intervalSec int) *GitHub {
	if intervalSec <= 0 {
		intervalSec = 60
	}
	return &GitHub{repos: repos, onlyMine: onlyMine, interval: time.Duration(intervalSec) * time.Second}
}

func (g *GitHub) Name() string { return "github" }

type ghRun struct {
	ID           int64     `json:"databaseId"`
	Status       string    `json:"status"`
	Conclusion   string    `json:"conclusion"`
	DisplayTitle string    `json:"displayTitle"`
	WorkflowName string    `json:"workflowName"`
	HeadBranch   string    `json:"headBranch"`
	URL          string    `json:"url"`
	CreatedAt    time.Time `json:"createdAt"`
	repo         string
}

func (g *GitHub) Run(ctx context.Context, h island.Host) error {
	if len(g.repos) == 0 {
		<-ctx.Done() // nothing configured
		return nil
	}
	if _, err := exec.LookPath("gh"); err != nil {
		log.Printf("github: gh CLI not found; plugin idle")
		<-ctx.Done()
		return nil
	}
	h.HandleAction("github.open", func() { g.open(h, &g.doneURL) })
	h.HandleAction("github.open-running", func() { g.open(h, &g.runningURL) })

	user := ""
	if g.onlyMine {
		out, err := exec.CommandContext(ctx, "gh", "api", "user", "--jq", ".login").Output()
		if err != nil {
			return fmt.Errorf("gh api user: %w", err)
		}
		user = strings.TrimSpace(string(out))
	}

	defer h.Clear("ci.running")
	started := time.Now()
	seen := map[int64]string{} // run id -> last status
	first := true
	for {
		var running []ghRun
		for _, repo := range g.repos {
			runs, err := g.list(ctx, repo, user)
			if err != nil {
				if ctx.Err() != nil {
					return nil
				}
				log.Printf("github: %s: %v", repo, err)
				continue
			}
			for _, r := range runs {
				prev, known := seen[r.ID]
				seen[r.ID] = r.Status
				if r.Status != "completed" {
					running = append(running, r)
					continue
				}
				finishedNow := (known && prev != "completed") ||
					(!known && !first && r.CreatedAt.After(started))
				if finishedNow {
					g.alert(h, r)
				}
			}
		}
		first = false
		g.showRunning(h, running)

		wait := g.interval
		if len(running) > 0 {
			wait = 20 * time.Second
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
	}
}

func (g *GitHub) list(ctx context.Context, repo, user string) ([]ghRun, error) {
	args := []string{"run", "list", "-R", repo, "-L", "10", "--json",
		"databaseId,status,conclusion,displayTitle,workflowName,headBranch,url,createdAt"}
	if user != "" {
		args = append(args, "-u", user)
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, "gh", args...).Output()
	if err != nil {
		return nil, err
	}
	var runs []ghRun
	if err := json.Unmarshal(out, &runs); err != nil {
		return nil, err
	}
	for i := range runs {
		runs[i].repo = repo
	}
	return runs, nil
}

func (g *GitHub) alert(h island.Host, r ghRun) {
	v := island.View{
		Kind: "ci", Subtitle: r.WorkflowName + " · " + r.HeadBranch, Trailing: shortRepo(r.repo),
		Click: "github.open",
	}
	ttl := 10 * time.Second
	switch r.Conclusion {
	case "success":
		v.Title, v.Icon, v.Accent = "CI passed", "emblem-ok-symbolic", "ok"
	case "cancelled", "skipped":
		v.Title, v.Icon, v.Accent = "CI "+r.Conclusion, "process-stop-symbolic", "warn"
	default:
		v.Title, v.Icon, v.Accent = "CI failed", "dialog-error-symbolic", "error"
		ttl = 30 * time.Second
	}
	g.mu.Lock()
	g.doneURL = r.URL
	g.mu.Unlock()
	h.Set(island.Activity{ID: "ci.done." + strconv.FormatInt(r.ID, 10), Priority: island.PriorityAlert, TTL: ttl, View: v})
}

func (g *GitHub) showRunning(h island.Host, running []ghRun) {
	if len(running) == 0 {
		h.Clear("ci.running")
		return
	}
	r := running[0]
	title := "CI running"
	if len(running) > 1 {
		title = fmt.Sprintf("%d CI runs", len(running))
	}
	g.mu.Lock()
	g.runningURL = r.URL
	g.mu.Unlock()
	h.Set(island.Activity{ID: "ci.running", Priority: island.PriorityCI, View: island.View{
		Kind: "ci", Title: title, Subtitle: r.WorkflowName + " · " + r.HeadBranch,
		Icon: "emblem-synchronizing-symbolic", StartedAt: island.UnixMs(r.CreatedAt),
		Click: "github.open-running",
	}})
}

func (g *GitHub) open(h island.Host, url *string) {
	g.mu.Lock()
	u := *url
	g.mu.Unlock()
	if u != "" {
		_ = exec.Command("xdg-open", u).Start()
	}
	h.ClearPrefix("ci.done.")
}

func shortRepo(r string) string {
	if i := strings.LastIndex(r, "/"); i >= 0 {
		return r[i+1:]
	}
	return r
}
