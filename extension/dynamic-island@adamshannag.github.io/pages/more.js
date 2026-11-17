import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {ALL_TABS, HOME_TAB, scale, tabOn} from '../lib/constants.js';
import {FAVORITES_MAX, homeFavorites, toggleFavorite} from '../lib/home.js';
import {frameLoop} from '../lib/motion.js';
import {PRESS_TILE, column, label, tactile} from '../lib/widgets.js';
import {Page} from './page.js';

const COLUMNS = 6;
const WIGGLE_DEG = 1.1;
const WIGGLE_HALF_S = 0.32;
const STAR_IN_MS = 280;
const SHAKE_MS = 360;
const SHAKE_PX = 6;
const SHAKE_TURNS = 3;
const DASH_RADIUS = 14;
const STAR_PX = 20;
const STAR_INSET = 6;
const TILE_IDS = ALL_TABS.map(([id]) => id).filter(id => id !== HOME_TAB);
const center = {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER};

function homogeneousRow(styleClass) {
    const row = new St.BoxLayout({style_class: styleClass, x_expand: true});
    row.layout_manager.homogeneous = true;
    return row;
}

class Tile {
    constructor([id, name, icon], {onTap}) {
        this.id = id;
        this.actor = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        this.actor.set_pivot_point(0.5, 0.5);
        const body = column({style_class: 'island-hm-tile-body', ...center});
        body.add_child(new St.Icon({icon_name: icon, style_class: 'island-hm-tile-icon', x_align: Clutter.ActorAlign.CENTER}));
        body.add_child(label('island-hm-tile-name', {text: name, x_align: Clutter.ActorAlign.CENTER}));
        this._button = tactile(new St.Button({
            style_class: 'island-hm-tile island-more-tile', can_focus: true, accessible_name: name,
            x_expand: true, child: body,
        }), {press: PRESS_TILE, lift: 1});
        this._button.connect('clicked', () => onTap(this));
        const k = scale();
        this._star = new St.Bin({
            style_class: 'island-more-star', visible: false, width: STAR_PX * k, height: STAR_PX * k,
            child: new St.Label({text: '★', ...center}), x: 0, y: Math.round(STAR_INSET * k),
        });
        this._star.set_pivot_point(0.5, 0.5);
        this.actor.add_child(this._button);
        this.actor.add_child(this._star);
        this.actor.connect('notify::width', () => (this._star.x = Math.round(this.actor.width - (STAR_PX + STAR_INSET) * k)));
    }

