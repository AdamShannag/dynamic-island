package dbusapi

import (
	"errors"
	"fmt"

	"github.com/godbus/dbus/v5"

	"github.com/AdamShannag/dynamic-island/internal/discovery"
)

func (a *api) RacePeers() (string, *dbus.Error) {
	if d := a.race.Engine().Discovery(); d != nil {
		return toJSON(d.Peers())
	}
	return toJSON([]discovery.Peer{})
}

func (a *api) RaceState() (string, *dbus.Error) { return toJSON(a.race.Engine().State()) }

func (a *api) RaceCreate() *dbus.Error { a.race.Engine().CreateLobby(); return nil }

func (a *api) RaceInvite(peerId string) *dbus.Error {
	d := a.race.Engine().Discovery()
	if d == nil {
		return dbusErr(errors.New("LAN race is turned off"))
	}
	peer, ok := findPeer(d.Peers(), peerId)
	if !ok {
		return dbusErr(fmt.Errorf("unknown peer %q", peerId))
	}
	return dbusErr(a.race.Engine().Invite(peer))
}

func (a *api) RaceRespond(accept bool) *dbus.Error { return dbusErr(a.race.Engine().Respond(accept)) }

func (a *api) RaceStart() *dbus.Error { return dbusErr(a.race.Engine().Start()) }

func (a *api) RaceProgress(typedChars int32) *dbus.Error {
	return dbusErr(a.race.Engine().SubmitProgress(int(typedChars)))
}

func (a *api) RaceLeave() *dbus.Error { a.race.Engine().Leave(); return nil }

func findPeer(peers []discovery.Peer, id string) (discovery.Peer, bool) {
	for _, p := range peers {
		if p.ID == id {
			return p, true
		}
	}
	return discovery.Peer{}, false
}
