import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {
    ACCENT_COLORS, DEFAULT_SETTINGS, FEATURES, SETTING_COLORS, SURFACES, TABS, featureOn, tabOn,
} from '../lib/constants.js';
import {Toggle, badge, column, group, label, page, rowText, scrollView} from '../lib/widgets.js';
import {Page} from './page.js';

const iconBadge = icon => badge({icon, color: SETTING_COLORS[icon] ?? '#636366'});

export class SettingsPage extends Page {
    static id = 'settings';
    static title = 'Settings';
    static parent = null;
    static height = 520;

    build() {
        const actor = page();
        const box = column({style_class: 'island-settings'});
        this._controls = [];
        this._buildAppearance(box);
        this._buildTabs(box);
        this._buildFeatures(box);
        actor.add_child(scrollView(box));
        return actor;
    }

    _buildAppearance(box) {
        const card = this._card(box, 'APPEARANCE');
        const swatches = new St.BoxLayout({style_class: 'island-swatches', y_align: Clutter.ActorAlign.CENTER});
        for (const [name, hex] of Object.entries(ACCENT_COLORS)) {
            const dot = new St.Widget({style_class: 'island-swatch-dot', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            dot.set_style(`background-color: ${hex};`);
            const btn = new St.Button({style_class: 'island-swatch', can_focus: true, accessible_name: name, child: dot});
            btn.connect('clicked', () => this.ext.updateSettings({accent: name}));
            swatches.add_child(btn);
            this._controls.push(st => (btn.checked = (st.accent ?? 'blue') === name));
        }
        this._row(card, 'Accent colour', null, 'applications-graphics-symbolic').add_child(swatches);

        const seg = new St.BoxLayout({style_class: 'island-seg', y_align: Clutter.ActorAlign.CENTER});
        for (const [id, name] of SURFACES) {
            const btn = new St.Button({style_class: 'island-seg-btn', label: name, can_focus: true});
            btn.connect('clicked', () => this.ext.updateSettings({surface: id}));
            seg.add_child(btn);
            this._controls.push(st => (btn.checked = (st.surface ?? 'black') === id));
        }
        this._row(card, 'Surface', null, 'weather-clear-night-symbolic').add_child(seg);
    }

    _buildTabs(box) {
        const card = this._card(box, 'TABS');
        this._row(card, 'Home', 'Always shown', 'user-home-symbolic')
            .add_child(label('island-setting-locked', {text: 'Always on'}));
        for (const [id, name, icon] of TABS.filter(([tid]) => tid !== 'home'))
            this._toggle(card, name, null, icon, st => tabOn(st, id), on => ({tabs: {[id]: on}}));
    }

    _buildFeatures(box) {
        const card = this._card(box, 'FEATURES');
        for (const [key, name, desc, icon] of FEATURES)
            this._toggle(card, name, desc, icon, st => featureOn(st, key), on => ({features: {[key]: on}}));
    }

    onSettings(st) {
        for (const sync of this._controls)
            sync(st ?? DEFAULT_SETTINGS);
    }

    _card(parent, title) {
        const g = group(title);
        parent.add_child(g.actor);
        return g.list;
    }

    _row(card, title, desc, icon) {
        const row = new St.BoxLayout({style_class: 'island-irow island-irow-box', x_expand: true});
        row.add_child(iconBadge(icon));
        row.add_child(rowText(title, desc).col);
        card.add_child(row);
        return row;
    }

    _toggle(card, title, desc, icon, get, patch) {
        const row = new St.Button({style_class: 'island-irow', can_focus: true, x_expand: true});
        const inner = new St.BoxLayout({style_class: 'island-irow-box', x_expand: true});
        inner.add_child(iconBadge(icon));
        inner.add_child(rowText(title, desc).col);
        const sw = new Toggle(true);
        inner.add_child(sw.actor);
        row.child = inner;
        row.connect('clicked', () => {
            sw.toggle();
            this.ext.updateSettings(patch(sw.state));
        });
        card.add_child(row);
        this._controls.push(st => sw.set(get(st), true));
    }
}
