import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {shoulderRadius} from './format.js';

const LEFT = -1;
const RIGHT = 1;

function drawEar(area, side, color) {
    const [w, h] = area.get_surface_size();
    const r = Math.min(w, h);
    const cr = area.get_context();
    cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
    if (side === LEFT) {
        cr.moveTo(0, 0);
        cr.lineTo(r, 0);
        cr.lineTo(r, r);
        cr.arcNegative(0, r, r, 0, -Math.PI / 2);
    } else {
        cr.moveTo(r, 0);
        cr.lineTo(0, 0);
        cr.lineTo(0, r);
        cr.arc(r, r, r, Math.PI, 1.5 * Math.PI);
    }
    cr.closePath();
    cr.fill();
    cr.$dispose();
}

export class Shoulders {
    constructor(owner) {
        this._owner = owner;
        this._radius = 0;
        this._ears = [LEFT, RIGHT].map(side => {
            const area = new St.DrawingArea({reactive: false});
            area.connect('repaint', a => drawEar(a, side, this._owner.get_theme_node().get_background_color()));
            owner.add_child(area);
            return {side, area};
        });
        owner.connectObject('style-changed', () => this._repaint(), this);
    }

    allocate(box, scaleFactor) {
        const width = Math.round(box.get_width());
        const r = Math.round(shoulderRadius(box.get_height() / scaleFactor) * scaleFactor);
        for (const {side, area} of this._ears) {
            const x = side === LEFT ? -r : width;
            area.allocate(new Clutter.ActorBox({x1: x, y1: 0, x2: x + r, y2: r}));
        }
        if (r !== this._radius) {
            this._radius = r;
            this._repaint();
        }
    }

    _repaint() {
        for (const {area} of this._ears)
            area.queue_repaint();
    }

    destroy() {
        this._owner.disconnectObject(this);
        for (const {area} of this._ears)
            area.destroy();
        this._ears = [];
    }
}
