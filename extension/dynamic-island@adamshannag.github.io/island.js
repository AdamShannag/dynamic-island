import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import GnomeDesktop from 'gi://GnomeDesktop';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    ACCENTS, AUTO_MIN_HEIGHT, DASH_WIDTH, FADE_IN_MS, FADE_OUT_MS, HOVER_IN_MS, HOVER_OUT_MS, IDLE, LIVE_KINDS, MODES,
    MORE_TAB, MORPH_MS, OSD_MS, REVEAL_DELAY_MS, TABS, TAB_ALIASES, TAB_IDS, VERTICAL, featureOn, scale, tabOn,
} from './lib/constants.js';
import {barTabs} from './lib/bar.js';
import {fmtClock} from './lib/format.js';
import {eachFrame, springTo} from './lib/motion.js';
import {Personality} from './lib/personality.js';
import {focusPids, openUri} from './lib/shell.js';
import {TabBar} from './lib/tabbar.js';
import {Pill} from './lib/pill.js';
import {Shoulders} from './lib/shoulders.js';
import {iconButton, label} from './lib/widgets.js';
import {PAGES} from './pages/index.js';

const OPEN_RETRY_MS = 150;
const RELEASE_SWALLOW_MS = 1500;
const PRIVATE_TABS = new Set(['clipboard', 'notes', 'inbox']);
const KIND_TABS = {agent: 'agents', task: 'activity', service: 'activity', race: 'race'};
const MORE = MORE_TAB[0];
const EXTRA_TABS = new Set(['settings', MORE]);

