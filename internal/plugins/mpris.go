package plugins

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/paths"

	"github.com/godbus/dbus/v5"

	"github.com/AdamShannag/dynamic-island/internal/island"
)

const (
	mprisPrefix = "org.mpris.MediaPlayer2."
	mprisPath   = dbus.ObjectPath("/org/mpris/MediaPlayer2")
	mprisPlayer = "org.mpris.MediaPlayer2.Player"
	mediaID     = "media"
	pausedTTL   = 60 * time.Second
)

type MPRIS struct {
	mu       sync.Mutex
	conn     *dbus.Conn
	selected string
	last     *island.View

	artMu    sync.Mutex
	inflight map[string]bool
	rescan   chan struct{}
}

func NewMPRIS() *MPRIS { return &MPRIS{inflight: map[string]bool{}} }

func (p *MPRIS) Name() string { return "mpris" }

func (p *MPRIS) Run(ctx context.Context, h island.Host) error {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return err
	}
	defer conn.Close()
	p.mu.Lock()
	p.conn, p.last, p.selected = conn, nil, ""
	p.mu.Unlock()
	p.rescan = make(chan struct{}, 1)

	if err := conn.AddMatchSignal(
		dbus.WithMatchInterface("org.freedesktop.DBus.Properties"),
		dbus.WithMatchMember("PropertiesChanged"),
		dbus.WithMatchObjectPath(mprisPath),
	); err != nil {
		return err
	}
	if err := conn.AddMatchSignal(
		dbus.WithMatchInterface(mprisPlayer),
		dbus.WithMatchMember("Seeked"),
		dbus.WithMatchObjectPath(mprisPath),
	); err != nil {
		return err
	}
	if err := conn.AddMatchSignal(
		dbus.WithMatchInterface("org.freedesktop.DBus"),
		dbus.WithMatchMember("NameOwnerChanged"),
		dbus.WithMatchArg0Namespace("org.mpris.MediaPlayer2"),
	); err != nil {
		return err
	}
	signals := make(chan *dbus.Signal, 32)
	conn.Signal(signals)

	for _, a := range []struct{ action, method string }{
		{"media.play-pause", "PlayPause"},
		{"media.next", "Next"},
		{"media.previous", "Previous"},
	} {
		method := mprisPlayer + "." + a.method
		h.HandleAction(a.action, func() { p.call(method) })
	}

	defer h.Clear(mediaID)
	p.update(h)

	var debounce <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return nil
		case _, ok := <-signals:
			if !ok {
				return io.ErrUnexpectedEOF
			}
			if debounce == nil {
				debounce = time.After(80 * time.Millisecond)
			}
		case <-p.rescan:
			p.update(h)
		case <-debounce:
			debounce = nil
			p.update(h)
		}
	}
}

func (p *MPRIS) call(method string) {
	p.mu.Lock()
	conn, name := p.conn, p.selected
	p.mu.Unlock()
	if conn == nil || name == "" {
		return
	}
	if err := conn.Object(name, mprisPath).Call(method, 0).Err; err != nil {
		log.Printf("mpris: %s on %s: %v", method, name, err)
	}
}

type player struct {
	name     string
	status   string
	meta     map[string]dbus.Variant
	position int64
	rate     float64
}

func (p *MPRIS) players() []player {
	var names []string
	if err := p.conn.BusObject().Call("org.freedesktop.DBus.ListNames", 0).Store(&names); err != nil {
		log.Printf("mpris: ListNames: %v", err)
		return nil
	}
	var out []player
	for _, n := range names {
		if !strings.HasPrefix(n, mprisPrefix) {
			continue
		}
		var props map[string]dbus.Variant
		err := p.conn.Object(n, mprisPath).
			Call("org.freedesktop.DBus.Properties.GetAll", 0, mprisPlayer).Store(&props)
		if err != nil {
			continue
		}
		pl := player{name: n}
		pl.status, _ = props["PlaybackStatus"].Value().(string)
		pl.meta, _ = props["Metadata"].Value().(map[string]dbus.Variant)
		pl.position, _ = props["Position"].Value().(int64)
		pl.rate, _ = props["Rate"].Value().(float64)
		out = append(out, pl)
	}
	return out
}

