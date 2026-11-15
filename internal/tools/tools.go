package tools

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/paths"

	"github.com/godbus/dbus/v5"
	"rsc.io/qr"
)

func QR(text string) (string, error) {
	text = strings.TrimSpace(text)
	if text == "" || len(text) > 2000 {
		return "", fmt.Errorf("text must be 1–2000 characters")
	}
	sum := sha1.Sum([]byte(text))
	path := paths.CacheFile("qr", hex.EncodeToString(sum[:10])+".png")
	if _, err := os.Stat(path); err == nil {
		return path, nil
	}
	code, err := qr.Encode(text, qr.M)
	if err != nil {
		return "", err
	}
	code.Scale = 8
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	return path, os.WriteFile(path, code.PNG(), 0o600)
}

type Color struct {
	Hex, RGB, HSL string
}

func PickColor(ctx context.Context) (Color, error) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return Color{}, err
	}
	defer conn.Close()

	token := fmt.Sprintf("dynamicisland%d", rand.Int63())
	sender := strings.ReplaceAll(strings.TrimPrefix(conn.Names()[0], ":"), ".", "_")
	reqPath := dbus.ObjectPath("/org/freedesktop/portal/desktop/request/" + sender + "/" + token)
	if err := conn.AddMatchSignal(
		dbus.WithMatchObjectPath(reqPath),
		dbus.WithMatchInterface("org.freedesktop.portal.Request"),
		dbus.WithMatchMember("Response"),
	); err != nil {
		return Color{}, err
	}
	sigs := make(chan *dbus.Signal, 4)
	conn.Signal(sigs)

	portal := conn.Object("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop")
	var handle dbus.ObjectPath
	err = portal.Call("org.freedesktop.portal.Screenshot.PickColor", 0, "",
		map[string]dbus.Variant{"handle_token": dbus.MakeVariant(token)}).Store(&handle)
	if err != nil {
		return Color{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	for {
		select {
		case <-ctx.Done():
			return Color{}, ctx.Err()
		case s := <-sigs:
			if s.Path != handle && s.Path != reqPath || len(s.Body) < 2 {
				continue
			}
			if code, _ := s.Body[0].(uint32); code != 0 {
				return Color{}, fmt.Errorf("cancelled")
			}
			res, _ := s.Body[1].(map[string]dbus.Variant)
			parts, _ := res["color"].Value().([]interface{})
			if len(parts) != 3 {
				return Color{}, fmt.Errorf("portal returned no colour")
			}
			var c [3]float64
			for i, p := range parts {
				c[i], _ = p.(float64)
			}
			return format(c[0], c[1], c[2]), nil
		}
	}
}

func format(r, g, b float64) Color {
	R, G, B := int(math.Round(r*255)), int(math.Round(g*255)), int(math.Round(b*255))
	h, s, l := hsl(r, g, b)
	return Color{
		Hex: fmt.Sprintf("#%02X%02X%02X", R, G, B),
		RGB: fmt.Sprintf("rgb(%d, %d, %d)", R, G, B),
		HSL: fmt.Sprintf("hsl(%.0f, %.0f%%, %.0f%%)", h, s*100, l*100),
	}
}

func hsl(r, g, b float64) (h, s, l float64) {
	mx, mn := math.Max(r, math.Max(g, b)), math.Min(r, math.Min(g, b))
	l = (mx + mn) / 2
	if mx == mn {
		return 0, 0, l
	}
	d := mx - mn
	if l > 0.5 {
		s = d / (2 - mx - mn)
	} else {
		s = d / (mx + mn)
	}
	switch mx {
	case r:
		h = (g - b) / d
		if g < b {
			h += 6
		}
	case g:
		h = (b-r)/d + 2
	default:
		h = (r-g)/d + 4
	}
	return h * 60, s, l
}
