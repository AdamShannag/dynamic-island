import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {VERTICAL} from '../lib/constants.js';
import {clock24} from '../lib/shell.js';
import {column, fillList, iconButton, label, multilineEntry, scrollView, searchEntry, setText} from '../lib/widgets.js';
import {Page} from './page.js';

const SAVE_DELAY_MS = 500;
const EMPTY_TEXT = 'No notes yet. Click the pencil to start one.';

function noteTitle(n) {
    const line = (n.text ?? '').split('\n').find(l => l.trim()) ?? '';
    return line.trim().slice(0, 80) || 'New Note';
}

function notePreview(n) {
    const lines = (n.text ?? '').split('\n').filter(l => l.trim());
    return (lines[1] ?? 'No additional text').trim().slice(0, 80);
}

function noteWhen(ms) {
    const d = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const now = GLib.DateTime.new_now_local();
    if (d.format('%F') === now.format('%F'))
        return d.format(clock24() ? '%H:%M' : '%l:%M %p').trim();
    if (now.difference(d) < 7 * 24 * 3600 * 1e6)
        return d.format('%A');
    return d.format('%-d %b %Y');
}

export class NotesPage extends Page {
    static id = 'notes';
    static height = 480;

    build() {
        const actor = new St.BoxLayout({style_class: 'island-page island-notes-page'});
        actor.add_child(this._buildSidebar());
        actor.add_child(this._buildEditor());
        this._notes = [];
        this._current = null;
        this._saveId = 0;
        this._rows = new Map();
        return actor;
    }

    _buildSidebar() {
        const side = new St.BoxLayout({style_class: 'island-card island-notes-side', ...VERTICAL, y_expand: true});
        const top = new St.BoxLayout({style_class: 'island-notes-top'});
        this._search = searchEntry('Search', {style_class: 'island-entry island-notes-search'});
        this._search.clutter_text.connect('text-changed', () => this._renderList());
        top.add_child(this._search);
        top.add_child(iconButton('document-new-symbolic', 'island-note-new', () => this._create(), 'New note'));
        side.add_child(top);
        this._list = column({style_class: 'island-note-list'});
        side.add_child(scrollView(this._list));
        return side;
    }

