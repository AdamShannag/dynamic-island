// Go Island: a thin view layer. All logic lives in the islandd daemon; this
// extension renders whatever View JSON it receives over D-Bus.
//
// The pill replaces the top-bar clock: idle it shows the time (click opens
// the usual calendar/notification menu), and it grows down out of the top
// bar when the daemon has something to show.
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import GnomeDesktop from 'gi://GnomeDesktop';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'org.goisland.Island';
const OBJ_PATH = '/org/goisland/Island';
const IFACE_XML = `
<node>
  <interface name="org.goisland.Island">
    <method name="GetState"><arg name="state" type="s" direction="out"/></method>
    <method name="Action"><arg name="name" type="s" direction="in"/></method>
    <signal name="StateChanged"><arg name="state" type="s"/></signal>
  </interface>
</node>`;
const IslandProxy = Gio.DBusProxy.makeProxyWrapper(IFACE_XML);

const MORPH_MS = 450;
const FADE_OUT_MS = 90;
const FADE_IN_MS = 220;
const IDLE = {kind: 'idle'};
const MODES = ['idle', 'compact', 'notify', 'expanded'];
const ACCENTS = ['ok', 'warn', 'error'];

function fmtClock(secs) {
    secs = Math.max(0, Math.floor(secs));
    const h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, s = secs % 60;
    const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const Island = GObject.registerClass(
class Island extends St.BoxLayout {
    _init(onAction) {
        super._init({
            style_class: 'goisland idle',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            opacity: 0,
        });
        this._onAction = onAction;
        this._state = IDLE;
        this._expanded = false;
        this._mode = 'idle';
        this._tickId = 0;
        this._shown = false;
        this.set_pivot_point(0.5, 0);

        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connectObject('notify::clock', () => this._tick(), this);
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

        // Everything lives in _content so it can fade while the pill morphs.
        this._content = new St.BoxLayout({style_class: 'goisland-content', x_expand: true, y_expand: true});
        this.add_child(this._content);

        this._art = new St.Bin({style_class: 'goisland-art', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'goisland-icon', y_align: Clutter.ActorAlign.CENTER});
        this._content.add_child(this._art);
        this._content.add_child(this._icon);

        const text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = this._label('goisland-title');
        this._subtitle = this._label('goisland-subtitle');
        text.add_child(this._title);
        text.add_child(this._subtitle);

        // Media progress: [0:42] [=====-----] [3:15]
        this._progress = new St.BoxLayout({style_class: 'goisland-progress'});
        this._posLabel = new St.Label({style_class: 'goisland-time', y_align: Clutter.ActorAlign.CENTER});
        this._lenLabel = new St.Label({style_class: 'goisland-time', y_align: Clutter.ActorAlign.CENTER});
        this._track = new St.Widget({
            style_class: 'goisland-track',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.BinLayout(),
        });
        this._fill = new St.Widget({style_class: 'goisland-fill', x_align: Clutter.ActorAlign.START, y_expand: true});
        this._track.add_child(this._fill);
        this._progress.add_child(this._posLabel);
        this._progress.add_child(this._track);
        this._progress.add_child(this._lenLabel);
        text.add_child(this._progress);

        this._controls = new St.BoxLayout({style_class: 'goisland-controls', x_align: Clutter.ActorAlign.CENTER});
        this._buttons = {};
        for (const [action, icon] of [
            ['media.previous', 'media-skip-backward-symbolic'],
            ['media.play-pause', 'media-playback-start-symbolic'],
            ['media.next', 'media-skip-forward-symbolic'],
        ]) {
            const btn = new St.Button({
                style_class: 'goisland-btn',
                can_focus: true,
                child: new St.Icon({icon_name: icon, style_class: 'goisland-btn-icon'}),
            });
            btn.connect('clicked', () => this._onAction(action));
            this._controls.add_child(btn);
            this._buttons[action] = btn;
        }
        text.add_child(this._controls);
        this._content.add_child(text);

        this._trailing = new St.Label({style_class: 'goisland-trailing', y_align: Clutter.ActorAlign.CENTER});
        this._content.add_child(this._trailing);

        this.connect('button-release-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            const s = this._state;
            if (s.kind === 'idle') {
                Main.panel.statusArea.dateMenu?.menu.toggle();
            } else if (s.kind === 'media') {
                this._expanded = !this._expanded;
                this._render(s);
            } else if (s.click) {
                this._onAction(s.click);
            }
            return Clutter.EVENT_STOP;
        });

        this.connect('destroy', () => {
            this._stopTicker();
            this._wallClock = null;
        });
    }

    _label(styleClass) {
        const l = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        return l;
    }

    setState(state) {
        const prev = this._state;
        this._state = state ?? IDLE;
        if (this._state.kind !== 'media' || prev.kind !== 'media')
            this._expanded = false;
        this._render(prev);
    }

    _targetMode() {
        const s = this._state;
        if (s.kind === 'idle')
            return 'idle';
        if (s.kind === 'media')
            return this._expanded ? 'expanded' : 'compact';
        return s.subtitle ? 'notify' : 'compact';
    }

    _render(prev) {
        const s = this._state;
        if (!this._shown) {
            this._apply();
            this._show();
            return;
        }
        // Content that changes shape (mode, kind, new track) cross-fades;
        // small updates (play/pause, timing) apply in place.
        const structural = this._targetMode() !== this._mode ||
            prev.kind !== s.kind || prev.title !== s.title || prev.art !== s.art;
        if (!structural) {
            this._apply();
            this.relayout(true);
            return;
        }
        this._content.remove_all_transitions();
        this._content.ease({
            opacity: 0,
            duration: FADE_OUT_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._wallClock)
                    return; // destroyed
                this._apply();
                this.relayout(true);
                this._content.ease({
                    opacity: 255,
                    delay: 100,
                    duration: FADE_IN_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            },
        });
    }

    // Push this._state into the widgets (no animation).
    _apply() {
        const s = this._state;
        const mode = this._targetMode();
        this._mode = mode;
        for (const m of MODES)
            this.remove_style_class_name(m);
        this.add_style_class_name(mode);
        for (const a of ACCENTS)
            this.remove_style_class_name(`accent-${a}`);
        if (ACCENTS.includes(s.accent))
            this.add_style_class_name(`accent-${s.accent}`);

        this._title.text = s.title ?? '';
        this._title.visible = mode !== 'idle';
        this._subtitle.text = s.subtitle ?? '';
        this._subtitle.visible = (mode === 'notify' || mode === 'expanded') && !!s.subtitle;

        if (mode === 'idle') {
            this._art.hide();
            this._icon.hide();
        } else if (s.art) {
            this._art.style = `background-image: url("file://${encodeURI(s.art)}");`;
            this._art.show();
            this._icon.hide();
        } else {
            this._art.hide();
            this._icon.icon_name = s.icon || 'dialog-information-symbolic';
            this._icon.show();
        }

        const actions = s.actions ?? [];
        this._controls.visible = mode === 'expanded';
        for (const [action, btn] of Object.entries(this._buttons))
            btn.visible = actions.includes(action);
        this._buttons['media.play-pause'].child.icon_name =
            s.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._progress.visible = mode === 'expanded' && !!s.timing;

        this._tick();
        this._syncTicker();
    }

    // Updates the live parts: clock, countdown/elapsed, media progress.
    _tick() {
        if (!this._wallClock)
            return;
        const s = this._state;
        const now = Date.now();
        let trailing = '';
        if (this._mode === 'idle')
            trailing = this._wallClock.clock;
        else if (s.endsAt)
            trailing = fmtClock((s.endsAt - now) / 1000);
        else if (s.startedAt)
            trailing = fmtClock((now - s.startedAt) / 1000);
        else if (s.trailing)
            trailing = s.trailing;
        else if (s.kind === 'media' && this._mode === 'compact')
            trailing = this._shortTime();
        this._trailing.text = trailing;
        this._trailing.visible = trailing !== '';

        const t = s.timing;
        if (t && this._progress.visible) {
            const elapsed = s.playing ? (now - t.at) / 1000 * (t.rate || 1) : 0;
            const pos = Math.min(t.length, Math.max(0, t.position + elapsed));
            this._posLabel.text = fmtClock(pos);
            this._lenLabel.text = fmtClock(t.length);
            const w = this._track.width;
            if (w > 0)
                this._fill.width = Math.round(w * (t.length ? pos / t.length : 0));
        }
    }

    _shortTime() {
        const fmt = this._interface.get_string('clock-format') === '12h' ? '%l:%M' : '%H:%M';
        return GLib.DateTime.new_now_local().format(fmt).trim();
    }

    _syncTicker() {
        const s = this._state;
        const needed = !!(s.endsAt || s.startedAt ||
            (s.timing && s.playing && this._mode === 'expanded'));
        if (needed && !this._tickId) {
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!needed) {
            this._stopTicker();
        }
    }

    _stopTicker() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    _size() {
        const barH = Math.max(24, Main.panel.height - 6);
        switch (this._mode) {
        case 'idle': {
            const [, natural] = this._content.get_preferred_width(barH);
            return [Math.max(140, Math.ceil(natural) + 36), barH];
        }
        case 'notify':
            return [400, 64];
        case 'expanded':
            return [440, 140];
        default:
            return [300, barH];
        }
    }

    relayout(animate) {
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const [width, height] = this._size();
        const barH = Math.max(24, Main.panel.height - 6);
        const t = {
            x: mon.x + Math.round((mon.width - width) / 2),
            y: mon.y + Math.round((Main.panel.height - barH) / 2),
            width,
            height,
        };
        if (!animate) {
            for (const p of ['x', 'y', 'width', 'height'])
                this.remove_transition(p);
            this.set(t);
            return;
        }
        this.ease({...t, duration: MORPH_MS, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }

    _show() {
        this._shown = true;
        this.relayout(false);
        this.set({opacity: 0, scale_x: 0.6, scale_y: 0.6});
        this.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: MORPH_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }
});

export default class GoIslandExtension extends Extension {
    enable() {
        this._island = new Island(name => this._action(name));
        Main.layoutManager.addTopChrome(this._island, {
            affectsInputRegion: true,
            trackFullscreen: true, // hide over fullscreen apps (like the top bar)
        });

        // Take over the clock: keep the dateMenu button (its menu still
        // anchors there) but make it invisible under the pill.
        this._dateMenu = Main.panel.statusArea.dateMenu;
        this._dateMenu?.container.set_opacity(0);

        this._island.setState(IDLE);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._island.relayout(false), this);
        Main.panel.connectObject('notify::height',
            () => this._island.relayout(false), this);

        this._watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION, BUS_NAME, Gio.BusNameWatcherFlags.NONE,
            () => this._connect(),
            () => this._disconnect());
    }

    disable() {
        Gio.bus_unwatch_name(this._watchId);
        this._watchId = 0;
        this._disconnect();
        Main.layoutManager.disconnectObject(this);
        Main.panel.disconnectObject(this);
        this._dateMenu?.container.set_opacity(255);
        this._dateMenu = null;
        Main.layoutManager.removeChrome(this._island);
        this._island.destroy();
        this._island = null;
    }

    _connect() {
        this._disconnect();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        // eslint-disable-next-line no-new
        new IslandProxy(Gio.DBus.session, BUS_NAME, OBJ_PATH, (proxy, error) => {
            if (cancellable.is_cancelled())
                return;
            if (error) {
                console.error(`go-island: proxy: ${error.message}`);
                return;
            }
            this._proxy = proxy;
            this._signalId = proxy.connectSignal('StateChanged',
                (_p, _sender, [json]) => this._apply(json));
            proxy.GetStateRemote((result, err) => {
                if (err)
                    console.error(`go-island: GetState: ${err.message}`);
                else if (!cancellable.is_cancelled())
                    this._apply(result[0]);
            });
        }, cancellable);
    }

    _disconnect() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._proxy && this._signalId)
            this._proxy.disconnectSignal(this._signalId);
        this._proxy = null;
        this._signalId = 0;
        this._island?.setState(IDLE);
    }

    _apply(json) {
        try {
            this._island?.setState(JSON.parse(json));
        } catch (e) {
            console.error(`go-island: bad state: ${e.message}`);
        }
    }

    _action(name) {
        this._proxy?.ActionRemote(name, (_r, err) => {
            if (err)
                console.error(`go-island: Action ${name}: ${err.message}`);
        });
    }
}
