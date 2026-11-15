package sysmon

import "testing"

func TestSample(t *testing.T) {
	m := New()
	s := m.Sample()
	if s.Cores < 1 || s.MemTotal == 0 || s.MemUsed == 0 || s.MemUsed > s.MemTotal || s.DiskTotal == 0 {
		t.Fatalf("implausible snapshot: %+v", s)
	}
	if s.CPU < 0 || s.CPU > 100 {
		t.Fatalf("cpu out of range: %v", s.CPU)
	}
	t.Logf("cpu=%.1f%% cores=%d load=%.2f temp=%.0fC mem=%d/%dMB disk=%d/%dGB top=%v",
		s.CPU, s.Cores, s.Load1, s.TempC, s.MemUsed>>20, s.MemTotal>>20, s.DiskUsed>>30, s.DiskTotal>>30, s.Top)
}