    _buildEditor() {
        const main = new St.BoxLayout({style_class: 'island-card island-notes-main', ...VERTICAL, x_expand: true, y_expand: true});
        const bar = new St.BoxLayout({style_class: 'island-notes-bar'});
        this._date = label('island-note-date', {x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        this._pinBtn = iconButton('view-pin-symbolic', 'island-row-btn', () => this._togglePin(), 'Pin note');
        bar.add_child(this._date);
        bar.add_child(this._pinBtn);
        bar.add_child(iconButton('user-trash-symbolic', 'island-row-btn', () => this._delete(), 'Delete note'));
        main.add_child(bar);
        this._editor = multilineEntry('island-note-editor', 'Start typing…');
        this._editor.clutter_text.connect('text-changed', () => this._onEdited());
        const box = column({x_expand: true});
        box.add_child(this._editor);
        main.add_child(scrollView(box));
        this._empty = label('island-empty', {text: EMPTY_TEXT, x_align: Clutter.ActorAlign.CENTER, visible: false});
        main.add_child(this._empty);
        return main;
    }

    onShow() {
        this._search.text = '';
        this._load();
        return this._editor;
    }

    onHide() {
        this._flush();
    }

    select(id) {
        this._load(id);
    }

    destroy() {
        this._flush();
    }

    _find(id) {
        return this._notes.find(n => n.id === id);
    }

    _load(selectId = null) {
        if (this.ext.presenting) {
            this._notes = [];
            this._renderList();
            this._empty.text = 'Hidden while presenting';
            this._select(null);
            return;
        }
        this.ext.callJson('NotesList', [], (notes, err) => {
            this._notes = err ? [] : notes ?? [];
            this._empty.text = err ? 'Daemon not running' : EMPTY_TEXT;
            this._renderList();
            const keep = selectId ?? this._current;
            this._select(this._find(keep) ?? this._notes[0] ?? null);
        });
    }

    _renderList() {
        const q = this._search.text.trim().toLowerCase();
        const notes = q ? this._notes.filter(n => (n.text ?? '').toLowerCase().includes(q)) : this._notes;
        const anyPinned = notes.some(n => n.pinned);
        const entries = [];
        let section = null;
        for (const n of notes) {
            const sec = n.pinned ? 'PINNED' : 'NOTES';
            if (anyPinned && sec !== section) {
                section = sec;
                entries.push({header: sec});
            }
            entries.push({n});
        }
        this._rows = new Map();
        fillList(this._list, entries, e => (e.header ? label('island-group island-note-group', {text: e.header}) : this._row(e.n)));
    }

    _row(n) {
        const col = column({x_expand: true});
        const title = label('island-note-title', {text: noteTitle(n)});
        const meta = new St.BoxLayout({style_class: 'island-note-meta'});
        const when = label('island-note-when', {text: noteWhen(n.updated)});
        const prev = label('island-note-preview', {text: notePreview(n), x_expand: true});
        meta.add_child(when);
        meta.add_child(prev);
        col.add_child(title);
        col.add_child(meta);
        const row = new St.Button({style_class: 'island-note-row', can_focus: true, child: col, x_expand: true});
        if (n.id === this._current)
            row.add_style_pseudo_class('checked');
        row.connect('clicked', () => this._select(n));
        this._rows.set(n.id, {row, title, when, prev});
        return row;
    }

    _select(n) {
        this._flush();
        const prev = this._find(this._current);
        if (prev && !prev.text.trim() && prev.id !== n?.id) {
            this.call('NoteDelete', [prev.id]);
            this._notes = this._notes.filter(x => x.id !== prev.id);
            this._rows.get(prev.id)?.row.destroy();
            this._rows.delete(prev.id);
        }
        for (const [id, r] of this._rows) {
            if (id === n?.id)
                r.row.add_style_pseudo_class('checked');
            else
                r.row.remove_style_pseudo_class('checked');
        }
        this._current = n?.id ?? null;
        this._loading = true;
        this._editor.text = n?.text ?? '';
        this._loading = false;
        this._editor.visible = !!n;
        this._empty.visible = !n;
        this._pinBtn.visible = !!n;
        if (n?.pinned)
            this._pinBtn.add_style_class_name('pinned');
        else
            this._pinBtn.remove_style_class_name('pinned');
        const d = n ? GLib.DateTime.new_from_unix_local(Math.floor(n.updated / 1000)) : null;
        this._date.text = d ? d.format('%-d %B %Y at %H:%M') : '';
    }

    _onEdited() {
        if (this._loading || this._current === null)
            return;
        const n = this._find(this._current);
        if (!n)
            return;
        n.text = this._editor.text;
        n.updated = Date.now();
        const r = this._rows.get(n.id);
        if (r) {
            setText(r.title, noteTitle(n));
            setText(r.prev, notePreview(n));
            setText(r.when, noteWhen(n.updated));
        }
        this._cancelSave();
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this.call('NoteSave', [n.id, n.text]);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelSave() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
    }

    _flush() {
        if (!this._saveId)
            return;
        this._cancelSave();
        const n = this._find(this._current);
        if (n)
            this.call('NoteSave', [n.id, n.text]);
    }

    _create() {
        this._flush();
        this.ext.callJson('NoteCreate', [], (n, err) => {
            if (err)
                return;
            this._search.text = '';
            this._load(n.id);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                this._editor.grab_key_focus();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _togglePin() {
        const n = this._find(this._current);
        if (n)
            this.call('NotePin', [n.id, !n.pinned], () => this._load(n.id));
    }

    _delete() {
        const id = this._current;
        if (id === null)
            return;
        this._cancelSave();
        const idx = this._notes.findIndex(x => x.id === id);
        const next = this._notes[idx + 1] ?? this._notes[idx - 1] ?? null;
        this._current = null;
        this.call('NoteDelete', [id], () => this._load(next?.id ?? null));
    }
}
