import St from 'gi://St';

import {ago, clipKind} from '../lib/format.js';
import {
    EmptyState, badge, column, fillList, group, hoverActions, iconButton, page, pillButton, rowText, scrollView,
    searchEntry,
} from '../lib/widgets.js';
import {Page} from './page.js';

const MAX_SHOWN = 50;

export class ClipboardPage extends Page {
    static id = 'clipboard';
    static autoHeight = true;

    build() {
        const actor = page();
        const top = new St.BoxLayout({style_class: 'island-toolbar'});
        this._filter = searchEntry('Search clipboard history');
        this._filter.clutter_text.connect('text-changed', () => this._render());
        this._filter.clutter_text.connect('activate', () => {
            const first = this._filtered()[0];
            if (first)
                this._copy(first.text);
        });
        top.add_child(this._filter);
        top.add_child(pillButton('Clear', () => this.call('ClipboardClear', [], () => this.refresh())));
        this._empty = new EmptyState(() => this.refit());
        this._groups = column({style_class: 'island-groups'});
        this._scroll = scrollView(this._groups);
        actor.add_child(top);
        actor.add_child(this._empty.actor);
        actor.add_child(this._scroll);
        this._items = [];
        return actor;
    }

    onShow() {
        this._filter.text = '';
        this.refresh();
        return this._filter;
    }

    refresh() {
        this.ext.callJson('ClipboardList', [], (items, err) => {
            this._items = err ? [] : items ?? [];
            this._render(err ? 'Daemon not running' : null);
        });
    }

    _filtered() {
        const q = this._filter.text.trim().toLowerCase();
        return q ? this._items.filter(it => it.text.toLowerCase().includes(q)) : this._items;
    }

    _emptySpec(items, error) {
        if (this.ext.presenting)
            return {icon: 'edit-paste-symbolic', title: 'Hidden while presenting'};
        if (error)
            return {icon: 'dialog-warning-symbolic', title: error};
        if (!this._items.length)
            return {icon: 'edit-paste-symbolic', title: 'Nothing copied yet', hint: 'Copy text anywhere and it shows up here'};
        if (!items.length)
            return {icon: 'system-search-symbolic', title: 'No matches'};
        return null;
    }

    _render(error = null) {
        const items = this._filtered();
        this._groups.destroy_all_children();
        const empty = this._emptySpec(items, error);
        this._scroll.visible = !empty;
        if (empty) {
            this._empty.show(empty);
            return;
        }
        this._empty.hide();
        const shown = items.slice(0, MAX_SHOWN);
        for (const [title, list] of [['PINNED', shown.filter(i => i.pinned)], ['RECENT', shown.filter(i => !i.pinned)]]) {
            if (!list.length)
                continue;
            const g = group(title);
            this._groups.add_child(g.actor);
            fillList(g.list, list, it => this._row(it), () => this.refit());
        }
    }

    _row(it) {
        const kind = clipKind(it.text);
        const row = new St.Button({style_class: 'island-irow', can_focus: true, x_expand: true});
        const box = new St.BoxLayout({style_class: 'island-irow-box', x_expand: true});
        box.add_child(badge(kind.badge));
        const first = it.text.trim().split('\n')[0].slice(0, 200);
        box.add_child(rowText(first, `${kind.label}  ·  ${ago(it.at)}`, {monoTitle: kind.mono}).col);
        box.add_child(hoverActions(row, [
            iconButton('view-app-grid-symbolic', 'island-row-btn', () => this.island.page('qr').open(it.text), 'Show as QR code'),
            iconButton('view-pin-symbolic', `island-row-btn${it.pinned ? ' pinned' : ''}`,
                () => this.call('ClipboardPin', [it.id, !it.pinned], () => this.refresh()), it.pinned ? 'Unpin' : 'Pin'),
            iconButton('user-trash-symbolic', 'island-row-btn',
                () => this.call('ClipboardDelete', [it.id], () => this.refresh()), 'Delete'),
        ]));
        row.child = box;
        row.connect('clicked', () => this._copy(it.text));
        return row;
    }

    _copy(text) {
        this.ext.copy(text);
        this.close();
    }
}
