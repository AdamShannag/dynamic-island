package plugins

import (
	"testing"

	"github.com/godbus/dbus/v5"
)

func notifyMsg(hints map[string]dbus.Variant) *dbus.Message {
	return &dbus.Message{Type: dbus.TypeMethodCall, Body: []interface{}{
		"Discord", uint32(0), "", "adam", "<b>hi</b> &amp; bye", []string{}, hints, int32(-1),
	}}
}

func TestNotificationsSkipsShellForward(t *testing.T) {
	n := NewNotifications(nil)
	v, _, ok := n.view(notifyMsg(map[string]dbus.Variant{"desktop-entry": dbus.MakeVariant("discord")}))
	if !ok || v.Title != "adam" || v.Subtitle != "hi & bye" || v.DesktopEntry != "discord" || !v.Mirror {
		t.Fatalf("original not mirrored correctly: ok=%v %+v", ok, v)
	}
	if _, _, ok := n.view(notifyMsg(map[string]dbus.Variant{"x-shell-sender": dbus.MakeVariant(":1.80")})); ok {
		t.Fatal("GNOME's forwarded copy must be ignored")
	}
}
