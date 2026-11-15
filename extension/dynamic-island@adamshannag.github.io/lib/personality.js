import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {
    CPU_DIZZY, POINTER_MS, SHAKE_MIN_PX, SHAKE_REVERSALS, SHAKE_WINDOW_MS, SLEEP_AFTER_MS, WATCH_ACTIVE_MS,
    WATCH_IDLE_MS,
} from './constants.js';

const CPU_SAMPLE_S = 4;
const WOBBLE_MS = 760;

function readCpu() {
    const [, bytes] = GLib.file_get_contents('/proc/stat');
    const f = new TextDecoder().decode(bytes).split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
    return [f[3] + (f[4] || 0), f.reduce((a, b) => a + b, 0)];
}

export function countReversals(samples, minPx = SHAKE_MIN_PX) {
    let reversals = 0, dir = 0, anchor = samples[0]?.[1];
    for (let i = 1; i < samples.length; i++) {
        const d = samples[i][1] - anchor;
        if (Math.abs(d) < minPx)
            continue;
        if (dir && Math.sign(d) !== dir)
            reversals++;
        dir = Math.sign(d);
        anchor = samples[i][1];
    }
    return reversals;
}

export class Personality {
    constructor(island, face) {
        this._island = island;
        this._face = face;
        this._asleep = false;
        this._wobbleTl = null;
        this._shake = [];
        this._cpuPrev = null;
        this._cpuHot = 0;
        this._lastPointer = [NaN, NaN];
        this._schedulePointer(POINTER_MS);
        this._cpuId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CPU_SAMPLE_S, () => {
            this._sampleCpu();
            return GLib.SOURCE_CONTINUE;
        });
        this._idleMon = global.backend.get_core_idle_monitor();
        this._idleWatch = this._idleMon.add_idle_watch(SLEEP_AFTER_MS, () => this._setAsleep(true));
        this._activeWatch = 0;
    }

    destroy() {
        for (const id of [this._pointerId, this._cpuId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._pointerId = this._cpuId = 0;
        for (const w of [this._idleWatch, this._activeWatch]) {
            if (w)
                this._idleMon.remove_watch(w);
        }
        this._idleWatch = this._activeWatch = 0;
        this._wobbleTl?.stop();
    }

    react(prev, state) {
        if (this._asleep)
            return;
        if (prev.accent === 'ok' && state.title !== prev.title)
            this._face.setMood('love', 2600);
        if (state.kind === 'usb' && (prev.kind !== 'usb' || prev.title !== state.title)) {
            this._face.setMood('surprised', 5000);
            this._island.bounce();
        }
    }

    wobble() {
        if (this._wobbleTl)
            return;
        const actor = this._island;
        this._face.setMood('squint', 900);
        const tl = new Clutter.Timeline({actor, duration: WOBBLE_MS});
        tl.connect('new-frame', () => {
            const t = tl.get_elapsed_time() / WOBBLE_MS;
            const a = Math.sin(t * Math.PI * 5) * Math.pow(1 - t, 2) * 0.14;
            actor.scale_x = 1 + a;
            actor.scale_y = 1 - a * 0.8;
        });
        tl.connect('completed', () => {
            actor.scale_x = actor.scale_y = 1;
            this._wobbleTl = null;
        });
        this._wobbleTl = tl;
        tl.start();
    }

    _schedulePointer(ms) {
        this._pointerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._pointerId = 0;
            this._schedulePointer(this._onPointer());
            return GLib.SOURCE_REMOVE;
        });
    }

    _setAsleep(on) {
        this._asleep = on;
        this._face.setMood(on ? 'sleep' : this._cpuHot >= 2 ? 'dizzy' : 'normal');
        if (on && !this._activeWatch) {
            this._activeWatch = this._idleMon.add_user_active_watch(() => {
                this._activeWatch = 0;
                this._setAsleep(false);
            });
        }
    }

    _sampleCpu() {
        let idle, total;
        try {
            [idle, total] = readCpu();
        } catch {
            return;
        }
        if (this._cpuPrev) {
            const busy = 1 - (idle - this._cpuPrev[0]) / Math.max(1, total - this._cpuPrev[1]);
            this._cpuHot = busy > CPU_DIZZY ? this._cpuHot + 1 : busy < 0.6 ? 0 : this._cpuHot;
            if (!this._asleep) {
                if (this._cpuHot >= 2 && this._face.mood === 'normal')
                    this._face.setMood('dizzy');
                else if (this._cpuHot === 0 && this._face.mood === 'dizzy')
                    this._face.setMood('normal');
            }
        }
        this._cpuPrev = [idle, total];
    }

    _onPointer() {
        const island = this._island;
        const faceVisible = this._face.actor.mapped && !this._asleep;
        if (!faceVisible && !island.hover)
            return 1000;
        const [px, py] = global.get_pointer();
        const moved = px !== this._lastPointer[0] || py !== this._lastPointer[1];
        this._lastPointer = [px, py];
        if (faceVisible && moved)
            this._face.wake();
        const next = moved ? WATCH_ACTIVE_MS : WATCH_IDLE_MS;

        const resting = island.mode === 'idle' || island.mode === 'compact';
        if (!island.hover || !resting) {
            this._shake = [];
            return next;
        }
        const now = GLib.get_monotonic_time() / 1000;
        const h = this._shake;
        if (!h.length || h[h.length - 1][1] !== px)
            h.push([now, px]);
        while (h.length && now - h[0][0] > SHAKE_WINDOW_MS)
            h.shift();
        if (countReversals(h) >= SHAKE_REVERSALS) {
            this._shake = [];
            this.wobble();
        }
        return POINTER_MS;
    }
}
