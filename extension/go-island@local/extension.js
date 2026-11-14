// Go Island: a thin view layer. All logic lives in the islandd daemon; this
// extension renders whatever View JSON it receives over D-Bus.
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';

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

// [width, height] per layout mode.
const SIZES = {
    compact: [260, 38],
    notify: [360, 60],
    expanded: [400, 112],
};
const MORPH_MS = 450;
const FADE_MS = 220;
const GAP_BELOW_PANEL = 6;
const IDLE = {kind: 'idle'};

const Island = GObject.registerClass(
class Island extends St.BoxLayout {
    _init(onAction) {
        super._init({
            style_class: 'goisland compact',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            visible: false,
            opacity: 0,
        });
        this._onAction = onAction;
        this._state = IDLE;
        this._expanded = false;
        this.set_pivot_point(0.5, 0);

        this._art = new St.Bin({style_class: 'goisland-art', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'goisland-icon', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._art);
        this.add_child(this._icon);

        const text = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = this._label('goisland-title');
        this._subtitle = this._label('goisland-subtitle');
        text.add_child(this._title);
        text.add_child(this._subtitle);

        this._controls = new St.BoxLayout({style_class: 'goisland-controls'});
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
        this.add_child(text);

        // Compact media: a small play-state glyph on the right.
        this._status = new St.Icon({style_class: 'goisland-status', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._status);

        this.connect('button-release-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            if (this._state.kind === 'media') {
                this._expanded = !this._expanded;
                this._render(true);
            } else if (this._state.kind === 'notify') {
                this._onAction('notify.dismiss');
            }
            return Clutter.EVENT_STOP;
        });
    }

    _label(styleClass) {
        const l = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        return l;
    }

    setState(state) {
        const wasKind = this._state.kind;
        this._state = state ?? IDLE;
        if (this._state.kind !== 'media' || wasKind !== 'media')
            this._expanded = false;
        this._render(wasKind !== 'idle');
    }

    _mode() {
        const s = this._state;
        if (s.kind === 'media')
            return this._expanded ? 'expanded' : 'compact';
        return s.subtitle ? 'notify' : 'compact';
    }

    _render(animate) {
        const s = this._state;
        if (s.kind === 'idle') {
            this._hide();
            return;
        }
        const mode = this._mode();
        for (const m of Object.keys(SIZES))
            this.remove_style_class_name(m);
        this.add_style_class_name(mode);

        this._title.text = s.title ?? '';
        this._subtitle.text = s.subtitle ?? '';
        this._subtitle.visible = mode !== 'compact' && !!s.subtitle;

        if (s.art) {
            this._art.style = `background-image: url("file://${s.art.replace(/"/g, '%22')}");`;
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
        const playIcon = s.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._buttons['media.play-pause'].child.icon_name = playIcon;

        this._status.visible = s.kind === 'media' && mode === 'compact';
        this._status.icon_name = s.playing ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic';

        if (!this.visible) {
            this._show();
            return;
        }
        this.relayout(animate);
    }

    _target() {
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return null;
        const [width, height] = SIZES[this._mode()];
        return {
            x: mon.x + Math.round((mon.width - width) / 2),
            y: mon.y + Main.panel.height + GAP_BELOW_PANEL,
            width,
            height,
        };
    }

    relayout(animate) {
        const t = this._target();
        if (!t)
            return;
        if (!animate) {
            this.remove_transition('x');
            this.remove_transition('width');
            this.remove_transition('height');
            this.set({...t});
            return;
        }
        this.ease({
            ...t,
            duration: MORPH_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    _show() {
        this.remove_all_transitions();
        this.relayout(false);
        this.set({visible: true, opacity: 0, scale_x: 0.5, scale_y: 0.5});
        this.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: MORPH_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    _hide() {
        if (!this.visible)
            return;
        this.ease({
            opacity: 0,
            scale_x: 0.8,
            scale_y: 0.8,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (this._state.kind === 'idle')
                    this.hide();
            },
        });
    }
});

export default class GoIslandExtension extends Extension {
    enable() {
        this._island = new Island(name => this._action(name));
        Main.layoutManager.addTopChrome(this._island, {
            affectsInputRegion: true,
            trackFullscreen: true, // hide over fullscreen apps
        });
        this._monitorsId = Main.layoutManager.connect('monitors-changed',
            () => this._island.relayout(false));
        this._watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION, BUS_NAME, Gio.BusNameWatcherFlags.NONE,
            () => this._connect(),
            () => this._disconnect());
    }

    disable() {
        Gio.bus_unwatch_name(this._watchId);
        this._watchId = 0;
        this._disconnect();
        Main.layoutManager.disconnect(this._monitorsId);
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
