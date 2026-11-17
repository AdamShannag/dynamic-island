import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {ALL_TABS, MORE_TAB, VERTICAL, tabOn} from './constants.js';
import {actionItems, firstLine, flatten, moveSelection, searchResults} from './find.js';
import {column, label, scrollView, setText} from './widgets.js';

const READY_MS = 180;

class ResultRow {
    constructor(item, onHover, onRun) {
        this.item = item;
        this.actor = new St.Button({style_class: 'island-find-row', x_expand: true, can_focus: false});
        const box = new St.BoxLayout({style_class: 'island-find-row-box', x_expand: true});
        const icon = new St.Bin({style_class: 'island-find-icon', y_align: Clutter.ActorAlign.CENTER});
        icon.child = new St.Icon({icon_name: item.icon ?? 'system-search-symbolic'});
        box.add_child(icon);
        const text = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(label('island-find-title', {text: item.title || ' '}));
        if (item.sub)
            text.add_child(label('island-find-sub', {text: item.sub}));
        box.add_child(text);
        this._hint = label('island-find-enter', {text: '↵', visible: false});
        box.add_child(this._hint);
        this.actor.child = box;
        this.actor.connect('notify::hover', () => {
            if (this.actor.hover)
                onHover(this);
        });
        this.actor.connect('clicked', () => onRun(this.item));
    }

    set selected(on) {
        if (on)
            this.actor.add_style_pseudo_class('selected');
        else
            this.actor.remove_style_pseudo_class('selected');
        this._hint.visible = on;
    }
}

export class Finder {
    constructor({ext, onRun, onResize}) {
        this._ext = ext;
        this._onRun = onRun;
        this._onResize = onResize;
        this._query = '';
        this._open = false;
        this._gen = 0;
        this._sig = null;
        this._rows = [];
        this._sel = 0;
        this._data = {ports: [], containers: [], clips: [], notes: []};
        this._ready = false;
        this._readyId = 0;
        this.settings = null;

        this.actor = column({style_class: 'island-find', x_expand: true, visible: false});
        this._list = column({style_class: 'island-find-list', x_expand: true});
        this._scroll = scrollView(this._list);
        this._empty = label('island-find-none', {text: 'No results', visible: false, x_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._empty);
        this.actor.add_child(this._scroll);
    }

    get isOpen() {
        return this._open;
    }

    open(query) {
        this._open = true;
        this._ready = false;
        this._query = query;
        this._sel = 0;
        this._sig = null;
        this._render();
        this._load();
    }

    close() {
        this._open = false;
        this._gen++;
        this._clearReady();
        this._data = {ports: [], containers: [], clips: [], notes: []};
    }

    prewarm() {
        this._open = true;
        this._render();
        this._open = false;
        this._sig = null;
    }

    _clearReady() {
        if (this._readyId)
            GLib.source_remove(this._readyId);
        this._readyId = 0;
    }

    _markReady() {
        this._clearReady();
        if (this._ready || !this._open)
            return;
        this._ready = true;
        this._sig = null;
        this._render();
    }

    setQuery(query) {
        if (query === this._query)
            return;
        this._query = query;
        this._sel = 0;
        this._render();
    }

    move(delta) {
        this._select(moveSelection(this._sel, delta, this._rows.length));
    }

    run() {
        const row = this._rows[this._sel];
        if (row)
            this._onRun(row.item);
    }

    _load() {
        const gen = ++this._gen;
        let pending = 0;
        const load = (method, key, ok = true) => {
            if (!ok)
                return;
            pending++;
            this._ext.callJson(method, [], (value, err) => {
                if (gen !== this._gen)
                    return;
                if (!err && Array.isArray(value))
                    this._data[key] = value;
                if (--pending === 0)
                    this._markReady();
                else if (this._ready)
                    this._render();
            });
        };
        this._clearReady();
        this._readyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, READY_MS, () => {
            this._readyId = 0;
            this._markReady();
            return GLib.SOURCE_REMOVE;
        });
        const priv = !this._ext.presenting;
        load('PortsList', 'ports', tabOn(this.settings, 'ports'));
        load('DockerList', 'containers', tabOn(this.settings, 'docker'));
        load('ClipboardList', 'clips', priv);
        load('NotesList', 'notes', priv);
        if (!pending)
            this._markReady();
    }

    _groups() {
        const st = this.settings;
        const tabs = [...ALL_TABS, MORE_TAB].filter(([id]) => tabOn(st, id)).map(([id, name, icon]) => ({
            id: `tab:${id}`, title: name, sub: 'Tab', icon, action: {kind: 'tab', id},
        }));
        const d = this._data;
        const clips = [...d.clips].sort((a, b) => (b.pinned - a.pinned) || (b.at - a.at)).map(c => ({
            id: `clip:${c.id}`, title: firstLine(c.text), sub: 'Copy to clipboard', icon: 'edit-paste-symbolic',
            keywords: c.text.slice(0, 400), action: {kind: 'clip', text: c.text},
        }));
        const notes = [...d.notes].sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated)).map(n => ({
            id: `note:${n.id}`, title: firstLine(n.text) || 'Untitled note', sub: 'Note', icon: 'document-edit-symbolic',
            keywords: n.text.slice(0, 400), action: {kind: 'note', id: n.id},
        }));
        return [
            {id: 'tabs', items: tabs},
            {id: 'actions', items: actionItems(d)},
            {id: 'clipboard', items: clips},
            {id: 'notes', items: notes},
        ];
    }

    _render() {
        if (!this._open)
            return;
        const groups = searchResults(this._groups(), this._query);
        const sig = groups.map(g => `${g.id}:${g.items.map(i => i.id).join(',')}`).join('|');
        if (sig !== this._sig) {
            this._sig = sig;
            this._list.destroy_all_children();
            this._rows = [];
            for (const g of groups) {
                this._list.add_child(label('island-find-group', {text: g.title}));
                for (const item of g.items) {
                    const row = new ResultRow(item, r => this._select(this._rows.indexOf(r), false), it => this._onRun(it));
                    this._rows.push(row);
                    this._list.add_child(row.actor);
                }
            }
            this._empty.visible = !this._rows.length;
            setText(this._empty, this._query.trim() ? `No results for “${this._query.trim()}”` : 'No results');
            this._scroll.visible = this._rows.length > 0;
            if (this._ready)
                this._onResize();
        }
        this._select(Math.min(this._sel, this._rows.length - 1));
    }

    _select(index, scroll = true) {
        this._sel = Math.max(0, index);
        this._rows.forEach((r, i) => (r.selected = i === this._sel));
        const row = this._rows[this._sel];
        if (!row || !scroll)
            return;
        const adj = this._scroll.vadjustment;
        const box = row.actor.get_allocation_box();
        if (box.y1 < adj.value)
            adj.value = box.y1;
        else if (box.y2 > adj.value + adj.page_size)
            adj.value = box.y2 - adj.page_size;
    }
}
