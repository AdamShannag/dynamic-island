import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {CLIP_DEBOUNCE_MS, SECRET_MIME} from './constants.js';

const SELF_COPY_GRACE_MS = 1000;

export class ClipboardWatcher {
    constructor({shouldRecord, record}) {
        this._shouldRecord = shouldRecord;
        this._record = record;
        this._reading = false;
        this._again = false;
        this._timer = 0;
        this._selfCopyAt = 0;
        this._alive = true;
        global.display.get_selection().connectObject('owner-changed',
            (_sel, type, source) => this._onOwnerChanged(type, source), this);
    }

    destroy() {
        this._alive = false;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        global.display.get_selection().disconnectObject(this);
    }

    copy(text) {
        this._selfCopyAt = Date.now();
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    }

    _onOwnerChanged(type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !source || !this._shouldRecord())
            return;
        if (Date.now() - this._selfCopyAt < SELF_COPY_GRACE_MS)
            return;
        if (source.get_mimetypes().includes(SECRET_MIME))
            return;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLIP_DEBOUNCE_MS, () => {
            this._timer = 0;
            this._read();
            return GLib.SOURCE_REMOVE;
        });
    }

    _read() {
        if (this._reading) {
            this._again = true;
            return;
        }
        this._reading = true;
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_cb, text) => {
            const copied = text ? String(text) : '';
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._reading = false;
                if (!this._alive)
                    return GLib.SOURCE_REMOVE;
                if (copied.trim())
                    this._record(copied);
                if (this._again) {
                    this._again = false;
                    this._read();
                }
                return GLib.SOURCE_REMOVE;
            });
        });
    }
}