func pick(players []player, selected string) *player {
	rank := func(pl player) int {
		r := 0
		switch pl.status {
		case "Playing":
			r = 4
		case "Paused":
			r = 2
		default:
			return 0
		}
		if pl.name == selected {
			r++
		}
		return r
	}
	var best *player
	for i := range players {
		if r := rank(players[i]); r > 0 && (best == nil || r > rank(*best)) {
			best = &players[i]
		}
	}
	return best
}

func (p *MPRIS) update(h island.Host) {
	p.mu.Lock()
	selected := p.selected
	p.mu.Unlock()

	best := pick(p.players(), selected)
	var title string
	if best != nil {
		title, _ = best.meta["xesam:title"].Value().(string)
	}
	if best == nil || title == "" {
		p.mu.Lock()
		p.selected, p.last = "", nil
		p.mu.Unlock()
		h.Clear(mediaID)
		return
	}

	artists, _ := best.meta["xesam:artist"].Value().([]string)
	artURL, _ := best.meta["mpris:artUrl"].Value().(string)
	v := island.View{
		Kind:     "media",
		Title:    title,
		Subtitle: strings.Join(artists, ", "),
		Icon:     "audio-x-generic-symbolic",
		Art:      p.resolveArt(artURL),
		Playing:  best.status == "Playing",
		Actions:  []string{"media.previous", "media.play-pause", "media.next"},
		Timing:   timing(best),
	}

	p.mu.Lock()
	p.selected = best.name
	unchanged := p.last != nil && sameMedia(*p.last, v)
	if !unchanged {
		p.last = &v
	}
	p.mu.Unlock()
	if unchanged {
		return
	}
	var ttl time.Duration
	if !v.Playing {
		ttl = pausedTTL
	}
	h.Set(island.Activity{ID: mediaID, Priority: island.PriorityAmbient, View: v, TTL: ttl})
}

func (p *MPRIS) resolveArt(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	switch u.Scheme {
	case "file":
		return u.Path
	case "http", "https":
	default:
		return ""
	}
	sum := sha1.Sum([]byte(raw))
	path := filepath.Join(artCacheDir(), hex.EncodeToString(sum[:]))
	if _, err := os.Stat(path); err == nil {
		return path
	}
	p.artMu.Lock()
	defer p.artMu.Unlock()
	if !p.inflight[path] {
		p.inflight[path] = true
		go p.download(raw, path)
	}
	return ""
}

func (p *MPRIS) download(raw, path string) {
	defer func() {
		p.artMu.Lock()
		delete(p.inflight, path)
		p.artMu.Unlock()
	}()
	client := http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(raw)
	if err != nil {
		log.Printf("mpris: art download: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	tmp := path + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return
	}
	_, err = io.Copy(f, io.LimitReader(resp.Body, 10<<20))
	f.Close()
	if err != nil || os.Rename(tmp, path) != nil {
		os.Remove(tmp)
		return
	}
	select {
	case p.rescan <- struct{}{}:
	default:
	}
}

func artCacheDir() string { return paths.CacheFile("art") }

func timing(pl *player) *island.Timing {
	var length int64
	switch l := pl.meta["mpris:length"].Value().(type) {
	case int64:
		length = l
	case uint64:
		length = int64(l)
	}
	if length <= 0 {
		return nil
	}
	rate := pl.rate
	if rate <= 0 {
		rate = 1
	}
	return &island.Timing{
		Length:   float64(length) / 1e6,
		Position: float64(pl.position) / 1e6,
		At:       island.UnixMs(time.Now()),
		Rate:     rate,
	}
}

func sameMedia(a, b island.View) bool {
	ta, tb := a.Timing, b.Timing
	a.Timing, b.Timing = nil, nil
	if !reflect.DeepEqual(a, b) {
		return false
	}
	if ta == nil || tb == nil {
		return ta == tb
	}
	if ta.Length != tb.Length || ta.Rate != tb.Rate {
		return false
	}
	expected := ta.Position
	if a.Playing {
		expected += float64(tb.At-ta.At) / 1000 * ta.Rate
	}
	return math.Abs(tb.Position-expected) < 2
}
