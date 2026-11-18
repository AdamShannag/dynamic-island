package draw

import "time"

func (e *Engine) SetStepDurations(draw, guess time.Duration) {
	e.mu.Lock()
	e.drawDuration = draw
	e.guessDuration = guess
	e.mu.Unlock()
}
