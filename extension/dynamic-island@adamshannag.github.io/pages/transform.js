import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import {VERTICAL} from '../lib/constants.js';
import {TOOLS} from '../lib/tools.js';
import {column, iconButton, label, multilineEntry, scrollView, setText, wrappingLabel} from '../lib/widgets.js';
import {Page} from './page.js';

const RUN_DELAY_MS = 120;
const MAX_SHOWN = 20000;
const chars = n => `${n.toLocaleString()} char${n === 1 ? '' : 's'}`;

function miniButton(text, cls, onClick) {
    const b = new St.Button({style_class: `island-xf-mini ${cls}`, label: text, can_focus: true, y_align: Clutter.ActorAlign.CENTER});
    b.connect('clicked', onClick);
    return b;
}

function pane(title, child, buttons) {
    const card = new St.BoxLayout({style_class: 'island-card island-xf-pane', ...VERTICAL, x_expand: true, y_expand: true});
    const bar = new St.BoxLayout({style_class: 'island-xf-pane-bar'});
    const titleLbl = label('island-group island-xf-pane-title', {text: title});
    titleLbl.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    bar.add_child(titleLbl);
    const count = label('island-xf-count', {x_expand: true});
    bar.add_child(count);
    for (const b of buttons)
        bar.add_child(b);
    card.add_child(bar);
    const box = column({x_expand: true});
    box.add_child(child);
    card.add_child(scrollView(box));
    return {card, count};
}

export class TransformPage extends Page {
    static id = 'transform';

    build() {
        const actor = new St.BoxLayout({style_class: 'island-page island-xf-page'});
        actor.add_child(this._buildSidebar());
        actor.add_child(this._buildMain());
        this._tool = TOOLS[0];
        this._mode = 0;
        this._timer = 0;
        this._select(TOOLS[0].id);
        return actor;
    }

    _buildSidebar() {
        const side = new St.BoxLayout({style_class: 'island-card island-xf-side', ...VERTICAL, y_expand: true});
        this._toolButtons = {};
        let group = null;
        for (const tool of TOOLS) {
            if (tool.group !== group) {
                group = tool.group;
                side.add_child(label('island-group island-xf-group', {text: group.toUpperCase()}));
            }
            const box = new St.BoxLayout({style_class: 'island-xf-tool-box', x_expand: true});
            box.add_child(new St.Bin({
                style_class: `island-xf-glyph g-${group.toLowerCase()}`, y_align: Clutter.ActorAlign.CENTER,
                child: new St.Label({text: tool.glyph, style_class: 'island-xf-glyph-text',
                    x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}),
            }));
            box.add_child(label('island-xf-tool-name', {text: tool.name, x_expand: true}));
            const btn = new St.Button({style_class: 'island-xf-tool', can_focus: true, child: box, x_expand: true});
            btn.child.x_align = Clutter.ActorAlign.FILL;
            btn.connect('clicked', () => this._select(tool.id));
            side.add_child(btn);
            this._toolButtons[tool.id] = btn;
        }
        return side;
    }

    _buildMain() {
        const main = new St.BoxLayout({style_class: 'island-xf-main', ...VERTICAL, x_expand: true, y_expand: true});
        const head = new St.BoxLayout({style_class: 'island-xf-head'});
        const titles = column({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = label('island-xf-title');
        this._desc = label('island-xf-desc');
        titles.add_child(this._title);
        titles.add_child(this._desc);
        head.add_child(titles);
        this._modes = new St.BoxLayout({style_class: 'island-seg', y_align: Clutter.ActorAlign.CENTER});
        head.add_child(this._modes);
        main.add_child(head);

        this._input = multilineEntry('island-xf-text', 'Type or paste text');
        this._input.clutter_text.connect('text-changed', () => this._schedule());
        const input = pane('INPUT', this._input, [
            miniButton('Paste', '', () => this.ext.latestClip(t => t && (this._input.text = t))),
            miniButton('Clear', '', () => (this._input.text = '')),
        ]);
        this._inCount = input.count;
        main.add_child(input.card);

        const swapRow = new St.BoxLayout({style_class: 'island-xf-swap-row', x_align: Clutter.ActorAlign.CENTER});
        swapRow.add_child(iconButton('view-sort-descending-symbolic', 'island-xf-swap', () => {
            if (this._ok && this._result)
                this._input.text = this._result;
        }, 'Use output as input'));
        main.add_child(swapRow);

        this._output = wrappingLabel('island-xf-text island-xf-out', {selectable: true});
        this._copyBtn = miniButton('Copy', 'accent', () => this._copy());
        const output = pane('OUTPUT', this._output, [this._copyBtn]);
        this._outCount = output.count;
        main.add_child(output.card);
        return main;
    }

    onShow() {
        if (!this._input.text) {
            this.ext.latestClip(text => {
                if (text && !this._input.text)
                    this._input.text = text;
            });
        }
        return this._input;
    }

    destroy() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }

    _select(id) {
        const tool = TOOLS.find(t => t.id === id) ?? TOOLS[0];
        if (tool !== this._tool)
            this._mode = 0;
        this._tool = tool;
        for (const [tid, btn] of Object.entries(this._toolButtons))
            btn.checked = tid === tool.id;
        setText(this._title, tool.name);
        setText(this._desc, tool.desc);
        this._modes.destroy_all_children();
        this._modes.visible = tool.modes.length > 1;
        tool.modes.forEach((m, k) => {
            const b = new St.Button({style_class: 'island-seg-btn', label: m.name, can_focus: true});
            b.checked = k === this._mode;
            b.connect('clicked', () => {
                this._mode = k;
                this._modes.get_children().forEach((c, j) => (c.checked = j === k));
                this._run();
            });
            this._modes.add_child(b);
        });
        this._run();
    }

    _schedule() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RUN_DELAY_MS, () => {
            this._timer = 0;
            this._run();
            return GLib.SOURCE_REMOVE;
        });
    }

    _run() {
        const text = this._input.text;
        const mode = this._tool.modes[this._mode] ?? this._tool.modes[0];
        setText(this._inCount, text ? chars(text.length) : '');
        let out = '', ok = true;
        if (text || this._tool.id === 'timestamp') {
            try {
                out = mode.fn(text);
            } catch (e) {
                ok = false;
                out = e.message;
            }
        }
        this._ok = ok;
        this._result = ok ? out : '';
        const shown = out.length > MAX_SHOWN
            ? `${out.slice(0, MAX_SHOWN)}\n… (showing the first 20,000 characters; Copy takes everything)`
            : out;
        this._output.text = shown || 'The result appears here as you type';
        this._output.style_class = `island-xf-text island-xf-out${!out ? ' placeholder' : ok ? '' : ' error'}`;
        setText(this._outCount, ok && out ? chars(out.length) : '');
        this._copyBtn.reactive = ok && !!out;
        this._copyBtn.opacity = ok && out ? 255 : 110;
    }

    _copy() {
        if (!this._ok || !this._result)
            return;
        this.ext.copy(this._result);
        this._copyBtn.label = 'Copied';
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
            if (this._copyBtn.get_stage())
                this._copyBtn.label = 'Copy';
            return GLib.SOURCE_REMOVE;
        });
    }
}
