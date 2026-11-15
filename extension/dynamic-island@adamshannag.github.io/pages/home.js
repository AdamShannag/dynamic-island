import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {VERTICAL, tabOn} from '../lib/constants.js';
import {dockerProblem, fmtClock} from '../lib/format.js';
import {Equalizer, column, iconButton, label} from '../lib/widgets.js';
import {Page} from './page.js';

function actionRow(color, title, onClick) {
    const row = new St.BoxLayout({style_class: 'island-action'});
    row.add_child(new St.Widget({style_class: `island-action-bar ${color}`}));
    const col = column({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    const sub = label('island-action-sub');
    col.add_child(label('island-action-title', {text: title}));
    col.add_child(sub);
    row.add_child(col);
    const btn = new St.Button({style_class: `island-action-btn ${color}`, can_focus: true, y_align: Clutter.ActorAlign.CENTER});
    btn.connect('clicked', onClick);
    row.add_child(btn);
    return {row, sub, btn};
}

export class HomePage extends Page {
    static id = 'home';
    static height = 292;

    build() {
        const page = new St.BoxLayout({style_class: 'island-page island-home'});
        page.add_child(this._buildMediaCard());
        page.add_child(this._buildTodayCard());
        return page;
    }

    _buildMediaCard() {
        const media = new St.BoxLayout({style_class: 'island-card island-media-card', ...VERTICAL, x_expand: true});
        const top = new St.BoxLayout({style_class: 'island-media-top'});
        const artFrame = new St.Widget({style_class: 'island-media-art', layout_manager: new Clutter.BinLayout()});
        this._art = new St.Bin({style_class: 'island-media-art-img', x_expand: true, y_expand: true});
        artFrame.add_child(new St.Icon({
            icon_name: 'audio-x-generic-symbolic', style_class: 'island-media-art-icon',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        }));
        artFrame.add_child(this._art);
        const col = column({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = label('island-media-title');
        this._sub = label('island-media-sub');
        col.add_child(this._title);
        col.add_child(this._sub);
        this._eq = new Equalizer('card');
        top.add_child(artFrame);
        top.add_child(col);
        top.add_child(this._eq.actor);
        media.add_child(top);
        media.add_child(new St.Widget({y_expand: true}));

        this._progress = new St.BoxLayout({style_class: 'island-progress'});
        this._posLabel = label('island-time');
        this._remLabel = label('island-time island-time-right');
        this._track = new St.Widget({style_class: 'island-track', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._fill = new St.Widget({style_class: 'island-fill', x: 0, y: 0});
        this._track.add_child(this._fill);
        for (const a of [this._posLabel, this._track, this._remLabel])
            this._progress.add_child(a);
        media.add_child(this._progress);

        this._controls = new St.BoxLayout({style_class: 'island-controls', x_align: Clutter.ActorAlign.CENTER});
        this._controls.add_child(iconButton('media-seek-backward-symbolic', 'island-btn',
            () => this.ext.action('media.previous'), 'Previous'));
        this._playBtn = iconButton('media-playback-start-symbolic', 'island-btn island-btn-big',
            () => this.ext.action('media.play-pause'), 'Play/Pause');
        this._controls.add_child(this._playBtn);
        this._controls.add_child(iconButton('media-seek-forward-symbolic', 'island-btn',
            () => this.ext.action('media.next'), 'Next'));
        media.add_child(this._controls);
        return media;
    }

    _buildTodayCard() {
        const today = new St.BoxLayout({style_class: 'island-card island-today-card', ...VERTICAL});
        this._date = label('island-today-date');
        this._greeting = label('island-today-title');
        today.add_child(this._date);
        today.add_child(this._greeting);
        this._focusRow = actionRow('green', 'Focus session', () =>
            this.ext.action(this.island.timer ? 'pomodoro.stop' : 'pomodoro.start'));
        this._dockerRow = actionRow('blue', 'Containers', () => this.island.showTab('docker'));
        this._dockerRow.btn.label = 'Open';
        today.add_child(this._focusRow.row);
        today.add_child(this._dockerRow.row);
        return today;
    }

    get ticking() {
        return !!(this.island.media?.playing || this.island.timer);
    }

    onShow() {
        this.onState();
        this._loadDockerCount();
        return null;
    }

    onSettings(st) {
        this._dockerRow.row.visible = tabOn(st, 'docker');
    }

    onState() {
        const m = this.island.media;
        const priv = this.ext.presenting;
        this._title.text = m ? priv ? 'Now playing' : m.title ?? '' : 'Not playing';
        this._sub.text = m ? priv ? 'Hidden while presenting' : m.subtitle ?? '' : 'Start music in any player';
        this._art.visible = !!m?.art && !priv;
        if (m?.art)
            this._art.style = `background-image: url("file://${encodeURI(m.art)}");`;
        this._eq.actor.visible = !!m;
        this._eq.running = !!m?.playing;
        this._progress.visible = !!m?.timing;
        this._controls.reactive = !!m;
        this._controls.opacity = m ? 255 : 90;
        this._playBtn.child.icon_name = m?.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';

        const now = GLib.DateTime.new_now_local();
        this._date.text = now.format('%a, %-d %b').toUpperCase();
        const h = now.get_hour();
        this._greeting.text = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
        this._focusRow.btn.label = this.island.timer ? 'Stop' : 'Start';
    }

    tick(now) {
        const timer = this.island.timer;
        this._focusRow.sub.text = timer
            ? `${timer.title} · ${fmtClock((timer.endsAt - now) / 1000)} left`
            : '25 min of deep work';
        const m = this.island.media;
        const t = m?.timing;
        if (!t)
            return;
        const elapsed = m.playing ? (now - t.at) / 1000 * (t.rate || 1) : 0;
        const pos = Math.min(t.length, Math.max(0, t.position + elapsed));
        this._posLabel.text = fmtClock(pos);
        this._remLabel.text = `-${fmtClock(t.length - pos)}`;
        const w = this._track.width;
        if (w > 0)
            this._fill.set_size(Math.round(w * (t.length ? pos / t.length : 0)), this._track.height);
    }

    _loadDockerCount() {
        this.ext.callJson('DockerList', [], (list, err) => {
            if (err) {
                this._dockerRow.sub.text = dockerProblem(err.message).title;
                return;
            }
            const bad = list.filter(c => /unhealthy/.test(c.status)).length;
            this._dockerRow.sub.text = `${list.length} running${bad ? ` · ${bad} unhealthy` : ''}`;
        });
    }
}
