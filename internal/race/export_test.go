package race

import "time"

func (e *Engine) SetRaceTimeout(d time.Duration) {
	e.mu.Lock()
	e.raceTimeout = d
	e.mu.Unlock()
}
