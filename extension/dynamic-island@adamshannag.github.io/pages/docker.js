import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import {VERTICAL} from '../lib/constants.js';
import {dockerProblem} from '../lib/format.js';
import {
    EmptyState, badge, column, fillList, group, hoverActions, iconButton, label, page, portButton,
    rowText, scrollView, setText,
} from '../lib/widgets.js';
import {Page} from './page.js';

const errorText = err => err.message.replace(/^.*?Error\.Failed: /, '');

function setStats(refs, st) {
    setText(refs.cpu, st ? `${st.cpu.toFixed(st.cpu < 10 ? 1 : 0)}% CPU` : '–');
    setText(refs.mem, st ? st.mem.replace(/iB$/, 'B') : ' ');
    refs.cpu.style_class = `island-usage-cpu${st && st.cpu >= 80 ? ' hot' : ''}`;
    refs.mem.style_class = `island-usage-mem${st && st.memPct >= 80 ? ' hot' : ''}`;
}

export class DockerPage extends Page {
    static id = 'docker';
    static autoHeight = true;
    static interval = 3000;

    build() {
        const actor = page();
        this._empty = new EmptyState(() => this.refit());
        this._groups = column({style_class: 'island-groups'});
        this._scroll = scrollView(this._groups);
        actor.add_child(this._empty.actor);
        actor.add_child(this._scroll);
        return actor;
    }

    refresh() {
        this.fetch('DockerList', [], (list, err) => {
            if (err || !list.length) {
                this._sig = null;
                this._groups.destroy_all_children();
                this._scroll.hide();
                this._empty.show(err ? dockerProblem(err.message) : {
                    icon: 'network-server-symbolic', title: 'No containers running',
                    hint: 'Start some with docker compose up or docker run',
                });
                return;
            }
            this._empty.hide();
            this._scroll.show();
            this._render(list);
        });
    }

    _render(list) {
        const sig = list.map(c => [c.id, c.state, c.status, c.ports, c.project].join('/')).join('|');
        if (sig === this._sig && this._stats) {
            for (const c of list) {
                const refs = this._stats.get(c.id);
                if (refs)
                    setStats(refs, c.stats);
            }
            return;
        }
        this._sig = sig;
        this._stats = new Map();
        this._groups.destroy_all_children();
        const projects = Map.groupBy ? Map.groupBy(list, c => c.project || '') : list.reduce((m, c) => {
            const key = c.project || '';
            m.set(key, [...m.get(key) ?? [], c]);
            return m;
        }, new Map());
        for (const [project, containers] of projects) {
            const count = label('island-igroup-count', {text: `${containers.length} running`});
            const g = group((project || 'standalone').toUpperCase(), count);
            this._groups.add_child(g.actor);
            fillList(g.list, containers, c => this._row(c), () => this.refit());
        }
    }

    _row(c) {
        const unhealthy = /unhealthy/.test(c.status);
        const color = c.state !== 'running' ? '#8e8e93' : unhealthy ? '#ff9f0a' : '#30d158';
        const row = new St.BoxLayout({style_class: 'island-irow island-irow-box', x_expand: true});
        row.add_child(badge({icon: 'network-server-symbolic', color}));
        const status = c.status.replace(/\s*\((healthy|unhealthy)\)/, '');
        const health = unhealthy ? 'Unhealthy' : /\(healthy\)/.test(c.status) ? 'Healthy' : '';
        row.add_child(rowText(c.name, [health, status, c.image].filter(Boolean).join('  ·  ')).col);
        const chips = new St.BoxLayout({style_class: 'island-port-chips', y_align: Clutter.ActorAlign.CENTER});
        for (const p of (c.ports || '').split(', ').filter(Boolean).slice(0, 3))
            chips.add_child(portButton(p, 'island-port-chip', port => this.island.openPort(port)));
        row.add_child(chips);
        const usage = column({style_class: 'island-usage', y_align: Clutter.ActorAlign.CENTER});
        const refs = {
            cpu: label('island-usage-cpu', {x_align: Clutter.ActorAlign.END}),
            mem: label('island-usage-mem', {x_align: Clutter.ActorAlign.END}),
        };
        setStats(refs, c.stats);
        this._stats.set(c.id, refs);
        usage.add_child(refs.cpu);
        usage.add_child(refs.mem);
        row.add_child(usage);
        const buttons = [iconButton('format-justify-left-symbolic', 'island-row-btn',
            () => this.island.page('logs').open(c), `Logs of ${c.name}`)];
        for (const [op, icon] of [['restart', 'view-refresh-symbolic'], ['stop', 'media-playback-stop-symbolic']]) {
            buttons.push(iconButton(icon, 'island-row-btn', () => {
                row.opacity = 128;
                this.call('DockerAction', [c.id, op], () => this.active && this.refresh());
            }, `${op} ${c.name}`));
        }
        row.add_child(hoverActions(row, buttons));
        return row;
    }
}

export class LogsPage extends Page {
    static id = 'logs';
    static title = 'Logs';
    static parent = 'docker';
    static height = 520;
    static interval = 2000;

    build() {
        const actor = page();
        this._hint = label('island-hint', {text: 'Last 50 lines · live'});
        const card = new St.BoxLayout({style_class: 'island-card island-logs-card', ...VERTICAL, x_expand: true, y_expand: true});
        this._text = new St.Label({style_class: 'island-logs', reactive: true});
        const ct = this._text.clutter_text;
        ct.line_wrap = true;
        ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        ct.selectable = true;
        ct.reactive = true;
        const box = column({x_expand: true});
        box.add_child(this._text);
        this._scroll = scrollView(box);
        card.add_child(this._scroll);
        actor.add_child(card);
        return actor;
    }

    get heading() {
        return this._container ? `Logs · ${this._container.name}` : 'Logs';
    }

    get navActions() {
        return this._hint;
    }

    open(container) {
        this._container = container;
        this._text.text = 'Loading…';
        this.island.showTab('logs');
    }

    onShow() {
        this._load(true);
        return null;
    }

    refresh() {
        this._load(false);
    }

    _load(scrollToEnd) {
        const c = this._container;
        if (!c)
            return;
        this.call('DockerLogs', [c.id, 50], (res, err) => {
            if (!this.active || this._container !== c)
                return;
            const adj = this._scroll.vadjustment;
            const atEnd = scrollToEnd || adj.value + adj.page_size >= adj.upper - 4;
            const text = err ? errorText(err) : res[0].trimEnd() || '(no output yet)';
            if (text === this._text.text)
                return;
            this._text.text = text;
            if (atEnd) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    adj.value = adj.upper - adj.page_size;
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
    }
}
