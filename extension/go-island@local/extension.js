// Go Island: a thin view layer. All logic lives in the islandd daemon; this
// extension renders whatever View JSON it receives over D-Bus.
//
// - A notch attached to the top edge that replaces the top-bar clock.
// - Live activities (media, timers, notifications) grow out of it.
// - Left-click opens the dashboard (Home / Docker / Ports / Clipboard /
//   Web); right-click opens the regular calendar menu.
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Pango from 'gi://Pango';
import GnomeDesktop from 'gi://GnomeDesktop';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Face} from './face.js';
import {calc, formatNumber, TOOLS} from './util.js';

const BUS_NAME = 'org.goisland.Island';
const OBJ_PATH = '/org/goisland/Island';
const IFACE_XML = `
<node>
  <interface name="org.goisland.Island">
    <method name="GetState"><arg name="state" type="s" direction="out"/></method>
    <method name="Action"><arg name="name" type="s" direction="in"/></method>
    <method name="DockerList"><arg name="containers" type="s" direction="out"/></method>
    <method name="DockerAction">
      <arg name="id" type="s" direction="in"/><arg name="op" type="s" direction="in"/>
    </method>
    <method name="DockerLogs">
      <arg name="id" type="s" direction="in"/><arg name="lines" type="i" direction="in"/>
      <arg name="text" type="s" direction="out"/>
    </method>
    <method name="PortsList"><arg name="listeners" type="s" direction="out"/></method>
    <method name="PortFree">
      <arg name="port" type="u" direction="in"/><arg name="summary" type="s" direction="out"/>
    </method>
    <method name="SitesList"><arg name="sites" type="s" direction="out"/></method>
    <method name="SiteAdd">
      <arg name="url" type="s" direction="in"/><arg name="name" type="s" direction="in"/>
    </method>
    <method name="SiteRemove"><arg name="id" type="u" direction="in"/></method>
    <method name="ClipboardAdd"><arg name="text" type="s" direction="in"/></method>
    <method name="ClipboardList"><arg name="items" type="s" direction="out"/></method>
    <method name="ClipboardDelete"><arg name="id" type="u" direction="in"/></method>
    <method name="ClipboardPin">
      <arg name="id" type="u" direction="in"/><arg name="pinned" type="b" direction="in"/>
    </method>
    <method name="ClipboardClear"/>
    <method name="AgentsList"><arg name="sessions" type="s" direction="out"/></method>
    <method name="ActivityList"><arg name="items" type="s" direction="out"/></method>
    <method name="SystemStats"><arg name="stats" type="s" direction="out"/></method>
    <method name="GetSettings"><arg name="settings" type="s" direction="out"/></method>
    <method name="SetSettings">
      <arg name="patch" type="s" direction="in"/><arg name="settings" type="s" direction="out"/>
    </method>
    <signal name="SettingsChanged"><arg name="settings" type="s"/></signal>
    <method name="NotesList"><arg name="notes" type="s" direction="out"/></method>
    <method name="NoteCreate"><arg name="note" type="s" direction="out"/></method>
    <method name="NoteSave"><arg name="id" type="u" direction="in"/><arg name="text" type="s" direction="in"/></method>
    <method name="NotePin"><arg name="id" type="u" direction="in"/><arg name="pinned" type="b" direction="in"/></method>
    <method name="NoteDelete"><arg name="id" type="u" direction="in"/></method>
    <method name="InboxList"><arg name="items" type="s" direction="out"/></method>
    <method name="InboxRemove"><arg name="id" type="u" direction="in"/></method>
    <method name="InboxClear"/>
    <method name="QR">
      <arg name="text" type="s" direction="in"/><arg name="png" type="s" direction="out"/>
    </method>
    <method name="PickColor"/>
    <method name="SetPresenting"><arg name="on" type="b" direction="in"/></method>
    <signal name="ColorPicked"><arg name="hex" type="s"/></signal>
    <signal name="StateChanged"><arg name="state" type="s"/></signal>
    <signal name="OpenDashboard"><arg name="tab" type="s"/></signal>
  </interface>
</node>`;
const IslandProxy = Gio.DBusProxy.makeProxyWrapper(IFACE_XML);

// GNOME 48 replaced St.BoxLayout's `vertical` with `orientation`.
const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION, 10);
const VERTICAL = SHELL_MAJOR >= 48 ? {orientation: Clutter.Orientation.VERTICAL} : {vertical: true};

// Sizes below are logical px; multiply by the display scale (HiDPI).
const scale = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

// Motion. The shape moves on a spring; content is laid out at its final
// size up front and revealed by the growing shape, so it can fade in almost
// immediately instead of waiting for the morph to finish.
const MORPH_MS = 480;
const FADE_OUT_MS = 70;
const REVEAL_DELAY_MS = 40;
const FADE_IN_MS = 200;

const DOCKER_REFRESH_MS = 3000;
const IDLE = {kind: 'idle'};
const MODES = ['idle', 'compact', 'notify', 'dashboard', 'osd'];
const ACCENTS = ['ok', 'warn', 'error'];
const TABS = [
    ['home', 'Home', 'user-home-symbolic'],
    ['inbox', 'Notifications', 'preferences-system-notifications-symbolic'],
    ['activity', 'Activity', 'utilities-system-monitor-symbolic'],
    ['agents', 'Agents', 'utilities-terminal-symbolic'],
    ['docker', 'Docker', 'network-server-symbolic'],
    ['ports', 'Ports', 'network-wired-symbolic'],
    ['clipboard', 'Clipboard', 'edit-paste-symbolic'],
    ['transform', 'Transform', 'edit-find-replace-symbolic'],
    ['notes', 'Notes', 'document-edit-symbolic'],
    ['search', 'Web', 'web-browser-symbolic'],
];
const TAB_ALIASES = {media: 'home', web: 'search', claude: 'agents'};
const DASH_WIDTH = 760;
const DASH_HEIGHT = {inbox: 480, settings: 520, activity: 470, transform: 500, home: 292, search: 360, agents: 400, notes: 480, qr: 430, logs: 520, default: 500};
const OSD_MS = 1600;
// Tabs whose sheet hugs its content (DASH_HEIGHT is then the maximum).
const AUTO_HEIGHT = new Set(['inbox', 'agents', 'docker', 'ports', 'clipboard', 'search']);
const AUTO_MIN_HEIGHT = 200;
const CLIP_DEBOUNCE_MS = 400; // collapse bursts of clipboard owner changes into one read // how long the volume/brightness bar stays up

// Personality.
const POINTER_MS = 33;           // shake detection rate while hovering
const WATCH_ACTIVE_MS = 60;      // cursor-moved check while it's moving (wakes the eyes)
const WATCH_IDLE_MS = 150;       // ...and while it's still
const SLEEP_AFTER_MS = 3 * 60 * 1000;
const CPU_DIZZY = 0.85;          // busy fraction that makes the island dizzy
const HOVER_IN_MS = 450;         // rest on a live pill this long before it expands
const HOVER_OUT_MS = 350;        // ...and it collapses this long after you leave
const SHAKE_WINDOW_MS = 600;     // shake = SHAKE_REVERSALS sharp direction changes within this window
const SHAKE_REVERSALS = 5;
const SHAKE_MIN_PX = 10;
const AGENT_REFRESH_MS = 2000;
const LIVE_KINDS = new Set(['agent', 'task', 'service']);
const AGENT_STATES = {
    working: ['Working', 'blue'],
    approval: ['Needs approval', 'yellow'],
    done: ['Finished', 'green'],
    error: ['Error', 'red'],
    ready: ['Idle', 'grey'],
};
const SITE_COLS = 8;
const TILE_COLORS = ['#0a84ff', '#30d158', '#ff9f0a', '#ff375f', '#bf5af2', '#64d2ff', '#ff453a', '#5e5ce6'];
// Password managers mark secrets with this mime type; never record them.
const SECRET_MIME = 'x-kde-passwordManagerHint';

// Damped spring (ζ≈0.8): fast start, ~2% overshoot, soft settle. t in [0,1].
function spring(t) {
    if (t >= 1)
        return 1;
    const z = 0.8, w = 11, wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
}
const PIXEL_PROPS = new Set(['x', 'y', 'width', 'height']);

function fmtClock(secs) {
    secs = Math.max(0, Math.floor(secs));
    const h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, s = secs % 60;
    const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function label(styleClass, props = {}) {
    const l = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function iconButton(iconName, styleClass, onClick, accessibleName = '') {
    const btn = new St.Button({
        style_class: styleClass,
        can_focus: true,
        accessible_name: accessibleName,
        y_align: Clutter.ActorAlign.CENTER,
        child: new St.Icon({icon_name: iconName}),
    });
    btn.connect('clicked', onClick);
    return btn;
}

function scrollView(child) {
    const sv = new St.ScrollView({
        style_class: 'goisland-scroll',
        x_expand: true,
        y_expand: true,
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        // Not overlay: the bar gets its own lane beside the content, so
        // cards never paint over it.
        overlay_scrollbars: false,
    });
    if (sv.set_child)
        sv.set_child(child);
    else
        sv.add_actor(child);
    return sv;
}

function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        console.error(`go-island: open ${uri}: ${e.message}`);
    }
}

// Focus the first window owned by any of the given pids (nearest first),
// e.g. agent → shell → terminal/IDE. Returns whether a window was found.
function focusPids(pids) {
    const wins = global.get_window_actors().map(a => a.meta_window).filter(w => w && !w.skip_taskbar);
    for (const pid of pids ?? []) {
        const mine = wins.filter(w => w.get_pid() === pid);
        if (mine.length) {
            mine.sort((a, b) => b.get_user_time() - a.get_user_time());
            Main.activateWindow(mine[0]);
            return true;
        }
    }
    return false;
}

// ---------- settings ----------
const ACCENT_COLORS = {
    blue: '#0a84ff', purple: '#bf5af2', pink: '#ff375f', orange: '#ff9f0a',
    green: '#30d158', teal: '#40c8e0', graphite: '#8e8e93',
};
const SURFACES = [['black', 'Black'], ['graphite', 'Graphite']];
const FEATURES = [
    ['face', 'Face', 'Eyes next to the clock that follow your cursor', 'face-smile-symbolic'],
    ['mediaPill', 'Music in the pill', 'Show the playing track in the pill (Home always shows it)', 'audio-x-generic-symbolic'],
    ['osd', 'Volume & brightness', 'Show volume and brightness changes in the island', 'audio-volume-high-symbolic'],
    ['hideBanners', "Hide GNOME's banners", 'Only the island shows notifications', 'notification-disabled-symbolic'],
    ['mirrorNotifications', 'Notifications', 'Show app notifications in the island', 'preferences-system-notifications-symbolic'],
    ['clipboardHistory', 'Clipboard history', 'Remember what you copy', 'edit-paste-symbolic'],
    ['usb', 'USB devices', 'Pop up when a device is plugged in', 'media-removable-symbolic'],
    ['battery', 'Battery', 'Charging and low-battery popups', 'battery-good-symbolic'],
];
// iOS-Settings-style badge colours, keyed by icon.
const SETTING_COLORS = {
    'user-home-symbolic': '#0a84ff', 'preferences-system-notifications-symbolic': '#ff453a',
    'utilities-system-monitor-symbolic': '#30d158', 'utilities-terminal-symbolic': '#ff9f0a',
    'network-server-symbolic': '#0a84ff', 'network-wired-symbolic': '#40c8e0', 'edit-paste-symbolic': '#8e8e93',
    'edit-find-replace-symbolic': '#bf5af2', 'document-edit-symbolic': '#ffcc00', 'web-browser-symbolic': '#0a84ff',
    'face-smile-symbolic': '#ff9f0a', 'audio-x-generic-symbolic': '#ff375f', 'audio-volume-high-symbolic': '#0a84ff',
    'notification-disabled-symbolic': '#ff453a', 'media-removable-symbolic': '#40c8e0', 'battery-good-symbolic': '#30d158',
    'applications-graphics-symbolic': '#bf5af2', 'weather-clear-night-symbolic': '#5e5ce6',
};
const DEFAULT_SETTINGS = {
    accent: 'blue', surface: 'black',
    tabs: {},      // missing = shown
    features: {},  // missing = on
};
const featureOn = (st, key) => st?.features?.[key] !== false;
const tabOn = (st, id) => id === 'home' || st?.tabs?.[id] !== false;

const SPARK_POINTS = 60; // one minute of history at 1 sample/s
const ROWS_PER_FRAME = 4; // list rows built per frame (keeps every frame well under 16 ms)

// Set text only when it changed (a text change triggers a relayout).
function setText(lbl, text) {
    if (lbl.text !== text)
        lbl.text = text;
}

// Run fn before each redraw until it returns false (falls back to a 16 ms timer).
function eachFrame(fn) {
    const laters = global.compositor?.get_laters?.();
    if (laters)
        laters.add(Meta.LaterType.BEFORE_REDRAW, fn);
    else
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => (fn() ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE));
}

