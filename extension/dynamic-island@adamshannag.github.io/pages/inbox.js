import St from 'gi://St';
import Pango from 'gi://Pango';

import {ago} from '../lib/format.js';
import {activateNotification, lookupApp} from '../lib/shell.js';
import {
    EmptyState, appBadge, column, fillList, hoverActions, iconButton, label, page, pillButton, scrollView, setText,
} from '../lib/widgets.js';
import {Page} from './page.js';

const ICON = 'preferences-system-notifications-symbolic';

export class InboxPage extends Page {
    static id = 'inbox';
    static height = 480;
    static autoHeight = true;
    static interval = 5000;

    build() {
        const actor = page();
        const bar = new St.BoxLayout({style_class: 'island-toolbar island-inbox-bar'});
        this._count = label('island-inbox-count', {x_expand: true});
        bar.add_child(this._count);
        bar.add_child(pillButton('Clear all', () => this.call('InboxClear', [], () => this.refresh())));
        actor.add_child(bar);
        this._empty = new EmptyState(() => this.refit());
        this._list = column({style_class: 'island-ncards'});
        this._scroll = scrollView(this._list);
        actor.add_child(this._empty.actor);
        actor.add_child(this._scroll);
        return actor;
    }

    refresh() {
        this.island.setUnread(false);
        if (this.ext.presenting) {
            this._showEmpty({icon: ICON, title: 'Hidden while presenting'});
            return;
        }
        this.fetch('InboxList', [], (items, err) => {
            items = err ? [] : items;
            setText(this._count, items.length ? `${items.length} notification${items.length === 1 ? '' : 's'}` : '');
            if (!items.length) {
                this._showEmpty({icon: ICON, title: "You're all caught up",
                    hint: err ? 'Daemon not running' : 'Notifications from your apps collect here'});
                return;
            }
            this._empty.hide();
            this._scroll.show();
            this._render(items);
        });
    }

    _showEmpty(spec) {
        this._sig = null;
        this._list.destroy_all_children();
        this._scroll.hide();
        if (this.ext.presenting)
            setText(this._count, '');
        this._empty.show(spec);
    }

    _render(items) {
        const sig = items.map(i => i.id).join(',');
        if (sig === this._sig && this._when) {
            items.forEach((it, k) => this._when[k] && setText(this._when[k], ago(it.at)));
            return;
        }
        this._sig = sig;
        this._when = [];
        fillList(this._list, items, (it, k) => this._card(it, k), () => this.refit());
    }

    _card(it, k) {
        const card = new St.Button({style_class: 'island-ncard', can_focus: true, x_expand: true});
        const box = new St.BoxLayout({style_class: 'island-ncard-box', x_expand: true});
        box.add_child(appBadge(lookupApp(it), it.app));
        const col = column({x_expand: true});
        const head = new St.BoxLayout({style_class: 'island-ncard-head'});
        const app = label('island-ncard-app', {text: (it.app || 'App').toUpperCase(), x_expand: true});
        app.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        head.add_child(app);
        const when = label('island-ncard-when', {text: ago(it.at)});
        this._when[k] = when;
        head.add_child(when);
        head.add_child(hoverActions(card, [iconButton('window-close-symbolic', 'island-row-btn small', () =>
            this.call('InboxRemove', [it.id], () => this.refresh()), 'Dismiss')]));
        col.add_child(head);
        col.add_child(label('island-ncard-title', {text: it.title}));
        if (it.body) {
            const body = new St.Label({style_class: 'island-ncard-body', text: it.body.slice(0, 280)});
            body.clutter_text.line_wrap = true;
            body.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            col.add_child(body);
        }
        box.add_child(col);
        card.child = box;
        card.connect('clicked', () => {
            activateNotification({title: it.title, subtitle: it.body, app: it.app, desktopEntry: it.desktopEntry});
            this.call('InboxRemove', [it.id]);
            this.close();
        });
        return card;
    }
}
