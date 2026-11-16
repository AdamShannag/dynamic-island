package discovery

import (
	"net"
	"strings"
)

var virtualPrefixes = []string{
	"docker", "br-", "veth", "virbr", "vmnet", "vboxnet", "lxc", "lxd", "cni", "flannel",
	"tun", "tap", "wg", "tailscale", "zt",
}

type candidate struct {
	iface string
	ip    net.IP
}

func LocalIP() string {
	return pickIP(interfaceIPs(), routeIP())
}

func interfaceIPs() []candidate {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []candidate
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			if ipNet, ok := addr.(*net.IPNet); ok {
				out = append(out, candidate{iface: iface.Name, ip: ipNet.IP})
			}
		}
	}
	return out
}

func routeIP() net.IP {
	conn, err := net.Dial("udp4", "192.0.2.1:9")
	if err != nil {
		return nil
	}
	defer conn.Close()
	if udp, ok := conn.LocalAddr().(*net.UDPAddr); ok {
		return udp.IP
	}
	return nil
}

func pickIP(cands []candidate, route net.IP) string {
	var best net.IP
	for _, c := range cands {
		ip := c.ip.To4()
		if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() || virtual(c.iface) {
			continue
		}
		if route != nil && ip.Equal(route) {
			return ip.String()
		}
		if best == nil || (!best.IsPrivate() && ip.IsPrivate()) {
			best = ip
		}
	}
	if best == nil {
		return "127.0.0.1"
	}
	return best.String()
}

func virtual(name string) bool {
	for _, p := range virtualPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}
