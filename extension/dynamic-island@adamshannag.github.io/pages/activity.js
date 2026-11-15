import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {VERTICAL, scale} from '../lib/constants.js';
import {fmtBytes, fmtClock, hexToRgb} from '../lib/format.js';
import {focusPids, lookupProcessApp} from '../lib/shell.js';
import {column, fillList, label, portButton, scrollView, setMessage, setText} from '../lib/widgets.js';
import {Page} from './page.js';

const SPARK_POINTS = 60;
const PROC_ROWS = 6;

class MetricTile {
    constructor(title, color, bar = false) {
        this.color = color;
        this.series = [];
        this.max = 100;
        this.frac = 0;
        this.actor = new St.BoxLayout({style_class: 'island-card island-tile', ...VERTICAL, x_expand: true});
        this.actor.add_child(label('island-group island-tile-title', {text: title}));
        this.value = label('island-tile-value');
        this.sub = label('island-tile-sub');
        this.actor.add_child(this.value);
        this.actor.add_child(this.sub);
        if (bar) {
            this._track = new St.Widget({style_class: 'island-tile-track', x_expand: true});
            this._fill = new St.Widget({style_class: 'island-tile-fill', x: 0, y: 0});
            this._fill.set_style(`background-color: ${color};`);
            this._track.add_child(this._fill);
            this._track.connect('notify::allocation', () => this._syncBar());
            this.actor.add_child(this._track);
        } else {
            this._chart = new St.DrawingArea({style_class: 'island-spark', x_expand: true});
            this._chart.connect('repaint', area => this._paint(area));
            this.actor.add_child(this._chart);
        }
    }

    setFraction(frac) {
        this.frac = frac;
        this._syncBar();
    }

    push(v, autoScaleFloor = 0) {
        this.series.push(v);
        if (this.series.length > SPARK_POINTS)
            this.series.shift();
        if (autoScaleFloor)
            this.max = Math.max(autoScaleFloor, ...this.series) * 1.15;
        this._chart?.queue_repaint();
    }

    _syncBar() {
        const w = this._track?.width;
        if (w > 0)
            this._fill.set_size(Math.round(w * Math.min(1, this.frac)), this._track.height);
    }

    _paint(area) {
        const cr = area.get_context();
        try {
            const [w, h] = area.get_surface_size();
            const pts = this.series;
            if (pts.length < 2)
                return;
            const [r, g, b] = hexToRgb(this.color);
            const step = w / (SPARK_POINTS - 1);
            const xy = pts.map((v, i) => [w - (pts.length - 1 - i) * step, h - 1 - Math.min(1, v / this.max) * (h - 3)]);
            cr.moveTo(xy[0][0], h);
            for (const [x, y] of xy)
                cr.lineTo(x, y);
            cr.lineTo(w, h);
            cr.closePath();
            cr.setSourceRGBA(r, g, b, 0.16);
            cr.fill();
            cr.moveTo(...xy[0]);
            for (const [x, y] of xy.slice(1))
                cr.lineTo(x, y);
            cr.setSourceRGBA(r, g, b, 0.95);
            cr.setLineWidth(1.6 * scale());
            cr.stroke();
        } finally {
            cr.$dispose();
        }
    }
}

