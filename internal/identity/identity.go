package identity

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"os/user"
	"strings"
	"sync"

	"github.com/AdamShannag/dynamic-island/internal/paths"
	"github.com/AdamShannag/dynamic-island/internal/settings"
)

const idFile = "peer-id"

var (
	mu    sync.Mutex
	known = map[string]string{}
)

func ID() (string, error) {
	file := paths.DataFile(idFile)
	mu.Lock()
	defer mu.Unlock()
	if id, ok := known[file]; ok {
		return id, nil
	}
	b, err := os.ReadFile(file)
	switch {
	case err == nil && strings.TrimSpace(string(b)) != "":
		known[file] = strings.TrimSpace(string(b))
		return known[file], nil
	case err != nil && !errors.Is(err, fs.ErrNotExist):
		return "", err
	}
	id := newID()
	if err := os.MkdirAll(paths.Data(), 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(file, []byte(id), 0o600); err != nil {
		return "", err
	}
	known[file] = id
	return id, nil
}

func Ephemeral() string {
	return newID()
}

func Name() string {
	if name := settings.Get().DisplayName; name != "" {
		return name
	}
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	return "Player"
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
