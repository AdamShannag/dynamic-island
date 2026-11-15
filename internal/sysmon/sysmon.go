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
	// Background sampling while someone is watching: Sample() returns the
	// latest snapshot instantly instead of measuring on the request path.
	snapMu    sync.Mutex
	snap      *Snapshot
	lastAsked time.Time
	running   bool

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

const (
	sampleEvery = time.Second
	idleStop    = 5 * time.Second // stop sampling this long after the last request
)

// Sample returns the latest metrics. The first request after a quiet period
// measures synchronously (with a short baseline); after that a background
// sampler keeps a fresh snapshot ready, so requests return immediately.
func (m *Monitor) Sample() Snapshot {
	m.snapMu.Lock()
	m.lastAsked = time.Now()
	snap, running := m.snap, m.running
	if !running {
		m.running = true
	}
	m.snapMu.Unlock()
	if !running {
		first := m.sampleNow(true)
		go m.loop()
		return first
	}
	if snap == nil {
		return m.sampleNow(false)
	}
	return *snap
}

func (m *Monitor) loop() {
	t := time.NewTicker(sampleEvery)
	defer t.Stop()
	for range t.C {
		m.snapMu.Lock()
		if time.Since(m.lastAsked) > idleStop {
			m.running, m.snap = false, nil
			m.snapMu.Unlock()
			return
		}
		m.snapMu.Unlock()
		m.sampleNow(false)
	}
}

func (m *Monitor) sampleNow(baseline bool) Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	if baseline || m.prevT.IsZero() || time.Since(m.prevT) > stale {
		m.measure(nil)
		time.Sleep(120 * time.Millisecond)
	}
	var s Snapshot
	m.measure(&s)
	m.snapMu.Lock()
	m.snap = &s
	m.snapMu.Unlock()
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

// readProcTicks returns utime+stime for every process. It reuses one
// buffer and parses fields in place (no per-process allocations).
func readProcTicks() map[int]uint64 {
	f, err := os.Open("/proc")
	if err != nil {
		return nil
	}
	names, _ := f.Readdirnames(-1)
	f.Close()
	out := make(map[int]uint64, len(names))
	buf := make([]byte, 1024)
	path := make([]byte, 0, 32)
	for _, name := range names {
		pid, err := strconv.Atoi(name)
		if err != nil {
			continue
		}
		path = append(append(append(path[:0], "/proc/"...), name...), "/stat"...)
		fd, err := syscall.Open(string(path), syscall.O_RDONLY, 0)
		if err != nil {
			continue
		}
		n, _ := syscall.Read(fd, buf)
		syscall.Close(fd)
		if n <= 0 {
			continue
		}
		b := buf[:n]
		r := bytes.LastIndexByte(b, ')')
		if r < 0 {
			continue
		}
		// Fields after ')': state(0) … utime(11) stime(12).
		field, start, ut := 0, -1, uint64(0)
		for i := r + 1; i <= len(b); i++ {
			if i == len(b) || b[i] == ' ' {
				if start >= 0 {
					if field == 11 || field == 12 {
						v, _ := strconv.ParseUint(string(b[start:i]), 10, 64)
						if field == 11 {
							ut = v
						} else {
							out[pid] = ut + v
							break
						}
					}
					field++
					start = -1
				}
			} else if start < 0 {
				start = i
			}
		}
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
