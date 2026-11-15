package inbox

import (
	"sync"
	"time"
)

type Item struct {
	ID           uint32 `json:"id"`
	App          string `json:"app"`
	DesktopEntry string `json:"desktopEntry,omitempty"`
	Icon         string `json:"icon,omitempty"`
	Art          string `json:"art,omitempty"`
	Title        string `json:"title"`
	Body         string `json:"body,omitempty"`
	At           int64  `json:"at"`
}

const keep = 200

var (
	mu    sync.Mutex
	items []Item
	next  uint32 = 1
)

func Add(it Item) {
	mu.Lock()
	defer mu.Unlock()
	it.ID, it.At = next, time.Now().UnixMilli()
	next++
	items = append([]Item{it}, items...)
	if len(items) > keep {
		items = items[:keep]
	}
}

func List() []Item {
	mu.Lock()
	defer mu.Unlock()
	return append([]Item{}, items...)
}

func Remove(id uint32) {
	mu.Lock()
	defer mu.Unlock()
	for i, it := range items {
		if it.ID == id {
			items = append(items[:i], items[i+1:]...)
			return
		}
	}
}

func Clear() {
	mu.Lock()
	defer mu.Unlock()
	items = nil
}
