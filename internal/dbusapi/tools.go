package dbusapi

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/godbus/dbus/v5"

	"github.com/AdamShannag/dynamic-island/internal/discovery"
	"github.com/AdamShannag/dynamic-island/internal/island"
	"github.com/AdamShannag/dynamic-island/internal/tools"
)

func (a *api) QR(text string) (string, *dbus.Error) {
	p, err := tools.QR(text)
	return p, dbusErr(err)
}

func (a *api) LanAddress() (string, *dbus.Error) {
	ip := discovery.LocalIP()
	if ip == "" {
		return "", dbusErr(errors.New("no LAN address"))
	}
	return ip, nil
}

func (a *api) PickColor() *dbus.Error {
	go a.pickColor()
	return nil
}

func (a *api) pickColor() {
	c, err := tools.PickColor(context.Background())
	if err != nil {
		if err.Error() != "cancelled" {
			a.popup("notify.color", 4*time.Second, island.View{Title: "Colour picker unavailable",
				Subtitle: err.Error(), Icon: "dialog-error-symbolic", Accent: "error"})
		}
		return
	}
	if err := a.emit(signalColorPicked, c.Hex); err != nil {
		log.Printf("emit %s: %v", signalColorPicked, err)
	}
	a.popup("notify.color", 8*time.Second, island.View{Title: c.Hex + " copied",
		Subtitle: c.RGB + "  ·  " + c.HSL, Swatch: c.Hex, Trailing: "colour"})
}
