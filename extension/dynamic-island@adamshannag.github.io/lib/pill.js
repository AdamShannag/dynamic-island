import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {LIVE_KINDS, VERTICAL} from './constants.js';
import {Face} from './face.js';
import {Equalizer, label, setText} from './widgets.js';

export class Pill {
    constructor({spyIcon, agentIcon, faceTarget}) {
        this._agentIcon = agentIcon;
        this._osd = null;
        this.actor = new St.BoxLayout({
            style_class: 'island-content',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        this._art = new St.Bin({style_class: 'island-art', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'island-icon', y_align: Clutter.ActorAlign.CENTER});
        this._textBox = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = label('island-title');
        this._subtitle = label('island-subtitle');
        this._textBox.add_child(this._title);
        this._textBox.add_child(this._subtitle);
        this._osdTrack = new St.Widget({
            style_class: 'island-osd-track', x_expand: true, y_align: Clutter.ActorAlign.CENTER, visible: false,
        });
        this._osdFill = new St.Widget({style_class: 'island-osd-fill', x: 0, y: 0});
        this._osdTrack.add_child(this._osdFill);
        this._osdTrack.connect('notify::allocation', () => this._syncOsdFill());
        this._eq = new Equalizer('pill');
        this.face = new Face(spyIcon);
        this.face.setTargetProvider(faceTarget);
        this._trailing = label('island-trailing');
        for (const a of [this._art, this._icon, this._textBox, this._osdTrack, this._eq.actor, this.face.actor, this._trailing])
            this.actor.add_child(a);
    }

    get title() {
        return this._title.text;
    }

    destroy() {
        this.face.destroy();
    }

    apply(s, mode, {presenting, showFace, osd}) {
        const masked = presenting && (s.kind === 'media' || LIVE_KINDS.has(s.kind));
        this._title.text = presenting && s.kind === 'media' ? 'Now playing' : s.title ?? '';
        this._title.visible = mode !== 'idle';
        this._subtitle.text = s.subtitle ?? '';
        this._subtitle.visible = mode === 'notify' && !!s.subtitle && !masked;
        this.face.actor.visible = mode === 'idle' && showFace;
        this._applyVisual(s, mode, presenting);
        this._eq.actor.visible = s.kind === 'media' && mode === 'compact';
        this._eq.running = this._eq.actor.visible && !!s.playing;
        this._applyOsd(mode === 'osd' ? osd : null);
    }

    setTrailing(text) {
        setText(this._trailing, text);
        this._trailing.visible = text !== '';
    }

    _applyVisual(s, mode, presenting) {
        this._art.style = null;
        if (mode === 'idle') {
            this._art.hide();
            this._icon.hide();
        } else if (s.swatch || (s.art && !presenting)) {
            this._art.style = s.swatch
                ? `background-color: ${s.swatch};`
                : `background-image: url("file://${encodeURI(s.art)}");`;
            this._art.show();
            this._icon.hide();
        } else {
            this._art.hide();
            if (s.icon === 'agent')
                this._icon.gicon = this._agentIcon;
            else
                this._icon.icon_name = s.icon || 'dialog-information-symbolic';
            this._icon.show();
        }
    }

    _applyOsd(osd) {
        this._osd = osd;
        const hasLevel = osd && osd.level !== null && osd.level !== undefined;
        this._osdTrack.visible = !!hasLevel;
        this._textBox.visible = !hasLevel;
        if (!osd)
            return;
        this._art.hide();
        this._icon.gicon = osd.gicon;
        this._icon.show();
        this._title.text = osd.label ?? '';
        this._title.visible = !hasLevel && !!osd.label;
        this._syncOsdFill();
    }

    _syncOsdFill() {
        const level = this._osd?.level;
        if (level === null || level === undefined)
            return;
        const w = this._osdTrack.width;
        if (w > 0)
            this._osdFill.set_size(Math.round(w * Math.max(0, Math.min(1, level))), this._osdTrack.height);
    }
}
