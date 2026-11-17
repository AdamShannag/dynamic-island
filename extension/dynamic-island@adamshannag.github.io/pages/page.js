import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {
    DASH_DEFAULT_HEIGHT, HOME_TAB, REVEAL_MS, REVEAL_RISE, REVEAL_STEP_MS, scale, tabInfo,
} from '../lib/constants.js';

export class Page {
    static id = '';
    static title = '';
    static parent = undefined;
    static height = DASH_DEFAULT_HEIGHT;
    static autoHeight = false;
    static interval = 0;

    constructor(island) {
        this.island = island;
        this.actor = this.build();
    }

    get id() {
        return this.constructor.id;
    }

    get parentTab() {
        return this.constructor.parent === undefined ? this.id : this.constructor.parent;
    }

    get heading() {
        return this.constructor.title || (tabInfo(this.id)?.[1] ?? '');
    }

    get navActions() {
        return null;
    }

    get backTab() {
        const parent = this.constructor.parent;
        return parent && parent !== this.id ? parent : HOME_TAB;
    }

    get height() {
        return this.constructor.height;
    }

    get autoHeight() {
        return this.constructor.autoHeight;
    }

    get interval() {
        return this.constructor.interval;
    }

    get ext() {
        return this.island.ext;
    }

    get active() {
        return this.island.dashOpen && this.island.tab === this.id;
    }

    call(method, args = [], cb = null) {
        this.ext.call(method, args, cb);
    }

    fetch(method, args, cb) {
        this.ext.callJson(method, args, (value, err) => {
            if (this.active)
                cb(value, err);
        });
    }

    refit() {
        this.island.refit();
    }

    close() {
        this.island.closeDash();
    }

    blocks() {
        return this.actor.get_children();
    }

    reveal() {
        const animate = St.Settings.get().enable_animations;
        const rise = REVEAL_RISE * scale();
        this.blocks().forEach((a, i) => {
            a.remove_all_transitions();
            if (!animate) {
                a.set({opacity: 255, translation_y: 0});
                return;
            }
            a.set({opacity: 0, translation_y: rise});
            a.ease({
                opacity: 255, translation_y: 0, duration: REVEAL_MS, delay: i * REVEAL_STEP_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        });
    }

    settle() {
        for (const a of this.blocks()) {
            a.remove_all_transitions();
            a.set({opacity: 255, translation_y: 0});
        }
    }

    build() {
        throw new Error(`${this.constructor.name} must implement build()`);
    }

    onShow() {
        this.refresh();
        return null;
    }

    onHide() {}

    refresh() {}

    onState() {}

    onSettings() {}

    tick() {}

    destroy() {}
}
