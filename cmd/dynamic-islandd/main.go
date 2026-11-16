package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/godbus/dbus/v5"

	"github.com/AdamShannag/dynamic-island/internal/clipboard"
	"github.com/AdamShannag/dynamic-island/internal/config"
	"github.com/AdamShannag/dynamic-island/internal/dbusapi"
	"github.com/AdamShannag/dynamic-island/internal/identity"
	"github.com/AdamShannag/dynamic-island/internal/island"
	"github.com/AdamShannag/dynamic-island/internal/lobby"
	"github.com/AdamShannag/dynamic-island/internal/paths"
	"github.com/AdamShannag/dynamic-island/internal/plugins"
	"github.com/AdamShannag/dynamic-island/internal/settings"
	"github.com/AdamShannag/dynamic-island/internal/sites"
)

var version = "dev"

func main() {
	disable := flag.String("disable", "", "comma-separated plugins to disable (also settable in config)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	log.SetFlags(0)
	if *showVersion {
		log.Print(version)
		return
	}
	if err := paths.Migrate(); err != nil {
		log.Printf("migrating legacy data directories: %v", err)
	}

	debug.SetMemoryLimit(32 << 20)
	runtime.GOMAXPROCS(2)

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
	ctxw := plugins.NewContext()
	if err := settings.Load(); err != nil {
		log.Printf("settings: %v (using defaults)", err)
	}
	peerID, err := identity.ID()
	if err != nil {
		log.Printf("peer identity: %v (using a temporary one)", err)
		peerID = identity.Ephemeral()
	}
	racePort := lobby.DefaultPort
	if v := os.Getenv("ISLAND_RACE_PORT"); v != "" {
		if n, perr := strconv.Atoi(v); perr == nil {
			racePort = n
		}
	}
	racePlugin := plugins.NewRace(peerID, identity.Name(), "", racePort)
	if err := dbusapi.Serve(dbusapi.Deps{
		Conn:      conn,
		Manager:   m,
		Clipboard: clip,
		Sites:     st,
		Activity:  ctxw,
		Race:      racePlugin,
	}); err != nil {
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

	all := []island.Plugin{
		plugins.NewMPRIS(),
		plugins.NewBattery(),
		plugins.NewNotifications(cfg.Notifications.IgnoreApps),
		plugins.NewPomodoro(cfg.Pomodoro.FocusMinutes, cfg.Pomodoro.BreakMinutes),
		plugins.NewDocker(),
		ctxw,
		plugins.NewUSB(),
		racePlugin,
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
