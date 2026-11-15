package clipboard

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/paths"
)

const (
	maxItems   = 200
	maxTextLen = 100_000
)

type Item struct {
	ID     uint32 `json:"id"`
	Text   string `json:"text"`
	Pinned bool   `json:"pinned"`
	At     int64  `json:"at"`
}

type Store struct {
	mu    sync.Mutex
	path  string
	items []Item
	next  uint32
}

func DefaultPath() string { return paths.DataFile("clipboard.json") }

func Open(path string) (*Store, error) {
	s := &Store{path: path, next: 1}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(b, &s.items); err != nil {
		return s, err
	}
	for _, it := range s.items {
		s.next = max(s.next, it.ID+1)
	}
	return s, nil
}

func (s *Store) Add(text string) error {
	if strings.TrimSpace(text) == "" || len(text) > maxTextLen {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	it := Item{ID: s.next, Text: text, At: time.Now().UnixMilli()}
	for i, old := range s.items {
		if old.Text == text {
			if i == 0 {
				return nil
			}
			it.ID, it.Pinned = old.ID, old.Pinned
			s.items = append(s.items[:i], s.items[i+1:]...)
			break
		}
	}
	if it.ID == s.next {
		s.next++
	}
	s.items = append([]Item{it}, s.items...)

	kept, unpinned := s.items[:0], 0
	for _, x := range s.items {
		if !x.Pinned {
			if unpinned++; unpinned > maxItems {
				continue
			}
		}
		kept = append(kept, x)
	}
	s.items = kept
	return s.save()
}

func (s *Store) List() []Item {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Item, 0, len(s.items))
	for _, pinned := range []bool{true, false} {
		for _, it := range s.items {
			if it.Pinned == pinned {
				out = append(out, it)
			}
		}
	}
	return out
}

func (s *Store) Delete(id uint32) error {
	return s.mutate(func() {
		for i, it := range s.items {
			if it.ID == id {
				s.items = append(s.items[:i], s.items[i+1:]...)
				return
			}
		}
	})
}

func (s *Store) SetPinned(id uint32, pinned bool) error {
	return s.mutate(func() {
		for i := range s.items {
			if s.items[i].ID == id {
				s.items[i].Pinned = pinned
			}
		}
	})
}

func (s *Store) Clear() error {
	return s.mutate(func() {
		kept := s.items[:0]
		for _, it := range s.items {
			if it.Pinned {
				kept = append(kept, it)
			}
		}
		s.items = kept
	})
}

func (s *Store) mutate(fn func()) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn()
	return s.save()
}

func (s *Store) save() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(s.items)
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
