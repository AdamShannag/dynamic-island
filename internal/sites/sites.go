// Package sites stores the user's saved sites (quick-launch bookmarks) and
// caches each site's own icon, fetched directly from the site.
package sites

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Site struct {
	ID   uint32 `json:"id"`
	Name string `json:"name"`
	URL  string `json:"url"`
	Icon string `json:"icon,omitempty"` // local file, once fetched
}

type Store struct {
	mu      sync.Mutex
	path    string
	iconDir string
	sites   []Site
	next    uint32
}

func dataDir() string {
	dir := os.Getenv("XDG_DATA_HOME")
	if dir == "" {
		dir = filepath.Join(os.Getenv("HOME"), ".local", "share")
	}
	return filepath.Join(dir, "go-island")
}

func Open() (*Store, error) {
	s := &Store{path: filepath.Join(dataDir(), "sites.json"), iconDir: filepath.Join(dataDir(), "site-icons"), next: 1}
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(b, &s.sites); err != nil {
		return s, err
	}
	for _, x := range s.sites {
		s.next = max(s.next, x.ID+1)
	}
	// Retry icons that failed earlier (e.g. offline at the time).
	for _, x := range s.sites {
		if x.Icon == "" {
			go s.fetchIcon(x.ID, x.URL)
		}
	}
	return s, nil
}

func (s *Store) List() []Site {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Site{}, s.sites...)
}

// Add saves a site. raw may omit the scheme ("github.com").
func (s *Store) Add(raw, name string) (Site, error) {
	raw = strings.TrimSpace(raw)
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return Site{}, fmt.Errorf("not a valid web address: %q", raw)
	}
	if name = strings.TrimSpace(name); name == "" {
		name = defaultName(u.Hostname())
	}
	s.mu.Lock()
	site := Site{ID: s.next, Name: name, URL: u.String()}
	s.next++
	s.sites = append(s.sites, site)
	err = s.save()
	s.mu.Unlock()
	go s.fetchIcon(site.ID, site.URL)
	return site, err
}

func (s *Store) Remove(id uint32) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, x := range s.sites {
		if x.ID == id {
			s.sites = append(s.sites[:i], s.sites[i+1:]...)
			return s.save()
		}
	}
	return fmt.Errorf("no site %d", id)
}

// fetchIcon tries the site's apple-touch-icon (high-res) then favicon.ico.
func (s *Store) fetchIcon(id uint32, rawURL string) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return
	}
	sum := sha1.Sum([]byte(u.Host))
	base := filepath.Join(s.iconDir, hex.EncodeToString(sum[:8]))
	for _, p := range []string{"/apple-touch-icon.png", "/favicon.ico"} {
		dst := base + filepath.Ext(p)
		if fileOK(dst) || download(u.Scheme+"://"+u.Host+p, dst) == nil {
			s.mu.Lock()
			for i := range s.sites {
				if s.sites[i].ID == id {
					s.sites[i].Icon = dst
				}
			}
			_ = s.save()
			s.mu.Unlock()
			return
		}
	}
}

func fileOK(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Size() > 0
}

func download(src, dst string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64)")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	ct := resp.Header.Get("Content-Type")
	if resp.StatusCode != http.StatusOK || strings.HasPrefix(ct, "text/") {
		return fmt.Errorf("no icon at %s", src) // many sites serve an HTML 404 page
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil || len(b) == 0 {
		return fmt.Errorf("empty icon")
	}
	return os.WriteFile(dst, b, 0o644)
}

func (s *Store) save() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s.sites, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// defaultName turns "news.ycombinator.com" into "Ycombinator" and
// "localhost" into "Localhost": short enough for a tile label.
func defaultName(host string) string {
	labels := strings.Split(strings.TrimPrefix(host, "www."), ".")
	n := labels[0]
	if len(labels) >= 2 {
		n = labels[len(labels)-2]
	}
	if n == "" {
		return host
	}
	return strings.ToUpper(n[:1]) + n[1:]
}
