package draw

import "time"

func (e *Engine) SetRoundDuration(d time.Duration) {
	e.mu.Lock()
	e.roundDuration = d
	e.mu.Unlock()
}
