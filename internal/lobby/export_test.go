package lobby

import "time"

func SetHeartbeat(every, silence time.Duration) (restore func()) {
	prevEvery, prevSilence := heartbeatEvery.get(), silenceLimit.get()
	heartbeatEvery.set(every)
	silenceLimit.set(silence)
	return func() {
		heartbeatEvery.set(prevEvery)
		silenceLimit.set(prevSilence)
	}
}
