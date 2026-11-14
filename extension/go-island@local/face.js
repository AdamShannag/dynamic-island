// The island's face: two little eyes that live next to the clock.
//
//   normal     eyes follow the cursor and blink every few seconds
//   dizzy      eyes orbit (heavy CPU load)
//   love       eyes turn into hearts (something succeeded)
//   squint     > <  (slapped / shaken)
//   surprised  eyes pop wide (a USB device was plugged in)
//   sleep      eyes closed, floating Zs (idle for a while)
//   spy        sunglasses (presentation mode)
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

const LOOK_X = 3;   // max logical px the eyes shift toward the cursor
const LOOK_Y = 2;
// Critically damped spring: no overshoot, ~0.25 s to settle. Integrated
// exactly per frame, so it feels the same at 60, 144 or 240 Hz and never
// stutters when a frame arrives late.
const SPRING_OMEGA = 18;  // rad/s; higher = snappier
const DIZZY_SPEED = 9;    // rad/s of eye orbit
const SETTLE_FRAMES = 12; // stop the frame loop after this many still frames

const scaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

export class Face {
    constructor(spyIcon) {
        this.actor = new St.BoxLayout({style_class: 'goisland-face', y_align: Clutter.ActorAlign.CENTER});
        this._eyesBox = new St.BoxLayout({style_class: 'goisland-eyes', y_align: Clutter.ActorAlign.CENTER});
        this._eyes = [0, 1].map(() => {
            const eye = new St.Widget({style_class: 'goisland-eye', layout_manager: new Clutter.BinLayout()});
            const dot = new St.Widget({
                style_class: 'goisland-eye-dot',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            dot.set_pivot_point(0.5, 0.5);
            const glyph = new St.Label({
                style_class: 'goisland-eye-glyph',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                visible: false,
            });
            glyph.clutter_text.ellipsize = 0; // Pango.EllipsizeMode.NONE: glyphs may overhang
            eye.add_child(dot);
            eye.add_child(glyph);
            this._eyesBox.add_child(eye);
            return {eye, dot, glyph};
        });
        this._spy = new St.Icon({gicon: spyIcon, style_class: 'goisland-spy', visible: false, y_align: Clutter.ActorAlign.CENTER});
        this._zzz = new St.Label({style_class: 'goisland-zzz', text: 'z', opacity: 0, y_align: Clutter.ActorAlign.START});
        this.actor.add_child(this._eyesBox);
        this.actor.add_child(this._spy);
        this.actor.add_child(this._zzz);

        this._base = 'normal'; // mood to return to after a temporary one
        this._mood = 'normal';
        this._moodTimer = 0;
        this._blinkTimer = 0;
        this._zzzTimer = 0;
        // Per-axis spring state; target comes from the cursor provider.
        this._pos = [0, 0];
        this._vel = [0, 0];
        this._orbit = 0;
        this._tl = null;
        this._lastT = 0;
        this._still = 0;
        this._provider = null; // () => [dx, dy] from the face centre to the cursor
        this.actor.connect('notify::mapped', () => {
            if (!this.actor.mapped)
                this._stopLoop();
        });
        this._spyOn = false;
        this._scheduleBlink();
    }

    get mood() {
        return this._mood;
    }

    // Temporary moods revert to the base mood after `ms`.
    setMood(mood, ms = 0) {
        if (this._spyOn && mood !== 'spy')
            return;
        if (this._moodTimer)
            GLib.source_remove(this._moodTimer);
        this._moodTimer = 0;
        if (ms > 0) {
            this._moodTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._moodTimer = 0;
                this._applyMood(this._base);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._base = mood;
        }
        this._applyMood(mood);
    }

    setSpy(on) {
        this._spyOn = on;
        this._eyesBox.visible = !on;
        this._spy.visible = on;
        if (!on)
            this._applyMood(this._base);
    }

    _applyMood(mood) {
        this._mood = mood;
        if (mood === 'dizzy')
            this.wake();
        const glyphs = {love: ['♥', '♥'], squint: ['>', '<']}[mood];
        this._eyes.forEach(({dot, glyph}, i) => {
            dot.remove_all_transitions();
            dot.visible = !glyphs;
            glyph.visible = !!glyphs;
            if (glyphs)
                glyph.text = glyphs[i];
            glyph.style_class = `goisland-eye-glyph ${mood}`;
            const [sx, sy] = {sleep: [1.1, 0.18], surprised: [1.35, 1.35]}[mood] ?? [1, 1];
            dot.ease({scale_x: sx, scale_y: sy, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
        this._syncZzz();
    }

    // The island supplies where the cursor is relative to the face.
    setTargetProvider(fn) {
        this._provider = fn;
    }

    // Start the frame-synced animation loop (idempotent). The island calls
    // this when the cursor moves; the loop stops itself once the eyes settle,
    // so a still cursor costs nothing.
    wake() {
        if (this._tl || this._spyOn || this._mood === 'sleep' || !this.actor.mapped || !this._provider)
            return;
        this._lastT = 0;
        this._still = 0;
        // A timeline bound to the actor runs on its stage view's frame
        // clock: exactly one update per displayed frame.
        const tl = new Clutter.Timeline({actor: this.actor, duration: 1000, repeat_count: -1});
        tl.connect('new-frame', () => this._frame());
        this._tl = tl;
        tl.start();
    }

    _stopLoop() {
        if (this._tl) {
            this._tl.stop();
            this._tl = null;
        }
    }

    _frame() {
        if (this._mood === 'sleep' || this._spyOn) {
            this._stopLoop();
            return;
        }
        const now = GLib.get_monotonic_time() / 1e6;
        const dt = this._lastT ? Math.min(0.05, Math.max(0.001, now - this._lastT)) : 1 / 60;
        this._lastT = now;
        const k = scaleFactor();

        let tx, ty;
        if (this._mood === 'dizzy') {
            this._orbit += dt * DIZZY_SPEED;
            tx = Math.cos(this._orbit) * 2.4 * k;
            ty = Math.sin(this._orbit) * 2.4 * k;
        } else {
            const [dx, dy] = this._provider();
            // Soft saturation: responsive near the face, gently capped far away.
            tx = Math.tanh(dx / (220 * k)) * LOOK_X * k;
            ty = Math.tanh(dy / (140 * k)) * LOOK_Y * k;
        }

        // Exact critically damped spring step for each axis.
        const w = SPRING_OMEGA, e = Math.exp(-w * dt);
        let moving = false;
        for (const [a, target] of [[0, tx], [1, ty]]) {
            const x = this._pos[a] - target, v = this._vel[a];
            const nx = (x + (v + w * x) * dt) * e;
            const nv = (v - w * (v + w * x) * dt) * e;
            this._pos[a] = target + nx;
            this._vel[a] = nv;
            if (Math.abs(nx) > 0.01 || Math.abs(nv) > 0.05)
                moving = true;
        }
        for (const [i, {dot, glyph}] of this._eyes.entries()) {
            const x = this._mood === 'dizzy' && i === 1 ? -this._pos[0] : this._pos[0];
            dot.translation_x = glyph.translation_x = x;
            dot.translation_y = glyph.translation_y = this._pos[1];
        }

        if (moving || this._mood === 'dizzy') {
            this._still = 0;
        } else if (++this._still >= SETTLE_FRAMES) {
            this._stopLoop(); // settled: zero work until the cursor moves again
        }
    }

    blink() {
        if (this._mood !== 'normal' || this._spyOn)
            return;
        for (const {dot} of this._eyes) {
            dot.ease({
                scale_y: 0.1,
                duration: 70,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => dot.ease({scale_y: 1, duration: 110, mode: Clutter.AnimationMode.EASE_OUT_QUAD}),
            });
        }
    }

    _scheduleBlink() {
        this._blinkTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500 + Math.random() * 3500, () => {
            this.blink();
            if (Math.random() < 0.2) { // the occasional double blink
                this._blinkTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
                    this.blink();
                    this._scheduleBlink();
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                this._scheduleBlink();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncZzz() {
        const sleeping = this._mood === 'sleep' && !this._spyOn;
        if (sleeping && !this._zzzTimer) {
            let n = 0;
            const puff = () => {
                const big = n++ % 3 === 2;
                this._zzz.text = big ? 'Z' : 'z';
                this._zzz.remove_all_transitions();
                this._zzz.set({opacity: 0, translation_y: 4, translation_x: 0});
                this._zzz.ease({
                    opacity: 220, translation_y: -3, translation_x: 3,
                    duration: 900, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => this._zzz.ease({opacity: 0, duration: 500}),
                });
                return GLib.SOURCE_CONTINUE;
            };
            puff();
            this._zzzTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, puff);
        } else if (!sleeping && this._zzzTimer) {
            GLib.source_remove(this._zzzTimer);
            this._zzzTimer = 0;
            this._zzz.remove_all_transitions();
            this._zzz.opacity = 0;
        }
    }

    destroy() {
        this._stopLoop();
        for (const id of [this._moodTimer, this._blinkTimer, this._zzzTimer]) {
            if (id)
                GLib.source_remove(id);
        }
        this._moodTimer = this._blinkTimer = this._zzzTimer = 0;
    }
}
