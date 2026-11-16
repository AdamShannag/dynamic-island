package plugins

import (
	"context"
	"fmt"
	"log"
	"math"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/island"
	"github.com/AdamShannag/dynamic-island/internal/race"
	"github.com/AdamShannag/dynamic-island/internal/settings"
)

const raceActivityID = "race"

type Race struct {
	eng *race.Engine
}

func NewRace(selfID, selfName, selfAddr string, port int) *Race {
	return &Race{eng: race.NewEngine(selfID, selfName, selfAddr, port)}
}

func (r *Race) Name() string { return "race" }

func (r *Race) Engine() *race.Engine { return r.eng }

func (r *Race) Run(ctx context.Context, h island.Host) error {
	h.HandleAction("race.accept", func() { _ = r.eng.Respond(true) })
	h.HandleAction("race.decline", func() { _ = r.eng.Respond(false) })

	r.eng.OnChange(func(s race.State) {
		if !settings.Enabled("race") || h.Presenting() {
			h.Clear(raceActivityID)
			return
		}
		switch s.Phase {
		case race.PhaseIdle:
			h.Clear(raceActivityID)
		case race.PhaseLobby:
			if s.IsHost {
				h.Set(island.Activity{
					ID: raceActivityID, Priority: island.PriorityStatus,
					View: island.View{Kind: "race", Title: "Race lobby", Subtitle: raceSummary(s),
						Icon: "input-keyboard-symbolic"},
				})
			} else {
				h.Set(island.Activity{
					ID: raceActivityID, Priority: island.PriorityAlert,
					View: island.View{Kind: "race", Title: "Race invite", Subtitle: raceSummary(s),
						Icon: "input-keyboard-symbolic", Accent: "ok"},
				})
			}
		case race.PhaseRacing:
			h.Set(island.Activity{
				ID: raceActivityID, Priority: island.PriorityStatus,
				View: island.View{Kind: "race", Title: "Racing", Subtitle: raceSummary(s),
					Icon: "input-keyboard-symbolic"},
			})
		case race.PhaseFinished, race.PhaseHostLeft:
			h.Set(island.Activity{
				ID: raceActivityID, Priority: island.PriorityNotify, TTL: 10 * time.Second,
				View: island.View{Kind: "race", Title: "Race", Subtitle: raceSummary(s),
					Icon: "input-keyboard-symbolic", Click: "notify.dismiss"},
			})
		}
	})

	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	var lastFailure time.Time
	for {
		select {
		case <-ctx.Done():
			r.eng.Disable()
			return nil
		case <-ticker.C:
			want := settings.Enabled("race") && !h.Presenting()
			switch {
			case want && !r.eng.Enabled():
				if time.Since(lastFailure) < 10*time.Second {
					continue
				}
				if err := r.eng.Enable(); err != nil {
					log.Printf("race: enable: %v", err)
					lastFailure = time.Now()
				} else {
					lastFailure = time.Time{}
				}
			case !want && r.eng.Enabled():
				r.eng.Disable()
			}
		}
	}
}

func raceSummary(s race.State) string {
	switch s.Phase {
	case race.PhaseLobby:
		ready := 0
		for _, racer := range s.Racers {
			if racer.Status == "accepted" {
				ready++
			}
		}
		return fmt.Sprintf("Race: %d/%d ready", ready, len(s.Racers))
	case race.PhaseRacing:
		var sum float64
		for _, racer := range s.Racers {
			sum += racer.Progress
		}
		pct := 0.0
		if len(s.Racers) > 0 {
			pct = sum / float64(len(s.Racers))
		}
		return fmt.Sprintf("Racing — %d%%", int(math.Round(pct*100)))
	case race.PhaseHostLeft:
		return "Race ended: host left"
	case race.PhaseFinished:
		return "Race finished"
	default:
		return ""
	}
}
