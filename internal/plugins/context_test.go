package plugins

import (
	"strings"
	"testing"
	"time"
)

func TestClassify(t *testing.T) {
	cases := []struct {
		cmd   string
		title string
		k     kind
		ok    bool
	}{
		{"go mod tidy", "go mod tidy", kindTask, true},
		{"/usr/local/go/bin/go test -race ./...", "go test ./...", kindTask, true},
		{"go run ./cmd/api", "go run ./cmd/api", kindRun, true},
		{"go list -json ./...", "", 0, false},
		{"go version", "", 0, false},
		{"java -Dmaven.home=/opt/mvn -classpath x org.codehaus.plexus.classworlds.launcher.Launcher clean install -DskipTests", "mvn clean install", kindTask, true},
		{"java -cp x org.codehaus.classworlds.Launcher -Didea.version=2026 spring-boot:run", "mvn spring-boot:run", kindRun, true},
		{"java -cp gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain bootRun", "gradle bootRun", kindRun, true},
		{"java -javaagent:/opt/idea/lib/idea_rt.jar=1234 -classpath /p/out com.acme.api.ApiApplication", "run ApiApplication", kindRun, true},
		{"node /usr/bin/npm run dev", "npm run dev", kindRun, true},
		{"node /usr/bin/npm install", "npm install", kindTask, true},
		{"node /usr/bin/npm run build", "npm run build", kindTask, true},
		{"pnpm test", "pnpm test", kindTask, true},
		{"cargo build --release", "cargo build", kindTask, true},
		{"docker build -t x .", "docker build", kindTask, true},
		{"docker ps", "", 0, false},
		{"python3 -m pytest tests", "pytest", kindTask, true},
		{"/tmp/GoLand/___go_build_github_com_acme_cmd_api", "run api", kindRun, true},
		{"bash", "", 0, false},
		{"make -C /some/dir -j8 build", "make build", kindTask, true},
		{"make VAR=1 test", "make test", kindTask, true},
	}
	for _, c := range cases {
		p := &procInfo{pid: 10, ppid: 1, args: strings.Fields(c.cmd)}
		title, k, ok := classify(p, map[int]*procInfo{10: p})
		if ok != c.ok || title != c.title || (ok && k != c.k) {
			t.Errorf("%q: got (%q, %v, %v), want (%q, %v, %v)", c.cmd, title, k, ok, c.title, c.k, c.ok)
		}
	}
}

func TestWrapperChildIgnored(t *testing.T) {
	parent := &procInfo{pid: 10, ppid: 1, args: []string{"make", "build"}}
	child := &procInfo{pid: 11, ppid: 10, args: []string{"go", "build", "./..."}}
	procs := map[int]*procInfo{10: parent, 11: child}
	if _, _, ok := classify(child, procs); ok {
		t.Fatal("child of a tracked wrapper should not be tracked separately")
	}
}

func TestExpectedFromLastRun(t *testing.T) {
	c := NewContext()
	done := &tracked{pid: 1, title: "go test", project: "island", kind: kindTask, start: time.Now().Add(-40 * time.Second), shown: true}
	c.remember(done)
	c.remember(&tracked{pid: 2, title: "vite", project: "island", kind: kindRun, start: time.Now().Add(-time.Minute), shown: true})
	c.tracked[3] = &tracked{pid: 3, title: "go test", project: "island", kind: kindTask, start: time.Now(), shown: true}
	c.tracked[4] = &tracked{pid: 4, title: "go test", project: "other", kind: kindTask, start: time.Now(), shown: true}
	c.tracked[5] = &tracked{pid: 5, title: "vite", project: "island", kind: kindRun, start: time.Now(), shown: true}
	for _, it := range c.List() {
		switch it.PID {
		case 3:
			if it.Expected < 39000 || it.Expected > 41000 {
				t.Fatalf("expected ~40s for a repeat run, got %dms", it.Expected)
			}
		case 4, 5:
			if it.Expected != 0 {
				t.Fatalf("pid %d: no estimate expected, got %dms", it.PID, it.Expected)
			}
		}
	}
}

func TestPlayerName(t *testing.T) {
	for bus, want := range map[string]string{
		"org.mpris.MediaPlayer2.spotify":                "Spotify",
		"org.mpris.MediaPlayer2.firefox.instance_1_234": "Firefox",
		"org.mpris.MediaPlayer2.":                       "",
	} {
		if got := playerName(bus); got != want {
			t.Fatalf("playerName(%q) = %q, want %q", bus, got, want)
		}
	}
}
