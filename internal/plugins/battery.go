package plugins

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/godbus/dbus/v5"

	"go-island/internal/island"
	"go-island/internal/settings"
)

const (
	upowerName   = "org.freedesktop.UPower"
	upowerDevice = "org.freedesktop.UPower.Device"
	displayDev   = dbus.ObjectPath("/org/freedesktop/UPower/devices/DisplayDevice")
)

// UPower device states.
const (
	upCharging      = 1
	upFullyCharged  = 4
	upPendingCharge = 5
)

var lowThresholds = []float64{20, 10, 5}

// Battery pops the island on plug/unplug and when crossing low thresholds.
type Battery struct{}

func NewBattery() *Battery { return &Battery{} }

func (b *Battery) Name() string { return "battery" }

func (b *Battery) Run(ctx context.Context, h island.Host) error {
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		return err
	}
	defer conn.Close()

	if err := conn.AddMatchSignal(
		dbus.WithMatchInterface("org.freedesktop.DBus.Properties"),
		dbus.WithMatchMember("PropertiesChanged"),
		dbus.WithMatchObjectPath(displayDev),
	); err != nil {
		return err
	}
	signals := make(chan *dbus.Signal, 16)
	conn.Signal(signals)
	obj := conn.Object(upowerName, displayDev)

	read := func() (pct float64, charging, present bool, err error) {
		var props map[string]dbus.Variant
		if err = obj.Call("org.freedesktop.DBus.Properties.GetAll", 0, upowerDevice).Store(&props); err != nil {
			return
		}
		pct, _ = props["Percentage"].Value().(float64)
		present, _ = props["IsPresent"].Value().(bool)
		state, _ := props["State"].Value().(uint32)
		charging = state == upCharging || state == upFullyCharged || state == upPendingCharge
		return
	}

	pct, charging, present, err := read()
	if err != nil {
		return err
	}
	if !present {
		<-ctx.Done() // desktop machine: nothing to do
		return nil
	}
	nextWarn := 0 // index into lowThresholds of the next warning to fire
	for nextWarn < len(lowThresholds) && pct <= lowThresholds[nextWarn] {
		nextWarn++ // don't warn about thresholds already passed at startup
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case _, ok := <-signals:
			if !ok {
				return io.ErrUnexpectedEOF
			}
		}
		newPct, newCharging, _, err := read()
		if err != nil {
			return err
		}
		label := fmt.Sprintf("%.0f%%", newPct)

		quiet := !settings.Enabled("battery")
		switch {
		case quiet:
			if newCharging && !charging {
				nextWarn = 0
			}
		case newCharging && !charging:
			nextWarn = 0
			h.Clear("battery.low")
			h.Set(island.Activity{
				ID: "battery.status", Priority: island.PriorityStatus, TTL: 4 * time.Second,
				View: island.View{Kind: "battery", Title: "Charging", Subtitle: label,
					Icon: "battery-good-charging-symbolic"},
			})
		case !newCharging && charging:
			h.Set(island.Activity{
				ID: "battery.status", Priority: island.PriorityStatus, TTL: 3 * time.Second,
				View: island.View{Kind: "battery", Title: "On battery", Subtitle: label,
					Icon: "battery-good-symbolic"},
			})
		}

		if !quiet && !newCharging && nextWarn < len(lowThresholds) && newPct <= lowThresholds[nextWarn] {
			for nextWarn < len(lowThresholds) && newPct <= lowThresholds[nextWarn] {
				nextWarn++
			}
			h.Set(island.Activity{
				ID: "battery.low", Priority: island.PriorityAlert, TTL: 8 * time.Second,
				View: island.View{Kind: "battery", Title: "Low battery", Subtitle: label + " remaining",
					Icon: "battery-caution-symbolic"},
			})
		}
		charging = newCharging
	}
}
