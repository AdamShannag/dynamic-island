package docker

import (
	"os/exec"
	"strings"
	"testing"
)

func TestClassify(t *testing.T) {
	cases := map[string]string{
		"Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?": ErrNotRunning,
		"permission denied while trying to connect to the Docker daemon socket":                             ErrPermission,
	}
	for stderr, want := range cases {
		err := classify(&exec.ExitError{Stderr: []byte(stderr)})
		if !strings.HasPrefix(err.Error(), want) {
			t.Errorf("%q -> %v, want %s", stderr, err, want)
		}
	}
	if err := classify(&exec.Error{Name: "docker", Err: exec.ErrNotFound}); !strings.HasPrefix(err.Error(), ErrNotInstalled) {
		t.Errorf("not found -> %v", err)
	}
}
