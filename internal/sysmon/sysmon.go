// Package sysmon samples system metrics from /proc and /sys for the
// dashboard's Activity tab. It only does work when asked (the tab polls
// while it's open), so it costs nothing otherwise.
package sysmon

import (
	"bufio"
	"bytes"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Proc struct {
	PID  int     `json:"pid"`
	Name string  `json:"name"`
	CPU  float64 `json:"cpu"` // percent of one core, like top
	Mem  uint64  `json:"mem"` // resident bytes
}

type Snapshot struct {
	CPU       float64 `json:"cpu"` // 0–100, all cores
	Cores     int     `json:"cores"`
	Load1     float64 `json:"load1"`
	TempC     float64 `json:"tempC,omitempty"`
	MemUsed   uint64  `json:"memUsed"`
	MemTotal  uint64  `json:"memTotal"`
	SwapUsed  uint64  `json:"swapUsed"`
	SwapTotal uint64  `json:"swapTotal"`
	DiskUsed  uint64  `json:"diskUsed"`
	DiskTotal uint64  `json:"diskTotal"`
	NetRx     float64 `json:"netRx"` // bytes/s
	NetTx     float64 `json:"netTx"`
	Top       []Proc  `json:"top"`
}

type Monitor struct {
	mu       sync.Mutex
	prevT    time.Time
	prevIdle uint64
	prevTot  uint64
	prevRx   uint64
	prevTx   uint64
	prevProc map[int]uint64 // pid -> utime+stime ticks
	tempPath string
	tempOnce sync.Once
}

func New() *Monitor { return &Monitor{prevProc: map[int]uint64{}} }

const (
	clkTck   = 100 // USER_HZ
	pageSize = 4096
	topN     = 6
	stale    = 5 * time.Second // older baseline: take a fresh 250 ms one first
)

// Sample returns current metrics; rates are measured since the previous call.
func (m *Monitor) Sample() Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.prevT.IsZero() || time.Since(m.prevT) > stale {
		m.measure(nil) // establish a baseline
		time.Sleep(250 * time.Millisecond)
	}
	var s Snapshot
	m.measure(&s)
	return s
}

func (m *Monitor) measure(out *Snapshot) {
	now := time.Now()
	dt := now.Sub(m.prevT).Seconds()

	idle, total, cores := readCPU()
	rx, tx := readNet()
	procTicks := readProcTicks()

	if out != nil && dt > 0 {
		if dTot := total - m.prevTot; dTot > 0 && total >= m.prevTot {
			out.CPU = 100 * (1 - float64(idle-m.prevIdle)/float64(dTot))
		}
		if rx >= m.prevRx && tx >= m.prevTx {
			out.NetRx = float64(rx-m.prevRx) / dt
			out.NetTx = float64(tx-m.prevTx) / dt
		}
		var procs []Proc
		for pid, t := range procTicks {
			prev, ok := m.prevProc[pid]
			if !ok || t < prev {
				continue
			}
			if cpu := float64(t-prev) / clkTck / dt * 100; cpu >= 0.1 {
				procs = append(procs, Proc{PID: pid, CPU: cpu})
			}
		}
		sort.Slice(procs, func(i, j int) bool { return procs[i].CPU > procs[j].CPU })
		if len(procs) > topN {
			procs = procs[:topN]
		}
		for i := range procs {
			procs[i].Name, procs[i].Mem = procNameMem(procs[i].PID)
		}
		out.Top = procs
		out.Cores = cores
		out.Load1 = readLoad()
		out.MemTotal, out.MemUsed, out.SwapTotal, out.SwapUsed = readMem()
		out.DiskTotal, out.DiskUsed = diskUsage("/")
		out.TempC = m.readTemp()
		if out.Top == nil {
			out.Top = []Proc{}
		}
	}
	m.prevT, m.prevIdle, m.prevTot, m.prevRx, m.prevTx, m.prevProc = now, idle, total, rx, tx, procTicks
}

