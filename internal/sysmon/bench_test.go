package sysmon

import "testing"

func BenchmarkProcTicks(b *testing.B) {
	for i := 0; i < b.N; i++ {
		readProcTicks()
	}
}

func TestProcTicksParse(t *testing.T) {
	m := readProcTicks()
	if len(m) < 10 {
		t.Fatalf("too few processes: %d", len(m))
	}
}
