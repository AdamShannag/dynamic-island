package plugins

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/draw"
	"github.com/AdamShannag/dynamic-island/internal/island"
	"github.com/AdamShannag/dynamic-island/internal/settings"
)

const drawActivityID = "draw"

type Draw struct {
	eng *draw.Engine
}

func NewDraw(selfID, selfName, selfAddr string, port int) *Draw {
	return &Draw{eng: draw.NewEngine(selfID, selfName, selfAddr, port)}
}

func (d *Draw) Name() string { return "draw" }

func (d *Draw) Engine() *draw.Engine { return d.eng }

func (d *Draw) Run(ctx context.Context, h island.Host) error {
	h.HandleAction("draw.accept", func() { _ = d.eng.Respond(true) })
	h.HandleAction("draw.decline", func() { _ = d.eng.Respond(false) })

	d.eng.OnChange(func(s draw.State) {
		if !settings.Enabled("draw") || h.Presenting() {
			h.Clear(drawActivityID)
			return
		}
		switch s.Phase {
		case draw.PhaseIdle:
			h.Clear(drawActivityID)
		case draw.PhaseLobby:
			if s.IsHost {
				h.Set(island.Activity{
					ID: drawActivityID, Priority: island.PriorityStatus,
					View: island.View{Kind: "draw", Title: "Draw lobby", Subtitle: drawSummary(s),
						Icon: "applications-graphics-symbolic"},
				})
			} else {
				h.Set(island.Activity{
					ID: drawActivityID, Priority: island.PriorityAlert,
					View: island.View{Kind: "draw", Title: "Draw invite", Subtitle: drawSummary(s),
						Icon: "applications-graphics-symbolic", Accent: "ok"},
				})
			}
		case draw.PhaseDrawing, draw.PhaseReveal:
			h.Set(island.Activity{
				ID: drawActivityID, Priority: island.PriorityStatus,
				View: island.View{Kind: "draw", Title: "Drawing", Subtitle: drawSummary(s),
					Icon: "applications-graphics-symbolic"},
			})
		case draw.PhaseFinished, draw.PhaseHostLeft, draw.PhaseMissed:
			h.Set(island.Activity{
				ID: drawActivityID, Priority: island.PriorityNotify, TTL: 10 * time.Second,
				View: island.View{Kind: "draw", Title: "Draw", Subtitle: drawSummary(s),
					Icon: "applications-graphics-symbolic", Click: "notify.dismiss"},
			})
		}
	})

	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	var lastFailure time.Time
	for {
		select {
		case <-ctx.Done():
			d.eng.Disable()
			return nil
		case <-ticker.C:
			want := settings.Enabled("draw") && !h.Presenting()
			switch {
			case want && !d.eng.Enabled():
				if time.Since(lastFailure) < 10*time.Second {
					continue
				}
				if err := d.eng.Enable(); err != nil {
					log.Printf("draw: enable: %v", err)
					lastFailure = time.Now()
				} else {
					lastFailure = time.Time{}
				}
			case !want && d.eng.Enabled():
				d.eng.Disable()
			}
		}
	}
}

func drawSummary(s draw.State) string {
	switch s.Phase {
	case draw.PhaseLobby:
		ready := 0
		for _, p := range s.Players {
			if p.Status == "accepted" {
				ready++
			}
		}
		return fmt.Sprintf("Draw: %d/%d ready", ready, len(s.Players))
	case draw.PhaseDrawing:
		return fmt.Sprintf("%s is drawing — round %d/%d", s.DrawerName, s.Round, s.TotalRounds)
	case draw.PhaseReveal:
		if s.LastRound != nil {
			return fmt.Sprintf("The word was %q", s.LastRound.Word)
		}
		return "Round over"
	case draw.PhaseHostLeft:
		return "Game ended: host left"
	case draw.PhaseFinished:
		return "Game finished"
	case draw.PhaseMissed:
		return "Game already started"
	default:
		return ""
	}
}
