package paths

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const (
	AppName    = "dynamic-island"
	legacyName = "go-island"
)

func Data() string   { return filepath.Join(dataBase(), AppName) }
func Config() string { return filepath.Join(configBase(), AppName) }
func Cache() string  { return filepath.Join(cacheBase(), AppName) }

func DataFile(name ...string) string   { return filepath.Join(append([]string{Data()}, name...)...) }
func ConfigFile(name ...string) string { return filepath.Join(append([]string{Config()}, name...)...) }
func CacheFile(name ...string) string  { return filepath.Join(append([]string{Cache()}, name...)...) }

func dataBase() string   { return xdg("XDG_DATA_HOME", ".local", "share") }
func configBase() string { return xdg("XDG_CONFIG_HOME", ".config") }
func cacheBase() string  { return xdg("XDG_CACHE_HOME", ".cache") }

func xdg(env string, fallback ...string) string {
	if dir := os.Getenv(env); filepath.IsAbs(dir) {
		return dir
	}
	return filepath.Join(append([]string{home()}, fallback...)...)
}

func home() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return os.TempDir()
}

func Migrate() error {
	var errs []error
	for _, base := range []string{dataBase(), configBase(), cacheBase()} {
		if err := migrateDir(filepath.Join(base, legacyName), filepath.Join(base, AppName)); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func migrateDir(oldDir, newDir string) error {
	if fi, err := os.Stat(oldDir); err != nil || !fi.IsDir() {
		return nil
	}
	if _, err := os.Lstat(newDir); err == nil || !errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(newDir), 0o700); err != nil {
		return fmt.Errorf("migrate %s: %w", oldDir, err)
	}
	if err := os.Rename(oldDir, newDir); err != nil {
		return fmt.Errorf("migrate %s -> %s: %w", oldDir, newDir, err)
	}
	return nil
}
