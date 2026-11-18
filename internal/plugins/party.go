package plugins

import (
	"context"
	"fmt"
	"log"
	"math"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/island"
	"github.com/AdamShannag/dynamic-island/internal/party"
	"github.com/AdamShannag/dynamic-island/internal/settings"
)

const partyActivityID = "party"

type Party struct {
	eng *party.Engine
}

func NewParty(selfID, selfName, selfAddr string, port int) *Party {
	return &Party{eng: party.NewEngine(selfID, selfName, selfAddr, port)}
}

func (p *Party) Name() string { return "play" }

func (p *Party) Engine() *party.Engine { return p.eng }

func (p *Party) Run(ctx context.Context, h island.Host) error {
	h.HandleAction("party.accept", func() { _ = p.eng.Respond(true) })
	h.HandleAction("party.decline", func() { _ = p.eng.Respond(false) })

	p.eng.OnChange(func(s party.State) {
		if !settings.Enabled("play") || h.Presenting() {
			h.Clear(partyActivityID)
			return
		}
		switch s.Phase {
		case party.PhaseIdle:
			h.Clear(partyActivityID)
		case party.PhaseLobby:
			if s.IsHost {
				h.Set(island.Activity{
					ID: partyActivityID, Priority: island.PriorityStatus,
					View: island.View{Kind: "party", Title: "Lobby", Subtitle: lobbySummary(s),
						Icon: "input-keyboard-symbolic"},
				})
			} else {
				h.Set(island.Activity{
					ID: partyActivityID, Priority: island.PriorityAlert,
					View: island.View{Kind: "party", Title: "Invite", Subtitle: lobbySummary(s),
						Icon: "input-keyboard-symbolic", Accent: "ok"},
				})
			}
		case party.PhasePlaying:
			h.Set(island.Activity{
				ID: partyActivityID, Priority: island.PriorityStatus,
				View: island.View{Kind: "party", Title: playingTitle(s), Subtitle: playingSummary(s),
					Icon: "input-keyboard-symbolic"},
			})
		case party.PhaseFinished, party.PhaseHostLeft, party.PhaseMissed:
			h.Set(island.Activity{
				ID: partyActivityID, Priority: island.PriorityNotify, TTL: 10 * time.Second,
				View: island.View{Kind: "party", Title: "Play", Subtitle: endSummary(s),
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
			p.eng.Disable()
			return nil
		case <-ticker.C:
			want := settings.Enabled("play") && !h.Presenting()
			switch {
			case want && !p.eng.Enabled():
				if time.Since(lastFailure) < 10*time.Second {
					continue
				}
				if err := p.eng.Enable(); err != nil {
					log.Printf("party: enable: %v", err)
					lastFailure = time.Now()
				} else {
					lastFailure = time.Time{}
				}
			case !want && p.eng.Enabled():
				p.eng.Disable()
			}
		}
	}
}

func lobbySummary(s party.State) string {
	ready := 0
	for _, pl := range s.Players {
		if pl.Status == "accepted" {
			ready++
		}
	}
	return fmt.Sprintf("Lobby: %d/%d ready", ready, len(s.Players))
}

func playingTitle(s party.State) string {
	switch s.Mode {
	case party.ModeRace:
		return "Racing"
	case party.ModeDraw:
		return "Drawing"
	case party.ModeSnake:
		return "Snake"
	default:
		return "Playing"
	}
}

func playingSummary(s party.State) string {
	switch s.Mode {
	case party.ModeRace:
		if s.Race == nil {
			return ""
		}
		var sum float64
		for _, racer := range s.Race.Racers {
			sum += racer.Progress
		}
		pct := 0.0
		if len(s.Race.Racers) > 0 {
			pct = sum / float64(len(s.Race.Racers))
		}
		return fmt.Sprintf("Racing — %d%%", int(math.Round(pct*100)))
	case party.ModeDraw:
		if s.Draw == nil {
			return ""
		}
		return fmt.Sprintf("Pass %d of %d", s.Draw.Pass, s.Draw.TotalPasses)
	case party.ModeSnake:
		if s.Snake == nil {
			return ""
		}
		alive := 0
		for _, p := range s.Snake.Players {
			if p.Alive {
				alive++
			}
		}
		return fmt.Sprintf("%d/%d alive", alive, len(s.Snake.Players))
	default:
		return ""
	}
}

func endSummary(s party.State) string {
	switch s.Phase {
	case party.PhaseHostLeft:
		return "Host left"
	case party.PhaseFinished:
		switch s.Mode {
		case party.ModeRace:
			return "Race finished"
		case party.ModeDraw:
			return "Game finished"
		case party.ModeSnake:
			return "Snake finished"
		default:
			return "Finished"
		}
	case party.PhaseMissed:
		return "Already started"
	default:
		return ""
	}
}