class ProcessRow {
    constructor(icons) {
        this._icons = icons;
        this.actor = new St.BoxLayout({style_class: 'island-proc-row', visible: false});
        this._iconBin = new St.Bin({style_class: 'island-proc-iconbin', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'island-proc-icon'});
        this._initial = new St.Label({style_class: 'island-proc-initial', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._iconBin.child = this._icon;
        this._name = label('island-proc-name', {x_expand: true});
        this._cpu = label('island-proc-cpu');
        this._mem = label('island-proc-mem');
        for (const a of [this._iconBin, this._name, this._cpu, this._mem])
            this.actor.add_child(a);
        this._iconFor = undefined;
    }

    update(p) {
        this.actor.visible = !!p;
        if (!p)
            return;
        setText(this._name, p.name || `pid ${p.pid}`);
        if (this._iconFor !== p.name) {
            this._iconFor = p.name;
            if (!this._icons.has(p.name))
                this._icons.set(p.name, lookupProcessApp(p.name)?.get_icon() ?? null);
            const gicon = this._icons.get(p.name);
            if (gicon) {
                this._icon.gicon = gicon;
                this._iconBin.child = this._icon;
                this._iconBin.remove_style_class_name('initial');
            } else {
                this._initial.text = (p.name || '?')[0].toUpperCase();
                this._iconBin.child = this._initial;
                this._iconBin.add_style_class_name('initial');
            }
        }
        setText(this._cpu, `${p.cpu.toFixed(p.cpu < 10 ? 1 : 0)}%`);
        setText(this._mem, fmtBytes(p.mem, 0));
        const cls = `island-proc-cpu${p.cpu >= 50 ? ' hot' : ''}`;
        if (this._cpu.style_class !== cls)
            this._cpu.style_class = cls;
    }
}

export class ActivityPage extends Page {
    static id = 'activity';
    static height = 470;
    static interval = 1000;

    build() {
        const page = new St.BoxLayout({style_class: 'island-page', ...VERTICAL});
        const tiles = new St.BoxLayout({style_class: 'island-tiles'});
        tiles.layout_manager.homogeneous = true;
        this._tiles = {
            cpu: new MetricTile('CPU', '#0a84ff'),
            mem: new MetricTile('MEMORY', '#30d158'),
            disk: new MetricTile('DISK', '#bf5af2', true),
            net: new MetricTile('NETWORK', '#ff9f0a'),
        };
        for (const t of Object.values(this._tiles))
            tiles.add_child(t.actor);
        page.add_child(tiles);

        const lower = new St.BoxLayout({style_class: 'island-activity-lower', y_expand: true});
        lower.add_child(this._buildTopCard());
        lower.add_child(this._buildRunningCard());
        page.add_child(lower);
        return page;
    }

    _buildTopCard() {
        const card = new St.BoxLayout({style_class: 'island-card island-list-card', ...VERTICAL, x_expand: true, y_expand: true});
        card.add_child(label('island-group', {text: 'TOP PROCESSES'}));
        const list = column({style_class: 'island-list'});
        const icons = new Map();
        this._procRows = Array.from({length: PROC_ROWS}, () => {
            const row = new ProcessRow(icons);
            list.add_child(row.actor);
            return row;
        });
        card.add_child(list);
        return card;
    }

    _buildRunningCard() {
        const card = new St.BoxLayout({style_class: 'island-card island-list-card', ...VERTICAL, x_expand: true, y_expand: true});
        card.add_child(label('island-group', {text: 'RUNNING'}));
        this._msg = label('island-empty island-empty-small', {visible: false, x_align: Clutter.ActorAlign.CENTER});
        this._list = column({style_class: 'island-list'});
        card.add_child(this._msg);
        card.add_child(scrollView(this._list));
        return card;
    }

    refresh() {
        this.fetch('SystemStats', [], (st, err) => {
            if (!err)
                this._renderStats(st);
        });
        this.fetch('ActivityList', [], (items, err) => {
            items = err ? [] : items;
            setMessage(this._msg, err ? 'Daemon not running' : items.length ? '' : 'No builds or dev servers running', () => this.refit());
            this._renderRunning(items);
        });
    }

    _renderStats(st) {
        const T = this._tiles;
        setText(T.cpu.value, `${Math.round(st.cpu)}%`);
        setText(T.cpu.sub, [`${st.cores} cores`, st.tempC ? `${Math.round(st.tempC)}°C` : '', `load ${st.load1.toFixed(2)}`]
            .filter(Boolean).join('  ·  '));
        T.cpu.push(st.cpu);

        setText(T.mem.value, fmtBytes(st.memUsed));
        setText(T.mem.sub, `of ${fmtBytes(st.memTotal, 0)}${st.swapTotal ? `  ·  swap ${fmtBytes(st.swapUsed)}` : ''}`);
        T.mem.push(st.memTotal ? 100 * st.memUsed / st.memTotal : 0);

        const disk = st.diskTotal ? st.diskUsed / st.diskTotal : 0;
        setText(T.disk.value, `${Math.round(disk * 100)}%`);
        setText(T.disk.sub, `${fmtBytes(st.diskUsed, 0)} of ${fmtBytes(st.diskTotal, 0)}`);
        T.disk.setFraction(disk);

        setText(T.net.value, `↓ ${fmtBytes(st.netRx)}/s`);
        setText(T.net.sub, `↑ ${fmtBytes(st.netTx)}/s`);
        T.net.push(st.netRx + st.netTx, 64 * 1024);

        this._procRows.forEach((row, k) => row.update(st.top[k]));
    }

    _renderRunning(items) {
        const now = Date.now();
        const elapsed = it => fmtClock((now - it.startedAt) / 1000);
        const sig = items.map(it => `${it.pid}:${(it.ports ?? []).join(',')}`).join('|');
        if (sig === this._sig && this._times) {
            items.forEach((it, k) => this._times[k] && setText(this._times[k], elapsed(it)));
            return;
        }
        this._sig = sig;
        this._times = [];
        fillList(this._list, items, (it, k) => {
            const box = new St.BoxLayout({x_expand: true, style_class: 'island-activity-row'});
            const badge = new St.Widget({
                style_class: `island-activity-badge ${it.kind}`,
                layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER,
            });
            badge.add_child(new St.Icon({
                icon_name: it.kind === 'service' ? 'network-server-symbolic' : 'system-run-symbolic',
                style_class: 'island-activity-icon', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            }));
            box.add_child(badge);
            const col = column({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            col.add_child(label('island-row-title island-mono', {text: it.title}));
            col.add_child(label('island-row-sub', {text: [it.project, it.app].filter(Boolean).join('  ·  ')}));
            box.add_child(col);
            if (it.ports?.length) {
                const chips = new St.BoxLayout({style_class: 'island-port-chips', y_align: Clutter.ActorAlign.CENTER});
                for (const port of it.ports.slice(0, 2))
                    chips.add_child(portButton(port, 'island-port-chip', p => this.island.openPort(p)));
                box.add_child(chips);
            }
            const time = label('island-activity-time live', {text: elapsed(it), y_align: Clutter.ActorAlign.CENTER});
            this._times[k] = time;
            box.add_child(time);
            const row = new St.Button({style_class: 'island-row island-clip-row', can_focus: true, child: box, x_expand: true});
            row.connect('clicked', () => {
                if (focusPids(it.focus))
                    this.close();
            });
            return row;
        }, () => this.refit());
    }
}
