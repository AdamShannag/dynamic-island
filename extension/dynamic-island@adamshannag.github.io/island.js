import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import GnomeDesktop from 'gi://GnomeDesktop';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    ACCENTS, AUTO_MIN_HEIGHT, DASH_RISE, DASH_WIDTH, FIND_HEIGHT, FIND_SHIFT, HOME_TAB, HOVER_IN_MS, HOVER_OUT_MS, IDLE,
    LIVE_KINDS, MODES, OSD_MS, PAGE_IN_DELAY_MS, PAGE_IN_MS, PAGE_OUT_MS, PAGE_SHIFT, SHAPES, TAB_ALIASES, VERTICAL,
    featureOn, scale, tabInfo, tabOn,
} from './lib/constants.js';
import {firstLine} from './lib/find.js';
import {Finder} from './lib/finder.js';
import {fmtClock} from './lib/format.js';
import {eachFrame, frameLoop} from './lib/motion.js';
import {Personality} from './lib/personality.js';
import {focusPids, openUri} from './lib/shell.js';
import {Pill} from './lib/pill.js';
import {Shoulders} from './lib/shoulders.js';
import {OPACITY_SPRING, SIZE_SPRING, SpringSet, clamp01, dashReveal, pillReveal} from './lib/spring.js';
import {iconButton, label, tactile} from './lib/widgets.js';
import {PAGES} from './pages/index.js';

const OPEN_RETRY_MS = 150;
const RELEASE_SWALLOW_MS = 1500;
const PRIVATE_TABS = new Set(['clipboard', 'notes', 'inbox']);
const KIND_TABS = {agent: 'agents', task: 'activity', service: 'activity', party: 'play'};
const MORE = 'more';
const SHOW_SCALE = 0.7;
const BOUNCE_SCALE = 1.07;
const BELL_PX = 32;
const BELL_ICON_PX = 17;
const BELL_DOT_X = 19;
const BELL_DOT_Y = 6;
const ENTER_KEYS = new Set([Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter]);

