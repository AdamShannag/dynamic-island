import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

export function spring(t) {
    if (t >= 1)
        return 1;
    const z = 0.8, w = 11, wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
}

const PIXEL_PROPS = new Set(['x', 'y', 'width', 'height']);

export function springTo(actor, target, duration, onDone = null) {
    const from = {};
    for (const k of Object.keys(target))
        from[k] = actor[k];
    const set = p => {
        for (const [k, to] of Object.entries(target)) {
            const v = from[k] + (to - from[k]) * p;
            actor[k] = PIXEL_PROPS.has(k) ? Math.round(v) : v;
        }
    };
    const tl = new Clutter.Timeline({actor, duration});
    tl.connect('new-frame', () => set(spring(tl.get_elapsed_time() / duration)));
    tl.connect('completed', () => {
        set(1);
        onDone?.();
    });
    tl.start();
    return tl;
}

export function eachFrame(fn) {
    const laters = global.compositor?.get_laters?.();
    if (laters)
        laters.add(Meta.LaterType.BEFORE_REDRAW, fn);
    else
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => (fn() ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE));
}

export function frameLoop(actor, onFrame) {
    const tl = new Clutter.Timeline({actor, duration: 1000, repeat_count: -1});
    tl.connect('new-frame', () => {
        if (!onFrame())
            tl.stop();
    });
    tl.start();
    return tl;
}
