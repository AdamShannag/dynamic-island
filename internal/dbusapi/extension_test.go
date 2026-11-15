package dbusapi

import (
	"encoding/xml"
	"os"
	"regexp"
	"strings"
	"testing"
)

const extensionInterface = "../../extension/dynamic-island@adamshannag.github.io/lib/dbus.js"

type member struct {
	Name string `xml:"name,attr"`
	Args []struct {
		Type      string `xml:"type,attr"`
		Direction string `xml:"direction,attr"`
	} `xml:"arg"`
}

func (m member) signature() string {
	var in, out []string
	for _, a := range m.Args {
		if a.Direction == "out" {
			out = append(out, a.Type)
		} else {
			in = append(in, a.Type)
		}
	}
	return strings.Join(in, "") + "->" + strings.Join(out, "")
}

func members(t *testing.T, doc string) map[string]string {
	t.Helper()
	var node struct {
		Interfaces []struct {
			Name    string   `xml:"name,attr"`
			Methods []member `xml:"method"`
			Signals []member `xml:"signal"`
		} `xml:"interface"`
	}
	if err := xml.Unmarshal([]byte(doc), &node); err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, in := range node.Interfaces {
		if in.Name != Iface {
			continue
		}
		for _, m := range in.Methods {
			out["method "+m.Name] = m.signature()
		}
		for _, s := range in.Signals {
			out["signal "+s.Name] = s.signature()
		}
	}
	return out
}

func TestExtensionInterfaceMatchesDaemon(t *testing.T) {
	src, err := os.ReadFile(extensionInterface)
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile("(?s)INTERFACE_XML = `(.*?)`").FindSubmatch(src)
	if m == nil {
		t.Fatal("INTERFACE_XML not found in lib/dbus.js")
	}
	ext := members(t, strings.ReplaceAll(string(m[1]), "${BUS_NAME}", Iface))
	daemon := members(t, introXML)
	for name, sig := range ext {
		if got, ok := daemon[name]; !ok {
			t.Errorf("extension declares %s, which the daemon doesn't export", name)
		} else if got != sig {
			t.Errorf("%s: extension expects %s, daemon has %s", name, sig, got)
		}
	}
	for _, name := range []string{"signal StateChanged", "signal SettingsChanged", "signal OpenDashboard", "signal ColorPicked"} {
		if _, ok := ext[name]; !ok {
			t.Errorf("extension doesn't declare %s", name)
		}
	}
}
