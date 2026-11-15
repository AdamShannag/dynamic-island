package notes

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/AdamShannag/dynamic-island/internal/paths"
)

type Note struct {
	ID      uint32 `json:"id"`
	Text    string `json:"text"`
	Created int64  `json:"created"`
	Updated int64  `json:"updated"`
	Pinned  bool   `json:"pinned"`
}

const maxNoteLen = 1 << 20

type Store struct {
	mu    sync.Mutex
	dir   string
	notes []Note
	next  uint32
}

func Open() (*Store, error) {
	s := &Store{dir: paths.Data(), next: 1}
	b, err := os.ReadFile(s.path())
	switch {
	case err == nil:
		if err := json.Unmarshal(b, &s.notes); err != nil {
			return s, err
		}
	case errors.Is(err, os.ErrNotExist):
		s.importLegacy()
	default:
		return s, err
	}
	for _, n := range s.notes {
		s.next = max(s.next, n.ID+1)
	}
	return s, nil
}

func (s *Store) path() string { return filepath.Join(s.dir, "notes.json") }

func (s *Store) importLegacy() {
	old := filepath.Join(s.dir, "notes.md")
	b, err := os.ReadFile(old)
	if err != nil || len(b) == 0 {
		return
	}
	now := time.Now().UnixMilli()
	if st, err := os.Stat(old); err == nil {
		now = st.ModTime().UnixMilli()
	}
	s.notes = []Note{{ID: 1, Text: string(b), Created: now, Updated: now}}
	if s.save() == nil {
		_ = os.Rename(old, old+".imported")
	}
}

func (s *Store) List() []Note {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := append([]Note{}, s.notes...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Pinned != out[j].Pinned {
			return out[i].Pinned
		}
		return out[i].Updated > out[j].Updated
	})
	return out
}

func (s *Store) Create() (Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UnixMilli()
	n := Note{ID: s.next, Created: now, Updated: now}
	s.next++
	s.notes = append(s.notes, n)
	return n, s.save()
}

func (s *Store) Save(id uint32, text string) error {
	if len(text) > maxNoteLen {
		return fmt.Errorf("note too large")
	}
	return s.update(id, func(n *Note) {
		if n.Text != text {
			n.Text, n.Updated = text, time.Now().UnixMilli()
		}
	})
}

func (s *Store) Pin(id uint32, pinned bool) error {
	return s.update(id, func(n *Note) { n.Pinned = pinned })
}

func (s *Store) Delete(id uint32) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, n := range s.notes {
		if n.ID == id {
			s.notes = append(s.notes[:i], s.notes[i+1:]...)
			return s.save()
		}
	}
	return fmt.Errorf("no note %d", id)
}

func (s *Store) update(id uint32, fn func(*Note)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.notes {
		if s.notes[i].ID == id {
			fn(&s.notes[i])
			return s.save()
		}
	}
	return fmt.Errorf("no note %d", id)
}

func (s *Store) save() error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(s.notes)
	if err != nil {
		return err
	}
	tmp := s.path() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path())
}
