import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {scale} from './constants.js';
import {CriticalSpring, frameLoop} from './motion.js';

const BUTTON_PX = 32;
const ICON_PX = 17;
const SETTLE_FRAMES = 8;

export class TabBar {
    constructor(tabs, onSelect) {
        this.actor = new St.Widget({
            style_class: 'island-tabs', layout_manager: new Clutter.FixedLayout(), y_align: Clutter.ActorAlign.CENTER,
        });
        this._indicator = new St.Widget({style_class: 'island-tab-indicator', x: 0, y: 0});
        const row = new St.BoxLayout({style_class: 'island-tabs-row', x: 0, y: 0});
        this.actor.add_child(this._indicator);
        this.actor.add_child(row);
        this._buttons = {};
        this._dots = {};
        for (const [id, name, icon] of tabs) {
            const k = scale();
            const face = new St.Widget({width: BUTTON_PX * k, height: BUTTON_PX * k});
            const inset = Math.round((BUTTON_PX - ICON_PX) / 2 * k);
            face.add_child(new St.Icon({icon_name: icon, style_class: 'island-tab-icon', icon_size: ICON_PX, x: inset, y: inset}));
            const dot = new St.Widget({style_class: 'island-tab-dot', visible: false,
                x: Math.round(21 * k), y: Math.round(4 * k)});
            face.add_child(dot);
            this._dots[id] = dot;
            const btn = new St.Button({style_class: 'island-tab', can_focus: true, accessible_name: name, child: face});
            btn.connect('clicked', () => onSelect(id));
            row.add_child(btn);
            this._buttons[id] = btn;
        }
        this._spring = new CriticalSpring(2);
        this._placed = false;
        this._loop = null;
        this.selected = null;
    }

    setVisible(id, visible) {
        if (this._buttons[id])
            this._buttons[id].visible = visible;
    }

    setDot(id, on) {
        if (this._dots[id])
            this._dots[id].visible = on;
    }

    select(id) {
        for (const [tid, btn] of Object.entries(this._buttons))
            btn.checked = tid === id;
        this.selected = id;
        this._indicator.visible = !!id;
        if (id)
            this.follow();
    }

    follow() {
        if (this._loop)
            return;
        const sp = this._spring;
        sp.lastT = 0;
        let still = 0;
        this._loop = frameLoop(this._indicator, () => {
            const btn = this._buttons[this.selected];
            if (!btn)
                return true;
            const target = [btn.x, btn.width];
            if (!this._placed) {
                sp.jump(target);
                this._placed = btn.width > 0;
            }
            const moving = sp.step(target);
            this._indicator.set_position(Math.round(sp.pos[0] * 2) / 2, btn.y);
            this._indicator.set_size(Math.max(0, sp.pos[1]), btn.height);
            still = moving ? 0 : still + 1;
            if (still > SETTLE_FRAMES) {
                this._loop = null;
                return false;
            }
            return true;
        });
    }

    destroy() {
        this._loop?.stop();
        this._loop = null;
    }
}