    setEditing(on, favorite, animate = true) {
        this.setFavorite(favorite, false);
        this._star.remove_all_transitions();
        this._star.visible = on;
        if (!on) {
            this.actor.rotation_angle_z = 0;
            return;
        }
        this._star.set_scale(animate ? 0 : 1, animate ? 0 : 1);
        if (!animate)
            return;
        this._star.ease({scale_x: 1, scale_y: 1, duration: STAR_IN_MS, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }

    setFavorite(on, pop = true) {
        if (on === this._star.has_style_class_name('on'))
            return;
        if (on)
            this._star.add_style_class_name('on');
        else
            this._star.remove_style_class_name('on');
        if (!pop || !this._star.visible)
            return;
        this._star.remove_all_transitions();
        this._star.set_scale(0.5, 0.5);
        this._star.ease({scale_x: 1, scale_y: 1, duration: STAR_IN_MS, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }

    wiggle(t, i) {
        const phase = i % 2 ? Math.PI : 0;
        this.actor.rotation_angle_z = Math.sin(Math.PI * t / WIGGLE_HALF_S + phase) * WIGGLE_DEG;
    }

    shake() {
        const px = SHAKE_PX * scale();
        const tl = new Clutter.Timeline({actor: this.actor, duration: SHAKE_MS});
        tl.connect('new-frame', () => {
            const p = tl.get_progress();
            this.actor.translation_x = Math.round(Math.sin(p * Math.PI * 2 * SHAKE_TURNS) * (1 - p) * px);
        });
        tl.connect('completed', () => (this.actor.translation_x = 0));
        tl.start();
    }

    destroy() {
        this.actor.destroy();
    }
}

function drawDashedBorder(area) {
    const [w, h] = area.get_surface_size();
    const k = scale();
    const c = area.get_theme_node().get_foreground_color();
    const cr = area.get_context();
    const lw = k, r = DASH_RADIUS * k - lw / 2, x = lw / 2, y = lw / 2, x2 = w - lw / 2, y2 = h - lw / 2;
    cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255);
    cr.setLineWidth(lw);
    cr.setDash([4 * k, 3 * k], 0);
    cr.newSubPath();
    cr.arc(x2 - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x2 - r, y2 - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y2 - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
    cr.stroke();
    cr.$dispose();
}

class EmptySlot {
    constructor(onTap) {
        const box = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        const border = new St.DrawingArea({style_class: 'island-more-dash', x_expand: true, y_expand: true});
        border.connect('repaint', a => drawDashedBorder(a));
        box.add_child(border);
        const body = column({style_class: 'island-hm-tile-body', ...center});
        body.add_child(label('island-more-plus', {text: '+', x_align: Clutter.ActorAlign.CENTER}));
        body.add_child(label('island-more-empty', {text: 'Empty', x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(body);
        this.actor = tactile(new St.Button({
            style_class: 'island-more-slot', can_focus: true, accessible_name: 'Add a favourite',
            x_expand: true, child: box,
        }), {press: PRESS_TILE});
        this.actor.connect('clicked', onTap);
    }

    wiggle() {}

    destroy() {
        this.actor.destroy();
    }
}

export class MorePage extends Page {
    static id = 'more';
    static height = 560;
    static autoHeight = true;

    build() {
        this._editing = false;
        this._loop = null;
        this._favSig = null;
        this._gridSig = null;
        this._favTiles = [];
        this._gridTiles = [];

        const actor = column({style_class: 'island-page island-more'});
        const head = new St.BoxLayout({style_class: 'island-more-head'});
        head.add_child(label('island-more-label', {text: 'Favorites', x_expand: true}));
        this._edit = new St.Button({style_class: 'island-more-edit', label: 'Edit', can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        this._edit.connect('clicked', () => this.setEditing(!this._editing));
        head.add_child(this._edit);
        actor.add_child(head);
        this._favRow = homogeneousRow('island-more-row island-more-favs');
        actor.add_child(this._favRow);
        actor.add_child(label('island-more-label island-more-all', {text: 'All tabs'}));
        this._grid = column({style_class: 'island-more-grid', x_expand: true});
        actor.add_child(this._grid);
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
        const favs = this._favorites();
        for (const tile of this._tiles())
            tile.setEditing(on, favs.includes(tile.id));
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
    }

    destroy() {
        this._stopWiggle();
        this._tiles().forEach(t => t.destroy());
        this._favTiles = [];
        this._gridTiles = [];
    }

    _tiles() {
        return [...this._favTiles, ...this._gridTiles];
    }

    _favorites() {
        return homeFavorites(this.island.settings, ALL_TABS.map(([id]) => id));
    }

    _onTap(tile) {
        if (!this._editing) {
            this.island.showTab(tile.id);
            return;
        }
        const {favorites, refused} = toggleFavorite(this._favorites(), tile.id);
        if (refused) {
            tile.shake();
            return;
        }
        this.ext.updateSettings({home: {favorites}});
    }

    _layout() {
        const st = this.island.settings;
        const favs = this._favorites().filter(id => tabOn(st, id));
        const shown = TILE_IDS.filter(id => tabOn(st, id));
        const info = new Map(ALL_TABS.map(t => [t[0], t]));
        const make = id => {
            const tile = new Tile(info.get(id), {onTap: t => this._onTap(t)});
            if (this._editing)
                tile.setEditing(true, favs.includes(id), false);
            return tile;
        };
        let changed = false;
        if (shown.join(',') !== this._gridSig) {
            this._gridSig = shown.join(',');
            this._gridTiles.forEach(t => t.destroy());
            this._grid.destroy_all_children();
            this._gridTiles = shown.map(make);
            for (let i = 0; i < shown.length; i += COLUMNS) {
                const row = homogeneousRow('island-more-row');
                const tiles = this._gridTiles.slice(i, i + COLUMNS);
                tiles.forEach(t => row.add_child(t.actor));
                for (let pad = tiles.length; pad < COLUMNS; pad++)
                    row.add_child(new St.Widget({x_expand: true}));
                this._grid.add_child(row);
            }
            changed = true;
        }
        if (favs.join(',') !== this._favSig) {
            this._favSig = favs.join(',');
            this._favTiles.forEach(t => t.destroy());
            this._favRow.destroy_all_children();
            this._favTiles = favs.map(make);
            this._favTiles.forEach(t => this._favRow.add_child(t.actor));
            for (let i = favs.length; i < FAVORITES_MAX; i++)
                this._favRow.add_child(new EmptySlot(() => this.setEditing(true)).actor);
            changed = true;
        }
        for (const tile of this._gridTiles)
            tile.setFavorite(favs.includes(tile.id));
        if (changed)
            this.refit();
    }

    _startWiggle() {
        if (this._loop)
            return;
        this._loop = frameLoop(this.actor, () => {
            if (!this._editing) {
                this._loop = null;
                return false;
            }
            const t = GLib.get_monotonic_time() / 1e6;
            this._tiles().forEach((tile, i) => tile.wiggle(t, i));
            return true;
        });
    }

    _stopWiggle() {
        this._loop?.stop();
        this._loop = null;
        for (const tile of this._tiles())
            tile.actor.rotation_angle_z = 0;
    }
}
