import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {
    column, confirmButton, fillList, group, hoverActions, label, page, portButton, rowText, scrollView, searchEntry,
    setMessage,
} from '../lib/widgets.js';
import {Page} from './page.js';

const LOCAL = new Set(['127.0.0.1', '::1']);
const ANY = new Set(['0.0.0.0', '::']);

export class PortsPage extends Page {
    static id = 'ports';
    static autoHeight = true;

    build() {
        const actor = page();
        this._entry = searchEntry('Filter, or type a port and press Enter to free it');
        this._entry.clutter_text.connect('text-changed', () => this._render());
        this._entry.clutter_text.connect('activate', () => {
            const port = Number(this._entry.text.trim().replace(/^:/, ''));
            if (Number.isInteger(port) && port > 0 && port < 65536) {
                this._entry.text = '';
                this._free(port);
            }
        });
        this._msg = label('island-empty', {x_align: Clutter.ActorAlign.CENTER, visible: false});
        this._groups = column({style_class: 'island-groups'});
        actor.add_child(this._entry);
        actor.add_child(this._msg);
        actor.add_child(scrollView(this._groups));
        this._ports = [];
        return actor;
    }

    onShow() {
        this._entry.text = '';
        this.refresh();
        return this._entry;
    }

    refresh() {
        this.fetch('PortsList', [], (ports, err) => {
            this._ports = err ? [] : ports;
            this._render(err ? 'Could not list ports' : null);
        });
    }

    _render(error = null) {
        const q = this._entry.text.trim().replace(/^:/, '').toLowerCase();
        const items = q
            ? this._ports.filter(l => `${l.port} ${l.process ?? ''} ${l.container ?? ''} ${l.cmd ?? ''}`.toLowerCase().includes(q))
            : this._ports;
        setMessage(this._msg, error ?? (items.length ? '' : q ? 'No matches. Press Enter to free that port.' : 'Nothing listening'),
            () => this.refit());
        this._groups.destroy_all_children();
        const owned = l => !!(l.container || l.pid);
        for (const [title, list] of [['YOUR APPS & CONTAINERS', items.filter(owned)], ['SYSTEM', items.filter(l => !owned(l))]]) {
            if (!list.length)
                continue;
            const g = group(title);
            this._groups.add_child(g.actor);
            fillList(g.list, list, l => this._row(l), () => this.refit());
        }
    }

    _row(l) {
        const own = !!(l.container || l.pid);
        const row = new St.BoxLayout({style_class: `island-irow island-irow-box${own ? '' : ' muted'}`, x_expand: true});
        row.add_child(portButton(l.port, 'island-port-pill', port => this.island.openPort(port)));
        const title = l.container ?? l.process ?? 'System service';
        const kind = l.container ? 'Container' : l.pid ? `PID ${l.pid}` : '';
        const where = ANY.has(l.addr) ? 'All interfaces' : LOCAL.has(l.addr) ? 'Localhost' : l.addr;
        row.add_child(rowText(title, [kind, where].filter(Boolean).join('  ·  ')).col);
        if (own) {
            const btn = confirmButton(l.container ? 'Stop' : 'Kill', () => {
                row.opacity = 128;
                this._free(l.port);
            });
            row.add_child(hoverActions(row, [btn]));
        }
        return row;
    }

    _free(port) {
        this.call('PortFree', [port], () => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                if (this.active)
                    this.refresh();
                return GLib.SOURCE_REMOVE;
            });
        });
    }
}