export const Island = GObject.registerClass(
class Island extends St.BoxLayout {
    _init(ext) {
        super._init({
            style_class: 'island idle',
            reactive: true,
            track_hover: true,
            can_focus: true,
            opacity: 0,
        });
        this.ext = ext;
        this.mode = 'idle';
        this.dashOpen = false;
        this.tab = 'home';
        this.media = null;
        this.timer = null;
        this.settings = null;
        this._state = IDLE;
        this._raw = IDLE;
        this._grab = null;
        this._tickId = 0;
        this._refreshId = 0;
        this._hoverId = 0;
        this._hoverExpanded = false;
        this._shown = false;
        this._springs = {};
        this._target = null;
        this._morphGen = 0;
        this._osd = null;
        this._osdTimer = 0;
        this._unread = false;
        this.set_pivot_point(0.5, 0);

        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connectObject('notify::clock', () => this._tick(), this);
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

        this._clip = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._clip);
        this._shoulders = new Shoulders(this);

        this._pill = new Pill({spyIcon: ext.spyIcon, agentIcon: ext.agentIcon, faceTarget: () => this._faceTarget()});
        this._content = this._pill.actor;
        this._clip.add_child(this._content);
        this._buildDash();
        this._personality = new Personality(this, this._pill.face);

        this.connect('button-release-event', (_a, event) => this._onClick(event));
        this.connect('notify::hover', () => this._onHover());
        this.connect('captured-event', (_a, event) => this._onCapturedEvent(event));
        this.connect('destroy', () => this._onDestroy());
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        this._shoulders?.allocate(box, scale());
    }

    _onDestroy() {
        this._personality.destroy();
        this._shoulders.destroy();
        this._shoulders = null;
        for (const id of [this._osdTimer, this._hoverId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._pill.destroy();
        this._tabs.destroy();
        for (const tl of Object.values(this._springs))
            tl.stop();
        this._springs = {};
        this.closeDash(false);
        for (const page of this._pages.values())
            page.destroy();
        this._stopTicker();
        this._wallClock = null;
    }

    _buildDash() {
        this._dash = new St.BoxLayout({
            style_class: 'island-dash',
            ...VERTICAL,
            visible: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this._clip.add_child(this._dash);
        this._dash.add_child(this._buildHeader());

        const body = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._pages = new Map();
        for (const PageClass of PAGES) {
            const page = new PageClass(this);
            page.actor.set({x_expand: true, y_expand: true, visible: false});
            body.add_child(page.actor);
            this._pages.set(page.id, page);
        }
        this._current = null;
        this._dash.add_child(body);
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'island-header'});
        this._tabs = new TabBar([...TABS, MORE_TAB], id => this.showTab(id));
        this._tabs.setOrder([...barTabs(null, TAB_IDS), MORE]);
        header.add_child(this._tabs.actor);
        this._tabName = label('island-tab-name', {x_expand: true});
        header.add_child(this._tabName);
        this._presentBadge = label('island-present-badge', {text: 'Presenting · private info hidden', visible: false});
        header.add_child(this._presentBadge);
        header.add_child(iconButton('color-select-symbolic', 'island-head-btn', () => {
            this.closeDash();
            this.ext.call('PickColor');
        }, 'Pick a colour'));
        this._spyBtn = new St.Button({
            style_class: 'island-head-btn', can_focus: true, accessible_name: 'Presentation mode',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({gicon: this.ext.spyIcon, style_class: 'island-head-spy'}),
        });
        this._spyBtn.connect('clicked', () => this.ext.setPresenting(!this.ext.presenting, false));
        header.add_child(this._spyBtn);
        header.add_child(iconButton('emblem-system-symbolic', 'island-head-btn', () => this.showTab('settings'), 'Settings'));
        this._dashClock = label('island-dash-clock');
        header.add_child(this._dashClock);
        return header;
    }

    page(id) {
        return this._pages.get(id);
    }

    setState(state) {
        const prev = this._state;
        const raw = state ?? IDLE;
        this._raw = raw;
        const k = raw.kind;
        if (k === 'media')
            this.media = raw;
        else if (k === 'idle')
            this.media = null;
        if (k === 'timer')
            this.timer = raw;
        else if (k === 'idle' || k === 'media')
            this.timer = null;
        this._state = k === 'media' && !featureOn(this.settings, 'mediaPill') ? IDLE : raw;
        if (raw.mirror && raw !== prev)
            this.setUnread(true);
        this._personality.react(prev, this._state);
        this._render(prev);
    }

    applySettings(st) {
        this.settings = st;
        for (const c of (this.style_class ?? '').split(' ')) {
            if (c.startsWith('theme-') || c.startsWith('surface-'))
                this.remove_style_class_name(c);
        }
        this.add_style_class_name(`theme-${st.accent ?? 'blue'}`);
        this.add_style_class_name(`surface-${st.surface ?? 'black'}`);

        this._tabs.setOrder([...this.barTabs().filter(id => tabOn(st, id)), MORE]);
        const parent = this._current?.parentTab;
        if (this.dashOpen && parent && !tabOn(st, parent))
            this.showTab('home');
        else if (this._current)
            this._tabs.select(this._barSelection(this._current));
        this.setUnread(this._unread);

        for (const page of this._pages.values())
            page.onSettings(st);
        this.setState(this._raw);
    }

    barTabs() {
        return barTabs(this.settings, TAB_IDS);
    }

    _barSelection(page) {
        const tab = page.parentTab;
        if (!tab || tab === MORE || this._tabs.shows(tab))
            return tab;
        return MORE;
    }

    setUnread(on) {
        this._unread = on;
        const dot = on && !(this.dashOpen && this.tab === 'inbox');
        const pinned = this._tabs.shows('inbox');
        this._tabs.setDot('inbox', dot && pinned);
        this._tabs.setDot(MORE, dot && !pinned);
    }

    setPresenting(on) {
        this._pill.face.setSpy(on);
        this._apply();
        this.relayout(true);
        if (this.dashOpen && PRIVATE_TABS.has(this.tab))
            this.showTab(this.tab);
    }

    showOsd(gicon, text, level, maxLevel) {
        const hadOsd = !!this._osd;
        this._osd = {gicon, label: text, level, maxLevel};
        if (this._osdTimer)
            GLib.source_remove(this._osdTimer);
        this._osdTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OSD_MS, () => {
            this._osdTimer = 0;
            this._osd = null;
            this._render(this._state);
            return GLib.SOURCE_REMOVE;
        });
        if (hadOsd && this.mode === 'osd')
            this._apply();
        else
            this._render(this._state);
    }

    openPort(port) {
        openUri(`http://localhost:${port}`);
        this.closeDash();
    }

    wobble() {
        this._personality.wobble();
    }

    bounce() {
        this.set({scale_x: 1.07, scale_y: 1.07});
        this._springTo({scale_x: 1, scale_y: 1}, 520, null, 'scale');
    }

    toggleDash(tab) {
        tab = TAB_ALIASES[tab] ?? tab;
        const valid = TAB_IDS.includes(tab) || EXTRA_TABS.has(tab);
        if (this.dashOpen) {
            if (valid && tab !== this.tab)
                this.showTab(tab);
            else
                this.closeDash();
            return;
        }
        this.openDash(valid ? tab : 'home');
    }

    openDash(tab, retried = false) {
        if (this.dashOpen)
            return;
        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        try {
            const seatState = this._grab.get_seat_state?.();
            if (seatState !== undefined && seatState !== Clutter.GrabState.ALL) {
                Main.popModal(this._grab);
                this._grab = null;
                if (!retried) {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, OPEN_RETRY_MS, () => {
                        this.openDash(tab, true);
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return;
            }
            this.dashOpen = true;
            this.tab = tab;
            this._render(this._state);
            this.showTab(tab);
        } catch (e) {
            if (this._grab) {
                Main.popModal(this._grab);
                this._grab = null;
            }
            throw e;
        }
    }

    closeDash(render = true) {
        if (!this.dashOpen)
            return;
        this._current?.onHide();
        this.dashOpen = false;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._stopRefresh();
        if (render)
            this._render(this._state);
    }

    showTab(id) {
        const page = this._pages.get(id);
        if (!page)
            return;
        if (this._current && this._current !== page)
            this._current.onHide();
        this._stopRefresh();
        this.tab = id;
        this._current = page;
        for (const p of this._pages.values())
            p.actor.visible = p === page;
        this._tabName.text = page.heading;
        this._tabs.select(this._barSelection(page));
        if (id === 'inbox')
            this.setUnread(false);

        const focus = page.onShow() ?? this;
        if (page.interval) {
            this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, page.interval, () => {
                page.refresh();
                return GLib.SOURCE_CONTINUE;
            });
        }
        focus.grab_key_focus();
        this.relayout(true);
        this._tick();
        this._syncTicker();
    }

    refit() {
        if (!this.dashOpen || !this._current?.autoHeight || this._refitQueued)
            return;
        this._refitQueued = true;
        eachFrame(() => {
            this._refitQueued = false;
            if (this.dashOpen)
                this.relayout(true);
            return false;
        });
    }

    prewarm() {
        if (this._prewarmed)
            return;
        this._prewarmed = true;
        const actors = [...this._pages.values()].map(p => p.actor);
        const width = (DASH_WIDTH - 40) * scale();
        let k = 0;
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            const actor = actors[k++];
            if (!actor || !this._wallClock)
                return GLib.SOURCE_REMOVE;
            actor.get_preferred_width(-1);
            actor.get_preferred_height(width);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopRefresh() {
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
    }

    _onHover() {
        if (this._hoverId)
            GLib.source_remove(this._hoverId);
        this._hoverId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.hover ? HOVER_IN_MS : HOVER_OUT_MS, () => {
            this._hoverId = 0;
            if (this._hoverExpanded !== this.hover) {
                this._hoverExpanded = this.hover;
                if (!this.dashOpen && LIVE_KINDS.has(this._state.kind))
                    this._render(this._state);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _targetMode() {
        const s = this._state;
        if (this.dashOpen)
            return 'dashboard';
        if (this._osd)
            return 'osd';
        if (s.kind === 'idle')
            return 'idle';
        if (s.kind === 'media')
            return 'compact';
        if (LIVE_KINDS.has(s.kind) && !s.accent)
            return this._hoverExpanded && s.subtitle ? 'notify' : 'compact';
        return s.subtitle ? 'notify' : 'compact';
    }

    _render(prev) {
        const s = this._state;
        if (!this._shown) {
            this._apply();
            this._show();
            return;
        }
        const mode = this._targetMode();
        const structural = mode !== this.mode ||
            (mode !== 'dashboard' && (prev.kind !== s.kind || prev.title !== s.title || prev.art !== s.art));
        if (!structural) {
            this._apply();
            this.relayout(true);
            return;
        }

        const gen = ++this._morphGen;
        const leaving = this.mode === 'dashboard' ? this._dash : this._content;
        leaving.remove_all_transitions();
        const morph = () => {
            if (!this._wallClock || gen !== this._morphGen)
                return;
            this._apply();
            const entering = this.mode === 'dashboard' ? this._dash : this._content;
            entering.remove_all_transitions();
            entering.opacity = 0;
            this.relayout(true);
            entering.ease({
                opacity: 255,
                delay: REVEAL_DELAY_MS,
                duration: FADE_IN_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        };
        if (leaving === this._dash && leaving.opacity > 0) {
            leaving.ease({
                opacity: 0,
                duration: FADE_OUT_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: morph,
            });
        } else {
            leaving.opacity = 0;
            morph();
        }
    }

    _apply() {
        const s = this._state;
        const mode = this._targetMode();
        this.mode = mode;
        for (const m of MODES)
            this.remove_style_class_name(m);
        this.add_style_class_name(mode);
        for (const a of ACCENTS)
            this.remove_style_class_name(`accent-${a}`);
        if (mode !== 'dashboard' && ACCENTS.includes(s.accent))
            this.add_style_class_name(`accent-${s.accent}`);
        this.ensure_style();

        this._dash.visible = mode === 'dashboard';
        this._content.visible = mode !== 'dashboard';
        this._pill.apply(s, mode, {
            presenting: this.ext.presenting,
            showFace: featureOn(this.settings, 'face'),
            osd: this._osd,
        });

        const priv = this.ext.presenting;
        this._presentBadge.visible = priv;
        this._spyBtn.checked = priv;
        for (const page of this._pages.values())
            page.onState();
        this._tick();
        this._syncTicker();
    }

    _trailingText(now) {
        const s = this._state;
        if (this.mode === 'osd') {
            const level = this._osd?.level;
            return level !== null && level !== undefined ? `${Math.round(level * 100)}%` : '';
        }
        if (this.mode === 'idle')
            return this._wallClock.clock;
        if (s.endsAt)
            return fmtClock((s.endsAt - now) / 1000);
        if (s.startedAt)
            return fmtClock((now - s.startedAt) / 1000);
        if (s.trailing)
            return s.trailing;
        if (s.kind === 'media')
            return this._shortTime();
        return '';
    }

    _tick() {
        if (!this._wallClock)
            return;
        const now = Date.now();
        this._pill.setTrailing(this._trailingText(now));
        if (!this.dashOpen)
            return;
        this._dashClock.text = this._wallClock.clock;
        this._current?.tick(now);
    }

    _shortTime() {
        const fmt = this._interface.get_string('clock-format') === '12h' ? '%l:%M' : '%H:%M';
        return GLib.DateTime.new_now_local().format(fmt).trim();
    }

    syncTicker() {
        this._syncTicker();
    }

    _syncTicker() {
        const s = this._state;
        const needed = !!(s.endsAt || s.startedAt || (this.dashOpen && this._current?.ticking));
        if (needed && !this._tickId) {
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!needed) {
            this._stopTicker();
        }
    }

    _stopTicker() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    _onClick(event) {
        if (this._swallowRelease && Date.now() - this._swallowRelease < RELEASE_SWALLOW_MS) {
            this._swallowRelease = 0;
            return Clutter.EVENT_STOP;
        }
        this._swallowRelease = 0;
        if (this.dashOpen)
            return Clutter.EVENT_STOP;
        switch (event.get_button()) {
        case Clutter.BUTTON_SECONDARY:
            Main.panel.statusArea.dateMenu?.menu.toggle();
            return Clutter.EVENT_STOP;
        case Clutter.BUTTON_MIDDLE:
            this.wobble();
            return Clutter.EVENT_STOP;
        case Clutter.BUTTON_PRIMARY:
            this._activate(this._state);
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _activate(s) {
        if (s.kind === 'agent' && !s.accent) {
            this.openDash('agents');
        } else if (s.mirror) {
            this.ext.activateNotification(s);
            this.ext.action('notify.dismiss');
        } else if (s.url) {
            openUri(s.url);
        } else if (s.focus?.length && focusPids(s.focus)) {
            if (s.click)
                this.ext.action(s.click);
        } else if (s.kind !== 'media' && s.kind !== 'timer' && s.click) {
            this.ext.action(s.click);
        } else {
            this.openDash(KIND_TABS[s.kind] ?? 'home');
        }
    }

    _onCapturedEvent(event) {
        if (!this.dashOpen)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            this.closeDash();
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            const target = global.stage.get_event_actor(event);
            if (!target || !this.contains(target)) {
                this._swallowRelease = Date.now();
                this.closeDash();
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _faceTarget() {
        const [px, py] = global.get_pointer();
        const f = this._pill.face.actor;
        const [fx, fy] = f.get_transformed_position();
        return [px - (fx + f.width / 2), py - (fy + f.height / 2)];
    }

    _size() {
        const barH = Main.panel.height;
        const k = scale();
        switch (this.mode) {
        case 'idle': {
            this._content.set_size(-1, -1);
            const [, natural] = this._content.get_preferred_width(barH);
            return [Math.max(150 * k, Math.ceil(natural) + 44 * k), barH];
        }
        case 'notify':
            return [420 * k, 72 * k];
        case 'dashboard':
            return this._dashSize(k);
        case 'osd':
            return [300 * k, barH];
        default:
            return [320 * k, barH];
        }
    }

    _dashSize(k) {
        const page = this._pages.get(this.tab);
        const width = DASH_WIDTH * k;
        const max = page.height * k;
        if (!page.autoHeight)
            return [width, max];
        const node = this.get_theme_node();
        this._dash.set_size(-1, -1);
        const [, natural] = this._dash.get_preferred_height(width - node.get_horizontal_padding());
        const h = Math.ceil(natural + node.get_vertical_padding());
        return [width, Math.max(AUTO_MIN_HEIGHT * k, Math.min(max, h))];
    }

    _springTo(target, duration, onDone = null, key = 'geom') {
        this._springs[key]?.stop();
        const tl = springTo(this, target, duration, () => {
            if (this._springs[key] === tl)
                delete this._springs[key];
            onDone?.();
        });
        this._springs[key] = tl;
    }

    relayout(animate) {
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const [width, height] = this._size();
        const t = {x: mon.x + Math.round((mon.width - width) / 2), y: mon.y, width, height};

        const node = this.get_theme_node();
        const innerW = width - node.get_horizontal_padding() -
            node.get_border_width(St.Side.LEFT) - node.get_border_width(St.Side.RIGHT);
        const innerH = height - node.get_vertical_padding() -
            node.get_border_width(St.Side.TOP) - node.get_border_width(St.Side.BOTTOM);
        const layer = this.mode === 'dashboard' ? this._dash : this._content;
        layer.set_size(Math.max(0, innerW), Math.max(0, innerH));

        const same = a => a && a.x === t.x && a.y === t.y && a.width === t.width && a.height === t.height;
        if (animate && this._springs.geom && same(this._target))
            return;
        this._target = t;
        if (!animate || same(this)) {
            this._springs.geom?.stop();
            delete this._springs.geom;
            this.set(t);
            return;
        }
        this._springTo(t, MORPH_MS);
    }

    _show() {
        this._shown = true;
        this.relayout(false);
        this.set({opacity: 0, scale_x: 0.7, scale_y: 0.7});
        this.ease({opacity: 255, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._springTo({scale_x: 1, scale_y: 1}, MORPH_MS, null, 'scale');
    }
});
