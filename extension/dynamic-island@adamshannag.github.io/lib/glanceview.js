import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {VERTICAL, tabOn} from './constants.js';
import {GLANCE_IDLE_SUB, GLANCE_IDLE_TITLE, glanceChips} from './glance.js';
import {Equalizer, label, setText} from './widgets.js';

const center = {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER};

export class GlanceView {
    constructor({ext, agentIcon}) {
        this._ext = ext;
        this._agentIcon = agentIcon;
        this._gen = 0;
        this._data = {agents: [], tasks: [], containers: 0};
        this._chipSig = null;
        this._chips = [];

        this.actor = new St.BoxLayout({
            style_class: 'island-glance', ...VERTICAL, visible: false, opacity: 0,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.START,
        });
        const top = new St.BoxLayout({style_class: 'island-glance-top', x_expand: true});
        const art = new St.Widget({style_class: 'island-glance-art', layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        art.add_child(new St.Icon({icon_name: 'audio-x-generic-symbolic', style_class: 'island-glance-art-icon', ...center}));
        this._art = new St.Bin({style_class: 'island-glance-art-img', x_expand: true, y_expand: true});
        art.add_child(this._art);
        top.add_child(art);
        const text = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = label('island-glance-title');
        this._sub = label('island-glance-sub');
        text.add_child(this._title);
        text.add_child(this._sub);
        top.add_child(text);
        this._eq = new Equalizer('pill');
        top.add_child(this._eq.actor);
        this._clock = label('island-glance-clock');
        top.add_child(this._clock);
        this.actor.add_child(top);
        this._chipRow = new St.BoxLayout({style_class: 'island-glance-chips', x_expand: true});
        this.actor.add_child(this._chipRow);
    }

    destroy() {
        this._gen++;
    }

    update(media, presenting) {
        setText(this._title, media ? presenting ? 'Now playing' : media.title ?? '' : GLANCE_IDLE_TITLE);
        setText(this._sub, media ? presenting ? 'Hidden while presenting' : media.subtitle ?? '' : GLANCE_IDLE_SUB);
        const art = media?.art && !presenting ? media.art : null;
        this._art.visible = !!art;
        if (art)
            this._art.style = `background-image: url("file://${encodeURI(art)}");`;
        this._eq.actor.visible = !!media?.playing;
        this._eq.running = this.actor.visible && !!media?.playing;
    }

    tick(clock, timer, now) {
        setText(this._clock, clock);
        this._renderChips(timer, now);
    }

    refresh(settings, timer) {
        const gen = ++this._gen;
        const load = (method, apply) => this._ext.callJson(method, [], (value, err) => {
            if (gen !== this._gen || err || !Array.isArray(value))
                return;
            apply(value);
            this._renderChips(timer, Date.now());
        });
        load('AgentsList', v => (this._data.agents = v));
        load('ActivityList', v => (this._data.tasks = v));
        if (tabOn(settings, 'docker'))
            load('DockerList', v => (this._data.containers = v.length));
        else
            this._data.containers = 0;
        this._renderChips(timer, Date.now());
    }

    stop() {
        this._gen++;
        this._eq.running = false;
    }

    _renderChips(timer, now) {
        const chips = glanceChips({...this._data, timer, now});
        const sig = chips.map(c => c.id).join('|');
        if (sig !== this._chipSig) {
            this._chipSig = sig;
            this._chipRow.destroy_all_children();
            this._chips = chips.map(c => this._chip(c));
        }
        chips.forEach((c, i) => setText(this._chips[i].label, c.label));
    }

    _chip(c) {
        const box = new St.BoxLayout({style_class: 'island-glance-chip', y_align: Clutter.ActorAlign.CENTER});
        const icon = new St.Icon({style_class: 'island-glance-chip-icon', y_align: Clutter.ActorAlign.CENTER});
        if (c.icon === 'agent')
            icon.gicon = this._agentIcon;
        else
            icon.icon_name = c.icon;
        icon.set_style(`color: ${c.color};`);
        box.add_child(icon);
        const text = label('island-glance-chip-label', {text: c.label});
        box.add_child(text);
        this._chipRow.add_child(box);
        return {actor: box, label: text};
    }
}
