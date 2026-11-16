package discovery

import (
	"context"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/mdns"
)

const serviceName = "_dynamicisland._tcp"

type Peer struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Addr string `json:"addr"`
}

type Discovery struct {
	server *mdns.Server
	cancel context.CancelFunc

	mu    sync.Mutex
	peers map[string]Peer
}

func Start(selfID, selfName string, port int) (*Discovery, error) {
	svc, err := mdns.NewMDNSService(selfID, serviceName, "", "", port, nil, []string{"id=" + selfID, "name=" + selfName})
	if err != nil {
		return nil, err
	}
	server, err := mdns.NewServer(&mdns.Config{Zone: svc})
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithCancel(context.Background())
	d := &Discovery{
		server: server,
		cancel: cancel,
		peers:  make(map[string]Peer),
	}
	go d.browseLoop(ctx, selfID)
	return d, nil
}

func (d *Discovery) browseLoop(ctx context.Context, selfID string) {
	for {
		d.browseOnce(selfID)
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

func (d *Discovery) browseOnce(selfID string) {
	entriesCh := make(chan *mdns.ServiceEntry, 32)
	var collected []*mdns.ServiceEntry
	drained := make(chan struct{})

	go func() {
		defer close(drained)
		for entry := range entriesCh {
			collected = append(collected, entry)
		}
	}()

	_ = mdns.Lookup(serviceName, entriesCh)
	close(entriesCh)
	<-drained

	scratch := make(map[string]Peer)
	for _, entry := range collected {
		peer, ok := parsePeer(entry)
		if !ok || peer.ID == selfID {
			continue
		}
		scratch[peer.ID] = peer
	}

	d.mu.Lock()
	d.peers = scratch
	d.mu.Unlock()
}

func parsePeer(entry *mdns.ServiceEntry) (Peer, bool) {
	var id, name string
	for _, field := range entry.InfoFields {
		key, value, ok := strings.Cut(field, "=")
		if !ok {
			continue
		}
		switch key {
		case "id":
			id = value
		case "name":
			name = value
		}
	}
	if id == "" {
		return Peer{}, false
	}

	addr := entry.AddrV4
	if addr == nil {
		addr = entry.AddrV6
	}
	if addr == nil {
		return Peer{}, false
	}

	return Peer{
		ID:   id,
		Name: name,
		Addr: net.JoinHostPort(addr.String(), strconv.Itoa(entry.Port)),
	}, true
}

func (d *Discovery) Peers() []Peer {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]Peer, 0, len(d.peers))
	for _, p := range d.peers {
		out = append(out, p)
	}
	return out
}

func (d *Discovery) Close() error {
	d.cancel()
	return d.server.Shutdown()
}
