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

const LOOK_X = 2.5; // max px the eyes shift toward the cursor
const LOOK_Y = 1.5;

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
        this._look = [0, 0];
        this._orbit = 0;
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

    // Called ~30×/s with the pointer offset from the face, in px.
    track(dx, dy) {
        if (this._mood === 'sleep' || this._spyOn)
            return;
        let tx, ty;
        if (this._mood === 'dizzy') {
            this._orbit += 0.35;
            tx = Math.cos(this._orbit) * 2.2;
            ty = Math.sin(this._orbit) * 2.2;
        } else {
            tx = Math.max(-1, Math.min(1, dx / 260)) * LOOK_X;
            ty = Math.max(-1, Math.min(1, dy / 160)) * LOOK_Y;
        }
        // Ease toward the target so motion stays soft at 30 fps.
        const step = (cur, t) => (Math.abs(t - cur) < 0.02 ? t : cur + (t - cur) * 0.35);
        const nx = step(this._look[0], tx), ny = step(this._look[1], ty);
        if (nx === this._look[0] && ny === this._look[1] && this._mood !== 'dizzy')
            return; // settled: no redraw
        this._look = [nx, ny];
        for (const [i, {dot, glyph}] of this._eyes.entries()) {
            const x = this._mood === 'dizzy' && i === 1 ? -nx : nx;
            dot.translation_x = glyph.translation_x = x;
            dot.translation_y = glyph.translation_y = ny;
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
        for (const id of [this._moodTimer, this._blinkTimer, this._zzzTimer]) {
            if (id)
                GLib.source_remove(id);
        }
        this._moodTimer = this._blinkTimer = this._zzzTimer = 0;
    }
}