func readCPU() (idle, total uint64, cores int) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "cpu ") {
			f := strings.Fields(line)[1:]
			for i, v := range f {
				n, _ := strconv.ParseUint(v, 10, 64)
				if i < 8 { // user..steal (guest is already in user)
					total += n
				}
				if i == 3 || i == 4 { // idle, iowait
					idle += n
				}
			}
		} else if strings.HasPrefix(line, "cpu") {
			cores++
		}
	}
	return
}

func readLoad() float64 {
	b, _ := os.ReadFile("/proc/loadavg")
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return v
}

func readMem() (total, used, swapTotal, swapUsed uint64) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return
	}
	kv := map[string]uint64{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) >= 2 {
			n, _ := strconv.ParseUint(f[1], 10, 64)
			kv[strings.TrimSuffix(f[0], ":")] = n * 1024
		}
	}
	total, swapTotal = kv["MemTotal"], kv["SwapTotal"]
	used = total - kv["MemAvailable"]
	swapUsed = swapTotal - kv["SwapFree"]
	return
}

func diskUsage(path string) (total, used uint64) {
	var st syscall.Statfs_t
	if syscall.Statfs(path, &st) != nil {
		return
	}
	total = st.Blocks * uint64(st.Bsize)
	used = (st.Blocks - st.Bfree) * uint64(st.Bsize)
	return
}

func readNet() (rx, tx uint64) {
	b, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(b), "\n")[2:] {
		name, rest, ok := strings.Cut(line, ":")
		name = strings.TrimSpace(name)
		if !ok || name == "lo" || strings.HasPrefix(name, "docker") || strings.HasPrefix(name, "br-") || strings.HasPrefix(name, "veth") {
			continue // count real interfaces only
		}
		f := strings.Fields(rest)
		if len(f) >= 9 {
			r, _ := strconv.ParseUint(f[0], 10, 64)
			t, _ := strconv.ParseUint(f[8], 10, 64)
			rx += r
			tx += t
		}
	}
	return
}

// readProcTicks returns utime+stime for every process.
func readProcTicks() map[int]uint64 {
	out := map[int]uint64{}
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		s := string(b)
		r := strings.LastIndexByte(s, ')')
		if r < 0 {
			continue
		}
		f := strings.Fields(s[r+1:])
		if len(f) < 13 {
			continue
		}
		ut, _ := strconv.ParseUint(f[11], 10, 64)
		st, _ := strconv.ParseUint(f[12], 10, 64)
		out[pid] = ut + st
	}
	return out
}

func procNameMem(pid int) (string, uint64) {
	dir := "/proc/" + strconv.Itoa(pid)
	name, _ := os.ReadFile(dir + "/comm")
	statm, _ := os.ReadFile(dir + "/statm")
	var rss uint64
	if f := strings.Fields(string(statm)); len(f) >= 2 {
		pages, _ := strconv.ParseUint(f[1], 10, 64)
		rss = pages * pageSize
	}
	return strings.TrimSpace(string(name)), rss
}

// readTemp finds the CPU package sensor once, then reads it.
func (m *Monitor) readTemp() float64 {
	m.tempOnce.Do(func() {
		hw, _ := filepath.Glob("/sys/class/hwmon/hwmon*")
		for _, d := range hw {
			name, _ := os.ReadFile(d + "/name")
			switch strings.TrimSpace(string(name)) {
			case "coretemp", "k10temp", "zenpower", "cpu_thermal", "acpitz":
				if _, err := os.Stat(d + "/temp1_input"); err == nil {
					m.tempPath = d + "/temp1_input"
					if strings.TrimSpace(string(name)) != "acpitz" {
						return // prefer a real CPU sensor over ACPI
					}
				}
			}
		}
	})
	if m.tempPath == "" {
		return 0
	}
	b, err := os.ReadFile(m.tempPath)
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseFloat(strings.TrimSpace(string(b)), 64)
	return v / 1000
}
