import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import {ROWS_PER_FRAME, TILE_COLORS, VERTICAL, scale} from './constants.js';
import {hashColor} from './format.js';
import {eachFrame} from './motion.js';

export function label(styleClass, props = {}) {
    const l = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

export function setText(lbl, text) {
    if (lbl.text !== text)
        lbl.text = text;
}

export function iconButton(iconName, styleClass, onClick, accessibleName = '') {
    const btn = new St.Button({
        style_class: styleClass,
        can_focus: true,
        accessible_name: accessibleName,
        y_align: Clutter.ActorAlign.CENTER,
        child: new St.Icon({icon_name: iconName}),
    });
    btn.connect('clicked', onClick);
    return btn;
}

export function pillButton(text, onClick, extraClass = '') {
    const btn = new St.Button({
        style_class: `island-pill-btn${extraClass ? ` ${extraClass}` : ''}`,
        label: text,
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    btn.connect('clicked', onClick);
    return btn;
}

export function searchEntry(hint, props = {}) {
    return new St.Entry({
        style_class: 'island-entry',
        hint_text: hint,
        can_focus: true,
        x_expand: true,
        primary_icon: new St.Icon({icon_name: 'system-search-symbolic', style_class: 'island-entry-icon'}),
        ...props,
    });
}

export function multilineEntry(styleClass, hint, props = {}) {
    const entry = new St.Entry({style_class: styleClass, hint_text: hint, can_focus: true, x_expand: true,
        y_align: Clutter.ActorAlign.START, ...props});
    const ct = entry.clutter_text;
    ct.single_line_mode = false;
    ct.activatable = false;
    ct.line_wrap = true;
    ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    return entry;
}

export function wrappingLabel(styleClass, {selectable = false, ellipsize = false, text = ''} = {}) {
    const lbl = new St.Label({style_class: styleClass, text, reactive: selectable});
    const ct = lbl.clutter_text;
    ct.line_wrap = true;
    ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    if (ellipsize)
        ct.ellipsize = Pango.EllipsizeMode.END;
    if (selectable) {
        ct.selectable = true;
        ct.reactive = true;
    }
    return lbl;
}

export function scrollView(child) {
    const sv = new St.ScrollView({
        style_class: 'island-scroll',
        x_expand: true,
        y_expand: true,
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        overlay_scrollbars: false,
    });
    if (sv.set_child)
        sv.set_child(child);
    else
        sv.add_actor(child);
    return sv;
}

export function page(extraClass = '') {
    return new St.BoxLayout({style_class: `island-page${extraClass ? ` ${extraClass}` : ''}`, ...VERTICAL});
}

export function column(props = {}) {
    return new St.BoxLayout({...VERTICAL, ...props});
}

export function group(title = null, trailing = null) {
    const actor = column({style_class: 'island-igroup'});
    if (title || trailing) {
        const head = new St.BoxLayout({style_class: 'island-igroup-head'});
        const t = label('island-igroup-title', {text: title ?? '', x_expand: true});
        t.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        head.add_child(t);
        if (trailing)
            head.add_child(trailing);
        actor.add_child(head);
    }
    const list = column({style_class: 'island-inset'});
    actor.add_child(list);
    return {actor, list};
}

export function badge(spec) {
    const bin = new St.Bin({style_class: `island-badge${spec.small ? ' small' : ''}`, y_align: Clutter.ActorAlign.CENTER});
    bin.set_style(`background-color: ${spec.color};`);
    const center = {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER};
    bin.child = spec.glyph !== undefined
        ? new St.Label({text: spec.glyph, style_class: 'island-badge-glyph', ...center})
        : new St.Icon({style_class: 'island-badge-icon', gicon: spec.gicon ?? null, icon_name: spec.icon ?? null, ...center});
    if (spec.tint)
        bin.child.set_style(`color: ${spec.tint};`);
    return bin;
}

export function appBadge(appInfo, name) {
    if (appInfo)
        return new St.Icon({gicon: appInfo.get_icon(), style_class: 'island-app-icon', y_align: Clutter.ActorAlign.CENTER});
    const n = name || '?';
    return badge({glyph: n[0].toUpperCase(), color: hashColor(n, TILE_COLORS)});
}

export function rowText(title, sub, {monoSub = false, monoTitle = false} = {}) {
    const col = column({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    const t = label(`island-irow-title${monoTitle ? ' island-mono' : ''}`, {text: title});
    col.add_child(t);
    let s = null;
    if (sub) {
        s = label(`island-irow-sub${monoSub ? ' island-mono' : ''}`, {text: sub});
        col.add_child(s);
    }
    return {col, title: t, sub: s};
}

export function hoverActions(row, buttons) {
    const box = new St.BoxLayout({style_class: 'island-row-actions', opacity: 0, y_align: Clutter.ActorAlign.CENTER});
    for (const b of buttons) {
        b.reactive = false;
        box.add_child(b);
    }
    row.reactive = true;
    row.track_hover = true;
    row.connect('notify::hover', () => {
        buttons.forEach(b => (b.reactive = row.hover));
        box.ease({opacity: row.hover ? 255 : 0, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    });
    return box;
}

export function confirmButton(text, onConfirm, extraClass = 'danger') {
    let armed = false;
    const btn = pillButton(text, () => {
        if (!armed) {
            armed = true;
            btn.label = 'Sure?';
            btn.add_style_pseudo_class('armed');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                if (armed && btn.get_stage()) {
                    armed = false;
                    btn.label = text;
                    btn.remove_style_pseudo_class('armed');
                }
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        armed = false;
        onConfirm();
    }, extraClass);
    return btn;
}

export function portButton(port, styleClass, onOpen) {
    const btn = new St.Button({
        style_class: `island-port-btn ${styleClass}`, label: `:${port}`, can_focus: true,
        y_align: Clutter.ActorAlign.CENTER, accessible_name: `Open localhost:${port}`,
    });
    btn.child.x_align = Clutter.ActorAlign.START;
    btn.connect('clicked', () => onOpen(port));
    return btn;
}

export function fillList(box, items, make, onDone = null) {
    box.destroy_all_children();
    const gen = (box._fillGen ?? 0) + 1;
    box._fillGen = gen;
    let i = 0;
    const step = () => {
        if (box._fillGen !== gen || !box.get_stage())
            return false;
        const end = Math.min(items.length, i + ROWS_PER_FRAME);
        for (; i < end; i++) {
            const actor = make(items[i], i);
            if (actor)
                box.add_child(actor);
        }
        if (i >= items.length)
            onDone?.();
        return i < items.length;
    };
    if (step())
        eachFrame(step);
}

export function setMessage(lbl, text, onResize = null) {
    lbl.text = text ?? '';
    if (lbl.visible !== !!text) {
        lbl.visible = !!text;
        onResize?.();
    }
}

export class EmptyState {
    constructor(onResize = null) {
        this._onResize = onResize;
        const center = {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER};
        this.actor = column({style_class: 'island-empty-state', visible: false, x_expand: true, y_expand: true, ...center});
        const frame = new St.Widget({style_class: 'island-empty-badge', layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'island-empty-icon', ...center});
        frame.add_child(this._icon);
        this._title = new St.Label({style_class: 'island-empty-title', x_align: Clutter.ActorAlign.CENTER});
        this._hint = new St.Label({style_class: 'island-empty-hint', x_align: Clutter.ActorAlign.CENTER});
        this._hint.clutter_text.line_wrap = true;
        for (const a of [frame, this._title, this._hint])
            this.actor.add_child(a);
    }

    show(spec) {
        this._onResize?.();
        if (spec.gicon)
            this._icon.gicon = spec.gicon;
        else
            this._icon.icon_name = spec.icon;
        setText(this._title, spec.title);
        setText(this._hint, spec.hint ?? '');
        this._hint.visible = !!spec.hint;
        this.actor.show();
    }

    hide() {
        if (this.actor.visible)
            this._onResize?.();
        this.actor.hide();
    }
}

export class Toggle {
    constructor(state) {
        this.actor = new St.Widget({style_class: 'island-toggle', y_align: Clutter.ActorAlign.CENTER});
        this._knob = new St.Widget({style_class: 'island-toggle-knob'});
        this.actor.add_child(this._knob);
        this._state = null;
        this.set(state, false);
    }

    get state() {
        return this._state;
    }

    set state(v) {
        this.set(v, true);
    }

    set(v, animate) {
        v = !!v;
        if (v === this._state)
            return;
        this._state = v;
        if (v)
            this.actor.add_style_pseudo_class('checked');
        else
            this.actor.remove_style_pseudo_class('checked');
        const k = scale();
        const x = (v ? 20 : 2) * k;
        this._knob.y = 2 * k;
        if (animate)
            this._knob.ease({x, duration: 170, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        else
            this._knob.x = x;
    }

    toggle() {
        this.state = !this._state;
    }
}

const EQ_WAVES = [[7.1, 11.3, 0.0], [8.7, 5.9, 1.7], [6.3, 13.1, 3.1], [9.4, 7.7, 4.4]];

export class Equalizer {
    constructor(styleClass) {
        this.actor = new St.BoxLayout({style_class: `island-eq ${styleClass}`, y_align: Clutter.ActorAlign.CENTER});
        this._bars = EQ_WAVES.map(() => {
            const bar = new St.Widget({style_class: 'island-eq-bar', y_expand: true});
            bar.set_pivot_point(0.5, 1);
            bar.scale_y = 0.35;
            this.actor.add_child(bar);
            return bar;
        });
        this._running = false;
        this._tl = null;
        this.actor.connect('notify::mapped', () => this._sync());
        this.actor.connect('destroy', () => this._stop());
    }

    set running(run) {
        this._running = run;
        this._sync();
    }

    _sync() {
        const on = this._running && this.actor.mapped;
        if (on && !this._tl) {
            const tl = new Clutter.Timeline({actor: this.actor, duration: 1000, repeat_count: -1});
            tl.connect('new-frame', () => {
                const t = GLib.get_monotonic_time() / 1e6;
                this._bars.forEach((bar, i) => {
                    const [f1, f2, ph] = EQ_WAVES[i];
                    const v = 0.58 + 0.26 * Math.sin(t * f1 + ph) + 0.16 * Math.sin(t * f2 + ph * 1.7);
                    bar.scale_y = Math.max(0.18, Math.min(1, v));
                });
            });
            this._tl = tl;
            tl.start();
        } else if (!on) {
            this._stop();
            this._bars.forEach(bar => (bar.scale_y = 0.35));
        }
    }

    _stop() {
        if (this._tl) {
            this._tl.stop();
            this._tl = null;
        }
    }
}