function fmtBytes(n, digits = 1) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i < 2 ? 0 : digits)} ${u[i]}`;
}

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

// Friendly explanation for a DockerList error (the daemon prefixes codes).
function dockerProblem(message) {
    if (message.includes('docker-not-installed'))
        return {icon: 'dialog-information-symbolic', title: "Docker isn't installed", hint: 'Install it with: sudo apt install docker.io'};
    if (message.includes('docker-not-running'))
        return {icon: 'media-playback-stop-symbolic', title: "Docker isn't running", hint: 'Start it with: sudo systemctl start docker'};
    if (message.includes('docker-permission'))
        return {icon: 'dialog-password-symbolic', title: 'No permission to use Docker',
            hint: 'Run: sudo usermod -aG docker $USER, then log out and back in'};
    return {icon: 'dialog-warning-symbolic', title: "Couldn't reach Docker",
        hint: message.replace(/^.*?Error\.Failed: /, '').slice(0, 160)};
}

// What a clipboard item is, for its badge and secondary line.
function clipKind(text) {
    const t = text.trim();
    if (/^https?:\/\/\S+$/i.test(t)) {
        let host = '';
        try {
            host = t.split('/')[2];
        } catch {}
        return {label: `Link  ·  ${host}`, badge: {icon: 'web-browser-symbolic', color: '#0a84ff'}};
    }
    if (/^[[{]/.test(t)) {
        try {
            const v = JSON.parse(t);
            const n = Array.isArray(v) ? `${v.length} items` : `${Object.keys(v).length} keys`;
            return {label: `JSON  ·  ${n}`, badge: {glyph: '{ }', color: '#ff9f0a'}, mono: true};
        } catch {}
    }
    if (/^(select|insert|update|delete|with|create|alter)\s/i.test(t))
        return {label: 'SQL', badge: {glyph: 'SQL', color: '#5e5ce6'}, mono: true};
    if (/^(\$ )?(sudo|kubectl|docker|git|go|npm|pnpm|yarn|curl|ssh|make|cd|ls|cat|grep|helm|terraform|psql|python3?|cargo)\b/.test(t))
        return {label: 'Command', badge: {icon: 'utilities-terminal-symbolic', color: '#636366'}, mono: true};
    const lines = t.split('\n').length;
    return {label: lines > 1 ? `Text  ·  ${lines} lines` : `Text  ·  ${t.length} characters`,
        badge: {glyph: 'Aa', color: '#8e8e93'}};
}

function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60)
        return 'now';
    if (s < 3600)
        return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
}

// A small on/off toggle drawn by the island itself, so it follows the
// island's accent colour and looks the same on every theme/GNOME version.
class Toggle {
    constructor(state) {
        this.actor = new St.Widget({style_class: 'goisland-toggle', y_align: Clutter.ActorAlign.CENTER});
        this._knob = new St.Widget({style_class: 'goisland-toggle-knob'});
        this.actor.add_child(this._knob);
        this._state = null;
        this.set(state, false);
    }

    get state() {
        return this._state;
    }

    set state(v) {
        this.set(v, true);
    }

    set(v, animate) {
        v = !!v;
        if (v === this._state)
            return;
        this._state = v;
        if (v)
            this.actor.add_style_pseudo_class('checked');
        else
            this.actor.remove_style_pseudo_class('checked');
        const k = scale();
        const x = (v ? 20 : 2) * k;
        this._knob.y = 2 * k;
        if (animate)
            this._knob.ease({x, duration: 170, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        else
            this._knob.x = x;
    }

    toggle() {
        this.state = !this._state;
    }
}

// "Now playing" equalizer: each bar is a blend of two sine waves at
// unrelated frequencies (organic, never repeating), evaluated once per
// displayed frame on the frame clock. It runs only while the music is
// playing and the bars are on screen.
const EQ_WAVES = [[7.1, 11.3, 0.0], [8.7, 5.9, 1.7], [6.3, 13.1, 3.1], [9.4, 7.7, 4.4]]; // rad/s, rad/s, phase

class Equalizer {
    constructor(styleClass) {
        this.actor = new St.BoxLayout({style_class: `goisland-eq ${styleClass}`, y_align: Clutter.ActorAlign.CENTER});
        this._bars = [0, 1, 2, 3].map(() => {
            const bar = new St.Widget({style_class: 'goisland-eq-bar', y_expand: true});
            bar.set_pivot_point(0.5, 1);
            bar.scale_y = 0.35;
            this.actor.add_child(bar);
            return bar;
        });
        this._running = false;
        this._tl = null;
        this.actor.connect('notify::mapped', () => this._sync());
        this.actor.connect('destroy', () => this._stop());
    }

    set running(run) {
        this._running = run;
        this._sync();
    }

    _sync() {
        const on = this._running && this.actor.mapped;
        if (on && !this._tl) {
            const tl = new Clutter.Timeline({actor: this.actor, duration: 1000, repeat_count: -1});
            tl.connect('new-frame', () => {
                const t = GLib.get_monotonic_time() / 1e6;
                this._bars.forEach((bar, i) => {
                    const [f1, f2, ph] = EQ_WAVES[i];
                    const v = 0.58 + 0.26 * Math.sin(t * f1 + ph) + 0.16 * Math.sin(t * f2 + ph * 1.7);
                    bar.scale_y = Math.max(0.18, Math.min(1, v));
                });
            });
            this._tl = tl;
            tl.start();
        } else if (!on) {
            this._stop();
            this._bars.forEach(bar => (bar.scale_y = 0.35));
        }
    }

    _stop() {
        if (this._tl) {
            this._tl.stop();
            this._tl = null;
        }
    }
}

const Island = GObject.registerClass(
class Island extends St.BoxLayout {
    _init(ext) {
        super._init({
            style_class: 'goisland idle',
            reactive: true,
            track_hover: true,
            can_focus: true,
            opacity: 0,
        });
        this._ext = ext;
        this._state = IDLE;
        this._media = null; // last media view; survives notifications covering it
        this._timer = null; // running pomodoro view, if any
        this._mode = 'idle';
        this._dashOpen = false;
        this._tab = 'home';
        this._grab = null;
        this._tickId = 0;
        this._dockerId = 0;
        this._shown = false;
        this._springs = {};
        this._target = null;
        this._morphGen = 0;
        this._clipItems = [];
        this.set_pivot_point(0.5, 0);

        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connectObject('notify::clock', () => this._tick(), this);
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

        // The shape itself is never clipped (so its rounded background stays
        // clean); content is clipped by this inner layer instead. Content is
        // given its final size and pinned top-centre, so a growing shape
        // reveals it rather than squeezing it.
        this._clip = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._clip);

        this._buildPill();
        this._buildDash();

        this.connect('button-release-event', (_a, event) => this._onClick(event));
        // Hover intent: brushing past a live pill must not make it morph.
        this._hoverExpanded = false;
        this._hoverId = 0;
        this.connect('notify::hover', () => {
            if (this._hoverId)
                GLib.source_remove(this._hoverId);
            this._hoverId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.hover ? HOVER_IN_MS : HOVER_OUT_MS, () => {
                this._hoverId = 0;
                if (this._hoverExpanded !== this.hover) {
                    this._hoverExpanded = this.hover;
                    if (!this._dashOpen && LIVE_KINDS.has(this._state.kind))
                        this._render(this._state);
                }
                return GLib.SOURCE_REMOVE;
            });
        });
        this.connect('captured-event', (_a, event) => this._onCapturedEvent(event));
        this._startPersonality();
        this.connect('destroy', () => {
            this._stopPersonality();
            if (this._osdTimer)
                GLib.source_remove(this._osdTimer);
            if (this._hoverId)
                GLib.source_remove(this._hoverId);
            this._face.destroy();
            for (const tl of Object.values(this._springs))
                tl.stop();
            this._springs = {};
            this._closeDash(false);
            this._stopTicker();
            this._wallClock = null;
        });
    }

    // ---------- construction ----------

    _buildPill() {
        this._content = new St.BoxLayout({
            style_class: 'goisland-content',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this._clip.add_child(this._content);

        this._art = new St.Bin({style_class: 'goisland-art', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'goisland-icon', y_align: Clutter.ActorAlign.CENTER});
        const text = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._textBox = text;
        this._title = label('goisland-title');
        this._subtitle = label('goisland-subtitle');
        text.add_child(this._title);
        text.add_child(this._subtitle);
        // Volume / brightness bar (takes over GNOME's OSD popup).
        // Fixed layout: the fill sits at x=0 and only its width changes (a
        // BinLayout would let the fill's width feed back into the track's).
        this._osdTrack = new St.Widget({
            style_class: 'goisland-osd-track', x_expand: true, y_align: Clutter.ActorAlign.CENTER, visible: false,
        });
        this._osdFill = new St.Widget({style_class: 'goisland-osd-fill', x: 0, y: 0});
        this._osdTrack.add_child(this._osdFill);
        this._osdTrack.connect('notify::allocation', () => this._syncOsdFill());
        this._osd = null;
        this._osdTimer = 0;
        this._pillEq = new Equalizer('pill');
        this._face = new Face(this._ext.spyIcon);
        this._face.setTargetProvider(() => this._faceTarget());
        this._trailing = label('goisland-trailing');
        for (const a of [this._art, this._icon, text, this._osdTrack, this._pillEq.actor, this._face.actor, this._trailing])
            this._content.add_child(a);
    }

    _buildDash() {
        this._dash = new St.BoxLayout({
            style_class: 'goisland-dash',
            ...VERTICAL,
            visible: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this._clip.add_child(this._dash);

        const header = new St.BoxLayout({style_class: 'goisland-header'});
        // Icon tabs: grey icons, the selected one white on a dark circle that
        // glides (spring) between tabs.
        // Fixed layout: the highlight goes exactly where it's placed (a
        // BinLayout would re-centre it under the row).
        const tabsWrap = new St.Widget({
            style_class: 'goisland-tabs', layout_manager: new Clutter.FixedLayout(), y_align: Clutter.ActorAlign.CENTER,
        });
        this._tabIndicator = new St.Widget({style_class: 'goisland-tab-indicator', x: 0, y: 0});
        const tabs = new St.BoxLayout({style_class: 'goisland-tabs-row', x: 0, y: 0});
        tabsWrap.add_child(this._tabIndicator);
        tabsWrap.add_child(tabs);
        this._tabButtons = {};
        this._tabDots = {};
        for (const [id, name, icon] of TABS) {
            // Exact positions (fixed layout): icon centred in the 32 px button,
            // unread dot in its top-right corner.
            const k = scale();
            const face = new St.Widget({width: 32 * k, height: 32 * k});
            face.add_child(new St.Icon({icon_name: icon, style_class: 'goisland-tab-icon', icon_size: 17,
                x: Math.round(7.5 * k), y: Math.round(7.5 * k)}));
            const dot = new St.Widget({style_class: 'goisland-tab-dot', visible: false,
                x: Math.round(21 * k), y: Math.round(4 * k)});
            face.add_child(dot);
            this._tabDots[id] = dot;
            const btn = new St.Button({style_class: 'goisland-tab', can_focus: true, accessible_name: name, child: face});
            btn.connect('clicked', () => this._showTab(id));
            tabs.add_child(btn);
            this._tabButtons[id] = btn;
        }
        this._indicator = {pos: [0, 0], vel: [0, 0], tl: null, lastT: 0, still: 0, placed: false};
        header.add_child(tabsWrap);
        this._tabName = label('goisland-tab-name', {x_expand: true});
        header.add_child(this._tabName);
        this._presentBadge = label('goisland-present-badge', {text: 'Presenting · private info hidden', visible: false});
        header.add_child(this._presentBadge);
        header.add_child(iconButton('color-select-symbolic', 'goisland-head-btn', () => {
            this._closeDash();
            this._ext.call('PickColor');
        }, 'Pick a colour'));
        this._spyBtn = new St.Button({
            style_class: 'goisland-head-btn', can_focus: true, accessible_name: 'Presentation mode',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({gicon: this._ext.spyIcon, style_class: 'goisland-head-spy'}),
        });
        this._spyBtn.connect('clicked', () => this._ext.setPresenting(!this._ext.presenting, false));
        header.add_child(this._spyBtn);
        header.add_child(iconButton('emblem-system-symbolic', 'goisland-head-btn', () => this._showTab('settings'), 'Settings'));
        this._dashClock = label('goisland-dash-clock');
        header.add_child(this._dashClock);
        this._dash.add_child(header);

        const body = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._pages = {
            home: this._buildHomePage(),
            activity: this._buildActivityPage(),
            agents: this._buildAgentsPage(),
            docker: this._buildDockerPage(),
            ports: this._buildPortsPage(),
            clipboard: this._buildClipboardPage(),
            transform: this._buildTransformPage(),
            notes: this._buildNotesPage(),
            inbox: this._buildInboxPage(),
            qr: this._buildQRPage(),
            settings: this._buildSettingsPage(),
            logs: this._buildLogsPage(),
            search: this._buildSearchPage(),
        };
        for (const page of Object.values(this._pages)) {
            page.set({x_expand: true, y_expand: true, visible: false});
            body.add_child(page);
        }
        this._dash.add_child(body);
    }

    // ----- Home: Now Playing card + Today card -----

    _buildHomePage() {
        const page = new St.BoxLayout({style_class: 'goisland-page goisland-home'});

        // Now Playing
        const media = new St.BoxLayout({style_class: 'goisland-card goisland-media-card', ...VERTICAL, x_expand: true});
        const top = new St.BoxLayout({style_class: 'goisland-media-top'});
        this._mArtFrame = new St.Widget({style_class: 'goisland-media-art', layout_manager: new Clutter.BinLayout()});
        this._mArt = new St.Bin({style_class: 'goisland-media-art-img', x_expand: true, y_expand: true});
        this._mArtIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic', style_class: 'goisland-media-art-icon',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        this._mArtFrame.add_child(this._mArtIcon);
        this._mArtFrame.add_child(this._mArt);
        const col = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._mTitle = label('goisland-media-title');
        this._mSub = label('goisland-media-sub');
        col.add_child(this._mTitle);
        col.add_child(this._mSub);
        this._mEq = new Equalizer('card');
        top.add_child(this._mArtFrame);
        top.add_child(col);
        top.add_child(this._mEq.actor);
        media.add_child(top);
        media.add_child(new St.Widget({y_expand: true})); // pins progress + controls to the bottom

        this._progress = new St.BoxLayout({style_class: 'goisland-progress'});
        this._posLabel = label('goisland-time');
        this._remLabel = label('goisland-time goisland-time-right');
        this._track = new St.Widget({style_class: 'goisland-track', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._fill = new St.Widget({style_class: 'goisland-fill', x: 0, y: 0});
        this._track.add_child(this._fill);
        for (const a of [this._posLabel, this._track, this._remLabel])
            this._progress.add_child(a);
        media.add_child(this._progress);

        this._controls = new St.BoxLayout({style_class: 'goisland-controls', x_align: Clutter.ActorAlign.CENTER});
        this._controls.add_child(iconButton('media-seek-backward-symbolic', 'goisland-btn',
            () => this._ext.action('media.previous'), 'Previous'));
        this._playBtn = iconButton('media-playback-start-symbolic', 'goisland-btn goisland-btn-big',
            () => this._ext.action('media.play-pause'), 'Play/Pause');
        this._controls.add_child(this._playBtn);
        this._controls.add_child(iconButton('media-seek-forward-symbolic', 'goisland-btn',
            () => this._ext.action('media.next'), 'Next'));
        media.add_child(this._controls);
        page.add_child(media);

        // Today
        const today = new St.BoxLayout({style_class: 'goisland-card goisland-today-card', ...VERTICAL});
        this._todayDate = label('goisland-today-date');
        this._todayTitle = label('goisland-today-title');
        today.add_child(this._todayDate);
        today.add_child(this._todayTitle);
        this._focusRow = this._actionRow('green', 'Focus session', () =>
            this._ext.action(this._timer ? 'pomodoro.stop' : 'pomodoro.start'));
        this._dockerRow = this._actionRow('blue', 'Containers', () => this._showTab('docker'));
        this._dockerRow.btn.label = 'Open';
        today.add_child(this._focusRow.row);
        today.add_child(this._dockerRow.row);
        page.add_child(today);
        return page;
    }

    _actionRow(color, title, onClick) {
        const row = new St.BoxLayout({style_class: 'goisland-action'});
        row.add_child(new St.Widget({style_class: `goisland-action-bar ${color}`}));
        const col = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const titleLbl = label('goisland-action-title', {text: title});
        const sub = label('goisland-action-sub');
        col.add_child(titleLbl);
        col.add_child(sub);
        row.add_child(col);
        const btn = new St.Button({style_class: `goisland-action-btn ${color}`, can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        btn.connect('clicked', onClick);
        row.add_child(btn);
        return {row, sub, btn};
    }

    _loadDockerCount() {
        this._ext.call('DockerList', [], (res, err) => {
            if (err) {
                this._dockerRow.sub.text = dockerProblem(err.message).title;
            } else {
                const list = JSON.parse(res[0]);
                const bad = list.filter(c => /unhealthy/.test(c.status)).length;
                this._dockerRow.sub.text = `${list.length} running${bad ? ` · ${bad} unhealthy` : ''}`;
            }
        });
    }

    // ----- Activity: system monitor + running dev builds/servers -----

    _buildActivityPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page', ...VERTICAL});
        const tiles = new St.BoxLayout({style_class: 'goisland-tiles'});
        tiles.layout_manager.homogeneous = true; // four equal tiles
        this._tiles = {
            cpu: this._metricTile('CPU', '#0a84ff'),
            mem: this._metricTile('MEMORY', '#30d158'),
            disk: this._metricTile('DISK', '#bf5af2', true),
            net: this._metricTile('NETWORK', '#ff9f0a'),
        };
        for (const t of Object.values(this._tiles))
            tiles.add_child(t.actor);
        page.add_child(tiles);

        const lower = new St.BoxLayout({style_class: 'goisland-activity-lower', y_expand: true});
        const topCard = new St.BoxLayout({style_class: 'goisland-card goisland-list-card', ...VERTICAL, x_expand: true, y_expand: true});
        topCard.add_child(label('goisland-group', {text: 'TOP PROCESSES'}));
        this._topList = new St.BoxLayout({...VERTICAL, style_class: 'goisland-list'});
        // Built once; refreshes only change text (no per-second rebuilds).
        this._procRows = Array.from({length: 6}, () => {
            const row = new St.BoxLayout({style_class: 'goisland-proc-row', visible: false});
            const iconBin = new St.Bin({style_class: 'goisland-proc-iconbin', y_align: Clutter.ActorAlign.CENTER});
            const icon = new St.Icon({style_class: 'goisland-proc-icon'});
            const initial = new St.Label({style_class: 'goisland-proc-initial', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            iconBin.child = icon;
            row.add_child(iconBin);
            const name = label('goisland-proc-name', {x_expand: true});
            const cpu = label('goisland-proc-cpu');
            const mem = label('goisland-proc-mem');
            row.add_child(name);
            row.add_child(cpu);
            row.add_child(mem);
            this._topList.add_child(row);
            return {row, iconBin, icon, initial, name, cpu, mem};
        });
        this._procIcons = new Map(); // process name -> GIcon (or null), looked up once
        topCard.add_child(this._topList);
        const runCard = new St.BoxLayout({style_class: 'goisland-card goisland-list-card', ...VERTICAL, x_expand: true, y_expand: true});
        runCard.add_child(label('goisland-group', {text: 'RUNNING'}));
        this._activityMsg = label('goisland-empty goisland-empty-small', {visible: false, x_align: Clutter.ActorAlign.CENTER});
        this._activityList = new St.BoxLayout({...VERTICAL, style_class: 'goisland-list'});
        runCard.add_child(this._activityMsg);
        runCard.add_child(scrollView(this._activityList));
        lower.add_child(topCard);
        lower.add_child(runCard);
        page.add_child(lower);
        return page;
    }

    _metricTile(title, color, bar = false) {
        const actor = new St.BoxLayout({style_class: 'goisland-card goisland-tile', ...VERTICAL, x_expand: true});
        actor.add_child(label('goisland-group goisland-tile-title', {text: title}));
        const value = label('goisland-tile-value');
        const sub = label('goisland-tile-sub');
        actor.add_child(value);
        actor.add_child(sub);
        const tile = {actor, value, sub, series: [], max: 100, color};
        if (bar) {
            tile.track = new St.Widget({style_class: 'goisland-tile-track', x_expand: true});
            tile.fill = new St.Widget({style_class: 'goisland-tile-fill', x: 0, y: 0});
            tile.fill.set_style(`background-color: ${color};`);
            tile.track.add_child(tile.fill);
            tile.track.connect('notify::allocation', () => this._syncTileBar(tile));
            actor.add_child(tile.track);
        } else {
            tile.chart = new St.DrawingArea({style_class: 'goisland-spark', x_expand: true});
            tile.chart.connect('repaint', area => this._paintSpark(area, tile));
            actor.add_child(tile.chart);
        }
        return tile;
    }

    _syncTileBar(tile) {
        const w = tile.track.width;
        if (w > 0)
            tile.fill.set_size(Math.round(w * Math.min(1, tile.frac ?? 0)), tile.track.height);
    }

    // Area + line sparkline, newest sample at the right edge.
    _paintSpark(area, tile) {
        const cr = area.get_context();
        try {
            const [w, h] = area.get_surface_size();
            const pts = tile.series;
            if (pts.length < 2)
                return;
            const [r, g, b] = hexToRgb(tile.color);
            const step = w / (SPARK_POINTS - 1);
            const xy = pts.map((v, i) => [w - (pts.length - 1 - i) * step, h - 1 - Math.min(1, v / tile.max) * (h - 3)]);
            cr.moveTo(xy[0][0], h);
            for (const [x, y] of xy)
                cr.lineTo(x, y);
            cr.lineTo(w, h);
            cr.closePath();
            cr.setSourceRGBA(r, g, b, 0.16);
            cr.fill();
            cr.moveTo(...xy[0]);
            for (const [x, y] of xy.slice(1))
                cr.lineTo(x, y);
            cr.setSourceRGBA(r, g, b, 0.95);
            cr.setLineWidth(1.6 * scale());
            cr.stroke();
        } finally {
            cr.$dispose();
        }
    }

    _pushSample(tile, v, autoScaleFloor = 0) {
        tile.series.push(v);
        if (tile.series.length > SPARK_POINTS)
            tile.series.shift();
        if (autoScaleFloor)
            tile.max = Math.max(autoScaleFloor, ...tile.series) * 1.15;
        tile.chart?.queue_repaint();
    }

    _loadActivity() {
        this._ext.call('SystemStats', [], (res, err) => {
            if (!err && this._dashOpen && this._tab === 'activity')
                this._renderStats(JSON.parse(res[0]));
        });
        this._ext.call('ActivityList', [], (res, err) => {
            if (!this._dashOpen || this._tab !== 'activity')
                return;
            const items = err ? [] : JSON.parse(res[0]);
            this._message(this._activityMsg, err ? 'Daemon not running' : items.length ? '' : 'No builds or dev servers running');
            this._renderActivity(items);
        });
    }

    _renderStats(st) {
        const T = this._tiles;
        setText(T.cpu.value, `${Math.round(st.cpu)}%`);
        setText(T.cpu.sub, [`${st.cores} cores`, st.tempC ? `${Math.round(st.tempC)}°C` : '', `load ${st.load1.toFixed(2)}`]
            .filter(Boolean).join('  ·  '));
        this._pushSample(T.cpu, st.cpu);

        const memPct = st.memTotal ? 100 * st.memUsed / st.memTotal : 0;
        setText(T.mem.value, fmtBytes(st.memUsed));
        setText(T.mem.sub, `of ${fmtBytes(st.memTotal, 0)}${st.swapTotal ? `  ·  swap ${fmtBytes(st.swapUsed)}` : ''}`);
        this._pushSample(T.mem, memPct);

        T.disk.frac = st.diskTotal ? st.diskUsed / st.diskTotal : 0;
        setText(T.disk.value, `${Math.round(T.disk.frac * 100)}%`);
        setText(T.disk.sub, `${fmtBytes(st.diskUsed, 0)} of ${fmtBytes(st.diskTotal, 0)}`);
        this._syncTileBar(T.disk);

        setText(T.net.value, `↓ ${fmtBytes(st.netRx)}/s`);
        setText(T.net.sub, `↑ ${fmtBytes(st.netTx)}/s`);
        this._pushSample(T.net, st.netRx + st.netTx, 64 * 1024);

        this._procRows.forEach((r, k) => {
            const p = st.top[k];
            r.row.visible = !!p;
            if (!p)
                return;
            setText(r.name, p.name || `pid ${p.pid}`);
            if (r.iconFor !== p.name) { // the app's icon, else a neutral initial
                r.iconFor = p.name;
                if (!this._procIcons.has(p.name))
                    this._procIcons.set(p.name, this._ext.lookupProcessApp(p.name)?.get_icon() ?? null);
                const gi = this._procIcons.get(p.name);
                if (gi) {
                    r.icon.gicon = gi;
                    r.iconBin.child = r.icon;
                    r.iconBin.remove_style_class_name('initial');
                } else {
                    r.initial.text = (p.name || '?')[0].toUpperCase();
                    r.iconBin.child = r.initial;
                    r.iconBin.add_style_class_name('initial');
                }
            }
            setText(r.cpu, `${p.cpu.toFixed(p.cpu < 10 ? 1 : 0)}%`);
            setText(r.mem, fmtBytes(p.mem, 0));
            const cls = `goisland-proc-cpu${p.cpu >= 50 ? ' hot' : ''}`;
            if (r.cpu.style_class !== cls)
                r.cpu.style_class = cls;
        });
    }

    _renderActivity(items) {
        const now = Date.now();
        const sig = items.map(it => `${it.pid}:${(it.ports ?? []).join(',')}`).join('|');
        if (sig === this._activitySig && this._activityTimes) {
            items.forEach((it, k) => this._activityTimes[k] && setText(this._activityTimes[k], fmtClock((now - it.startedAt) / 1000)));
            return;
        }
        this._activitySig = sig;
        this._activityTimes = [];
        this._fillList(this._activityList, items, (it, k) => {
            const box = new St.BoxLayout({x_expand: true, style_class: 'goisland-activity-row'});
            const badge = new St.Widget({
                style_class: `goisland-activity-badge ${it.kind}`,
                layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER,
            });
            badge.add_child(new St.Icon({
                icon_name: it.kind === 'service' ? 'network-server-symbolic' : 'system-run-symbolic',
                style_class: 'goisland-activity-icon', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            }));
            box.add_child(badge);
            const col = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            col.add_child(label('goisland-row-title goisland-mono', {text: it.title}));
            col.add_child(label('goisland-row-sub', {text: [it.project, it.app].filter(Boolean).join('  ·  ')}));
            box.add_child(col);
            if (it.ports?.length) {
                const chips = new St.BoxLayout({style_class: 'goisland-port-chips', y_align: Clutter.ActorAlign.CENTER});
                for (const port of it.ports.slice(0, 2))
                    chips.add_child(this._portButton(port, 'goisland-port-chip'));
                box.add_child(chips);
            }
            const time = label('goisland-activity-time live', {text: fmtClock((now - it.startedAt) / 1000), y_align: Clutter.ActorAlign.CENTER});
            this._activityTimes[k] = time;
            box.add_child(time);
            const row = new St.Button({style_class: 'goisland-row goisland-clip-row', can_focus: true, child: box, x_expand: true});
            row.connect('clicked', () => {
                if (focusPids(it.focus))
                    this._closeDash();
            });
            return row;
        });
    }

    // ----- Agents -----

    _buildAgentsPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page', ...VERTICAL});
        this._agentEmpty = this._emptyState();
        this._agentGroup = this._group('SESSIONS');
        const content = new St.BoxLayout({...VERTICAL, style_class: 'goisland-groups'});
        content.add_child(this._agentGroup.actor);
        this._agentScroll = scrollView(content);
        page.add_child(this._agentEmpty.actor);
        page.add_child(this._agentScroll);
        return page;
    }

    _loadAgents() {
        this._ext.call('AgentsList', [], (res, err) => {
            if (!this._dashOpen || this._tab !== 'agents')
                return;
            const list = err ? [] : JSON.parse(res[0]);
            if (!list.length) {
                this._agentSig = null;
                this._agentScroll.hide();
                this._agentEmpty.show(err ? {icon: 'dialog-warning-symbolic', title: 'Daemon not running'}
                    : {gicon: this._ext.agentIcon, icon: 'utilities-terminal-symbolic', title: 'No agent sessions',
                        hint: 'Run island claude install, then start Claude Code'});
                return;
            }
            this._agentEmpty.hide();
            this._agentScroll.show();
            this._renderAgents(list);
        });
    }

    _renderAgents(list) {
        const sig = JSON.stringify(list.map(a => [a.id, a.state, a.detail, a.title, a.project, a.costUsd, a.contextPct]));
        if (sig === this._agentSig && this._agentWhen) {
            list.forEach((a, k) => this._agentWhen[k] && setText(this._agentWhen[k], ago(a.updatedAt)));
            return;
        }
        this._agentSig = sig;
        this._agentWhen = [];
        this._fillList(this._agentGroup.list, list, (a, k) => {
            const [stateName, color] = AGENT_STATES[a.state] ?? AGENT_STATES.ready;
            const row = new St.Button({style_class: 'goisland-irow', can_focus: true, x_expand: true});
            const box = new St.BoxLayout({style_class: 'goisland-irow-box', x_expand: true});
            box.add_child(this._badge({gicon: this._ext.agentIcon, color: 'rgba(255, 159, 10, 0.16)'}));
            const detail = a.detail || a.title || '';
            const text = this._rowText(`${a.project || 'session'}`, detail, {monoSub: detail.startsWith('$ ')});
            box.add_child(text.col);
            const meta = new St.BoxLayout({...VERTICAL, y_align: Clutter.ActorAlign.CENTER, style_class: 'goisland-irow-meta'});
            meta.add_child(label(`goisland-pill-badge ${color}`, {text: stateName, x_align: Clutter.ActorAlign.END}));
            const usage = [a.costUsd ? `$${a.costUsd.toFixed(2)}` : '', a.contextPct ? `${Math.round(a.contextPct)}% context` : '']
                .filter(Boolean).join('  ·  ');
            const when = label('goisland-irow-sub', {text: ago(a.updatedAt), x_align: Clutter.ActorAlign.END});
            this._agentWhen[k] = when;
            if (usage)
                meta.add_child(label('goisland-irow-sub', {text: usage, x_align: Clutter.ActorAlign.END}));
            meta.add_child(when);
            box.add_child(meta);
            row.child = box;
            row.connect('clicked', () => {
                if (focusPids(a.focus))
                    this._closeDash();
            });
            return row;
        });
    }

    // ----- Docker -----

    _buildDockerPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page', ...VERTICAL});
        this._dockerEmpty = this._emptyState();
        this._dockerGroups = new St.BoxLayout({...VERTICAL, style_class: 'goisland-groups'});
        this._dockerScroll = scrollView(this._dockerGroups);
        page.add_child(this._dockerEmpty.actor);
        page.add_child(this._dockerScroll);
        return page;
    }

    _buildLogsPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page', ...VERTICAL});
        const bar = new St.BoxLayout({style_class: 'goisland-toolbar'});
        const back = new St.Button({style_class: 'goisland-pill-btn', label: 'Back', can_focus: true});
        back.connect('clicked', () => this._showTab('docker'));
        this._logsTitle = label('goisland-logs-title', {x_expand: true});
        this._logsHint = label('goisland-hint', {text: 'Last 50 lines · live'});
        bar.add_child(back);
        bar.add_child(this._logsTitle);
        bar.add_child(this._logsHint);
        const card = new St.BoxLayout({style_class: 'goisland-card goisland-logs-card', ...VERTICAL, x_expand: true, y_expand: true});
        this._logsText = new St.Label({style_class: 'goisland-logs'});
        const ct = this._logsText.clutter_text;
        ct.line_wrap = true;
        ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        ct.selectable = true;
        ct.reactive = true;
        this._logsText.reactive = true;
        const box = new St.BoxLayout({...VERTICAL, x_expand: true});
        box.add_child(this._logsText);
        this._logsScroll = scrollView(box);
        card.add_child(this._logsScroll);
        page.add_child(bar);
        page.add_child(card);
        return page;
    }

    _showLogs(c) {
        this._logsFor = c;
        this._logsTitle.text = c.name;
        this._logsText.text = 'Loading…';
        this._showTab('logs');
    }

    _loadLogs(scrollToEnd) {
        const c = this._logsFor;
        if (!c)
            return;
        this._ext.call('DockerLogs', [c.id, 50], (res, err) => {
            if (!this._dashOpen || this._tab !== 'logs' || this._logsFor !== c)
                return;
            const adj = this._logsScroll.vadjustment;
            const atEnd = scrollToEnd || adj.value + adj.page_size >= adj.upper - 4;
            const text = err ? err.message.replace(/^.*?Error\.Failed: /, '') : res[0].trimEnd() || '(no output yet)';
            if (text === this._logsText.text)
                return;
            this._logsText.text = text;
            if (atEnd) { // follow the tail unless you've scrolled up to read
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    adj.value = adj.upper - adj.page_size;
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
    }

    _loadDocker() {
        this._ext.call('DockerList', [], (res, err) => {
            if (!this._dashOpen || this._tab !== 'docker')
                return;
            const list = err ? [] : JSON.parse(res[0]);
            if (err || !list.length) {
                this._dockerSig = null;
                this._dockerGroups.destroy_all_children();
                this._dockerScroll.hide();
                this._dockerEmpty.show(err ? dockerProblem(err.message) : {
                    icon: 'network-server-symbolic', title: 'No containers running',
                    hint: 'Start some with docker compose up or docker run',
                });
                return;
            }
            this._dockerEmpty.hide();
            this._dockerScroll.show();
            this._renderDocker(list);
        });
    }

    // A centred icon + title + hint, for lists with nothing to show.
    _emptyState() {
        const actor = new St.BoxLayout({
            style_class: 'goisland-empty-state', ...VERTICAL, visible: false,
            x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        const badge = new St.Widget({style_class: 'goisland-empty-badge', layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
        const icon = new St.Icon({style_class: 'goisland-empty-icon', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        badge.add_child(icon);
        const title = new St.Label({style_class: 'goisland-empty-title', x_align: Clutter.ActorAlign.CENTER});
        const hint = new St.Label({style_class: 'goisland-empty-hint', x_align: Clutter.ActorAlign.CENTER});
        hint.clutter_text.line_wrap = true;
        for (const a of [badge, title, hint])
            actor.add_child(a);
        return {
            actor,
            show: spec => {
                this._refit();
                if (spec.gicon)
                    icon.gicon = spec.gicon;
                else
                    icon.icon_name = spec.icon;
                setText(title, spec.title);
                setText(hint, spec.hint ?? '');
                hint.visible = !!spec.hint;
                actor.show();
            },
            hide: () => {
                if (actor.visible)
                    this._refit();
                actor.hide();
            },
        };
    }

    _renderDocker(list) {
        const sig = list.map(c => [c.id, c.state, c.status, c.ports, c.project].join('/')).join('|');
        if (sig === this._dockerSig && this._dockerStats) {
            for (const c of list) {
                const refs = this._dockerStats.get(c.id);
                if (refs)
                    this._setDockerStats(refs, c.stats);
            }
            return;
        }
        this._dockerSig = sig;
        this._dockerStats = new Map();
        this._dockerGroups.destroy_all_children();
        const projects = new Map();
        for (const c of list) {
            const key = c.project || '';
            if (!projects.has(key))
                projects.set(key, []);
            projects.get(key).push(c);
        }
        for (const [project, containers] of projects) {
            const count = label('goisland-igroup-count', {text: `${containers.length} running`});
            const g = this._group((project || 'standalone').toUpperCase(), count);
            this._dockerGroups.add_child(g.actor);
            this._fillList(g.list, containers, c => this._makeDockerRow(c));
        }
    }

    _setDockerStats(refs, st) {
        setText(refs.cpu, st ? `${st.cpu.toFixed(st.cpu < 10 ? 1 : 0)}% CPU` : '–');
        setText(refs.mem, st ? st.mem.replace(/iB$/, 'B') : ' ');
        refs.cpu.style_class = `goisland-usage-cpu${st && st.cpu >= 80 ? ' hot' : ''}`;
        refs.mem.style_class = `goisland-usage-mem${st && st.memPct >= 80 ? ' hot' : ''}`;
    }

    _makeDockerRow(c) {
        const unhealthy = /unhealthy/.test(c.status);
        const color = c.state !== 'running' ? '#8e8e93' : unhealthy ? '#ff9f0a' : '#30d158';
        const row = new St.BoxLayout({style_class: 'goisland-irow goisland-irow-box', x_expand: true});
        row.add_child(this._badge({icon: 'network-server-symbolic', color}));
        const status = c.status.replace(/\s*\((healthy|unhealthy)\)/, '');
        const health = unhealthy ? 'Unhealthy' : /\(healthy\)/.test(c.status) ? 'Healthy' : '';
        row.add_child(this._rowText(c.name, [health, status, c.image].filter(Boolean).join('  ·  ')).col);
        const chips = new St.BoxLayout({style_class: 'goisland-port-chips', y_align: Clutter.ActorAlign.CENTER});
        for (const p of (c.ports || '').split(', ').filter(Boolean).slice(0, 3))
            chips.add_child(this._portButton(p, 'goisland-port-chip'));
        row.add_child(chips);
        const usage = new St.BoxLayout({...VERTICAL, style_class: 'goisland-usage', y_align: Clutter.ActorAlign.CENTER});
        const refs = {
            cpu: label('goisland-usage-cpu', {x_align: Clutter.ActorAlign.END}),
            mem: label('goisland-usage-mem', {x_align: Clutter.ActorAlign.END}),
        };
        this._setDockerStats(refs, c.stats);
        this._dockerStats.set(c.id, refs);
        usage.add_child(refs.cpu);
        usage.add_child(refs.mem);
        row.add_child(usage);
        const btns = [iconButton('format-justify-left-symbolic', 'goisland-row-btn', () => this._showLogs(c), `Logs of ${c.name}`)];
        for (const [op, icon] of [['restart', 'view-refresh-symbolic'], ['stop', 'media-playback-stop-symbolic']]) {
            btns.push(iconButton(icon, 'goisland-row-btn', () => {
                row.opacity = 128;
                this._ext.call('DockerAction', [c.id, op], () => this._loadDocker());
            }, `${op} ${c.name}`));
        }
        row.add_child(this._hoverActions(row, btns));
        return row;
    }

    // ----- Ports -----

    _buildPortsPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page', ...VERTICAL});
        this._portEntry = new St.Entry({
            style_class: 'goisland-entry',
            hint_text: 'Filter, or type a port and press Enter to free it',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'system-search-symbolic', style_class: 'goisland-entry-icon'}),
        });
        this._portEntry.clutter_text.connect('text-changed', () => this._renderPorts());
        this._portEntry.clutter_text.connect('activate', () => {
            const port = Number(this._portEntry.text.trim().replace(/^:/, ''));
            if (Number.isInteger(port) && port > 0 && port < 65536) {
                this._portEntry.text = '';
                this._freePort(port);
            }
        });
        this._portMsg = label('goisland-empty', {x_align: Clutter.ActorAlign.CENTER, visible: false});
        this._portGroups = new St.BoxLayout({...VERTICAL, style_class: 'goisland-groups'});
        page.add_child(this._portEntry);
        page.add_child(this._portMsg);
        page.add_child(scrollView(this._portGroups));
        this._ports = [];
        return page;
    }

    _loadPorts() {
        this._ext.call('PortsList', [], (res, err) => {
            if (!this._dashOpen || this._tab !== 'ports')
                return;
            this._ports = err ? [] : JSON.parse(res[0]);
            this._renderPorts(err ? 'Could not list ports' : null);
        });
    }

    _renderPorts(error = null) {
        const q = this._portEntry.text.trim().replace(/^:/, '').toLowerCase();
        const items = q
            ? this._ports.filter(l => `${l.port} ${l.process ?? ''} ${l.container ?? ''} ${l.cmd ?? ''}`.toLowerCase().includes(q))
            : this._ports;
        this._message(this._portMsg, error ?? (items.length ? '' : q ? 'No matches. Press Enter to free that port.' : 'Nothing listening'));
        this._portGroups.destroy_all_children();
        const mine = items.filter(l => l.container || l.pid);
        const system = items.filter(l => !(l.container || l.pid));
        for (const [title, list] of [['YOUR APPS & CONTAINERS', mine], ['SYSTEM', system]]) {
            if (!list.length)
                continue;
            const g = this._group(title);
            this._portGroups.add_child(g.actor);
            this._fillList(g.list, list, l => this._makePortRow(l));
        }
    }

    _makePortRow(l) {
        const own = !!(l.container || l.pid);
        const row = new St.BoxLayout({style_class: `goisland-irow goisland-irow-box${own ? '' : ' muted'}`, x_expand: true});
        row.add_child(this._portButton(l.port, 'goisland-port-pill'));
        const title = l.container ?? l.process ?? 'System service';
        const kind = l.container ? 'Container' : l.pid ? `PID ${l.pid}` : '';
        const where = l.addr === '0.0.0.0' || l.addr === '::' ? 'All interfaces' : l.addr === '127.0.0.1' || l.addr === '::1' ? 'Localhost' : l.addr;
        row.add_child(this._rowText(title, [kind, where].filter(Boolean).join('  ·  ')).col);
        if (own) {
            const verb = l.container ? 'Stop' : 'Kill';
            const btn = new St.Button({style_class: 'goisland-pill-btn danger', label: verb, can_focus: true, y_align: Clutter.ActorAlign.CENTER});
            let armed = false;
            btn.connect('clicked', () => {
                if (!armed) { // two-step confirm
                    armed = true;
                    btn.label = 'Sure?';
                    btn.add_style_pseudo_class('armed');
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                        if (armed && btn.get_stage()) {
                            armed = false;
                            btn.label = verb;
                            btn.remove_style_pseudo_class('armed');
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                    return;
                }
                armed = false;
                row.opacity = 128;
                this._freePort(l.port);
            });
            row.add_child(this._hoverActions(row, [btn]));
        }
        return row;
    }

    // A port number that opens http://localhost:PORT when clicked.
    _portButton(port, styleClass) {
        const btn = new St.Button({
            style_class: `goisland-port-btn ${styleClass}`, label: `:${port}`, can_focus: true,
            y_align: Clutter.ActorAlign.CENTER, accessible_name: `Open localhost:${port}`,
        });
        btn.child.x_align = Clutter.ActorAlign.START; // align numbers in the Ports column
        btn.connect('clicked', () => {
            openUri(`http://localhost:${port}`);
            this._closeDash();
        });
        return btn;
    }

    _freePort(port) {
        this._ext.call('PortFree', [port], () => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                if (this._dashOpen && this._tab === 'ports')
                    this._loadPorts();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // ----- Clipboard -----

    _buildClipboardPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page', ...VERTICAL});
        const top = new St.BoxLayout({style_class: 'goisland-toolbar'});
        this._clipFilter = new St.Entry({
            style_class: 'goisland-entry', hint_text: 'Search clipboard history', can_focus: true, x_expand: true,
            primary_icon: new St.Icon({icon_name: 'system-search-symbolic', style_class: 'goisland-entry-icon'}),
        });
        this._clipFilter.clutter_text.connect('text-changed', () => this._renderClipboard());
        this._clipFilter.clutter_text.connect('activate', () => {
            const first = this._filteredClips()[0];
            if (first)
                this._copy(first.text);
        });
        const clear = new St.Button({style_class: 'goisland-pill-btn', label: 'Clear', can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        clear.connect('clicked', () => this._ext.call('ClipboardClear', [], () => this._loadClipboard()));
        top.add_child(this._clipFilter);
        top.add_child(clear);
        this._clipEmpty = this._emptyState();
        this._clipGroups = new St.BoxLayout({...VERTICAL, style_class: 'goisland-groups'});
        this._clipScroll = scrollView(this._clipGroups);
        page.add_child(top);
        page.add_child(this._clipEmpty.actor);
        page.add_child(this._clipScroll);
        return page;
    }

    // ----- Transform (tool sidebar + live conversion) -----

    _buildTransformPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page goisland-xf-page'});

        // Sidebar: tools grouped like a Mac sidebar, each with a glyph badge.
        const side = new St.BoxLayout({style_class: 'goisland-card goisland-xf-side', ...VERTICAL, y_expand: true});
        this._xfRows = {};
        let group = null;
        for (const tool of TOOLS) {
            if (tool.group !== group) {
                group = tool.group;
                side.add_child(label('goisland-group goisland-xf-group', {text: group.toUpperCase()}));
            }
            const box = new St.BoxLayout({style_class: 'goisland-xf-tool-box', x_expand: true});
            const badge = new St.Bin({
                style_class: `goisland-xf-glyph g-${group.toLowerCase()}`, y_align: Clutter.ActorAlign.CENTER,
                child: new St.Label({text: tool.glyph, style_class: 'goisland-xf-glyph-text',
                    x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}),
            });
            box.add_child(badge);
            box.add_child(label('goisland-xf-tool-name', {text: tool.name, x_expand: true}));
            const btn = new St.Button({style_class: 'goisland-xf-tool', can_focus: true, child: box, x_expand: true});
            btn.child.x_align = Clutter.ActorAlign.FILL; // left-aligned like a sidebar, not centred
            btn.connect('clicked', () => this._selectTool(tool.id));
            side.add_child(btn);
            this._xfRows[tool.id] = btn;
        }
        page.add_child(side);

        // Main: title + modes, input, swap, output.
        const main = new St.BoxLayout({style_class: 'goisland-xf-main', ...VERTICAL, x_expand: true, y_expand: true});
        const head = new St.BoxLayout({style_class: 'goisland-xf-head'});
        const titles = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._xfTitle = label('goisland-xf-title');
        this._xfDesc = label('goisland-xf-desc');
        titles.add_child(this._xfTitle);
        titles.add_child(this._xfDesc);
        head.add_child(titles);
        this._xfModes = new St.BoxLayout({style_class: 'goisland-seg', y_align: Clutter.ActorAlign.CENTER});
        head.add_child(this._xfModes);
        main.add_child(head);

        const multiline = (styleClass, hint) => {
            const e = new St.Entry({style_class: styleClass, hint_text: hint, can_focus: true, x_expand: true, y_align: Clutter.ActorAlign.START});
            const ct = e.clutter_text;
            ct.single_line_mode = false;
            ct.activatable = false;
            ct.line_wrap = true;
            ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            return e;
        };
        const pane = (title, child, buttons) => {
            const card = new St.BoxLayout({style_class: 'goisland-card goisland-xf-pane', ...VERTICAL, x_expand: true, y_expand: true});
            const bar = new St.BoxLayout({style_class: 'goisland-xf-pane-bar'});
            const titleLbl = label('goisland-group goisland-xf-pane-title', {text: title});
            titleLbl.clutter_text.ellipsize = Pango.EllipsizeMode.NONE; // letter-spacing isn't measured
            bar.add_child(titleLbl);
            const count = label('goisland-xf-count', {x_expand: true});
            bar.add_child(count);
            for (const b of buttons)
                bar.add_child(b);
            card.add_child(bar);
            const box = new St.BoxLayout({...VERTICAL, x_expand: true});
            box.add_child(child);
            card.add_child(scrollView(box));
            return {card, count};
        };
        const mini = (text, cls, fn) => {
            const b = new St.Button({style_class: `goisland-xf-mini ${cls}`, label: text, can_focus: true, y_align: Clutter.ActorAlign.CENTER});
            b.connect('clicked', fn);
            return b;
        };

        this._xfIn = multiline('goisland-xf-text', 'Type or paste text');
        this._xfIn.clutter_text.connect('text-changed', () => this._scheduleTransform());
        const input = pane('INPUT', this._xfIn, [
            mini('Paste', '', () => this._ext.latestClip(t => t && (this._xfIn.text = t))),
            mini('Clear', '', () => (this._xfIn.text = '')),
        ]);
        this._xfInCount = input.count;
        main.add_child(input.card);

        // Swap: feed the output back in as input (chain tools).
        const swapRow = new St.BoxLayout({style_class: 'goisland-xf-swap-row', x_align: Clutter.ActorAlign.CENTER});
        const swap = iconButton('view-sort-descending-symbolic', 'goisland-xf-swap', () => {
            if (this._xfOk && this._xfResult)
                this._xfIn.text = this._xfResult;
        }, 'Use output as input');
        swapRow.add_child(swap);
        main.add_child(swapRow);

        this._xfOut = new St.Label({style_class: 'goisland-xf-text goisland-xf-out'});
        const oct = this._xfOut.clutter_text;
        oct.line_wrap = true;
        oct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        oct.selectable = true;
        this._xfOut.reactive = true;
        this._xfCopy = mini('Copy', 'accent', () => {
            if (!this._xfOk || !this._xfResult)
                return;
            this._ext.copy(this._xfResult);
            this._xfCopy.label = 'Copied';
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                if (this._xfCopy.get_stage())
                    this._xfCopy.label = 'Copy';
                return GLib.SOURCE_REMOVE;
            });
        });
        const output = pane('OUTPUT', this._xfOut, [this._xfCopy]);
        this._xfOutCount = output.count;
        main.add_child(output.card);
        page.add_child(main);

        this._xfTool = TOOLS[0];
        this._xfMode = 0;
        this._xfTimer = 0;
        this._selectTool(TOOLS[0].id);
        return page;
    }

    _selectTool(id) {
        const tool = TOOLS.find(t => t.id === id) ?? TOOLS[0];
        if (tool !== this._xfTool)
            this._xfMode = 0;
        this._xfTool = tool;
        for (const [tid, btn] of Object.entries(this._xfRows))
            btn.checked = tid === tool.id;
        setText(this._xfTitle, tool.name);
        setText(this._xfDesc, tool.desc);
        this._xfModes.destroy_all_children();
        this._xfModes.visible = tool.modes.length > 1;
        tool.modes.forEach((m, k) => {
            const b = new St.Button({style_class: 'goisland-seg-btn', label: m.name, can_focus: true});
            b.checked = k === this._xfMode;
            b.connect('clicked', () => {
                this._xfMode = k;
                this._xfModes.get_children().forEach((c, j) => (c.checked = j === k));
                this._runTransform();
            });
            this._xfModes.add_child(b);
        });
        this._runTransform();
    }

    _scheduleTransform() {
        if (this._xfTimer)
            GLib.source_remove(this._xfTimer);
        this._xfTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._xfTimer = 0;
            this._runTransform();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Live conversion; errors show inline instead of a result.
    _runTransform() {
        const text = this._xfIn.text;
        const mode = this._xfTool.modes[this._xfMode] ?? this._xfTool.modes[0];
        const count = n => `${n.toLocaleString()} char${n === 1 ? '' : 's'}`;
        setText(this._xfInCount, text ? count(text.length) : '');
        let out = '', ok = true;
        if (text || this._xfTool.id === 'timestamp') {
            try {
                out = mode.fn(text);
            } catch (e) {
                ok = false;
                out = e.message;
            }
        }
        this._xfOk = ok;
        this._xfResult = ok ? out : '';
        const shown = out.length > 20000 ? `${out.slice(0, 20000)}\n… (showing the first 20,000 characters; Copy takes everything)` : out;
        this._xfOut.text = shown || 'The result appears here as you type';
        this._xfOut.style_class = `goisland-xf-text goisland-xf-out${!out ? ' placeholder' : ok ? '' : ' error'}`;
        setText(this._xfOutCount, ok && out ? count(out.length) : '');
        this._xfCopy.reactive = ok && !!out;
        this._xfCopy.opacity = ok && out ? 255 : 110;
    }

    // Pre-fill the input with the latest clipboard text when it's empty.
    _loadTransformInput() {
        if (this._xfIn.text)
            return;
        this._ext.latestClip(text => {
            if (text && !this._xfIn.text)
                this._xfIn.text = text;
        });
    }

    // ----- Notes (Apple Notes style: list + editor) -----

    _buildNotesPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page goisland-notes-page'});

        // Left: search, new note, list
        const side = new St.BoxLayout({style_class: 'goisland-card goisland-notes-side', ...VERTICAL, y_expand: true});
        const top = new St.BoxLayout({style_class: 'goisland-notes-top'});
        this._noteSearch = new St.Entry({
            style_class: 'goisland-entry goisland-notes-search', hint_text: 'Search', can_focus: true, x_expand: true,
            primary_icon: new St.Icon({icon_name: 'system-search-symbolic', style_class: 'goisland-entry-icon'}),
        });
        this._noteSearch.clutter_text.connect('text-changed', () => this._renderNoteList());
        top.add_child(this._noteSearch);
        top.add_child(iconButton('document-new-symbolic', 'goisland-note-new', () => this._newNote(), 'New note'));
        side.add_child(top);
        this._noteList = new St.BoxLayout({...VERTICAL, style_class: 'goisland-note-list'});
        side.add_child(scrollView(this._noteList));
        page.add_child(side);

        // Right: date, pin, delete, editor
        const main = new St.BoxLayout({style_class: 'goisland-card goisland-notes-main', ...VERTICAL, x_expand: true, y_expand: true});
        const bar = new St.BoxLayout({style_class: 'goisland-notes-bar'});
        this._noteDate = label('goisland-note-date', {x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        this._notePinBtn = iconButton('view-pin-symbolic', 'goisland-row-btn', () => this._togglePin(), 'Pin note');
        bar.add_child(this._noteDate);
        bar.add_child(this._notePinBtn);
        bar.add_child(iconButton('user-trash-symbolic', 'goisland-row-btn', () => this._deleteNote(), 'Delete note'));
        main.add_child(bar);
        this._noteEditor = new St.Entry({
            style_class: 'goisland-note-editor', hint_text: 'Start typing…', can_focus: true,
            x_expand: true, y_align: Clutter.ActorAlign.START,
        });
        const ct = this._noteEditor.clutter_text;
        ct.single_line_mode = false;
        ct.activatable = false;
        ct.line_wrap = true;
        ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        ct.connect('text-changed', () => this._onNoteEdited());
        const box = new St.BoxLayout({...VERTICAL, x_expand: true});
        box.add_child(this._noteEditor);
        main.add_child(scrollView(box));
        this._noteEmpty = label('goisland-empty', {text: 'No notes yet. Click the pencil to start one.', x_align: Clutter.ActorAlign.CENTER, visible: false});
        main.add_child(this._noteEmpty);
        page.add_child(main);

        this._notesData = [];
        this._noteId = null;
        this._noteSaveId = 0;
        this._noteRows = new Map();
        return page;
    }

    _loadNotes(selectId = null) {
        if (this._ext.presenting) {
            this._notesData = [];
            this._renderNoteList();
            this._noteEmpty.text = 'Hidden while presenting';
            this._showNote(null);
            return;
        }
        this._ext.call('NotesList', [], (res, err) => {
            this._notesData = err ? [] : JSON.parse(res[0]) ?? [];
            this._noteEmpty.text = err ? 'Daemon not running' : 'No notes yet. Click the pencil to start one.';
            this._renderNoteList();
            const keep = selectId ?? this._noteId;
            const next = this._notesData.find(n => n.id === keep) ?? this._notesData[0] ?? null;
            this._showNote(next);
        });
    }

    _noteTitle(n) {
        const line = (n.text ?? '').split('\n').find(l => l.trim()) ?? '';
        return line.trim().slice(0, 80) || 'New Note';
    }

    _notePreview(n) {
        const lines = (n.text ?? '').split('\n').filter(l => l.trim());
        return (lines[1] ?? 'No additional text').trim().slice(0, 80);
    }

    _noteWhen(ms) {
        const d = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
        const now = GLib.DateTime.new_now_local();
        if (d.format('%F') === now.format('%F'))
            return d.format(this._ext.clock24 ? '%H:%M' : '%l:%M %p').trim();
        if (now.difference(d) < 7 * 24 * 3600 * 1e6)
            return d.format('%A');
        return d.format('%-d %b %Y');
    }

    _renderNoteList() {
        const q = this._noteSearch.text.trim().toLowerCase();
        const notes = q ? this._notesData.filter(n => (n.text ?? '').toLowerCase().includes(q)) : this._notesData;
        const entries = [];
        let section = null;
        for (const n of notes) {
            const sec = n.pinned ? 'PINNED' : 'NOTES';
            if (sec !== section && (n.pinned || notes.some(x => x.pinned))) {
                section = sec;
                entries.push({header: sec});
            }
            entries.push({n});
        }
        this._noteRows = new Map();
        this._fillList(this._noteList, entries, e => {
            if (e.header)
                return label('goisland-group goisland-note-group', {text: e.header});
            const n = e.n;
            const col = new St.BoxLayout({...VERTICAL, x_expand: true});
            const title = label('goisland-note-title', {text: this._noteTitle(n)});
            const meta = new St.BoxLayout({style_class: 'goisland-note-meta'});
            const when = label('goisland-note-when', {text: this._noteWhen(n.updated)});
            const prev = label('goisland-note-preview', {text: this._notePreview(n), x_expand: true});
            meta.add_child(when);
            meta.add_child(prev);
            col.add_child(title);
            col.add_child(meta);
            const row = new St.Button({style_class: 'goisland-note-row', can_focus: true, child: col, x_expand: true});
            if (n.id === this._noteId)
                row.add_style_pseudo_class('checked');
            row.connect('clicked', () => this._showNote(n));
            this._noteRows.set(n.id, {row, title, when, prev});
            return row;
        });
    }

    _showNote(n) {
        this._flushNoteSave();
        // Like Apple Notes: leaving an empty note deletes it.
        const prev = this._notesData.find(x => x.id === this._noteId);
        if (prev && !prev.text.trim() && prev.id !== n?.id) {
            this._ext.call('NoteDelete', [prev.id]);
            this._notesData = this._notesData.filter(x => x.id !== prev.id);
            this._noteRows.get(prev.id)?.row.destroy();
            this._noteRows.delete(prev.id);
        }
        for (const [id, r] of this._noteRows) {
            if (id === n?.id)
                r.row.add_style_pseudo_class('checked');
            else
                r.row.remove_style_pseudo_class('checked');
        }
        this._noteId = n?.id ?? null;
        this._noteLoading = true;
        this._noteEditor.text = n?.text ?? '';
        this._noteLoading = false;
        this._noteEditor.visible = !!n;
        this._noteEmpty.visible = !n;
        this._notePinBtn.visible = !!n;
        if (this._notePinBtn.visible) {
            if (n.pinned)
                this._notePinBtn.add_style_class_name('pinned');
            else
                this._notePinBtn.remove_style_class_name('pinned');
        }
        const d = n ? GLib.DateTime.new_from_unix_local(Math.floor(n.updated / 1000)) : null;
        this._noteDate.text = d ? d.format('%-d %B %Y at %H:%M') : '';
    }

    _onNoteEdited() {
        if (this._noteLoading || this._noteId === null)
            return;
        const n = this._notesData.find(x => x.id === this._noteId);
        if (!n)
            return;
        n.text = this._noteEditor.text;
        n.updated = Date.now();
        const r = this._noteRows.get(n.id);
        if (r) { // live-update the list row in place
            setText(r.title, this._noteTitle(n));
            setText(r.prev, this._notePreview(n));
            setText(r.when, this._noteWhen(n.updated));
        }
        if (this._noteSaveId)
            GLib.source_remove(this._noteSaveId);
        this._noteSaveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._noteSaveId = 0;
            this._ext.call('NoteSave', [n.id, n.text]);
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushNoteSave() {
        if (!this._noteSaveId)
            return;
        GLib.source_remove(this._noteSaveId);
        this._noteSaveId = 0;
        const n = this._notesData.find(x => x.id === this._noteId);
        if (n)
            this._ext.call('NoteSave', [n.id, n.text]);
    }

    _newNote() {
        this._flushNoteSave();
        this._ext.call('NoteCreate', [], (res, err) => {
            if (err)
                return;
            const n = JSON.parse(res[0]);
            this._noteSearch.text = '';
            this._loadNotes(n.id);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                this._noteEditor.grab_key_focus();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _togglePin() {
        const n = this._notesData.find(x => x.id === this._noteId);
        if (n)
            this._ext.call('NotePin', [n.id, !n.pinned], () => this._loadNotes(n.id));
    }

    _deleteNote() {
        const id = this._noteId;
        if (id === null)
            return;
        if (this._noteSaveId) {
            GLib.source_remove(this._noteSaveId);
            this._noteSaveId = 0;
        }
        const idx = this._notesData.findIndex(x => x.id === id);
        const next = this._notesData[idx + 1] ?? this._notesData[idx - 1] ?? null;
        this._noteId = null;
        this._ext.call('NoteDelete', [id], () => this._loadNotes(next?.id ?? null));
    }

    // ----- Notifications inbox -----

    _buildInboxPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page', ...VERTICAL});
        const bar = new St.BoxLayout({style_class: 'goisland-toolbar goisland-inbox-bar'});
        this._inboxCount = label('goisland-inbox-count', {x_expand: true});
        const clear = new St.Button({style_class: 'goisland-pill-btn', label: 'Clear all', can_focus: true});
        clear.connect('clicked', () => this._ext.call('InboxClear', [], () => this._loadInbox()));
        bar.add_child(this._inboxCount);
        bar.add_child(clear);
        page.add_child(bar);
        this._inboxEmpty = this._emptyState();
        this._inboxList = new St.BoxLayout({...VERTICAL, style_class: 'goisland-ncards'});
        this._inboxScroll = scrollView(this._inboxList);
        page.add_child(this._inboxEmpty.actor);
        page.add_child(this._inboxScroll);
        return page;
    }

    _loadInbox() {
        this.setUnread(false);
        if (this._ext.presenting) {
            this._inboxList.destroy_all_children();
            this._inboxScroll.hide();
            setText(this._inboxCount, '');
            this._inboxEmpty.show({icon: 'preferences-system-notifications-symbolic', title: 'Hidden while presenting'});
            return;
        }
        this._ext.call('InboxList', [], (res, err) => {
            if (!this._dashOpen || this._tab !== 'inbox')
                return;
            const items = err ? [] : JSON.parse(res[0]);
            setText(this._inboxCount, items.length ? `${items.length} notification${items.length === 1 ? '' : 's'}` : '');
            if (!items.length) {
                this._inboxSig = null;
                this._inboxList.destroy_all_children();
                this._inboxScroll.hide();
                this._inboxEmpty.show({icon: 'preferences-system-notifications-symbolic', title: "You're all caught up",
                    hint: err ? 'Daemon not running' : 'Notifications from your apps collect here'});
                return;
            }
            this._inboxEmpty.hide();
            this._inboxScroll.show();
            this._renderInbox(items);
        });
    }

    _renderInbox(items) {
        const sig = items.map(i => i.id).join(',');
        if (sig === this._inboxSig && this._inboxWhen) {
            items.forEach((it, k) => this._inboxWhen[k] && setText(this._inboxWhen[k], ago(it.at)));
            return;
        }
        this._inboxSig = sig;
        this._inboxWhen = [];
        this._fillList(this._inboxList, items, (it, k) => {
            const card = new St.Button({style_class: 'goisland-ncard', can_focus: true, x_expand: true});
            const box = new St.BoxLayout({style_class: 'goisland-ncard-box', x_expand: true});
            box.add_child(this._appBadge(it.app, it.desktopEntry));
            const col = new St.BoxLayout({...VERTICAL, x_expand: true});
            const head = new St.BoxLayout({style_class: 'goisland-ncard-head'});
            const app = label('goisland-ncard-app', {text: (it.app || 'App').toUpperCase(), x_expand: true});
            app.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            head.add_child(app);
            const when = label('goisland-ncard-when', {text: ago(it.at)});
            this._inboxWhen[k] = when;
            head.add_child(when);
            head.add_child(this._hoverActions(card, [iconButton('window-close-symbolic', 'goisland-row-btn small', () =>
                this._ext.call('InboxRemove', [it.id], () => this._loadInbox()), 'Dismiss')]));
            col.add_child(head);
            col.add_child(label('goisland-ncard-title', {text: it.title}));
            if (it.body) {
                const body = new St.Label({style_class: 'goisland-ncard-body', text: it.body.slice(0, 280)});
                body.clutter_text.line_wrap = true;
                body.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                col.add_child(body);
            }
            box.add_child(col);
            card.child = box;
            card.connect('clicked', () => {
                this._ext.activateNotification({title: it.title, subtitle: it.body, app: it.app, desktopEntry: it.desktopEntry});
                this._ext.call('InboxRemove', [it.id]);
                this._closeDash();
            });
            return card;
        });
    }

    // Unread dot on the Notifications tab icon.
    setUnread(on) {
        const dot = this._tabDots?.inbox;
        if (dot)
            dot.visible = on && !(this._dashOpen && this._tab === 'inbox');
    }

    // ----- QR -----

    _buildQRPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page goisland-qr-page', ...VERTICAL});
        const card = new St.BoxLayout({style_class: 'goisland-card goisland-qr-card', x_expand: true, y_expand: true});
        this._qrImg = new St.Bin({style_class: 'goisland-qr-img', y_align: Clutter.ActorAlign.CENTER});
        const col = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'goisland-qr-info'});
        col.add_child(label('goisland-group', {text: 'SCAN WITH YOUR PHONE'}));
        this._qrText = new St.Label({style_class: 'goisland-qr-text'});
        this._qrText.clutter_text.line_wrap = true;
        this._qrText.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._qrText.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        col.add_child(this._qrText);
        const back = new St.Button({style_class: 'goisland-pill-btn', label: 'Back', can_focus: true, x_align: Clutter.ActorAlign.START});
        back.connect('clicked', () => this._showTab(this._qrReturn ?? 'clipboard'));
        col.add_child(back);
        card.add_child(this._qrImg);
        card.add_child(col);
        page.add_child(card);
        return page;
    }

    _showQR(text) {
        this._ext.call('QR', [text], (res, err) => {
            if (err || !this._dashOpen)
                return;
            this._qrReturn = this._tab;
            this._qrImg.style = `background-image: url("file://${encodeURI(res[0])}");`;
            this._qrText.text = text.length > 400 ? `${text.slice(0, 400)}…` : text;
            this._showTab('qr');
        });
    }

    _loadClipboard() {
        this._ext.call('ClipboardList', [], (res, err) => {
            this._clipItems = err ? [] : JSON.parse(res[0]) ?? [];
            this._renderClipboard(err ? 'Daemon not running' : null);
        });
    }

    _filteredClips() {
        const q = this._clipFilter.text.trim().toLowerCase();
        return q ? this._clipItems.filter(it => it.text.toLowerCase().includes(q)) : this._clipItems;
    }

    _renderClipboard(error = null) {
        const items = this._filteredClips();
        this._clipGroups.destroy_all_children();
        let empty = null;
        if (this._ext.presenting)
            empty = {icon: 'edit-paste-symbolic', title: 'Hidden while presenting'};
        else if (error)
            empty = {icon: 'dialog-warning-symbolic', title: error};
        else if (!this._clipItems.length)
            empty = {icon: 'edit-paste-symbolic', title: 'Nothing copied yet', hint: 'Copy text anywhere and it shows up here'};
        else if (!items.length)
            empty = {icon: 'system-search-symbolic', title: 'No matches'};
        this._clipScroll.visible = !empty;
        if (empty) {
            this._clipEmpty.show(empty);
            return;
        }
        this._clipEmpty.hide();
        const shown = items.slice(0, 50);
        const pinned = shown.filter(i => i.pinned), recent = shown.filter(i => !i.pinned);
        for (const [title, list] of [['PINNED', pinned], ['RECENT', recent]]) {
            if (!list.length)
                continue;
            const g = this._group(title);
            this._clipGroups.add_child(g.actor);
            this._fillList(g.list, list, it => this._makeClipRow(it));
        }
    }

    _makeClipRow(it) {
        const kind = clipKind(it.text);
        const row = new St.Button({style_class: 'goisland-irow', can_focus: true, x_expand: true});
        const box = new St.BoxLayout({style_class: 'goisland-irow-box', x_expand: true});
        box.add_child(this._badge(kind.badge));
        const first = it.text.trim().split('\n')[0].slice(0, 200);
        box.add_child(this._rowText(first, `${kind.label}  ·  ${ago(it.at)}`, {monoTitle: kind.mono}).col);
        box.add_child(this._hoverActions(row, [
            iconButton('view-app-grid-symbolic', 'goisland-row-btn', () => this._showQR(it.text), 'Show as QR code'),
            iconButton('view-pin-symbolic', `goisland-row-btn${it.pinned ? ' pinned' : ''}`,
                () => this._ext.call('ClipboardPin', [it.id, !it.pinned], () => this._loadClipboard()), it.pinned ? 'Unpin' : 'Pin'),
            iconButton('user-trash-symbolic', 'goisland-row-btn',
                () => this._ext.call('ClipboardDelete', [it.id], () => this._loadClipboard()), 'Delete'),
        ]));
        row.child = box;
        row.connect('clicked', () => this._copy(it.text));
        return row;
    }

    _copy(text) {
        this._ext.copy(text);
        this._closeDash();
    }

    // ----- Web: search + saved sites -----

    _buildSearchPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page goisland-web', ...VERTICAL});
        this._searchEntry = new St.Entry({
            style_class: 'goisland-entry goisland-search-entry',
            hint_text: 'Search Google or enter an address',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'system-search-symbolic', style_class: 'goisland-entry-icon'}),
        });
        this._searchEntry.clutter_text.connect('text-changed', () => this._updateCalc());
        this._searchEntry.clutter_text.connect('activate', () => {
            const q = this._searchEntry.text.trim();
            if (!q)
                return;
            if (this._calcValue !== null) { // a calculation: copy the result
                this._ext.copy(this._calcValue);
                this._calcHint.text = 'Copied';
                return;
            }
            const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(q);
            const looksLikeHost = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(q) || /^localhost(:\d+)?(\/\S*)?$/.test(q);
            let uri = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
            if (hasScheme)
                uri = q;
            else if (looksLikeHost)
                uri = q.startsWith('localhost') ? `http://${q}` : `https://${q}`;
            openUri(uri);
            this._searchEntry.text = '';
            this._closeDash();
        });
        const searchRow = new St.BoxLayout({style_class: 'goisland-toolbar'});
        searchRow.add_child(this._searchEntry);
        const qrBtn = iconButton('view-app-grid-symbolic', 'goisland-pill-btn goisland-icon-btn', () => {
            const q = this._searchEntry.text.trim();
            if (q)
                this._showQR(q);
            else
                this._ext.latestClip(t => t && this._showQR(t.trim()));
        }, 'QR code of this text (or the clipboard)');
        qrBtn.y_align = Clutter.ActorAlign.FILL;
        searchRow.add_child(qrBtn);
        page.add_child(searchRow);

        this._calcRow = new St.BoxLayout({style_class: 'goisland-calc', visible: false});
        this._calcResult = label('goisland-calc-result', {x_expand: true});
        this._calcHint = label('goisland-hint', {text: 'Enter to copy'});
        this._calcRow.add_child(this._calcResult);
        this._calcRow.add_child(this._calcHint);
        this._calcValue = null;
        page.add_child(this._calcRow);

        const card = new St.BoxLayout({style_class: 'goisland-card goisland-sites-card', ...VERTICAL, x_expand: true});
        const head = new St.BoxLayout({style_class: 'goisland-section-head'});
        head.add_child(label('goisland-group', {text: 'FAVORITES', x_expand: true}));
        head.add_child(label('goisland-hint', {text: 'Right-click to remove'}));
        card.add_child(head);

        this._addRow = new St.BoxLayout({style_class: 'goisland-add-row', visible: false});
        this._addUrl = new St.Entry({style_class: 'goisland-entry', hint_text: 'example.com', can_focus: true, x_expand: true});
        this._addName = new St.Entry({style_class: 'goisland-entry goisland-add-name', hint_text: 'Name (optional)', can_focus: true});
        const save = new St.Button({style_class: 'goisland-pill-btn primary', label: 'Save', can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        const submit = () => {
            const url = this._addUrl.text.trim();
            if (!url)
                return;
            this._ext.call('SiteAdd', [url, this._addName.text.trim()], (_r, err) => {
                if (err) {
                    this._addUrl.add_style_pseudo_class('error');
                    return;
                }
                this._addUrl.remove_style_pseudo_class('error');
                this._addUrl.text = this._addName.text = '';
                this._addRow.hide();
                this._loadSites();
                // The daemon fetches the icon in the background; pick it up shortly.
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
                    if (this._dashOpen && this._tab === 'search')
                        this._loadSites();
                    return GLib.SOURCE_REMOVE;
                });
            });
        };
        this._addUrl.clutter_text.connect('activate', submit);
        this._addName.clutter_text.connect('activate', submit);
        save.connect('clicked', submit);
        for (const a of [this._addUrl, this._addName, save])
            this._addRow.add_child(a);
        card.add_child(this._addRow);

        this._siteGrid = new St.BoxLayout({...VERTICAL, style_class: 'goisland-site-grid'});
        card.add_child(scrollView(this._siteGrid));
        page.add_child(card);
        this._sites = [];
        return page;
    }

    _updateCalc() {
        const v = calc(this._searchEntry.text);
        this._calcValue = v === null ? null : formatNumber(v);
        if (this._calcRow.visible !== (v !== null)) {
            this._calcRow.visible = v !== null;
            this._refit();
        }
        if (v !== null) {
            this._calcResult.text = `= ${this._calcValue}`;
            this._calcHint.text = 'Enter to copy';
        }
    }

    _loadSites() {
        this._ext.call('SitesList', [], (res, err) => {
            this._sites = err ? [] : JSON.parse(res[0]) ?? [];
            this._renderSites();
        });
    }

    _renderSites() {
        this._siteGrid.destroy_all_children();
        const tiles = this._sites.map(site => this._siteTile(site));
        tiles.push(this._addTile());
        for (let i = 0; i < tiles.length; i += SITE_COLS) {
            const row = new St.BoxLayout({style_class: 'goisland-site-row'});
            tiles.slice(i, i + SITE_COLS).forEach(t => row.add_child(t));
            this._siteGrid.add_child(row);
        }
        this._refit(); // the favourites arrived after the sheet was sized
    }

    _tile(iconActor, name, styleClass = '') {
        const box = new St.BoxLayout({...VERTICAL, style_class: 'goisland-site-box'});
        const frame = new St.Widget({
            style_class: `goisland-site-icon ${styleClass}`,
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
        });
        frame.add_child(iconActor);
        box.add_child(frame);
        box.add_child(label('goisland-site-name', {text: name, x_align: Clutter.ActorAlign.CENTER}));
        return [new St.Button({
            style_class: 'goisland-site', child: box, can_focus: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
        }), frame];
    }

    _siteTile(site) {
        let icon;
        if (site.icon) {
            icon = new St.Bin({style_class: 'goisland-site-img', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            icon.style = `background-image: url("file://${encodeURI(site.icon)}");`;
        } else {
            icon = new St.Label({
                text: (site.name[0] ?? '?').toUpperCase(), style_class: 'goisland-site-letter',
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            });
        }
        const [btn, frame] = this._tile(icon, site.name);
        if (!site.icon) {
            const hash = [...site.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
            frame.style = `background-color: ${TILE_COLORS[hash % TILE_COLORS.length]};`;
        }
        btn.accessible_name = site.name;
        btn.connect('clicked', (_b, button) => {
            if (button === Clutter.BUTTON_SECONDARY) {
                this._ext.call('SiteRemove', [site.id], () => this._loadSites());
                return;
            }
            openUri(site.url);
            this._closeDash();
        });
        return btn;
    }

    _addTile() {
        const [btn] = this._tile(new St.Icon({icon_name: 'list-add-symbolic', style_class: 'goisland-site-add-icon',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}), 'Add site', 'add');
        btn.accessible_name = 'Add site';
        btn.connect('clicked', () => {
            this._addRow.visible = !this._addRow.visible;
            this._refit();
            if (this._addRow.visible)
                this._addUrl.grab_key_focus();
        });
        return btn;
    }

    // ---------- state ----------

    setState(state) {
        const prev = this._state;
        const raw = state ?? IDLE;
        this._raw = raw;
        const k = raw.kind;
        if (k === 'media')
            this._media = raw;
        else if (k === 'idle')
            this._media = null;
        // A running timer outranks media, so seeing media/idle means no timer.
        if (k === 'timer')
            this._timer = raw;
        else if (k === 'idle' || k === 'media')
            this._timer = null;
        // With "Music in the pill" off, the pill stays on the clock (Home
        // still has the Now Playing card).
        this._state = k === 'media' && !featureOn(this._settings, 'mediaPill') ? IDLE : raw;
        if (raw.mirror && raw !== prev && !(this._dashOpen && this._tab === 'inbox'))
            this.setUnread(true);
        this._react(prev);
        this._render(prev);
    }

    // ---------- settings ----------

    applySettings(st) {
        this._settings = st;
        for (const c of [...(this.style_class ?? '').split(' ')]) {
            if (c.startsWith('theme-') || c.startsWith('surface-'))
                this.remove_style_class_name(c);
        }
        this.add_style_class_name(`theme-${st.accent ?? 'blue'}`);
        this.add_style_class_name(`surface-${st.surface ?? 'black'}`);

        for (const [id] of TABS)
            this._tabButtons[id].visible = tabOn(st, id);
        this._dockerRow.row.visible = tabOn(st, 'docker');
        if (this._dashOpen && this._selectedTab && !tabOn(st, this._selectedTab))
            this._showTab('home');
        else if (this._selectedTab)
            this._runIndicator();

        this._syncSettingsPage();
        this.setState(this._raw ?? IDLE); // re-evaluate face / music pill
    }

    _buildSettingsPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page', ...VERTICAL});
        const box = new St.BoxLayout({...VERTICAL, style_class: 'goisland-settings'});
        this._settingControls = [];

        // Appearance
        const look = this._settingsCard(box, 'APPEARANCE');
        const accentRow = this._settingsRow(look, 'Accent colour', null, 'applications-graphics-symbolic');
        const swatches = new St.BoxLayout({style_class: 'goisland-swatches', y_align: Clutter.ActorAlign.CENTER});
        for (const [name, hex] of Object.entries(ACCENT_COLORS)) {
            const dot = new St.Widget({style_class: 'goisland-swatch-dot', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            dot.set_style(`background-color: ${hex};`);
            const btn = new St.Button({style_class: 'goisland-swatch', can_focus: true, accessible_name: name, child: dot});
            btn.connect('clicked', () => this._ext.updateSettings({accent: name}));
            swatches.add_child(btn);
            this._settingControls.push(st => (btn.checked = (st.accent ?? 'blue') === name));
        }
        accentRow.add_child(swatches);
        const surfaceRow = this._settingsRow(look, 'Surface', null, 'weather-clear-night-symbolic');
        const seg = new St.BoxLayout({style_class: 'goisland-seg', y_align: Clutter.ActorAlign.CENTER});
        for (const [id, name] of SURFACES) {
            const btn = new St.Button({style_class: 'goisland-seg-btn', label: name, can_focus: true});
            btn.connect('clicked', () => this._ext.updateSettings({surface: id}));
            seg.add_child(btn);
            this._settingControls.push(st => (btn.checked = (st.surface ?? 'black') === id));
        }
        surfaceRow.add_child(seg);

        // Tabs
        const tabs = this._settingsCard(box, 'TABS');
        const home = this._settingsRow(tabs, 'Home', 'Always shown', 'user-home-symbolic');
        home.add_child(label('goisland-setting-locked', {text: 'Always on'}));
        for (const [id, name, icon] of TABS.filter(([tid]) => tid !== 'home'))
            this._settingsToggle(tabs, name, null, icon, st => tabOn(st, id), on => ({tabs: {[id]: on}}));

        // Features
        const feats = this._settingsCard(box, 'FEATURES');
        for (const [key, name, desc, icon] of FEATURES)
            this._settingsToggle(feats, name, desc, icon, st => featureOn(st, key), on => ({features: {[key]: on}}));

        page.add_child(scrollView(box));
        return page;
    }

    _settingsCard(parent, title) {
        const g = this._group(title);
        parent.add_child(g.actor);
        return g.list;
    }

    _settingsRow(card, title, desc, icon = null) {
        const row = new St.BoxLayout({style_class: 'goisland-irow goisland-irow-box', x_expand: true});
        if (icon)
            row.add_child(this._badge({icon, color: SETTING_COLORS[icon] ?? '#636366'}));
        row.add_child(this._rowText(title, desc).col);
        card.add_child(row);
        return row;
    }

    _settingsToggle(card, title, desc, icon, get, patch) {
        const row = new St.Button({style_class: 'goisland-irow', can_focus: true, x_expand: true});
        const inner = new St.BoxLayout({style_class: 'goisland-irow-box', x_expand: true});
        if (icon)
            inner.add_child(this._badge({icon, color: SETTING_COLORS[icon] ?? '#636366'}));
        inner.add_child(this._rowText(title, desc).col);
        const sw = new Toggle(true);
        inner.add_child(sw.actor);
        row.child = inner;
        row.connect('clicked', () => {
            sw.toggle(); // instant feedback; the daemon's reply confirms it
            this._ext.updateSettings(patch(sw.state));
        });
        card.add_child(row);
        this._settingControls.push(st => sw.set(get(st), true));
    }

    _syncSettingsPage() {
        const st = this._settings ?? DEFAULT_SETTINGS;
        for (const sync of this._settingControls ?? [])
            sync(st);
    }

    // Called instead of GNOME's OSD popup (volume, brightness, mic…).
    showOsd(gicon, label, level, maxLevel) {
        const hadOsd = !!this._osd;
        this._osd = {gicon, label, level, maxLevel};
        if (this._osdTimer)
            GLib.source_remove(this._osdTimer);
        this._osdTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OSD_MS, () => {
            this._osdTimer = 0;
            this._osd = null;
            this._render(this._state);
            return GLib.SOURCE_REMOVE;
        });
        if (hadOsd && this._mode === 'osd')
            this._apply(); // just move the bar
        else
            this._render(this._state);
    }

    _syncOsdFill() {
        const o = this._osd;
        if (!o || o.level === null || o.level === undefined)
            return;
        const w = this._osdTrack.width;
        if (w > 0)
            this._osdFill.set_size(Math.round(w * Math.max(0, Math.min(1, o.level))), this._osdTrack.height);
    }

    _targetMode() {
        const s = this._state;
        if (this._dashOpen)
            return 'dashboard';
        if (this._osd)
            return 'osd';
        if (s.kind === 'idle')
            return 'idle';
        if (s.kind === 'media')
            return 'compact';
        // Long-lived activity stays slim; hover to see the detail line.
        if (LIVE_KINDS.has(s.kind) && !s.accent)
            return this._hoverExpanded && s.subtitle ? 'notify' : 'compact';
        return s.subtitle ? 'notify' : 'compact';
    }

    _render(prev) {
        const s = this._state;
        if (!this._shown) {
            this._apply();
            this._show();
            return;
        }
        const mode = this._targetMode();
        const structural = mode !== this._mode ||
            (mode !== 'dashboard' && (prev.kind !== s.kind || prev.title !== s.title || prev.art !== s.art));
        if (!structural) {
            this._apply();
            this.relayout(true);
            return;
        }

        const gen = ++this._morphGen;
        const leaving = this._mode === 'dashboard' ? this._dash : this._content;
        leaving.remove_all_transitions();
        const morph = () => {
            if (!this._wallClock || gen !== this._morphGen)
                return; // destroyed or superseded
            this._apply();
            const entering = this._mode === 'dashboard' ? this._dash : this._content;
            entering.remove_all_transitions();
            entering.opacity = 0;
            this.relayout(true);
            entering.ease({
                opacity: 255,
                delay: REVEAL_DELAY_MS,
                duration: FADE_IN_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        };
        // The small pill content just disappears (it's tiny and about to be
        // replaced); the big dashboard gets a very short fade.
        if (leaving === this._dash && leaving.opacity > 0) {
            leaving.ease({
                opacity: 0,
                duration: FADE_OUT_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: morph,
            });
        } else {
            leaving.opacity = 0;
            morph();
        }
    }

    // Push state into widgets (no animation).
    _apply() {
        const s = this._state;
        const mode = this._targetMode();
        this._mode = mode;
        for (const m of MODES)
            this.remove_style_class_name(m);
        this.add_style_class_name(mode);
        for (const a of ACCENTS)
            this.remove_style_class_name(`accent-${a}`);
        if (mode !== 'dashboard' && ACCENTS.includes(s.accent))
            this.add_style_class_name(`accent-${s.accent}`);
        this.ensure_style();

        this._dash.visible = mode === 'dashboard';
        this._content.visible = mode !== 'dashboard';

        const priv = this._ext.presenting;
        const masked = priv && (s.kind === 'media' || LIVE_KINDS.has(s.kind));
        this._title.text = priv && s.kind === 'media' ? 'Now playing' : s.title ?? '';
        this._title.visible = mode !== 'idle';
        this._subtitle.text = s.subtitle ?? '';
        this._subtitle.visible = mode === 'notify' && !!s.subtitle && !masked;
        this._face.actor.visible = mode === 'idle' && featureOn(this._settings, 'face');
        this._art.style = null;
        if (mode === 'idle') {
            this._art.hide();
            this._icon.hide();
        } else if (s.swatch) {
            this._art.style = `background-color: ${s.swatch};`;
            this._art.show();
            this._icon.hide();
        } else if (s.art && !priv) {
            this._art.style = `background-image: url("file://${encodeURI(s.art)}");`;
            this._art.show();
            this._icon.hide();
        } else {
            this._art.hide();
            if (s.icon === 'agent')
                this._icon.gicon = this._ext.agentIcon;
            else
                this._icon.icon_name = s.icon || 'dialog-information-symbolic';
            this._icon.show();
        }
        const o = mode === 'osd' ? this._osd : null;
        const hasLevel = o && o.level !== null && o.level !== undefined;
        this._osdTrack.visible = !!hasLevel;
        this._textBox.visible = !hasLevel; // the bar takes the full width
        if (o) {
            this._art.hide();
            this._icon.gicon = o.gicon;
            this._icon.show();
            this._title.text = o.label ?? '';
            this._title.visible = !hasLevel && !!o.label;
            this._syncOsdFill();
        }
        this._pillEq.actor.visible = s.kind === 'media' && mode === 'compact';
        this._pillEq.running = this._pillEq.actor.visible && !!s.playing;

        this._applyHome();
        this._tick();
        this._syncTicker();
    }

    _applyHome() {
        const m = this._media;
        const priv = this._ext.presenting;
        this._presentBadge.visible = priv;
        this._spyBtn.checked = priv;
        this._mTitle.text = m ? priv ? 'Now playing' : m.title ?? '' : 'Not playing';
        this._mSub.text = m ? priv ? 'Hidden while presenting' : m.subtitle ?? '' : 'Start music in any player';
        this._mArt.visible = !!m?.art && !priv;
        if (m?.art)
            this._mArt.style = `background-image: url("file://${encodeURI(m.art)}");`;
        this._mEq.actor.visible = !!m;
        this._mEq.running = !!m?.playing && this._dashOpen;
        this._progress.visible = !!m?.timing;
        this._controls.reactive = !!m;
        this._controls.opacity = m ? 255 : 90;
        this._playBtn.child.icon_name = m?.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';

        const now = GLib.DateTime.new_now_local();
        this._todayDate.text = now.format('%a, %-d %b').toUpperCase();
        const h = now.get_hour();
        this._todayTitle.text = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
        this._focusRow.btn.label = this._timer ? 'Stop' : 'Start';
    }

    // Live parts: clock, countdown/elapsed, media progress, focus timer.
    _tick() {
        if (!this._wallClock)
            return;
        const s = this._state;
        const now = Date.now();
        let trailing = '';
        if (this._mode === 'osd') {
            const o = this._osd;
            trailing = o?.level !== null && o?.level !== undefined ? `${Math.round(o.level * 100)}%` : '';
        } else if (this._mode === 'idle')
            trailing = this._wallClock.clock;
        else if (s.endsAt)
            trailing = fmtClock((s.endsAt - now) / 1000);
        else if (s.startedAt)
            trailing = fmtClock((now - s.startedAt) / 1000);
        else if (s.trailing)
            trailing = s.trailing;
        else if (s.kind === 'media')
            trailing = this._shortTime();
        this._trailing.text = trailing;
        this._trailing.visible = trailing !== '';

        if (!this._dashOpen)
            return;
        this._dashClock.text = this._wallClock.clock;
        this._focusRow.sub.text = this._timer
            ? `${this._timer.title} · ${fmtClock((this._timer.endsAt - now) / 1000)} left`
            : '25 min of deep work';

        const m = this._media;
        const t = m?.timing;
        if (t && this._tab === 'home') {
            const elapsed = m.playing ? (now - t.at) / 1000 * (t.rate || 1) : 0;
            const pos = Math.min(t.length, Math.max(0, t.position + elapsed));
            this._posLabel.text = fmtClock(pos);
            this._remLabel.text = `-${fmtClock(t.length - pos)}`;
            const w = this._track.width;
            if (w > 0)
                this._fill.set_size(Math.round(w * (t.length ? pos / t.length : 0)), this._track.height);
        }
    }

    _shortTime() {
        const fmt = this._interface.get_string('clock-format') === '12h' ? '%l:%M' : '%H:%M';
        return GLib.DateTime.new_now_local().format(fmt).trim();
    }

    _syncTicker() {
        const s = this._state;
        const needed = !!(s.endsAt || s.startedAt ||
            (this._dashOpen && this._tab === 'home' && (this._media?.playing || this._timer)));
        if (needed && !this._tickId) {
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
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

    // ---------- input ----------

    _onClick(event) {
        // The press that closed the dashboard (outside click) was delivered
        // to the island during the grab, so Clutter sends its release here
        // too. Swallow it, or it would reopen the dashboard immediately.
        if (this._swallowRelease && Date.now() - this._swallowRelease < 1500) {
            this._swallowRelease = 0;
            return Clutter.EVENT_STOP;
        }
        this._swallowRelease = 0;
        const button = event.get_button();
        if (this._dashOpen)
            return Clutter.EVENT_STOP; // clicks on dashboard background do nothing
        if (button === Clutter.BUTTON_SECONDARY) {
            Main.panel.statusArea.dateMenu?.menu.toggle();
            return Clutter.EVENT_STOP;
        }
        if (button === Clutter.BUTTON_MIDDLE) {
            this.wobble();
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const s = this._state;
        // A working agent opens the Agents tab (its terminal is usually
        // already focused); approvals and results jump to the terminal.
        if (s.kind === 'agent' && !s.accent) {
            this.openDash('agents');
            return Clutter.EVENT_STOP;
        }
        // A mirrored app notification behaves like GNOME's banner: open
        // the app (Discord jumps to the message), then dismiss.
        if (s.mirror) {
            this._ext.activateNotification(s);
            this._ext.action('notify.dismiss');
            return Clutter.EVENT_STOP;
        }
        // A dev server with a port opens in the browser.
        if (s.url) {
            openUri(s.url);
            return Clutter.EVENT_STOP;
        }
        // Context-aware items (builds, services, agent popups) jump to their window.
        if (s.focus?.length && focusPids(s.focus)) {
            if (s.click)
                this._ext.action(s.click);
            return Clutter.EVENT_STOP;
        }
        if (s.kind !== 'media' && s.kind !== 'timer' && s.click) // e.g. dismiss a notification
            this._ext.action(s.click);
        else
            this.openDash({agent: 'agents', task: 'activity', service: 'activity'}[s.kind] ?? 'home');
        return Clutter.EVENT_STOP;
    }

    // While the dashboard holds the grab, close it on Escape or an outside click.
    _onCapturedEvent(event) {
        if (!this._dashOpen)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            this._closeDash();
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            const target = global.stage.get_event_actor(event);
            if (!target || !this.contains(target)) {
                this._swallowRelease = Date.now(); // see _onClick
                this._closeDash();
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // ---------- dashboard ----------

    // From `island open [tab]` (bind it to a keyboard shortcut).
    toggleDash(tab) {
        tab = TAB_ALIASES[tab] ?? tab;
        const valid = TABS.some(([id]) => id === tab) || tab === 'settings';
        if (this._dashOpen) {
            if (valid && tab !== this._tab)
                this._showTab(tab);
            else
                this._closeDash();
            return;
        }
        this.openDash(valid ? tab : 'home');
    }

    openDash(tab, retried = false) {
        if (this._dashOpen)
            return;
        // Like GNOME's own menus (GrabHelper): only open with a complete
        // grab. With keyboard-only, X11 sends outside clicks straight to the
        // windows underneath and the dashboard could never be dismissed.
        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        if (this._grab.get_seat_state() !== Clutter.GrabState.ALL) {
            Main.popModal(this._grab); // something else holds input (a menu, a drag)
            this._grab = null;
            if (!retried) // e.g. a keyboard shortcut still being released
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                    this.openDash(tab, true);
                    return GLib.SOURCE_REMOVE;
                });
            return;
        }
        this._dashOpen = true;
        this._tab = tab; // so the morph targets the right size
        this._render(this._state);
        this._showTab(tab);
    }

    _closeDash(render = true) {
        if (!this._dashOpen)
            return;
        this._flushNoteSave?.();
        this._dashOpen = false;
        this._mEq.running = false;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._stopDocker();
        if (render)
            this._render(this._state);
    }

    _showTab(id) {
        this._tab = id;
        for (const [tid, btn] of Object.entries(this._tabButtons))
            btn.checked = tid === id;
        for (const [pid, page] of Object.entries(this._pages))
            page.visible = pid === id;
        // Sub-pages keep their parent tab selected and name themselves.
        // Sub-pages keep their parent tab highlighted; Settings has none.
        const SUBPAGES = {logs: 'docker', qr: this._qrReturn ?? 'clipboard', settings: null};
        const parent = id in SUBPAGES ? SUBPAGES[id] : id;
        this._tabName.text = {qr: '›  QR code', logs: '›  Logs', settings: 'Settings'}[id] ?? '';
        this._selectTab(parent);

        this._stopDocker();
        let focus = this;
        if (id === 'activity') {
            this._loadActivity();
            this._dockerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._loadActivity();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (id === 'logs') {
            this._loadLogs(true);
            this._dockerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                this._loadLogs(false);
                return GLib.SOURCE_CONTINUE;
            });
        } else if (id === 'agents') {
            this._loadAgents();
            this._dockerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AGENT_REFRESH_MS, () => {
                this._loadAgents();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (id === 'home') {
            this._applyHome();
            this._loadDockerCount();
        } else if (id === 'docker') {
            this._loadDocker();
            this._dockerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DOCKER_REFRESH_MS, () => {
                this._loadDocker();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (id === 'ports') {
            this._portEntry.text = '';
            this._loadPorts();
            focus = this._portEntry;
        } else if (id === 'transform') {
            this._loadTransformInput();
            focus = this._xfIn;
        } else if (id === 'notes') {
            this._noteSearch.text = '';
            this._loadNotes();
            focus = this._noteEditor;
        } else if (id === 'inbox') {
            this._loadInbox();
            this._dockerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                this._loadInbox();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (id === 'clipboard') {
            this._clipFilter.text = '';
            this._loadClipboard();
            focus = this._clipFilter;
        } else if (id === 'search') {
            this._updateCalc();
            this._addRow.hide();
            this._loadSites();
            focus = this._searchEntry;
        }
        focus.grab_key_focus();
        this._mEq.running = id === 'home' && !!this._media?.playing;
        this.relayout(true); // tabs have different heights
        this._tick();
        this._syncTicker();
    }

    _selectTab(id) {
        for (const [tid, btn] of Object.entries(this._tabButtons))
            btn.checked = tid === id;
        this._selectedTab = id;
        this._tabIndicator.visible = !!id;
        if (id)
            this._runIndicator();
    }

    // The highlight follows the selected button every frame (its position
    // and width change while labels expand/collapse), on a critically
    // damped spring, then stops once settled.
    _runIndicator() {
        const ind = this._indicator;
        if (ind.tl)
            return;
        ind.lastT = 0;
        ind.still = 0;
        const tl = new Clutter.Timeline({actor: this._tabIndicator, duration: 1000, repeat_count: -1});
        tl.connect('new-frame', () => {
            const btn = this._tabButtons[this._selectedTab];
            if (!btn)
                return;
            const target = [btn.x, btn.width];
            if (!ind.placed) { // first show: no slide-in from x=0
                ind.pos = [...target];
                ind.vel = [0, 0];
                ind.placed = btn.width > 0;
            }
            const now = GLib.get_monotonic_time() / 1e6;
            const dt = ind.lastT ? Math.min(0.05, Math.max(0.001, now - ind.lastT)) : 1 / 60;
            ind.lastT = now;
            const w = 22, e = Math.exp(-w * dt);
            let moving = false;
            for (let a = 0; a < 2; a++) {
                const x = ind.pos[a] - target[a], v = ind.vel[a];
                const nx = (x + (v + w * x) * dt) * e;
                ind.vel[a] = (v - w * (v + w * x) * dt) * e;
                ind.pos[a] = target[a] + nx;
                if (Math.abs(nx) > 0.05 || Math.abs(ind.vel[a]) > 0.5)
                    moving = true;
            }
            this._tabIndicator.set_position(Math.round(ind.pos[0] * 2) / 2, btn.y);
            this._tabIndicator.set_size(Math.max(0, ind.pos[1]), btn.height);
            if (moving)
                ind.still = 0;
            else if (++ind.still > 8) {
                tl.stop();
                ind.tl = null;
            }
        });
        ind.tl = tl;
        tl.start();
    }

    // Replace a list's rows, building a few per frame so opening a long
    // list never drops a frame. A newer fill cancels an older one.
    _fillList(box, items, make) {
        box.destroy_all_children();
        const gen = (box._fillGen ?? 0) + 1;
        box._fillGen = gen;
        let i = 0;
        const step = () => {
            if (box._fillGen !== gen || !box.get_stage())
                return false;
            const end = Math.min(items.length, i + ROWS_PER_FRAME);
            for (; i < end; i++) {
                const actor = make(items[i], i);
                if (actor)
                    box.add_child(actor);
            }
            if (i >= items.length)
                this._refit();
            return i < items.length;
        };
        if (step())
            eachFrame(step);
    }

    // Lay out every page once while the shell is idle (one page per idle
    // slot), so styles, fonts and text layouts are ready before the first
    // time you open a tab; that first switch would otherwise stall a frame.
    prewarm() {
        if (this._prewarmed)
            return;
        this._prewarmed = true;
        const pages = Object.values(this._pages);
        const width = (DASH_WIDTH - 40) * scale();
        let k = 0;
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            const page = pages[k++];
            if (!page || !this._wallClock)
                return GLib.SOURCE_REMOVE;
            page.get_preferred_width(-1);
            page.get_preferred_height(width);
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ---------- Apple-style building blocks ----------

    // Inset grouped list: a small caps title above a rounded card whose rows
    // are separated by hairlines. The card hugs its content.
    _group(title = null, trailing = null) {
        const actor = new St.BoxLayout({...VERTICAL, style_class: 'goisland-igroup'});
        if (title || trailing) {
            const head = new St.BoxLayout({style_class: 'goisland-igroup-head'});
            const t = label('goisland-igroup-title', {text: title ?? '', x_expand: true});
            t.clutter_text.ellipsize = Pango.EllipsizeMode.NONE; // letter-spacing isn't measured
            head.add_child(t);
            if (trailing)
                head.add_child(trailing);
            actor.add_child(head);
        }
        const list = new St.BoxLayout({...VERTICAL, style_class: 'goisland-inset'});
        actor.add_child(list);
        return {actor, list};
    }

    // A rounded-square icon badge, like iOS Settings: {icon|gicon|glyph, color}.
    _badge(spec) {
        const bin = new St.Bin({style_class: `goisland-badge${spec.small ? ' small' : ''}`, y_align: Clutter.ActorAlign.CENTER});
        bin.set_style(`background-color: ${spec.color};`);
        bin.child = spec.glyph !== undefined
            ? new St.Label({text: spec.glyph, style_class: 'goisland-badge-glyph', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER})
            : new St.Icon({style_class: 'goisland-badge-icon', gicon: spec.gicon ?? null, icon_name: spec.icon ?? null,
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        if (spec.tint)
            bin.child.set_style(`color: ${spec.tint};`);
        return bin;
    }

    // The sending app's real icon, or a coloured initial badge (iOS style).
    _appBadge(app, desktopEntry) {
        const info = this._ext.lookupApp({app, desktopEntry});
        if (info)
            return new St.Icon({gicon: info.get_icon(), style_class: 'goisland-app-icon', y_align: Clutter.ActorAlign.CENTER});
        const name = app || '?';
        const hash = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
        return this._badge({glyph: name[0].toUpperCase(), color: TILE_COLORS[hash % TILE_COLORS.length]});
    }

    // Row actions that fade in on hover (macOS hover controls). While
    // hidden they can't be clicked, so nothing destructive is hit blindly.
    _hoverActions(row, buttons) {
        const box = new St.BoxLayout({style_class: 'goisland-row-actions', opacity: 0, y_align: Clutter.ActorAlign.CENTER});
        for (const b of buttons) {
            b.reactive = false;
            box.add_child(b);
        }
        row.reactive = true;
        row.track_hover = true;
        row.connect('notify::hover', () => {
            buttons.forEach(b => (b.reactive = row.hover));
            box.ease({opacity: row.hover ? 255 : 0, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
        return box;
    }

    // Title + secondary line column used by every row.
    _rowText(title, sub, {monoSub = false, monoTitle = false} = {}) {
        const col = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const t = label(`goisland-irow-title${monoTitle ? ' goisland-mono' : ''}`, {text: title});
        col.add_child(t);
        let s = null;
        if (sub) {
            s = label(`goisland-irow-sub${monoSub ? ' goisland-mono' : ''}`, {text: sub});
            col.add_child(s);
        }
        return {col, title: t, sub: s};
    }

    // Re-measure an auto-height tab after its content changed (debounced to
    // the next frame so several updates cost one relayout).
    _refit() {
        if (!this._dashOpen || !AUTO_HEIGHT.has(this._tab) || this._refitQueued)
            return;
        this._refitQueued = true;
        eachFrame(() => {
            this._refitQueued = false;
            if (this._dashOpen)
                this.relayout(true);
            return false;
        });
    }

    _stopDocker() {
        if (this._dockerId) {
            GLib.source_remove(this._dockerId);
            this._dockerId = 0;
        }
    }

    _message(lbl, text) {
        lbl.text = text ?? '';
        if (lbl.visible !== !!text) {
            lbl.visible = !!text;
            this._refit();
        }
    }

    // ---------- personality ----------

    _startPersonality() {
        this._asleep = false;
        this._wobbling = false;
        this._shake = [];
        this._cpuPrev = null;
        this._cpuHot = 0;
        this._schedulePointer(POINTER_MS);
        this._cpuId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
            this._sampleCpu();
            return GLib.SOURCE_CONTINUE;
        });
        this._idleMon = global.backend.get_core_idle_monitor();
        this._idleWatch = this._idleMon.add_idle_watch(SLEEP_AFTER_MS, () => this._setAsleep(true));
        this._activeWatch = 0;
    }

    // Self-rescheduling pointer poll: ~30 fps only when the cursor is near
    // the eyes or over the island, ~4 fps when it's far, and a slow 1 Hz
    // check when there's nothing to animate (face hidden, asleep).
    _schedulePointer(ms) {
        this._pointerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._pointerId = 0;
            this._schedulePointer(this._onPointer());
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopPersonality() {
        for (const id of [this._pointerId, this._cpuId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._pointerId = this._cpuId = 0;
        for (const w of [this._idleWatch, this._activeWatch]) {
            if (w)
                this._idleMon.remove_watch(w);
        }
        this._idleWatch = this._activeWatch = 0;
        this._wobbleTl?.stop();
    }

    setPresenting(on) {
        this._face.setSpy(on);
        this._apply();
        this.relayout(true); // the idle width depends on face vs. sunglasses
        if (this._dashOpen && ['clipboard', 'notes', 'inbox'].includes(this._tab))
            this._showTab(this._tab);
    }

    _setAsleep(on) {
        this._asleep = on;
        this._face.setMood(on ? 'sleep' : this._cpuHot >= 2 ? 'dizzy' : 'normal');
        if (on && !this._activeWatch) {
            this._activeWatch = this._idleMon.add_user_active_watch(() => {
                this._activeWatch = 0;
                this._setAsleep(false);
            });
        }
    }

    // Busy CPU for a few seconds makes the island dizzy.
    _sampleCpu() {
        try {
            const [, bytes] = GLib.file_get_contents('/proc/stat');
            const f = new TextDecoder().decode(bytes).split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
            const idle = f[3] + (f[4] || 0);
            const total = f.reduce((a, b) => a + b, 0);
            if (this._cpuPrev) {
                const busy = 1 - (idle - this._cpuPrev[0]) / Math.max(1, total - this._cpuPrev[1]);
                this._cpuHot = busy > CPU_DIZZY ? this._cpuHot + 1 : busy < 0.6 ? 0 : this._cpuHot;
                if (!this._asleep) {
                    if (this._cpuHot >= 2 && this._face.mood === 'normal')
                        this._face.setMood('dizzy');
                    else if (this._cpuHot === 0 && this._face.mood === 'dizzy')
                        this._face.setMood('normal');
                }
            }
            this._cpuPrev = [idle, total];
        } catch {
            // /proc unavailable: no dizziness
        }
    }

    // React to activity changes: hearts after success, surprise + bounce on USB.
    _react(prev) {
        const s = this._state;
        if (this._asleep)
            return;
        if (prev.accent === 'ok' && s.title !== prev.title)
            this._face.setMood('love', 2600);
        if (s.kind === 'usb' && (prev.kind !== 'usb' || prev.title !== s.title)) {
            this._face.setMood('surprised', 5000);
            this.set({scale_x: 1.07, scale_y: 1.07});
            this._springTo({scale_x: 1, scale_y: 1}, 520, null, 'scale');
        }
    }

    // Jelly wobble: middle-click, or shake the mouse over the island.
    wobble() {
        if (this._wobbling)
            return;
        this._wobbling = true;
        this._face.setMood('squint', 900);
        const D = 760;
        const tl = new Clutter.Timeline({actor: this, duration: D});
        tl.connect('new-frame', () => {
            const t = tl.get_elapsed_time() / D;
            const a = Math.sin(t * Math.PI * 5) * Math.pow(1 - t, 2) * 0.14;
            this.scale_x = 1 + a;
            this.scale_y = 1 - a * 0.8;
        });
        tl.connect('completed', () => {
            this.scale_x = this.scale_y = 1;
            this._wobbling = false;
        });
        this._wobbleTl = tl;
        tl.start();
    }

    // Cursor offset from the face centre (read every frame while the eyes
    // are animating).
    _faceTarget() {
        const [px, py] = global.get_pointer();
        const f = this._face.actor;
        const [fx, fy] = f.get_transformed_position();
        return [px - (fx + f.width / 2), py - (fy + f.height / 2)];
    }

    // A cheap watcher: it only notices that the cursor moved and wakes the
    // face's frame-synced loop (which does the smooth part and stops itself
    // once the eyes settle). While hovering it also feeds shake detection.
    // Returns the delay until the next poll.
    _onPointer() {
        const faceVisible = this._face.actor.mapped && !this._asleep;
        if (!faceVisible && !this.hover)
            return 1000; // nothing to animate
        const [px, py] = global.get_pointer();
        const moved = px !== this._lastPx || py !== this._lastPy;
        this._lastPx = px;
        this._lastPy = py;
        if (faceVisible && moved)
            this._face.wake();
        let next = moved ? WATCH_ACTIVE_MS : WATCH_IDLE_MS;

        const resting = this._mode === 'idle' || this._mode === 'compact';
        if (!this.hover || !resting) {
            if (this._shake.length)
                this._shake = [];
            return next;
        }
        const now = GLib.get_monotonic_time() / 1000;
        const h = this._shake;
        if (!h.length || h[h.length - 1][1] !== px)
            h.push([now, px]);
        while (h.length && now - h[0][0] > SHAKE_WINDOW_MS)
            h.shift();
        // Count sharp direction reversals; small jitters are ignored.
        let reversals = 0, dir = 0, anchor = h[0]?.[1];
        for (let i = 1; i < h.length; i++) {
            const d = h[i][1] - anchor;
            if (Math.abs(d) < SHAKE_MIN_PX)
                continue;
            if (dir && Math.sign(d) !== dir)
                reversals++;
            dir = Math.sign(d);
            anchor = h[i][1];
        }
        if (reversals >= SHAKE_REVERSALS) {
            this._shake = [];
            this.wobble();
        }
        return POINTER_MS;
    }

    // ---------- layout ----------

    _size() {
        const barH = Main.panel.height;
        const k = scale(); // panel height and measured widths are already device px
        switch (this._mode) {
        case 'idle': {
            this._content.set_size(-1, -1); // measure natural width
            const [, natural] = this._content.get_preferred_width(barH);
            return [Math.max(150 * k, Math.ceil(natural) + 44 * k), barH];
        }
        case 'notify':
            return [420 * k, 72 * k];
        case 'dashboard': {
            const max = (DASH_HEIGHT[this._tab] ?? DASH_HEIGHT.default) * k;
            if (!AUTO_HEIGHT.has(this._tab))
                return [DASH_WIDTH * k, max];
            // Hug the content: measure the dashboard at its inner width.
            const node = this.get_theme_node();
            const innerW = DASH_WIDTH * k - node.get_horizontal_padding();
            this._dash.set_size(-1, -1);
            const [, natural] = this._dash.get_preferred_height(innerW);
            const h = Math.ceil(natural + node.get_vertical_padding());
            return [DASH_WIDTH * k, Math.max(AUTO_MIN_HEIGHT * k, Math.min(max, h))];
        }
        case 'osd':
            return [300 * k, barH];
        default:
            return [320 * k, barH];
        }
    }

    // Animate numeric properties along the spring curve on the actor's frame
    // clock. (Clutter's set_progress_func is unusable from GJS: it freezes
    // the transition.) Geometry is rounded so text never renders blurry.
    _springTo(target, duration, onDone = null, key = 'geom') {
        this._springs[key]?.stop();
        const from = {};
        for (const k of Object.keys(target))
            from[k] = this[k];
        const set = p => {
            for (const [k, to] of Object.entries(target)) {
                const v = from[k] + (to - from[k]) * p;
                this[k] = PIXEL_PROPS.has(k) ? Math.round(v) : v;
            }
        };
        const tl = new Clutter.Timeline({actor: this, duration});
        tl.connect('new-frame', () => set(spring(tl.get_elapsed_time() / duration)));
        tl.connect('completed', () => {
            set(1);
            if (this._springs[key] === tl)
                delete this._springs[key];
            onDone?.();
        });
        this._springs[key] = tl;
        tl.start();
    }

    relayout(animate) {
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const [width, height] = this._size();
        const t = {x: mon.x + Math.round((mon.width - width) / 2), y: mon.y, width, height};

        // Pin the visible layer to its final inner size so the morph reveals
        // it instead of reflowing it every frame.
        const node = this.get_theme_node();
        const innerW = width - node.get_horizontal_padding() -
            node.get_border_width(St.Side.LEFT) - node.get_border_width(St.Side.RIGHT);
        const innerH = height - node.get_vertical_padding() -
            node.get_border_width(St.Side.TOP) - node.get_border_width(St.Side.BOTTOM);
        const layer = this._mode === 'dashboard' ? this._dash : this._content;
        layer.set_size(Math.max(0, innerW), Math.max(0, innerH));

        const same = a => a && a.x === t.x && a.y === t.y && a.width === t.width && a.height === t.height;
        if (animate && this._springs.geom && same(this._target))
            return; // already heading there
        this._target = t;
        if (!animate || same(this)) {
            this._springs.geom?.stop();
            delete this._springs.geom;
            this.set(t);
            return;
        }
        this._springTo(t, MORPH_MS);
    }

    _show() {
        this._shown = true;
        this.relayout(false);
        this.set({opacity: 0, scale_x: 0.7, scale_y: 0.7});
        this.ease({opacity: 255, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._springTo({scale_x: 1, scale_y: 1}, MORPH_MS, null, 'scale');
    }
});

export default class GoIslandExtension extends Extension {
    enable() {
        this._enabled = true;
        this._clipReading = false;
        this._clipAgain = false;
        this._clipTimer = 0;
        this.agentIcon = Gio.icon_new_for_string(`${this.path}/icons/agent.svg`);
        this.spyIcon = Gio.icon_new_for_string(`${this.path}/icons/spy.svg`);
        this.presenting = false;
        this._island = new Island(this);
        Main.layoutManager.addTopChrome(this._island, {
            affectsInputRegion: true,
            trackFullscreen: true, // hide over fullscreen apps (like the top bar)
        });

        // Take over the clock: keep the dateMenu button (its menu still
        // anchors there, opened via right-click) but hide it under the notch.
        this._dateMenu = Main.panel.statusArea.dateMenu;
        this._dateMenu?.container.set_opacity(0);

        this._island.setState(IDLE);
        Main.layoutManager.connectObject('monitors-changed', () => this._island.relayout(false), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor',
            () => this._island.relayout(false), this);

        // Volume / brightness / mic popups morph out of the island instead.
        // Falls back to GNOME's own popup over fullscreen apps (the island
        // hides there) and while the dashboard is open.
        this.settings = DEFAULT_SETTINGS;
        this._island.applySettings(this.settings);
        this._setOsdTakeover(true);
        Main.panel.connectObject('notify::height', () => this._island.relayout(false), this);

        // Screen sharing turns on presentation mode automatically (and off
        // again when it ends, unless you turned it on yourself).
        this._shares = new Set();
        global.backend.get_remote_access_controller?.()?.connectObject('new-handle', (_c, handle) => {
            if (handle.is_recording)
                return; // the built-in screen recorder isn't sharing
            this._shares.add(handle);
            this.setPresenting(true, true);
            handle.connectObject('stopped', () => {
                this._shares.delete(handle);
                if (!this._shares.size && this._autoPresent)
                    this.setPresenting(false, false);
            }, this);
        }, this);

        // Clipboard history: only the compositor can read the clipboard on Wayland.
        global.display.get_selection().connectObject('owner-changed',
            (_sel, type, source) => this._onClipboardChanged(type, source), this);

        this._watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION, BUS_NAME, Gio.BusNameWatcherFlags.NONE,
            () => this._connect(),
            () => this._disconnect());
    }

    disable() {
        this._enabled = false;
        this._setOsdTakeover(false);
        if (this._clipTimer) {
            GLib.source_remove(this._clipTimer);
            this._clipTimer = 0;
        }

        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        this.setPresenting(false, false); // restores notification banners
        global.backend.get_remote_access_controller?.()?.disconnectObject(this);
        for (const h of this._shares ?? [])
            h.disconnectObject(this);
        this._shares = null;
        Gio.bus_unwatch_name(this._watchId);
        this._watchId = 0;
        this._disconnect();
        global.display.get_selection().disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.panel.disconnectObject(this);
        this._dateMenu?.container.set_opacity(255);
        this._dateMenu = null;
        Main.layoutManager.removeChrome(this._island);
        this._island.destroy();
        this._island = null;
    }

    // Presentation mode: hide personal content, silence notification
    // banners, stop recording clipboard copies, and put on the sunglasses.
    setPresenting(on, auto) {
        if (on === this.presenting) {
            if (!auto)
                this._autoPresent = false; // a manual toggle wins over auto-off
            return;
        }
        this.presenting = on;
        this._autoPresent = on && auto;
        const notif = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        if (on) {
            this._bannersWere = notif.get_boolean('show-banners');
            notif.set_boolean('show-banners', false);
        } else if (this._bannersWere !== undefined) {
            notif.set_boolean('show-banners', this._bannersWere);
            this._bannersWere = undefined;
        }
        this.call('SetPresenting', [on]);
        this._island?.setPresenting(on);
    }

    _setOsdTakeover(on) {
        const osd = Main.osdWindowManager;
        if (on && !this._origOsdShow) {
            this._origOsdShow = osd.show;
            const ext = this;
            osd.show = function (monitorIndex, icon, label, level, maxLevel) {
                const island = ext._island;
                const primary = Main.layoutManager.primaryMonitor;
                if (island && !island._dashOpen && primary && !primary.inFullscreen &&
                    (monitorIndex === -1 || monitorIndex === Main.layoutManager.primaryIndex)) {
                    island.showOsd(icon, label, level, maxLevel);
                    return;
                }
                ext._origOsdShow.call(this, monitorIndex, icon, label, level, maxLevel);
            };
        } else if (!on && this._origOsdShow) {
            osd.show = this._origOsdShow;
            this._origOsdShow = null;
        }
    }

    applySettings(st) {
        this.settings = st;
        this._island?.applySettings(st);
        this._setOsdTakeover(featureOn(st, 'osd'));
        this._blockBanners(!!this._proxy && featureOn(st, 'hideBanners'));
    }

    // Activate GNOME's own copy of a mirrored notification exactly like a
    // banner click: the app receives its "default" action plus an
    // activation token (so it can raise itself and open the message), or
    // GNOME opens the app if it has no default action. If that copy is
    // gone, fall back to opening the app.
    activateNotification(view) {
        const norm = t => (t ?? '').replace(/<[^>]*>/g, '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
            .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
        let match = null;
        for (const source of Main.messageTray.getSources()) {
            for (const n of source.notifications ?? []) {
                if (norm(n.title) === view.title && (!view.subtitle || norm(n.body) === view.subtitle))
                    match = n; // the last match is the newest
            }
        }
        if (match) {
            match.activate();
            return true;
        }
        const app = this.lookupApp(view);
        if (app) {
            app.activate();
            Main.overview.hide();
            return true;
        }
        return false;
    }

    lookupApp(view) {
        const apps = Shell.AppSystem.get_default();
        for (const id of [view.desktopEntry, view.app?.toLowerCase(), view.app].filter(Boolean)) {
            // Exact matches only: the heuristic lookup returns unrelated apps.
            const app = apps.lookup_app(`${id}.desktop`) ?? apps.lookup_desktop_wmclass(id) ?? apps.lookup_startup_wmclass(id);
            if (app)
                return app;
        }
        return null;
    }

    // Map a process name (brave, code, slack…) to its app: exact ids first,
    // then a search hit whose desktop id starts with the name.
    lookupProcessApp(name) {
        if (!name)
            return null;
        const exact = this.lookupApp({app: name});
        if (exact)
            return exact;
        const apps = Shell.AppSystem.get_default();
        const low = name.toLowerCase();
        for (const group of Shell.AppSystem.search(low)) {
            for (const id of group) {
                if (id.toLowerCase().startsWith(low))
                    return apps.lookup_app(id);
            }
        }
        return null;
    }

    get clock24() {
        return new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('clock-format') !== '12h';
    }

    // Send a partial settings patch to the daemon; it saves and broadcasts.
    updateSettings(patch) {
        this.call('SetSettings', [JSON.stringify(patch)], (res, err) => {
            if (!err)
                this.applySettings(JSON.parse(res[0]));
            else
                this._island?.applySettings(this.settings); // revert optimistic toggles
        });
    }

    // GNOME shows a banner only when MessageTray._bannerBlocked is false,
    // and panel menus toggle that flag as they open/close. While the island
    // is connected (it shows notifications itself), pin it on by shadowing
    // the accessor on the instance. Notifications still land in the
    // calendar's list.
    _blockBanners(on) {
        const tray = Main.messageTray;
        if (!tray || on === !!this._bannersBlocked)
            return;
        this._bannersBlocked = on;
        if (on) {
            Object.defineProperty(tray, 'bannerBlocked', {
                configurable: true,
                get: () => true,
                set: () => {}, // ignore panel menus while the island is active
            });
            tray._bannerBlocked = true;
        } else {
            delete tray.bannerBlocked; // back to MessageTray's own accessor
            tray._bannerBlocked = false;
        }
        tray._updateState?.();
    }

    // ---------- clipboard ----------
    //
    // A GNOME Shell crash (SIGSEGV in a GJS callback trampoline, invoked
    // when a clipboard transfer completed) traced back to clipboard reads.
    // So reads are rare and strictly serial:
    //   - only for history capture, debounced (bursts of owner changes
    //     collapse into one read),
    //   - never more than one in flight,
    //   - never for text the island copied itself (it already knows it),
    //   - the native callback only schedules work; nothing runs inside it.
    // Everything else (Transform, QR) uses the daemon's history instead.

    _onClipboardChanged(type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !source || !this._proxy || this.presenting ||
            !featureOn(this.settings, 'clipboardHistory'))
            return;
        if (Date.now() - (this._selfCopyAt ?? 0) < 1000)
            return; // our own copy(); already recorded
        if (source.get_mimetypes().includes(SECRET_MIME))
            return;
        if (this._clipTimer)
            GLib.source_remove(this._clipTimer);
        this._clipTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLIP_DEBOUNCE_MS, () => {
            this._clipTimer = 0;
            this._readClipboard();
            return GLib.SOURCE_REMOVE;
        });
    }

    _readClipboard() {
        if (this._clipReading) {
            this._clipAgain = true; // read once more after the current one
            return;
        }
        this._clipReading = true;
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_cb, text) => {
            const copy = text ? String(text) : '';
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._clipReading = false;
                if (!this._enabled)
                    return GLib.SOURCE_REMOVE;
                if (copy.trim())
                    this.call('ClipboardAdd', [copy]);
                if (this._clipAgain) {
                    this._clipAgain = false;
                    this._readClipboard();
                }
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // Copy text to the clipboard and record it, without reading it back.
    copy(text) {
        this._selfCopyAt = Date.now();
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        if (!this.presenting)
            this.call('ClipboardAdd', [text]);
    }

    // The most recent clipboard text, from the daemon's history.
    latestClip(cb) {
        this.call('ClipboardList', [], (res, err) => {
            if (err)
                return cb(null);
            const items = JSON.parse(res[0]) ?? [];
            items.sort((a, b) => b.at - a.at);
            cb(items[0]?.text ?? null);
        });
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
            this._blockBanners(featureOn(this.settings, 'hideBanners'));
            this.call('GetSettings', [], (res, err) => {
                if (!err && !cancellable.is_cancelled())
                    this.applySettings(JSON.parse(res[0]));
            });
            GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 3, () => {
                this._island?.prewarm();
                return GLib.SOURCE_REMOVE;
            });
            this._signalIds = [
                proxy.connectSignal('StateChanged', (_p, _sender, [json]) => this._applyState(json)),
                proxy.connectSignal('OpenDashboard', (_p, _sender, [tab]) => this._island?.toggleDash(tab)),
                proxy.connectSignal('SettingsChanged', (_p, _sender, [json]) => this.applySettings(JSON.parse(json))),
                proxy.connectSignal('ColorPicked', (_p, _sender, [hex]) =>
                    this.copy(hex)),
            ];
            if (this.presenting)
                this.call('SetPresenting', [true]);
            this.call('GetState', [], (result, err) => {
                if (!err && !cancellable.is_cancelled())
                    this._applyState(result[0]);
            });
        }, cancellable);
    }

    _disconnect() {
        this._blockBanners(false); // daemon gone: GNOME's banners come back
        this._cancellable?.cancel();
        this._cancellable = null;
        for (const id of this._signalIds ?? [])
            this._proxy?.disconnectSignal(id);
        this._signalIds = [];
        this._proxy = null;
        this._island?.setState(IDLE);
    }

    _applyState(json) {
        try {
            this._island?.setState(JSON.parse(json));
        } catch (e) {
            console.error(`go-island: bad state: ${e.message}`);
        }
    }

    // call invokes a daemon method; cb(result, error) is optional.
    call(method, args = [], cb = null) {
        if (!this._proxy) {
            cb?.(null, new Error('daemon not running'));
            return;
        }
        const fn = this._proxy[`${method}Remote`];
        if (typeof fn !== 'function') {
            console.error(`go-island: unknown method ${method}`);
            cb?.(null, new Error(`unknown method ${method}`));
            return;
        }
        fn.call(this._proxy, ...args, (result, err) => {
            if (err)
                console.error(`go-island: ${method}: ${err.message}`);
            cb?.(result, err);
        });
    }

    action(name) {
        this.call('Action', [name]);
    }
}
