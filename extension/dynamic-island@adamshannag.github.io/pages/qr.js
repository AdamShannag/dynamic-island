import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {VERTICAL} from '../lib/constants.js';
import {column, label, pillButton} from '../lib/widgets.js';
import {Page} from './page.js';

export class QRPage extends Page {
    static id = 'qr';
    static title = '›  QR code';
    static height = 430;

    get parentTab() {
        return this._return ?? 'clipboard';
    }

    build() {
        const actor = new St.BoxLayout({style_class: 'island-page island-qr-page', ...VERTICAL});
        const card = new St.BoxLayout({style_class: 'island-card island-qr-card', x_expand: true, y_expand: true});
        this._img = new St.Bin({style_class: 'island-qr-img', y_align: Clutter.ActorAlign.CENTER});
        const col = column({x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'island-qr-info'});
        col.add_child(label('island-group', {text: 'SCAN WITH YOUR PHONE'}));
        this._text = new St.Label({style_class: 'island-qr-text'});
        const ct = this._text.clutter_text;
        ct.line_wrap = true;
        ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        ct.ellipsize = Pango.EllipsizeMode.END;
        col.add_child(this._text);
        const back = pillButton('Back', () => this.island.showTab(this.parentTab));
        back.x_align = Clutter.ActorAlign.START;
        col.add_child(back);
        card.add_child(this._img);
        card.add_child(col);
        actor.add_child(card);
        return actor;
    }

    open(text) {
        this.call('QR', [text], (res, err) => {
            if (err || !this.island.dashOpen)
                return;
            this._return = this.island.tab;
            this._img.style = `background-image: url("file://${encodeURI(res[0])}");`;
            this._text.text = text.length > 400 ? `${text.slice(0, 400)}…` : text;
            this.island.showTab('qr');
        });
    }

    onShow() {
        return null;
    }
}
