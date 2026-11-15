import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {TILE_COLORS, VERTICAL} from '../lib/constants.js';
import {hashColor, searchUri} from '../lib/format.js';
import {openUri} from '../lib/shell.js';
import {calc, formatNumber} from '../lib/tools.js';
import {column, iconButton, label, pillButton, scrollView, searchEntry} from '../lib/widgets.js';
import {Page} from './page.js';

const SITE_COLS = 8;
const ICON_REFETCH_MS = 2500;
const CENTER = {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER};

function siteTile(iconActor, name, styleClass = '') {
    const box = column({style_class: 'island-site-box'});
    const frame = new St.Widget({
        style_class: `island-site-icon ${styleClass}`,
        layout_manager: new Clutter.BinLayout(),
        x_align: Clutter.ActorAlign.CENTER,
    });
    frame.add_child(iconActor);
    box.add_child(frame);
    box.add_child(label('island-site-name', {text: name, x_align: Clutter.ActorAlign.CENTER}));
    const btn = new St.Button({
        style_class: 'island-site', child: box, can_focus: true, accessible_name: name,
        button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
    });
    return {btn, frame};
}

export class SearchPage extends Page {
    static id = 'search';
    static height = 360;
    static autoHeight = true;

    build() {
        const actor = new St.BoxLayout({style_class: 'island-page island-web', ...VERTICAL});
        actor.add_child(this._buildSearchRow());
        actor.add_child(this._buildCalcRow());
        actor.add_child(this._buildSitesCard());
        this._sites = [];
        return actor;
    }

    _buildSearchRow() {
        this._entry = searchEntry('Search Google or enter an address', {style_class: 'island-entry island-search-entry'});
        this._entry.clutter_text.connect('text-changed', () => this._updateCalc());
        this._entry.clutter_text.connect('activate', () => this._submit());
        const row = new St.BoxLayout({style_class: 'island-toolbar'});
        row.add_child(this._entry);
        const qr = iconButton('view-app-grid-symbolic', 'island-pill-btn island-icon-btn', () => {
            const q = this._entry.text.trim();
            if (q)
                this.island.page('qr').open(q);
            else
                this.ext.latestClip(t => t && this.island.page('qr').open(t.trim()));
        }, 'QR code of this text (or the clipboard)');
        qr.y_align = Clutter.ActorAlign.FILL;
        row.add_child(qr);
        return row;
    }

    _buildCalcRow() {
        this._calcRow = new St.BoxLayout({style_class: 'island-calc', visible: false});
        this._calcResult = label('island-calc-result', {x_expand: true});
        this._calcHint = label('island-hint', {text: 'Enter to copy'});
        this._calcRow.add_child(this._calcResult);
        this._calcRow.add_child(this._calcHint);
        this._calcValue = null;
        return this._calcRow;
    }

    _buildSitesCard() {
        const card = new St.BoxLayout({style_class: 'island-card island-sites-card', ...VERTICAL, x_expand: true});
        const head = new St.BoxLayout({style_class: 'island-section-head'});
        head.add_child(label('island-group', {text: 'FAVORITES', x_expand: true}));
        head.add_child(label('island-hint', {text: 'Right-click to remove'}));
        card.add_child(head);

        this._addRow = new St.BoxLayout({style_class: 'island-add-row', visible: false});
        this._addUrl = new St.Entry({style_class: 'island-entry', hint_text: 'example.com', can_focus: true, x_expand: true});
        this._addName = new St.Entry({style_class: 'island-entry island-add-name', hint_text: 'Name (optional)', can_focus: true});
        const submit = () => this._addSite();
        this._addUrl.clutter_text.connect('activate', submit);
        this._addName.clutter_text.connect('activate', submit);
        for (const a of [this._addUrl, this._addName, pillButton('Save', submit, 'primary')])
            this._addRow.add_child(a);
        card.add_child(this._addRow);

        this._grid = column({style_class: 'island-site-grid'});
        card.add_child(scrollView(this._grid));
        return card;
    }

    onShow() {
        this._updateCalc();
        this._addRow.hide();
        this.refresh();
        return this._entry;
    }

    refresh() {
        this.ext.callJson('SitesList', [], (sites, err) => {
            this._sites = err ? [] : sites ?? [];
            this._renderSites();
        });
    }

    _submit() {
        const q = this._entry.text.trim();
        if (!q)
            return;
        if (this._calcValue !== null) {
            this.ext.copy(this._calcValue);
            this._calcHint.text = 'Copied';
            return;
        }
        openUri(searchUri(q));
        this._entry.text = '';
        this.close();
    }

    _updateCalc() {
        const v = calc(this._entry.text);
        this._calcValue = v === null ? null : formatNumber(v);
        if (this._calcRow.visible !== (v !== null)) {
            this._calcRow.visible = v !== null;
            this.refit();
        }
        if (v !== null) {
            this._calcResult.text = `= ${this._calcValue}`;
            this._calcHint.text = 'Enter to copy';
        }
    }

    _addSite() {
        const url = this._addUrl.text.trim();
        if (!url)
            return;
        this.call('SiteAdd', [url, this._addName.text.trim()], (_r, err) => {
            if (err) {
                this._addUrl.add_style_pseudo_class('error');
                return;
            }
            this._addUrl.remove_style_pseudo_class('error');
            this._addUrl.text = this._addName.text = '';
            this._addRow.hide();
            this.refresh();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ICON_REFETCH_MS, () => {
                if (this.active)
                    this.refresh();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _renderSites() {
        this._grid.destroy_all_children();
        const tiles = this._sites.map(site => this._siteButton(site));
        tiles.push(this._addButton());
        for (let i = 0; i < tiles.length; i += SITE_COLS) {
            const row = new St.BoxLayout({style_class: 'island-site-row'});
            tiles.slice(i, i + SITE_COLS).forEach(t => row.add_child(t));
            this._grid.add_child(row);
        }
        this.refit();
    }

    _siteButton(site) {
        let icon;
        if (site.icon) {
            icon = new St.Bin({style_class: 'island-site-img', ...CENTER});
            icon.style = `background-image: url("file://${encodeURI(site.icon)}");`;
        } else {
            icon = new St.Label({text: (site.name[0] ?? '?').toUpperCase(), style_class: 'island-site-letter', ...CENTER});
        }
        const {btn, frame} = siteTile(icon, site.name);
        if (!site.icon)
            frame.style = `background-color: ${hashColor(site.name, TILE_COLORS)};`;
        btn.connect('clicked', (_b, button) => {
            if (button === Clutter.BUTTON_SECONDARY) {
                this.call('SiteRemove', [site.id], () => this.refresh());
                return;
            }
            openUri(site.url);
            this.close();
        });
        return btn;
    }

    _addButton() {
        const {btn} = siteTile(new St.Icon({icon_name: 'list-add-symbolic', style_class: 'island-site-add-icon', ...CENTER}),
            'Add site', 'add');
        btn.connect('clicked', () => {
            this._addRow.visible = !this._addRow.visible;
            this.refit();
            if (this._addRow.visible)
                this._addUrl.grab_key_focus();
        });
        return btn;
    }
}
