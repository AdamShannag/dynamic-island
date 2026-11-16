package discovery

import (
	"net"
	"testing"
)

func TestPickIP(t *testing.T) {
	c := func(iface, ip string) candidate { return candidate{iface: iface, ip: net.ParseIP(ip)} }
	cases := []struct {
		name  string
		cands []candidate
		route string
		want  string
	}{
		{"bridges before the LAN", []candidate{c("docker0", "172.17.0.1"), c("br-1", "172.20.0.1"), c("wlp0s20f3", "172.26.218.60")}, "", "172.26.218.60"},
		{"route picks among physical", []candidate{c("eth0", "192.168.1.5"), c("wlan0", "10.0.0.7")}, "10.0.0.7", "10.0.0.7"},
		{"route through a VPN is ignored", []candidate{c("tun0", "10.8.0.2"), c("wlan0", "192.168.1.9")}, "10.8.0.2", "192.168.1.9"},
		{"link-local and IPv6 skipped", []candidate{c("eth0", "fe80::1"), c("eth0", "169.254.3.3"), c("eth0", "192.168.0.4")}, "", "192.168.0.4"},
		{"private preferred over public", []candidate{c("eth0", "203.0.113.4"), c("eth1", "192.168.0.4")}, "", "192.168.0.4"},
		{"nothing usable", []candidate{c("docker0", "172.17.0.1")}, "", "127.0.0.1"},
	}
	for _, tc := range cases {
		var route net.IP
		if tc.route != "" {
			route = net.ParseIP(tc.route)
		}
		if got := pickIP(tc.cands, route); got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}
}
