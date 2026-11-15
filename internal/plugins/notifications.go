package plugins

import (
	"context"
	"fmt"
	"html"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/godbus/dbus/v5"

	"github.com/AdamShannag/dynamic-island/internal/inbox"
	"github.com/AdamShannag/dynamic-island/internal/island"
	"github.com/AdamShannag/dynamic-island/internal/settings"
)

type Notifications struct {
	ignore map[string]bool
	seq    int
}

func NewNotifications(ignoreApps []string) *Notifications {
	n := &Notifications{ignore: map[string]bool{}}
	for _, a := range ignoreApps {
		n.ignore[strings.ToLower(a)] = true
	}
	return n
}

func (n *Notifications) Name() string { return "notifications" }

var markup = regexp.MustCompile(`<[^>]*>`)

func (n *Notifications) Run(ctx context.Context, h island.Host) error {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return err
	}
	defer conn.Close()

	msgs := make(chan *dbus.Message, 64)
	conn.Eavesdrop(msgs)
	call := conn.BusObject().Go("org.freedesktop.DBus.Monitoring.BecomeMonitor", 0, nil,
		[]string{"type='method_call',interface='org.freedesktop.Notifications',member='Notify'"},
		uint32(0))
	if call.Err != nil {
		return call.Err
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case msg, ok := <-msgs:
			if !ok {
				return io.ErrUnexpectedEOF
			}
			switch msg.Type {
			case dbus.TypeError:
				return fmt.Errorf("BecomeMonitor: %v", msg.Body)
			case dbus.TypeMethodCall:
				v, ttl, ok := n.view(msg)
				if !ok {
					continue
				}
				if settings.TabOn("inbox") {
					inbox.Add(inbox.Item{App: v.App, DesktopEntry: v.DesktopEntry, Icon: v.Icon, Art: v.Art,
						Title: v.Title, Body: v.Subtitle})
				}
				if h.Presenting() || !settings.Enabled("mirrorNotifications") {
					continue
				}
				{
					n.seq++
					h.Set(island.Activity{
						ID: fmt.Sprintf("notify.mirror.%d", n.seq), Priority: island.PriorityNotify,
						TTL: ttl, View: v,
					})
				}
			}
		}
	}
}

func (n *Notifications) view(msg *dbus.Message) (island.View, time.Duration, bool) {
	if len(msg.Body) < 7 {
		return island.View{}, 0, false
	}
	app, _ := msg.Body[0].(string)
	icon, _ := msg.Body[2].(string)
	summary, _ := msg.Body[3].(string)
	body, _ := msg.Body[4].(string)
	hints, _ := msg.Body[6].(map[string]dbus.Variant)
	if summary == "" || n.ignore[strings.ToLower(app)] {
		return island.View{}, 0, false
	}
	if _, fwd := hints["x-shell-sender"]; fwd {
		return island.View{}, 0, false
	}

	de, _ := hints["desktop-entry"].Value().(string)
	v := island.View{
		Kind:         "notify",
		Title:        clean(summary),
		Subtitle:     clean(body),
		Trailing:     app,
		Click:        "notify.dismiss",
		Mirror:       true,
		App:          app,
		DesktopEntry: de,
	}
	if p, _ := hints["image-path"].Value().(string); isPath(p) {
		v.Art = strings.TrimPrefix(p, "file://")
	} else if isPath(icon) {
		v.Art = strings.TrimPrefix(icon, "file://")
	} else if icon != "" {
		v.Icon = icon
	} else if de, _ := hints["desktop-entry"].Value().(string); de != "" {
		v.Icon = de
	} else {
		v.Icon = "dialog-information-symbolic"
	}

	ttl := 5 * time.Second
	if u, _ := hints["urgency"].Value().(byte); u == 2 {
		v.Accent, ttl = "warn", 10*time.Second
	}
	return v, ttl, true
}

func isPath(s string) bool { return strings.HasPrefix(s, "/") || strings.HasPrefix(s, "file://") }

func clean(s string) string {
	s = html.UnescapeString(markup.ReplaceAllString(s, ""))
	return strings.Join(strings.Fields(s), " ")
}
