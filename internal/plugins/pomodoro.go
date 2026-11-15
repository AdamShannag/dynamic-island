package plugins

import (
	"context"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/island"
)

type Pomodoro struct {
	focus, brk time.Duration
}

func NewPomodoro(focusMin, breakMin int) *Pomodoro {
	if focusMin <= 0 {
		focusMin = 25
	}
	if breakMin <= 0 {
		breakMin = 5
	}
	return &Pomodoro{time.Duration(focusMin) * time.Minute, time.Duration(breakMin) * time.Minute}
}

func (p *Pomodoro) Name() string { return "pomodoro" }

const pomodoroID = "pomodoro"

func (p *Pomodoro) Run(ctx context.Context, h island.Host) error {
	cmds := make(chan string, 4)
	for _, c := range []string{"start", "stop", "toggle"} {
		c := c
		h.HandleAction("pomodoro."+c, func() {
			select {
			case cmds <- c:
			default:
			}
		})
	}

	phase := ""
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	defer h.Clear(pomodoroID)

	begin := func(name string, d time.Duration) {
		phase = name
		timer.Reset(d)
		v := island.View{
			Kind: "timer", Title: "Focus", Icon: "alarm-symbolic",
			EndsAt: island.UnixMs(time.Now().Add(d)),
		}
		if name == "break" {
			v.Title, v.Icon, v.Accent = "Break", "face-smile-symbolic", "ok"
		}
		h.Set(island.Activity{ID: pomodoroID, Priority: island.PriorityTimer, View: v})
	}
	stop := func() {
		phase = ""
		timer.Stop()
		h.Clear(pomodoroID)
	}
	alert := func(title, body string) {
		h.Set(island.Activity{
			ID: "notify.pomodoro", Priority: island.PriorityNotify, TTL: 10 * time.Second,
			View: island.View{Kind: "notify", Title: title, Subtitle: body,
				Icon: "alarm-symbolic", Accent: "warn", Click: "notify.dismiss"},
		})
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case c := <-cmds:
			switch {
			case c == "start" || (c == "toggle" && phase == ""):
				begin("focus", p.focus)
			default:
				stop()
			}
		case <-timer.C:
			if phase == "focus" {
				alert("Focus block done", "Take a "+island.FormatDuration(p.brk)+" break")
				begin("break", p.brk)
			} else {
				stop()
				alert("Break over", "Back to it")
			}
		}
	}
}
