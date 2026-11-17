package dbusapi

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/godbus/dbus/v5"

	"github.com/AdamShannag/dynamic-island/internal/discovery"
	"github.com/AdamShannag/dynamic-island/internal/draw"
	"github.com/AdamShannag/dynamic-island/internal/party"
)

func (a *api) PartyPeers() (string, *dbus.Error) {
	if d := a.party.Engine().Discovery(); d != nil {
		return toJSON(d.Peers())
	}
	return toJSON([]discovery.Peer{})
}

func (a *api) PartyState() (string, *dbus.Error) { return toJSON(a.party.Engine().State()) }

func (a *api) PartyCreate() *dbus.Error { a.party.Engine().CreateLobby(); return nil }

func (a *api) PartyInvite(peerId string) *dbus.Error {
	d := a.party.Engine().Discovery()
	if d == nil {
		return dbusErr(errors.New("LAN play is turned off"))
	}
	peer, ok := findPeer(d.Peers(), peerId)
	if !ok {
		return dbusErr(fmt.Errorf("unknown peer %q", peerId))
	}
	return dbusErr(a.party.Engine().Invite(peer))
}

func (a *api) PartyRespond(accept bool) *dbus.Error { return dbusErr(a.party.Engine().Respond(accept)) }

func (a *api) PartySetMode(mode string) *dbus.Error {
	return dbusErr(a.party.Engine().SetMode(party.Mode(mode)))
}

func (a *api) PartySetRounds(rounds int32) *dbus.Error {
	return dbusErr(a.party.Engine().SetRounds(int(rounds)))
}

func (a *api) PartyStart() *dbus.Error { return dbusErr(a.party.Engine().Start()) }

func (a *api) PartyRematch() *dbus.Error { return dbusErr(a.party.Engine().Rematch()) }

func (a *api) PartyLeave() *dbus.Error { a.party.Engine().Leave(); return nil }

func (a *api) RaceProgress(typedChars int32) *dbus.Error {
	return dbusErr(a.party.Engine().RaceEngine().SubmitProgress(int(typedChars)))
}

func (a *api) DrawStroke(stroke string) *dbus.Error {
	var s draw.Stroke
	if err := json.Unmarshal([]byte(stroke), &s); err != nil {
		return dbusErr(err)
	}
	return dbusErr(a.party.Engine().DrawEngine().SubmitStroke(s))
}

func (a *api) DrawGuess(text string) *dbus.Error {
	return dbusErr(a.party.Engine().DrawEngine().SubmitGuess(text))
}

func (a *api) SnakeInput(heading float64) *dbus.Error {
	return dbusErr(a.party.Engine().SnakeInput(heading))
}

func findPeer(peers []discovery.Peer, id string) (discovery.Peer, bool) {
	for _, p := range peers {
		if p.ID == id {
			return p, true
		}
	}
	return discovery.Peer{}, false
}
