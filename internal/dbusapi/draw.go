package dbusapi

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/godbus/dbus/v5"

	"github.com/AdamShannag/dynamic-island/internal/discovery"
	"github.com/AdamShannag/dynamic-island/internal/draw"
)

func (a *api) DrawPeers() (string, *dbus.Error) {
	if d := a.draw.Engine().Discovery(); d != nil {
		return toJSON(d.Peers())
	}
	return toJSON([]discovery.Peer{})
}

func (a *api) DrawState() (string, *dbus.Error) { return toJSON(a.draw.Engine().State()) }

func (a *api) DrawCreate() *dbus.Error { a.draw.Engine().CreateLobby(); return nil }

func (a *api) DrawInvite(peerId string) *dbus.Error {
	d := a.draw.Engine().Discovery()
	if d == nil {
		return dbusErr(errors.New("LAN drawing is turned off"))
	}
	peer, ok := findPeer(d.Peers(), peerId)
	if !ok {
		return dbusErr(fmt.Errorf("unknown peer %q", peerId))
	}
	return dbusErr(a.draw.Engine().Invite(peer))
}

func (a *api) DrawRespond(accept bool) *dbus.Error { return dbusErr(a.draw.Engine().Respond(accept)) }

func (a *api) DrawStart() *dbus.Error { return dbusErr(a.draw.Engine().Start()) }

func (a *api) DrawStroke(stroke string) *dbus.Error {
	var s draw.Stroke
	if err := json.Unmarshal([]byte(stroke), &s); err != nil {
		return dbusErr(err)
	}
	return dbusErr(a.draw.Engine().SubmitStroke(s))
}

func (a *api) DrawGuess(text string) *dbus.Error {
	return dbusErr(a.draw.Engine().SubmitGuess(text))
}

func (a *api) DrawLeave() *dbus.Error { a.draw.Engine().Leave(); return nil }
