package plugins

import (
	"strings"
	"testing"
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
		{"go list -json ./...", "", 0, false}, // gopls noise
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