const animationsOn = () => St.Settings.get().enable_animations;

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
        this.tab = HOME_TAB;
        this.media = null;
        this.timer = null;
        this.settings = null;
        this._state = IDLE;
        this._raw = IDLE;
        this._pillMode = 'idle';
        this._grab = null;
        this._tickId = 0;
        this._refreshId = 0;
        this._hoverId = 0;
        this._hoverExpanded = false;
        this._shown = false;
        this._osd = null;
        this._osdTimer = 0;
        this._unread = false;
        this._finding = false;
        this._pendingFind = false;
        this._loop = null;
        this._lastFrame = 0;
        this._radius = -1;
        this._shoulderPx = 0;
        this._motion = new SpringSet({
            width: [SIZE_SPRING, 0], height: [SIZE_SPRING, 0], radius: [SIZE_SPRING, SHAPES.idle.radius],
            shoulder: [SIZE_SPRING, SHAPES.idle.shoulder], scale: [SIZE_SPRING, 1],
            op: [OPACITY_SPRING, 0], fade: [OPACITY_SPRING, 1],
        });
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
        this._bg = new St.Widget({style_class: 'island-bg', x_expand: true, y_expand: true});
        this._clip.add_child(this._bg);
        this._shoulders = new Shoulders(this, this._bg);

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
        this._shoulders?.allocate(box, this._shoulderPx);
    }

    _onDestroy() {
        this._personality.destroy();
        this._shoulders.destroy();
        this._shoulders = null;
        for (const id of [this._osdTimer, this._hoverId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._loop?.stop();
        this._loop = null;
        this._pill.destroy();
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
            opacity: 0,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this._clip.add_child(this._dash);
        this._header = this._buildHeader();
        this._dash.add_child(this._header);
        this._nav = this._buildNav();
        this._dash.add_child(this._nav);

        const body = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._pages = new Map();
        for (const PageClass of PAGES) {
            const page = new PageClass(this);
            page.actor.set({x_expand: true, y_expand: true, visible: false});
            body.add_child(page.actor);
            this._pages.set(page.id, page);
        }
        this._finder = new Finder({ext: this.ext, onRun: item => this._runFind(item), onResize: () => this.refit()});
        this._finder.actor.set({y_expand: true});
        body.add_child(this._finder.actor);
        this._current = null;
        this._dash.add_child(body);
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'island-header'});
        this._gridBtn = iconButton('view-app-grid-symbolic', 'island-head-grid', () => this._toggleMore(), 'All tabs');
        header.add_child(this._gridBtn);

        this._search = new St.Entry({
            style_class: 'island-head-search',
            hint_text: 'Search',
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            primary_icon: new St.Icon({icon_name: 'system-search-symbolic', style_class: 'island-head-search-icon'}),
            secondary_icon: label('island-key-chip', {text: 'Ctrl K'}),
        });
        this._search.clutter_text.connect('text-changed', () => this._onSearchText());
        this._search.clutter_text.connect('key-focus-in', () => this._beginFind());
        header.add_child(this._search);

        const k = scale();
        const bell = new St.Widget({layout_manager: new Clutter.FixedLayout(), width: BELL_PX * k, height: BELL_PX * k});
        const inset = Math.round((BELL_PX - BELL_ICON_PX) / 2 * k);
        bell.add_child(new St.Icon({
            icon_name: 'preferences-system-notifications-symbolic', icon_size: BELL_ICON_PX, x: inset, y: inset,
            style_class: 'island-head-bell-icon',
        }));
        this._bellDot = new St.Widget({
            style_class: 'island-bell-dot', visible: false, x: Math.round(BELL_DOT_X * k), y: Math.round(BELL_DOT_Y * k),
        });
        bell.add_child(this._bellDot);
        this._bell = tactile(new St.Button({
            style_class: 'island-head-bell', can_focus: true, accessible_name: 'Notifications',
            y_align: Clutter.ActorAlign.CENTER, child: bell,
        }));
        this._bell.connect('clicked', () => this.showTab('inbox'));
        header.add_child(this._bell);

        this._presentBadge = label('island-present-badge', {text: 'Presenting', visible: false});
        header.add_child(this._presentBadge);
        this._spyBtn = tactile(new St.Button({
            style_class: 'island-head-btn', can_focus: true, accessible_name: 'Presentation mode',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({gicon: this.ext.spyIcon, style_class: 'island-head-spy'}),
        }));
        this._spyBtn.connect('clicked', () => this.ext.setPresenting(!this.ext.presenting, false));
        header.add_child(this._spyBtn);
        this._dashClock = label('island-dash-clock');
        header.add_child(this._dashClock);
        return header;
    }

    _buildNav() {
        const nav = new St.BoxLayout({style_class: 'island-nav', visible: false});
        nav.add_child(iconButton('go-previous-symbolic', 'island-nav-back', () => this._goBack(), 'Back'));
        this._navTitle = label('island-nav-title', {x_expand: true});
        nav.add_child(this._navTitle);
        this._navActions = new St.Bin({style_class: 'island-nav-actions', y_align: Clutter.ActorAlign.CENTER});
        nav.add_child(this._navActions);
        return nav;
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
        this._finder.settings = st;
        for (const c of (this.style_class ?? '').split(' ')) {
            if (c.startsWith('theme-') || c.startsWith('surface-'))
                this.remove_style_class_name(c);
        }
        this.add_style_class_name(`theme-${st.accent ?? 'blue'}`);
        this.add_style_class_name(`surface-${st.surface ?? 'black'}`);

        const parent = this._current?.parentTab;
        if (this.dashOpen && parent && !tabOn(st, parent))
            this.showTab(HOME_TAB);

        for (const page of this._pages.values())
            page.onSettings(st);
        this.setState(this._raw);
    }

    setUnread(on) {
        this._unread = on;
        this._bellDot.visible = on && !(this.dashOpen && this.tab === 'inbox');
    }

    setPresenting(on) {
        this._pill.face.setSpy(on);
        this._apply();
        this.relayout(true);
        if (this._finding)
            this._finder.open(this._search.text);
        else if (this.dashOpen && PRIVATE_TABS.has(this.tab))
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
        if (!animationsOn())
            return;
        this._motion.springs.scale.x = BOUNCE_SCALE;
        this._kick();
    }

    toggleDash(tab) {
        tab = TAB_ALIASES[tab] ?? tab;
        const valid = !!tabInfo(tab);
        if (this.dashOpen) {
            if (valid && tab !== this.tab)
                this.showTab(tab);
            else
                this.closeDash();
            return;
        }
        this.openDash(valid ? tab : HOME_TAB);
    }

    openSearch() {
        if (this.dashOpen) {
            this.focusSearch();
            return;
        }
        this._pendingFind = true;
        this.openDash(HOME_TAB);
    }

    focusSearch() {
        if (!this.dashOpen)
            return;
        this._search.grab_key_focus();
        this._beginFind();
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
                } else {
                    this._pendingFind = false;
                }
                return;
            }
            this.dashOpen = true;
            this.tab = tab;
            this._dash.visible = true;
            this._render(this._state);
            this.showTab(tab);
            if (this._pendingFind) {
                this._pendingFind = false;
                this.focusSearch();
            }
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
        this._pendingFind = false;
        this._endFind();
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

    showTab(id, {back = false} = {}) {
        const page = this._pages.get(id);
        if (!page)
            return;
        const fromFind = this._finding;
        const from = fromFind ? this._finder.actor : this._current?.actor;
        this._endFind();
        if (this._current && this._current !== page)
            this._current.onHide();
        this._stopRefresh();
        this.tab = id;
        this._current = page;
        this._syncHeader();

        this._swap(from, page.actor, fromFind ? {dy: -1} : {dx: back ? -1 : 1});
        const focus = page.onShow() ?? this;
        if (from !== page.actor)
            page.reveal();
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
        if (!this.dashOpen || !(this._finding || this._current?.autoHeight) || this._refitQueued)
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
        const width = this._innerWidth(DASH_WIDTH * scale());
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

    _toggleMore() {
        if (this.tab === MORE && !this._finding)
            this.showTab(HOME_TAB, {back: true});
        else
            this.showTab(MORE);
    }

    _goBack() {
        this.showTab(this._current?.backTab ?? HOME_TAB, {back: true});
    }

    _escape() {
        if (this._finding)
            this._leaveFind();
        else if (this.tab !== HOME_TAB)
            this.showTab(HOME_TAB, {back: true});
        else
            this.closeDash();
    }

    _syncHeader() {
        if (this.tab === MORE && !this._finding)
            this._gridBtn.add_style_class_name('active');
        else
            this._gridBtn.remove_style_class_name('active');
        const page = this._current;
        this._nav.visible = !this._finding && !!page && page.id !== HOME_TAB;
        if (page)
            this._navTitle.text = page.heading;
        const actions = this._nav.visible ? page.navActions : null;
        if (this._navActions.child !== actions)
            this._navActions.child = actions;
        this.setUnread(this._unread && !(this.dashOpen && this.tab === 'inbox'));
    }

    _onSearchText() {
        const text = this._search.text;
        if (!this._finding && this.dashOpen && text)
            this._beginFind();
        else if (this._finding)
            this._finder.setQuery(text);
    }

    _beginFind() {
        if (this._finding || !this.dashOpen)
            return;
        this._finding = true;
        this._finder.open(this._search.text);
        this._syncHeader();
        this._swap(this._current?.actor, this._finder.actor, {dy: 1});
        this.relayout(true);
    }

    _endFind() {
        if (!this._finding)
            return;
        this._finding = false;
        this._finder.close();
        this._search.text = '';
    }

    _leaveFind() {
        if (!this._finding)
            return;
        this._endFind();
        this._syncHeader();
        this._swap(this._finder.actor, this._current.actor, {dy: -1});
        this.grab_key_focus();
        this.relayout(true);
    }

    _runFind(item) {
        const a = item.action;
        const ext = this.ext;
        switch (a.kind) {
        case 'tab':
            this.showTab(a.id);
            break;
        case 'note':
            this.showTab('notes');
            this.page('notes').select(a.id);
            break;
        case 'clip':
            this.closeDash();
            ext.copy(a.text);
            ext.notify('Copied to clipboard', firstLine(a.text), 'edit-paste-symbolic', 'ok');
            break;
        case 'focus':
            this.closeDash();
            ext.action('pomodoro.start');
            ext.notify('Focus started', '25 minutes', 'alarm-symbolic', 'ok');
            break;
        case 'color':
            this.closeDash();
            ext.call('PickColor');
            break;
        case 'lan':
            this.closeDash();
            ext.call('LanAddress', [], (res, err) => {
                if (err) {
                    ext.notify("Couldn't find a LAN address", 'Connect to a network first', 'dialog-error-symbolic', 'error');
                    return;
                }
                ext.copy(res[0]);
                ext.notify('LAN address copied', res[0], 'network-wired-symbolic', 'ok');
            });
            break;
        case 'port':
            this.closeDash();
            ext.call('PortFree', [a.port]);
            break;
        case 'restart':
            this.closeDash();
            ext.notify(`Restarting ${a.name}`, '', 'view-refresh-symbolic', '');
            ext.call('DockerAction', [a.id, 'restart'], (_res, err) => {
                if (err)
                    ext.notify(`Couldn't restart ${a.name}`, err.message.replace(/^.*?Error\.Failed: /, ''), 'dialog-error-symbolic', 'error');
                else
                    ext.notify(`${a.name} restarted`, '', 'emblem-ok-symbolic', 'ok');
            });
            break;
        }
    }

    _layers() {
        return [...[...this._pages.values()].map(p => p.actor), this._finder.actor];
    }

    _shownLayer() {
        return this._finding ? this._finder.actor : this._current?.actor;
    }

    _swap(from, to, {dx = 0, dy = 0} = {}) {
        const animate = animationsOn() && this._dash.opacity > 0 && !!from && from !== to && from.visible;
        const rest = {opacity: 255, translation_x: 0, translation_y: 0};
        for (const a of this._layers()) {
            if (a === to || (animate && a === from))
                continue;
            a.remove_all_transitions();
            a.set({...rest, visible: false});
        }
        to.remove_all_transitions();
        to.visible = true;
        if (!animate) {
            to.set(rest);
            return;
        }
        const k = scale();
        const sx = Math.round(PAGE_SHIFT * k), sy = Math.round(FIND_SHIFT * k);
        from.remove_all_transitions();
        from.ease({
            opacity: 0, translation_x: -dx * sx, translation_y: -dy * sy, duration: PAGE_OUT_MS,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onStopped: () => {
                if (from !== this._shownLayer())
                    from.set({...rest, visible: false});
            },
        });
        to.set({opacity: 0, translation_x: dx * sx, translation_y: dy * sy});
        to.ease({
            ...rest, duration: PAGE_IN_MS, delay: PAGE_IN_DELAY_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
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
        const swap = mode !== 'dashboard' && this.mode !== 'dashboard' &&
            (mode !== this.mode || prev.kind !== s.kind || prev.title !== s.title || prev.art !== s.art);
        this._apply();
        if (swap && animationsOn())
            this._motion.springs.fade.x = 0;
        this.relayout(true);
    }

    _apply() {
        const s = this._state;
        const mode = this._targetMode();
        this.mode = mode;
        if (mode !== 'dashboard')
            this._pillMode = mode;
        for (const m of MODES)
            this.remove_style_class_name(m);
        this.add_style_class_name(this._pillMode);
        if (mode === 'dashboard')
            this.add_style_class_name('dashboard');
        if (mode !== 'dashboard') {
            for (const a of ACCENTS)
                this.remove_style_class_name(`accent-${a}`);
            if (ACCENTS.includes(s.accent))
                this.add_style_class_name(`accent-${s.accent}`);
        }
        this.ensure_style();

        if (mode !== 'dashboard') {
            this._pill.apply(s, mode, {
                presenting: this.ext.presenting,
                showFace: featureOn(this.settings, 'face'),
                osd: this._osd,
            });
        }

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
        if (this.mode !== 'dashboard')
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
            this.openDash(KIND_TABS[s.kind] ?? HOME_TAB);
        }
    }

    _onCapturedEvent(event) {
        if (!this.dashOpen)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS)
            return this._onKey(event);
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

    _onKey(event) {
        const sym = event.get_key_symbol();
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (ctrl && (sym === Clutter.KEY_k || sym === Clutter.KEY_K)) {
            this.focusSearch();
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Escape) {
            this._escape();
            return Clutter.EVENT_STOP;
        }
        if (!this._finding)
            return Clutter.EVENT_PROPAGATE;
        if (sym === Clutter.KEY_Up || sym === Clutter.KEY_Down) {
            this._finder.move(sym === Clutter.KEY_Up ? -1 : 1);
            return Clutter.EVENT_STOP;
        }
        if (ENTER_KEYS.has(sym)) {
            this._finder.run();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _faceTarget() {
        const [px, py] = global.get_pointer();
        const f = this._pill.face.actor;
        const [fx, fy] = f.get_transformed_position();
        const dx = px - (fx + f.width / 2), dy = py - (fy + f.height / 2);
        return Number.isFinite(dx) && Number.isFinite(dy) ? [dx, dy] : [0, 0];
    }

    _size() {
        const barH = Main.panel.height;
        const k = scale();
        const shape = SHAPES[this.mode];
        switch (this.mode) {
        case 'idle': {
            this._content.set_size(-1, -1);
            const [, natural] = this._content.get_preferred_width(barH);
            return [Math.max(shape.width * k, Math.ceil(natural)), barH];
        }
        case 'notify':
            return [shape.width * k, shape.height * k];
        case 'dashboard':
            return this._dashSize(k);
        default:
            return [shape.width * k, barH];
        }
    }

    _innerWidth(width) {
        return width - this._dash.get_theme_node().get_horizontal_padding();
    }

    _dashSize(k) {
        const width = DASH_WIDTH * k;
        if (this._finding)
            return [width, this._sheetHeight(width, this._finder.actor, FIND_HEIGHT * k, k)];
        const page = this._current ?? this._pages.get(this.tab);
        if (!page.autoHeight)
            return [width, page.height * k];
        return [width, this._sheetHeight(width, page.actor, page.height * k, k)];
    }

    _sheetHeight(width, actor, max, k) {
        const inner = this._innerWidth(width);
        const gap = this._dash.layout_manager.spacing;
        let h = this._dash.get_theme_node().get_vertical_padding() +
            this._header.get_preferred_height(inner)[1] + gap + actor.get_preferred_height(inner)[1];
        if (this._nav.visible)
            h += this._nav.get_preferred_height(inner)[1] + gap;
        return Math.max(AUTO_MIN_HEIGHT * k, Math.min(max, Math.ceil(h)));
    }

    relayout(animate) {
        if (!Main.layoutManager.primaryMonitor)
            return;
        const [width, height] = this._size();
        const layer = this.mode === 'dashboard' ? this._dash : this._content;
        layer.set_size(Math.round(width), Math.round(height));
        const shape = SHAPES[this.mode];
        const targets = {
            width, height, radius: shape.radius, shoulder: shape.shoulder, op: this.mode === 'dashboard' ? 1 : 0,
        };
        if (!animate || !animationsOn()) {
            this._motion.jump({...targets, fade: 1, scale: 1});
            this._paint();
            return;
        }
        this._motion.retarget(targets);
        this._kick();
    }

    _kick() {
        if (this._loop)
            return;
        this._lastFrame = 0;
        this._loop = frameLoop(this, () => this._frame());
    }

    _frame() {
        const now = GLib.get_monotonic_time() / 1e6;
        const dt = this._lastFrame ? now - this._lastFrame : 1 / 60;
        this._lastFrame = now;
        const moving = this._motion.step(dt);
        this._paint();
        if (!moving)
            this._loop = null;
        return moving;
    }

    _paint() {
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const m = this._motion;
        const k = scale();
        const w = Math.max(1, Math.round(m.value('width')));
        const h = Math.max(1, Math.round(m.value('height')));
        this.set_position(mon.x + Math.round((mon.width - w) / 2), mon.y);
        this.set_size(w, h);

        const r = Math.max(0, Math.round(m.value('radius')));
        if (r !== this._radius) {
            this._radius = r;
            this._bg.set_style(`border-radius: 0 0 ${r}px ${r}px;`);
        }
        const sh = Math.max(0, Math.round(m.value('shoulder') * k));
        if (sh !== this._shoulderPx) {
            this._shoulderPx = sh;
            this.queue_relayout();
        }

        const op = m.value('op');
        const dash = dashReveal(op);
        this._dash.visible = this.dashOpen || dash > 0;
        this._dash.opacity = Math.round(dash * 255);
        this._dash.translation_y = Math.round(-DASH_RISE * (1 - dash) * k);
        const pill = pillReveal(op) * clamp01(m.value('fade'));
        this._content.visible = !this.dashOpen || pill > 0;
        this._content.opacity = Math.round(pill * 255);

        const s = m.value('scale');
        if (this.scale_x !== s)
            this.set_scale(s, s);
    }

    _show() {
        this._shown = true;
        this.relayout(false);
        if (animationsOn()) {
            this._motion.springs.scale.x = SHOW_SCALE;
            this._paint();
            this._kick();
        }
        this.opacity = 0;
        this.ease({opacity: 255, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
});
