package plugins

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/island"
	"github.com/AdamShannag/dynamic-island/internal/settings"
)

type USB struct{}

func NewUSB() *USB { return &USB{} }

func (u *USB) Name() string { return "usb" }

const usbRoot = "/sys/bus/usb/devices"

var gamepadRe = regexp.MustCompile(`(?i)controller|gamepad|joystick|xbox|dualsense|dualshock|8bitdo`)
var phoneRe = regexp.MustCompile(`(?i)android|iphone|pixel|galaxy|phone|mtp`)

func (u *USB) Run(ctx context.Context, h island.Host) error {
	known := usbDevices()
	t := time.NewTicker(1500 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
		now := usbDevices()
		for id, dev := range now {
			if _, ok := known[id]; ok {
				continue
			}
			if !settings.Enabled("usb") {
				continue
			}
			if v, ok := describeUSB(id, dev); ok {
				h.Set(island.Activity{ID: "usb." + id, Priority: island.PriorityStatus, TTL: 3500 * time.Millisecond, View: v})
			}
		}
		for id, dev := range known {
			if _, ok := now[id]; !ok && dev != "" && settings.Enabled("usb") {
				h.Set(island.Activity{ID: "usb." + id, Priority: island.PriorityStatus, TTL: 2 * time.Second,
					View: island.View{Kind: "usb", Title: dev, Subtitle: "Disconnected", Icon: "media-eject-symbolic"}})
			}
		}
		known = now
	}
}

func usbDevices() map[string]string {
	out := map[string]string{}
	ents, _ := os.ReadDir(usbRoot)
	for _, e := range ents {
		id := e.Name()
		if strings.Contains(id, ":") || strings.HasPrefix(id, "usb") {
			continue
		}
		out[id] = readSys(filepath.Join(usbRoot, id, "product"))
	}
	return out
}

func readSys(p string) string {
	b, _ := os.ReadFile(p)
	return strings.TrimSpace(string(b))
}

func describeUSB(id, product string) (island.View, bool) {
	dir := filepath.Join(usbRoot, id)
	maker := readSys(filepath.Join(dir, "manufacturer"))
	if readSys(filepath.Join(dir, "bDeviceClass")) == "09" {
		return island.View{}, false
	}
	classes := map[string]bool{}
	protocols := map[string]bool{}
	ifaceNames := ""
	ifaces, _ := filepath.Glob(dir + "/" + id + ":*")
	for _, i := range ifaces {
		classes[readSys(filepath.Join(i, "bInterfaceClass"))] = true
		if readSys(filepath.Join(i, "bInterfaceClass")) == "03" {
			protocols[readSys(filepath.Join(i, "bInterfaceProtocol"))] = true
		}
		ifaceNames += " " + readSys(filepath.Join(i, "interface"))
	}
	all := product + " " + maker + ifaceNames
	kind, icon := "USB device", "media-removable-symbolic"
	switch {
	case classes["09"] && len(classes) == 1:
		return island.View{}, false
	case classes["08"]:
		kind, icon = "USB drive", "drive-removable-media-symbolic"
	case classes["06"] || phoneRe.MatchString(all):
		kind, icon = "Phone", "phone-symbolic"
	case gamepadRe.MatchString(all):
		kind, icon = "Game controller", "input-gaming-symbolic"
	case protocols["01"]:
		kind, icon = "Keyboard", "input-keyboard-symbolic"
	case protocols["02"]:
		kind, icon = "Mouse", "input-mouse-symbolic"
	case classes["01"]:
		kind, icon = "Audio device", "audio-headphones-symbolic"
	case classes["0e"]:
		kind, icon = "Camera", "camera-web-symbolic"
	case classes["03"]:
		kind, icon = "Input device", "input-mouse-symbolic"
	}
	title := product
	if title == "" {
		title = kind
	}
	return island.View{Kind: "usb", Title: title, Subtitle: kind + " connected", Icon: icon}, true
}
