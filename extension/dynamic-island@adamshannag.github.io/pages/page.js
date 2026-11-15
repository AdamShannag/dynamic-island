import {DASH_DEFAULT_HEIGHT} from '../lib/constants.js';

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
        return this.constructor.title;
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
