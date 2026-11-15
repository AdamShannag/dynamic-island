import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {ago} from '../lib/format.js';
import {focusPids} from '../lib/shell.js';
import {EmptyState, badge, column, fillList, group, label, page, rowText, scrollView, setText} from '../lib/widgets.js';
import {Page} from './page.js';

const AGENT_STATES = {
    working: ['Working', 'blue'],
    approval: ['Needs approval', 'yellow'],
    done: ['Finished', 'green'],
    error: ['Error', 'red'],
    ready: ['Idle', 'grey'],
};

export class AgentsPage extends Page {
    static id = 'agents';
    static height = 400;
    static autoHeight = true;
    static interval = 2000;

    build() {
        const actor = page();
        this._empty = new EmptyState(() => this.refit());
        this._group = group('SESSIONS');
        const content = column({style_class: 'island-groups'});
        content.add_child(this._group.actor);
        this._scroll = scrollView(content);
        actor.add_child(this._empty.actor);
        actor.add_child(this._scroll);
        return actor;
    }

    refresh() {
        this.fetch('AgentsList', [], (list, err) => {
            list = err ? [] : list;
            if (!list.length) {
                this._sig = null;
                this._scroll.hide();
                this._empty.show(err ? {icon: 'dialog-warning-symbolic', title: 'Daemon not running'}
                    : {gicon: this.ext.agentIcon, icon: 'utilities-terminal-symbolic', title: 'No agent sessions',
                        hint: 'Run island claude install, then start Claude Code'});
                return;
            }
            this._empty.hide();
            this._scroll.show();
            this._render(list);
        });
    }

    _render(list) {
        const sig = JSON.stringify(list.map(a => [a.id, a.state, a.detail, a.title, a.project, a.costUsd, a.contextPct]));
        if (sig === this._sig && this._when) {
            list.forEach((a, k) => this._when[k] && setText(this._when[k], ago(a.updatedAt)));
            return;
        }
        this._sig = sig;
        this._when = [];
        fillList(this._group.list, list, (a, k) => this._row(a, k), () => this.refit());
    }

    _row(a, k) {
        const [stateName, color] = AGENT_STATES[a.state] ?? AGENT_STATES.ready;
        const row = new St.Button({style_class: 'island-irow', can_focus: true, x_expand: true});
        const box = new St.BoxLayout({style_class: 'island-irow-box', x_expand: true});
        box.add_child(badge({gicon: this.ext.agentIcon, color: 'rgba(255, 159, 10, 0.16)'}));
        const detail = a.detail || a.title || '';
        box.add_child(rowText(a.project || 'session', detail, {monoSub: detail.startsWith('$ ')}).col);
        const end = {x_align: Clutter.ActorAlign.END};
        const meta = column({y_align: Clutter.ActorAlign.CENTER, style_class: 'island-irow-meta'});
        meta.add_child(label(`island-pill-badge ${color}`, {text: stateName, ...end}));
        const usage = [a.costUsd ? `$${a.costUsd.toFixed(2)}` : '', a.contextPct ? `${Math.round(a.contextPct)}% context` : '']
            .filter(Boolean).join('  ·  ');
        if (usage)
            meta.add_child(label('island-irow-sub', {text: usage, ...end}));
        const when = label('island-irow-sub', {text: ago(a.updatedAt), ...end});
        this._when[k] = when;
        meta.add_child(when);
        box.add_child(meta);
        row.child = box;
        row.connect('clicked', () => {
            if (focusPids(a.focus))
                this.close();
        });
        return row;
    }
}
