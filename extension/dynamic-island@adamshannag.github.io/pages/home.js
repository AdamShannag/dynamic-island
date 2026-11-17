import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {ALL_TABS, MORE_TAB, tabOn} from '../lib/constants.js';
import {fmtClock} from '../lib/format.js';
import {NOTHING_RUNNING, continueItems, focusSubtitle, homeFavorites, signature, taskProgress} from '../lib/home.js';
import {PRESS_TILE, column, iconButton, label, setText, tactile} from '../lib/widgets.js';
import {Page} from './page.js';

const TILE_SLOTS = 6;
const TILES_PER_ROW = 3;
const FAVORITE_IDS = ALL_TABS.map(([id]) => id);

function row(styleClass, props = {}) {
    const box = new St.BoxLayout({style_class: styleClass, ...props});
    box.layout_manager.homogeneous = true;
    return box;
}

function progressBar() {
    const track = new St.Widget({style_class: 'island-track island-hm-track', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    const fill = new St.Widget({style_class: 'island-fill', x: 0, y: 0});
    track.add_child(fill);
    return {
        track,
        set(frac) {
            const w = track.width;
            if (w > 0)
                fill.set_size(Math.round(w * Math.min(1, Math.max(0, frac))), track.height);
        },
    };
}

class MediaCard {
    constructor(page) {
        this._page = page;
        this._lastPlayer = '';
        this.actor = column({style_class: 'island-hm-card island-hm-media', x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.FILL});

        const head = new St.BoxLayout({style_class: 'island-hm-media-head'});
        const art = new St.Widget({style_class: 'island-hm-art', layout_manager: new Clutter.BinLayout()});
        art.add_child(new St.Icon({
            icon_name: 'audio-x-generic-symbolic', style_class: 'island-hm-art-icon',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        }));
        this._art = new St.Bin({style_class: 'island-hm-art-img', x_expand: true, y_expand: true});
        art.add_child(this._art);
        const text = column({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = label('island-hm-title');
        this._artist = label('island-hm-muted');
        text.add_child(this._title);
        text.add_child(this._artist);
        head.add_child(art);
        head.add_child(text);
        this.actor.add_child(head);
        this.actor.add_child(new St.Widget({y_expand: true}));

        this._live = column({style_class: 'island-hm-media-live'});
        this._progress = new St.BoxLayout({style_class: 'island-hm-progress'});
        this._pos = label('island-hm-time');
        this._rem = label('island-hm-time island-hm-time-right');
        this._bar = progressBar();
        for (const a of [this._pos, this._bar.track, this._rem])
            this._progress.add_child(a);
        this._live.add_child(this._progress);

        const controls = new St.BoxLayout({style_class: 'island-hm-controls', x_align: Clutter.ActorAlign.CENTER});
        controls.add_child(iconButton('media-skip-backward-symbolic', 'island-hm-ctl',
            () => page.ext.action('media.previous'), 'Previous'));
        this._play = iconButton('media-playback-start-symbolic', 'island-hm-ctl island-hm-play island-hm-accent',
            () => page.ext.action('media.play-pause'), 'Play/Pause');
        controls.add_child(this._play);
        controls.add_child(iconButton('media-skip-forward-symbolic', 'island-hm-ctl',
            () => page.ext.action('media.next'), 'Next'));
        this._live.add_child(controls);
        this.actor.add_child(this._live);

        this._resume = new St.Button({
            style_class: 'island-hm-resume island-hm-accent', can_focus: true,
            x_align: Clutter.ActorAlign.START, label: 'Resume', visible: false,
        });
        this._resume.connect('clicked', () => page.ext.action('media.resume'));
        this.actor.add_child(this._resume);
    }

    update(m, presenting) {
        this._live.visible = !!m;
        setText(this._title, m ? presenting ? 'Now playing' : m.title ?? '' : 'Nothing playing');
        setText(this._artist, m ? presenting ? 'Hidden while presenting' : m.subtitle ?? '' : this._idleHint());
        this._art.visible = !!m?.art && !presenting;
        if (m?.art && !presenting)
            this._art.style = `background-image: url("file://${encodeURI(m.art)}");`;
        this._progress.visible = !!m?.timing;
        this._play.child.icon_name = m?.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._resume.visible = !m && !!this._lastPlayer;
        if (!m)
            this._loadLastPlayer();
    }

    _idleHint() {
        return this._lastPlayer ? `Last played in ${this._lastPlayer}` : 'Start music in any player';
    }

    _loadLastPlayer() {
        this._page.call('MediaLastPlayer', [], res => {
            const name = res?.[0] ?? '';
            if (this._page.island.media)
                return;
            this._lastPlayer = name;
            this._resume.label = name ? `Resume ${name}` : 'Resume';
            this._resume.visible = !!name;
            setText(this._artist, this._idleHint());
        });
    }

    tick(m, now) {
        const t = m?.timing;
        if (!t)
            return;
        const elapsed = m.playing ? (now - t.at) / 1000 * (t.rate || 1) : 0;
        const pos = Math.min(t.length, Math.max(0, t.position + elapsed));
        setText(this._pos, fmtClock(pos));
        setText(this._rem, `-${fmtClock(t.length - pos)}`);
        this._bar.set(t.length ? pos / t.length : 0);
    }
}

class Favorites {
    constructor(page) {
        this._page = page;
        this._sig = null;
        this.actor = column({style_class: 'island-hm-favs', x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.FILL});
        this._rows = [0, 1].map(() => {
            const r = row('island-hm-favs-row', {x_expand: true, y_expand: true});
            this.actor.add_child(r);
            return r;
        });
    }

    update(settings) {
        const tabs = new Map(ALL_TABS.map(t => [t[0], t]));
        const ids = homeFavorites(settings, FAVORITE_IDS).filter(id => tabOn(settings, id));
        const sig = ids.join('|');
        if (sig === this._sig)
            return;
        this._sig = sig;
        this._rows.forEach(r => r.destroy_all_children());
        for (let i = 0; i < TILE_SLOTS; i++) {
            const entry = i === TILE_SLOTS - 1 ? MORE_TAB : tabs.get(ids[i]);
            const r = this._rows[Math.floor(i / TILES_PER_ROW)];
            r.add_child(entry ? this._tile(entry) : new St.Widget({x_expand: true, y_expand: true}));
        }
    }

    _tile([id, name, icon]) {
        const body = column({style_class: 'island-hm-tile-body', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        body.add_child(new St.Icon({icon_name: icon, style_class: 'island-hm-tile-icon', x_align: Clutter.ActorAlign.CENTER}));
        body.add_child(label('island-hm-tile-name', {text: name, x_align: Clutter.ActorAlign.CENTER}));
        const btn = new St.Button({
            style_class: 'island-hm-tile', can_focus: true, accessible_name: name,
            x_expand: true, y_expand: true, child: body,
        });
        btn.connect('clicked', () => this._page.island.showTab(id));
        return tactile(btn, {press: PRESS_TILE, lift: 1});
    }
}

class ContinueCard {
    constructor(page, item) {
        this.actor = new St.BoxLayout({style_class: 'island-hm-card island-hm-cc', x_expand: true});
        const icon = new St.Bin({style_class: 'island-hm-cc-icon', y_align: Clutter.ActorAlign.CENTER});
        icon.child = new St.Icon({icon_name: ContinueCard.icon(item)});
        this.actor.add_child(icon);
        const text = column({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = label('island-hm-cc-title');
        this._sub = label('island-hm-muted island-hm-cc-sub');
        if (item.kind === 'empty') {
            this._sub.clutter_text.line_wrap = true;
            this._sub.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        }
        text.add_child(this._title);
        text.add_child(this._sub);
        this._bar = progressBar();
        this._bar.track.add_style_class_name('island-hm-cc-bar');
        this._bar.track.opacity = 0;
        text.add_child(this._bar.track);
        this.actor.add_child(text);
        this._btn = ContinueCard.button(page, item);
        if (this._btn)
            this.actor.add_child(this._btn);
    }

    static icon(item) {
        if (item.kind === 'run')
            return item.task?.kind === 'service' ? 'network-transmit-receive-symbolic' : 'system-run-symbolic';
        return {docker: 'network-server-symbolic', focus: 'alarm-symbolic'}[item.kind] ?? 'emblem-ok-symbolic';
    }

    static button(page, item) {
        switch (item.kind) {
        case 'run':
            return iconButton('go-next-symbolic', 'island-hm-cc-btn', () => page.island.showTab('activity'), 'Open in Activity');
        case 'docker':
            return iconButton('go-next-symbolic', 'island-hm-cc-btn', () => page.island.showTab('docker'), 'Open Docker');
        case 'focus':
            return iconButton('media-playback-start-symbolic', 'island-hm-cc-btn island-hm-accent',
                () => page.ext.action('pomodoro.toggle'), 'Start or stop focus');
        }
        return null;
    }

    update(item, island, now) {
        switch (item.kind) {
        case 'run': {
            const p = taskProgress(item.task, now);
            setText(this._title, item.task.title || 'Running');
            setText(this._sub, p.sub);
            this._bar.track.opacity = p.pct === null ? 0 : 255;
            if (p.pct !== null)
                this._bar.set(p.pct);
            break;
        }
        case 'docker':
            setText(this._title, 'Containers');
            setText(this._sub, `${item.count} running`);
            break;
        case 'focus':
            setText(this._title, island.timer?.title === 'Break' ? 'Break' : 'Focus session');
            setText(this._sub, focusSubtitle(island.timer, now));
            this._btn.child.icon_name = island.timer ? 'media-playback-stop-symbolic' : 'media-playback-start-symbolic';
            break;
        default:
            setText(this._title, 'Nothing running');
            setText(this._sub, NOTHING_RUNNING);
        }
    }
}

export class HomePage extends Page {
    static id = 'home';
    static height = 420;
    static autoHeight = true;
    static interval = 4000;

    build() {
        this._tasks = [];
        this._docker = 0;
        this._items = [];
        this._cards = [];
        this._sig = null;
        this._hadMedia = null;

        const page = column({style_class: 'island-page island-home'});
        const top = row('island-hm-top', {x_expand: true});
        this._media = new MediaCard(this);
        this._favs = new Favorites(this);
        top.add_child(this._media.actor);
        top.add_child(this._favs.actor);
        page.add_child(top);
        this._label = label('island-hm-label', {text: 'Continue'});
        page.add_child(this._label);
        this._cont = row('island-hm-cont', {x_expand: true});
        page.add_child(this._cont);
        this._renderContinue();
        return page;
    }

    get ticking() {
        return true;
    }

    onShow() {
        this.onState();
        this.refresh();
        return null;
    }

    onSettings(st) {
        this._favs.update(st);
        this.refresh();
    }

    onState() {
        const m = this.island.media;
        this._media.update(m, this.ext.presenting);
        this._media.tick(m, Date.now());
        this._renderContinue();
        if (this._hadMedia !== null && this._hadMedia !== !!m)
            this.refit();
        this._hadMedia = !!m;
    }

    refresh() {
        if (!this.active)
            return;
        this.fetch('ActivityList', [], (list, err) => {
            this._tasks = !err && Array.isArray(list) ? list : [];
            this._renderContinue();
        });
        if (!tabOn(this.island.settings, 'docker')) {
            this._docker = 0;
            this._renderContinue();
            return;
        }
        this.fetch('DockerList', [], (list, err) => {
            this._docker = !err && Array.isArray(list) ? list.length : 0;
            this._renderContinue();
        });
    }

    tick(now) {
        this._media.tick(this.island.media, now);
        this._items.forEach((item, i) => this._cards[i]?.update(item, this.island, now));
    }

    _renderContinue() {
        this._showItems(continueItems({tasks: this._tasks, docker: this._docker, focus: true}));
    }

    _showItems(items) {
        this._items = items.length ? items : [{id: 'empty', kind: 'empty'}];
        const sig = signature(this._items);
        if (sig !== this._sig) {
            this._sig = sig;
            this._cont.destroy_all_children();
            this._cards = this._items.map(item => new ContinueCard(this, item));
            this._cards.forEach(c => this._cont.add_child(c.actor));
            if (this.active)
                this.refit();
        }
        this.tick(Date.now());
    }

    blocks() {
        return [this._media.actor, this._favs.actor, this._label, ...this._cont.get_children()];
    }
}
