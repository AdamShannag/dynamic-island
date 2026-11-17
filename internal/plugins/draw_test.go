package plugins

import (
	"context"
	"testing"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/draw"
	"github.com/AdamShannag/dynamic-island/internal/settings"
)

func TestDrawSummary(t *testing.T) {
	cases := []struct {
		s    draw.State
		want string
	}{
		{draw.State{Phase: draw.PhaseLobby, Players: []draw.Player{{Status: "accepted"}, {Status: "pending"}, {Status: "accepted"}}}, "Draw: 2/3 ready"},
		{draw.State{Phase: draw.PhaseDrawing, DrawerName: "Ada", Round: 2, TotalRounds: 3}, "Ada is drawing — round 2/3"},
		{draw.State{Phase: draw.PhaseReveal, LastRound: &draw.RoundResult{Word: "guitar"}}, `The word was "guitar"`},
		{draw.State{Phase: draw.PhaseHostLeft}, "Game ended: host left"},
		{draw.State{Phase: draw.PhaseFinished}, "Game finished"},
		{draw.State{Phase: draw.PhaseMissed}, "Game already started"},
	}
	for _, c := range cases {
		if got := drawSummary(c.s); got != c.want {
			t.Errorf("drawSummary(%+v) = %q, want %q", c.s, got, c.want)
		}
	}
}

func TestDrawNoActivityWhilePresenting(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	h := &fakeHost{presenting: true}
	d := NewDraw("h1", "Host", "127.0.0.1", 18720)
	d.Engine().Enable()
	defer d.Engine().Disable()
	ctx, cancel := context.WithCancel(context.Background())
	go d.Run(ctx, h)
	defer cancel()
	d.Engine().CreateLobby()
	time.Sleep(200 * time.Millisecond)
	if _, ok := h.activity("draw"); ok {
		t.Fatal("must not set a pill Activity while presenting, even for a game the engine already had running")
	}
}

func TestDrawRunTracksSetting(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if _, err := settings.Update([]byte(`{"features":{"draw":false}}`)); err != nil {
		t.Fatal(err)
	}
	d := NewDraw("h1", "Host", "127.0.0.1", 18721)
	h := &fakeHost{}
	ctx, cancel := context.WithCancel(context.Background())
	go d.Run(ctx, h)
	defer cancel()

	time.Sleep(1500 * time.Millisecond)
	if d.Engine().Enabled() {
		t.Fatal("must stay disabled while the draw feature is off")
	}

	settings.Update([]byte(`{"features":{"draw":true}}`))
	waitFor(t, func() bool { return d.Engine().Enabled() })

	settings.Update([]byte(`{"features":{"draw":false}}`))
	waitFor(t, func() bool { return !d.Engine().Enabled() })
}
