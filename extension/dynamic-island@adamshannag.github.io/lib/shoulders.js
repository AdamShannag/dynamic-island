import Clutter from 'gi://Clutter';
import St from 'gi://St';

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
    constructor(owner, source) {
        this._owner = owner;
        this._source = source;
        this._radius = 0;
        this._color = '';
        this._ears = [LEFT, RIGHT].map(side => {
            const area = new St.DrawingArea({reactive: false});
            area.connect('repaint', a => drawEar(a, side, this._source.get_theme_node().get_background_color()));
            owner.add_child(area);
            return {side, area};
        });
        source.connectObject('style-changed', () => this._onStyle(), this);
    }

    _onStyle() {
        const bg = this._source.get_theme_node().get_background_color();
        const c = `${bg.red},${bg.green},${bg.blue},${bg.alpha}`;
        if (c === this._color)
            return;
        this._color = c;
        this._repaint();
    }

    allocate(box, radius) {
        const width = Math.round(box.get_width());
        const r = Math.max(0, Math.round(radius));
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
        this._source.disconnectObject(this);
        for (const {area} of this._ears)
            area.destroy();
        this._ears = [];
    }
}
