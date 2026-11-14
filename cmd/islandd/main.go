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

	"go-island/internal/clipboard"
	"go-island/internal/config"
	"go-island/internal/dbusapi"
	"go-island/internal/island"
	"go-island/internal/plugins"
	"go-island/internal/sites"
)

func main() {
	disable := flag.String("disable", "", "comma-separated plugins to disable (also settable in config)")
	flag.Parse()
	log.SetFlags(0) // journald adds timestamps

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		log.Fatalf("session bus: %v", err)
	}
	defer conn.Close()

	clip, err := clipboard.Open(clipboard.DefaultPath())
	if err != nil {
		log.Printf("clipboard history: %v (starting empty)", err)
	}
	st, err := sites.Open()
	if err != nil {
		log.Printf("saved sites: %v (starting empty)", err)
	}
	m := island.NewManager()
	if err := dbusapi.Serve(conn, m, clip, st); err != nil {
		log.Fatal(err)
	}
	log.Printf("serving %s", dbusapi.BusName)

	cfg, err := config.Load()
	if err != nil {
		log.Printf("config %s: %v (using defaults)", config.Path(), err)
	}
	off := map[string]bool{}
	for _, n := range append(strings.Split(*disable, ","), cfg.Disable...) {
		off[strings.TrimSpace(n)] = true
	}
	if e := cfg.Notifications.Enabled; e != nil && !*e {
		off["notifications"] = true
	}

	// Register new plugins here.
	all := []island.Plugin{
		plugins.NewMPRIS(),
		plugins.NewBattery(),
		plugins.NewNotifications(cfg.Notifications.IgnoreApps),
		plugins.NewPomodoro(cfg.Pomodoro.FocusMinutes, cfg.Pomodoro.BreakMinutes),
		plugins.NewDocker(),
		plugins.NewContext(),
		plugins.NewUSB(),
	}

	var wg sync.WaitGroup
	for _, p := range all {
		if off[p.Name()] {
			log.Printf("plugin %s disabled", p.Name())
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
