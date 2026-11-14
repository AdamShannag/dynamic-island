// islandd is the Go Island daemon: it runs plugins and serves the island
// state on the session bus for the GNOME Shell extension.
package main

import (
	"context"
	"flag"
	"log"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/godbus/dbus/v5"

	"go-island/internal/dbusapi"
	"go-island/internal/island"
	"go-island/internal/plugins"
)

func main() {
	disable := flag.String("disable", "", "comma-separated plugins to disable (mpris,battery)")
	flag.Parse()
	log.SetFlags(0) // journald adds timestamps

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		log.Fatalf("session bus: %v", err)
	}
	defer conn.Close()

	m := island.NewManager()
	if err := dbusapi.Serve(conn, m); err != nil {
		log.Fatal(err)
	}
	log.Printf("serving %s", dbusapi.BusName)

	off := map[string]bool{}
	for _, n := range strings.Split(*disable, ",") {
		off[strings.TrimSpace(n)] = true
	}

	// Register new plugins here.
	all := []island.Plugin{
		plugins.NewMPRIS(),
		plugins.NewBattery(),
	}

	var wg sync.WaitGroup
	for _, p := range all {
		if off[p.Name()] {
			continue
		}
		wg.Add(1)
		go func(p island.Plugin) {
			defer wg.Done()
			supervise(ctx, p, m)
		}(p)
	}
	<-ctx.Done()
	wg.Wait()
}

// supervise runs a plugin and restarts it with backoff if it fails.
func supervise(ctx context.Context, p island.Plugin, h island.Host) {
	backoff := time.Second
	for {
		start := time.Now()
		err := p.Run(ctx, h)
		if ctx.Err() != nil {
			return
		}
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
		log.Printf("plugin %s stopped: %v (restarting in %s)", p.Name(), err, backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}
