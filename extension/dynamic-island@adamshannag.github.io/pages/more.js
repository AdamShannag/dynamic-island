import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {SETTING_COLORS, TABS, scale, tabOn} from '../lib/constants.js';
import {pinHint, togglePin} from '../lib/bar.js';
import {frameLoop} from '../lib/motion.js';
import {column, label, page, pillButton, setMessage, setText} from '../lib/widgets.js';
import {Page} from './page.js';

const COLUMNS = 5;
const TILE_W = 128;
const TILE_H = 112;
const STAR_PX = 24;
const STAR_INSET = 6;
const WIGGLE_DEG = 1.4;
const WIGGLE_SPEED = 13;
const BROWSE_HINT = 'Open a tab, or tap Edit to choose what sits on the bar';
const center = {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER};

class Tile {
    constructor(id, name, icon, onClick, onStar) {
        const k = scale();
        this.id = id;
        this.actor = new St.Widget({layout_manager: new Clutter.FixedLayout(), width: TILE_W * k, height: TILE_H * k});
        this.actor.set_pivot_point(0.5, 0.5);
        const body = column({style_class: 'island-more-tile-body', ...center});
        const iconBadge = new St.Bin({style_class: 'island-more-badge', x_align: Clutter.ActorAlign.CENTER});
        iconBadge.set_style(`background-color: ${SETTING_COLORS[icon] ?? '#636366'};`);
        iconBadge.child = new St.Icon({icon_name: icon, style_class: 'island-more-badge-icon', ...center});
        body.add_child(iconBadge);
        body.add_child(label('island-more-name', {text: name, x_align: Clutter.ActorAlign.CENTER}));
        this._button = new St.Button({
            style_class: 'island-more-tile', can_focus: true, accessible_name: name, child: body,
            width: TILE_W * k, height: TILE_H * k,
        });
        this._button.connect('clicked', () => onClick(id));
        this._star = new St.Button({
            style_class: 'island-more-star', can_focus: true, accessible_name: `Pin ${name}`, visible: false,
            child: new St.Label({text: '★', ...center}),
            x: Math.round((TILE_W - STAR_PX - STAR_INSET) * k), y: Math.round(STAR_INSET * k),
            width: STAR_PX * k, height: STAR_PX * k,
        });
        this._star.connect('clicked', () => onStar(id));
        this.actor.add_child(this._button);
        this.actor.add_child(this._star);
    }

    setEditing(on) {
        this._star.visible = on;
        if (!on)
            this.actor.rotation_angle_z = 0;
    }

    setPinned(on) {
        if (on)
            this._star.add_style_class_name('pinned');
        else
            this._star.remove_style_class_name('pinned');
    }

    wiggle(t, i) {
        this.actor.rotation_angle_z = Math.sin(t * WIGGLE_SPEED + i * 1.7) * WIGGLE_DEG;
    }
}

export class MorePage extends Page {
    static id = 'more';
    static title = 'More';
    static height = 520;
    static autoHeight = true;

    build() {
        const actor = page('island-more');
        const top = new St.BoxLayout({style_class: 'island-more-top'});
        this._hint = label('island-more-hint', {text: BROWSE_HINT, x_expand: true});
        top.add_child(this._hint);
        this._edit = pillButton('Edit', () => this.setEditing(!this._editing));
        top.add_child(this._edit);
        actor.add_child(top);
        this._msg = label('island-more-msg', {visible: false});
        actor.add_child(this._msg);
        this._grid = column({style_class: 'island-more-grid', x_align: Clutter.ActorAlign.CENTER});
        actor.add_child(this._grid);

        this._editing = false;
        this._loop = null;
        this._layoutKey = '';
        this._shown = [];
        this._tiles = new Map();
        for (const [id, name, icon] of TABS.filter(([tid]) => tid !== 'home'))
            this._tiles.set(id, new Tile(id, name, icon, t => this._onTile(t), t => this._toggle(t)));
        this._layout();
        return actor;
    }

    get editing() {
        return this._editing;
    }

    setEditing(on) {
        if (this._editing === on)
            return;
        this._editing = on;
        this._edit.label = on ? 'Done' : 'Edit';
        if (on)
            this._edit.add_style_class_name('primary');
        else
            this._edit.remove_style_class_name('primary');
        for (const tile of this._tiles.values())
            tile.setEditing(on);
        setMessage(this._msg, '', () => this.refit());
        this._syncHint();
        if (on)
            this._startWiggle();
        else
            this._stopWiggle();
    }

    onShow() {
        this._layout();
        return null;
    }

    onHide() {
        this.setEditing(false);
    }

    onSettings() {
        this._layout();
        this._syncPins();
        this._syncHint();
    }

    destroy() {
        this._stopWiggle();
        for (const tile of this._tiles.values())
            tile.actor.destroy();
        this._tiles.clear();
    }

    _onTile(id) {
        if (this._editing)
            this._toggle(id);
        else
            this.island.showTab(id);
    }

    _toggle(id) {
        const st = this.island.settings;
        const {bar, error} = togglePin(this.island.barTabs().filter(t => tabOn(st, t)), id);
        setMessage(this._msg, error, () => this.refit());
        if (!error)
            this.ext.updateSettings({bar});
    }

    _syncPins() {
        const bar = this.island.barTabs();
        for (const [id, tile] of this._tiles)
            tile.setPinned(bar.includes(id));
    }

    _syncHint() {
        setText(this._hint, this._editing ? pinHint(this.island.barTabs()) : BROWSE_HINT);
    }

    _layout() {
        const st = this.island.settings;
        const shown = [...this._tiles.values()].filter(t => tabOn(st, t.id));
        const key = shown.map(t => t.id).join(',');
        if (key === this._layoutKey)
            return;
        this._layoutKey = key;
        this._shown = shown;
        for (const tile of this._tiles.values())
            tile.actor.get_parent()?.remove_child(tile.actor);
        this._grid.destroy_all_children();
        for (let i = 0; i < shown.length; i += COLUMNS) {
            const row = new St.BoxLayout({style_class: 'island-more-row'});
            for (const tile of shown.slice(i, i + COLUMNS))
                row.add_child(tile.actor);
            this._grid.add_child(row);
        }
        this.refit();
    }

    _startWiggle() {
        if (this._loop)
            return;
        this._loop = frameLoop(this._grid, () => {
            if (!this._editing) {
                this._loop = null;
                return false;
            }
            const t = GLib.get_monotonic_time() / 1e6;
            this._shown.forEach((tile, i) => tile.wiggle(t, i));
            return true;
        });
    }

    _stopWiggle() {
        this._loop?.stop();
        this._loop = null;
        for (const tile of this._tiles.values())
            tile.actor.rotation_angle_z = 0;
    }
}
