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
import {calc, formatNumber, TRANSFORMS} from './util.js';

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
    <method name="NotesGet"><arg name="text" type="s" direction="out"/></method>
    <method name="NotesSave"><arg name="text" type="s" direction="in"/></method>
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
const DASH_HEIGHT = {transform: 470, home: 292, search: 360, agents: 400, notes: 420, qr: 430, logs: 520, default: 500};
const OSD_MS = 1600;
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
        overlay_scrollbars: true,
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

function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60)
        return 'now';
    if (s < 3600)
        return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
}

// A tiny "now playing" equalizer. It steps at a few frames per second
// (like a real level meter) instead of animating every frame, which keeps
// the shell nearly idle while music plays.
const EQ_STEP_MS = 180;
const EQ_PATTERN = [[0.5, 0.9, 0.4, 0.7], [0.8, 0.5, 0.9, 0.4], [0.4, 1.0, 0.6, 0.8], [0.9, 0.6, 0.5, 1.0], [0.6, 0.4, 0.8, 0.5]];

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
        this._timer = 0;
        this._step = 0;
        this.actor.connect('notify::mapped', () => this._sync());
        this.actor.connect('destroy', () => this._stop());
    }

    set running(run) {
        this._running = run;
        this._sync();
    }

    // Only tick while playing *and* on screen.
    _sync() {
        const on = this._running && this.actor.mapped;
        if (on && !this._timer) {
            this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EQ_STEP_MS, () => {
                const row = EQ_PATTERN[this._step++ % EQ_PATTERN.length];
                this._bars.forEach((bar, i) => (bar.scale_y = row[i]));
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!on) {
            this._stop();
            this._bars.forEach(bar => (bar.scale_y = 0.35));
        }
    }

    _stop() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
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
        const tabs = new St.BoxLayout({style_class: 'goisland-tabs', x_expand: true});
        this._tabButtons = {};
        for (const [id, name, icon] of TABS) {
            const btn = new St.Button({
                style_class: 'goisland-tab',
                can_focus: true,
                accessible_name: name,
                child: new St.Icon({icon_name: icon, style_class: 'goisland-tab-icon'}),
            });
            btn.connect('clicked', () => this._showTab(id));
            tabs.add_child(btn);
            this._tabButtons[id] = btn;
        }
        this._tabName = label('goisland-tab-name');
        tabs.add_child(this._tabName);
        header.add_child(tabs);
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
        this._dashClock = label('goisland-dash-clock');
        header.add_child(this._dashClock);
        this._dash.add_child(header);

        const body = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._pages = {
            home: this._buildHomePage(),
            agents: this._buildAgentsPage(),
            docker: this._buildDockerPage(),
            ports: this._buildPortsPage(),
            clipboard: this._buildClipboardPage(),
            transform: this._buildTransformPage(),
            notes: this._buildNotesPage(),
            qr: this._buildQRPage(),
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
                this._dockerRow.sub.text = 'Docker unavailable';
            } else {
                const list = JSON.parse(res[0]);
                const bad = list.filter(c => /unhealthy/.test(c.status)).length;
                this._dockerRow.sub.text = `${list.length} running${bad ? ` · ${bad} unhealthy` : ''}`;
            }
        });
    }

    // ----- Agents -----

    _buildAgentsPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page', ...VERTICAL});
        const card = new St.BoxLayout({style_class: 'goisland-card goisland-list-card', ...VERTICAL, x_expand: true, y_expand: true});
        this._agentList = new St.BoxLayout({...VERTICAL, style_class: 'goisland-list'});
        this._agentMsg = label('goisland-empty', {x_align: Clutter.ActorAlign.CENTER, visible: false});
        card.add_child(this._agentMsg);
        card.add_child(scrollView(this._agentList));
        page.add_child(card);
        return page;
    }

    _loadAgents() {
        this._ext.call('AgentsList', [], (res, err) => {
            if (!this._dashOpen || this._tab !== 'agents')
                return;
            const list = err ? [] : JSON.parse(res[0]);
            this._message(this._agentMsg, err ? 'Daemon not running'
                : list.length ? '' : 'No agent sessions yet. Run `island claude install`, then start Claude Code.');
            this._renderAgents(list);
        });
    }

    _renderAgents(list) {
        this._agentList.destroy_all_children();
        for (const a of list) {
            const [stateName, color] = AGENT_STATES[a.state] ?? AGENT_STATES.ready;
            const box = new St.BoxLayout({x_expand: true, style_class: 'goisland-agent-row'});
            box.add_child(new St.Widget({style_class: `goisland-dot ${color}`, y_align: Clutter.ActorAlign.CENTER}));
            const col = new St.BoxLayout({...VERTICAL, x_expand: true});
            const head = new St.BoxLayout({style_class: 'goisland-agent-head'});
            head.add_child(label('goisland-row-title', {text: `${a.agent} · ${a.project || 'session'}`}));
            head.add_child(label(`goisland-agent-state ${color}`, {text: stateName}));
            col.add_child(head);
            col.add_child(label('goisland-row-sub', {text: a.detail || a.title || ''}));
            box.add_child(col);
            const meta = new St.BoxLayout({...VERTICAL, y_align: Clutter.ActorAlign.CENTER});
            const usage = [a.costUsd ? `$${a.costUsd.toFixed(2)}` : '', a.contextPct ? `${Math.round(a.contextPct)}% ctx` : '']
                .filter(Boolean).join('  ·  ');
            meta.add_child(label('goisland-agent-usage', {text: usage || ' ', x_align: Clutter.ActorAlign.END}));
            meta.add_child(label('goisland-agent-when', {text: ago(a.updatedAt), x_align: Clutter.ActorAlign.END}));
            box.add_child(meta);
            const row = new St.Button({style_class: 'goisland-row goisland-clip-row', can_focus: true, child: box, x_expand: true});
            row.connect('clicked', () => {
                if (focusPids(a.focus))
                    this._closeDash();
            });
            this._agentList.add_child(row);
        }
    }

    // ----- Docker -----

    _buildDockerPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page', ...VERTICAL});
        const card = new St.BoxLayout({style_class: 'goisland-card goisland-list-card', ...VERTICAL, x_expand: true, y_expand: true});
        this._dockerList = new St.BoxLayout({...VERTICAL, style_class: 'goisland-list'});
        this._dockerMsg = label('goisland-empty', {x_align: Clutter.ActorAlign.CENTER, visible: false});
        card.add_child(this._dockerMsg);
        card.add_child(scrollView(this._dockerList));
        page.add_child(card);
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
            if (err) {
                this._dockerList.destroy_all_children();
                this._message(this._dockerMsg, err.message.replace(/^.*?Error\.Failed: /, ''));
                return;
            }
            const list = JSON.parse(res[0]);
            this._message(this._dockerMsg, list.length ? '' : 'No running containers');
            this._renderDocker(list);
        });
    }

    _renderDocker(list) {
        this._dockerList.destroy_all_children();
        let project = null;
        for (const c of list) {
            if (c.project !== project) {
                project = c.project;
                this._dockerList.add_child(label('goisland-group', {text: (project || 'standalone').toUpperCase()}));
            }
            const row = new St.BoxLayout({style_class: 'goisland-row'});
            const healthy = c.state === 'running' && !/unhealthy/.test(c.status);
            row.add_child(new St.Widget({
                style_class: `goisland-dot ${healthy ? 'ok' : 'bad'}`, y_align: Clutter.ActorAlign.CENTER,
            }));
            const col = new St.BoxLayout({...VERTICAL, x_expand: true});
            col.add_child(label('goisland-row-title', {text: c.name}));
            col.add_child(label('goisland-row-sub', {text: [c.status, c.image].filter(Boolean).join('  ·  ')}));
            row.add_child(col);
            const chips = new St.BoxLayout({style_class: 'goisland-port-chips', y_align: Clutter.ActorAlign.CENTER});
            for (const p of (c.ports || '').split(', ').filter(Boolean).slice(0, 3))
                chips.add_child(this._portButton(p, 'goisland-port-chip'));
            row.add_child(chips);
            const st = c.stats;
            const usage = new St.BoxLayout({...VERTICAL, style_class: 'goisland-usage', y_align: Clutter.ActorAlign.CENTER});
            const cpu = label(`goisland-usage-cpu${st && st.cpu >= 80 ? ' hot' : ''}`, {
                text: st ? `${st.cpu.toFixed(st.cpu < 10 ? 1 : 0)}% CPU` : '–', x_align: Clutter.ActorAlign.END,
            });
            const mem = label(`goisland-usage-mem${st && st.memPct >= 80 ? ' hot' : ''}`, {
                text: st ? st.mem.replace(/iB$/, 'B') : ' ', x_align: Clutter.ActorAlign.END,
            });
            usage.add_child(cpu);
            usage.add_child(mem);
            row.add_child(usage);
            row.add_child(iconButton('format-justify-left-symbolic', 'goisland-row-btn',
                () => this._showLogs(c), `Logs of ${c.name}`));
            for (const [op, icon] of [['restart', 'view-refresh-symbolic'], ['stop', 'media-playback-stop-symbolic']]) {
                row.add_child(iconButton(icon, 'goisland-row-btn', () => {
                    row.opacity = 128;
                    this._ext.call('DockerAction', [c.id, op], () => this._loadDocker());
                }, `${op} ${c.name}`));
            }
            this._dockerList.add_child(row);
        }
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
        const card = new St.BoxLayout({style_class: 'goisland-card goisland-list-card', ...VERTICAL, x_expand: true, y_expand: true});
        this._portList = new St.BoxLayout({...VERTICAL, style_class: 'goisland-list'});
        this._portMsg = label('goisland-empty', {x_align: Clutter.ActorAlign.CENTER, visible: false});
        card.add_child(this._portMsg);
        card.add_child(scrollView(this._portList));
        page.add_child(this._portEntry);
        page.add_child(card);
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
        this._portList.destroy_all_children();
        const q = this._portEntry.text.trim().replace(/^:/, '').toLowerCase();
        const items = q
            ? this._ports.filter(l => `${l.port} ${l.process ?? ''} ${l.container ?? ''} ${l.cmd ?? ''}`.toLowerCase().includes(q))
            : this._ports;
        this._message(this._portMsg, error ?? (items.length ? '' : q ? 'No matches. Press Enter to free that port.' : 'Nothing listening'));
        for (const l of items) {
            const mine = !!(l.container || l.pid);
            const row = new St.BoxLayout({style_class: `goisland-row${mine ? '' : ' muted'}`});
            row.add_child(this._portButton(l.port, 'goisland-port'));
            const col = new St.BoxLayout({...VERTICAL, x_expand: true});
            const owner = l.container ? `${l.container}  ·  container` : l.process ? `${l.process}  ·  pid ${l.pid}` : 'System service';
            col.add_child(label('goisland-row-title', {text: owner}));
            col.add_child(label('goisland-row-sub', {text: [l.addr, l.cmd].filter(Boolean).join('  ·  ')}));
            row.add_child(col);
            if (mine) {
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
                row.add_child(btn);
            }
            this._portList.add_child(row);
        }
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
            style_class: 'goisland-entry', hint_text: 'Filter clipboard', can_focus: true, x_expand: true,
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

        const card = new St.BoxLayout({style_class: 'goisland-card goisland-list-card', ...VERTICAL, x_expand: true, y_expand: true});
        this._clipList = new St.BoxLayout({...VERTICAL, style_class: 'goisland-list'});
        this._clipMsg = label('goisland-empty', {x_align: Clutter.ActorAlign.CENTER, visible: false});
        card.add_child(this._clipMsg);
        card.add_child(scrollView(this._clipList));
        page.add_child(top);
        page.add_child(card);
        return page;
    }

    // ----- Transform -----

    _buildTransformPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page', ...VERTICAL});
        const multiline = (styleClass, hint) => {
            const e = new St.Entry({style_class: styleClass, hint_text: hint, can_focus: true, x_expand: true, y_align: Clutter.ActorAlign.START});
            const ct = e.clutter_text;
            ct.single_line_mode = false;
            ct.activatable = false;
            ct.line_wrap = true;
            ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            return e;
        };
        const pane = (title, child, extra) => {
            const card = new St.BoxLayout({style_class: 'goisland-card goisland-xf-card', ...VERTICAL, x_expand: true, y_expand: true});
            const head = new St.BoxLayout({style_class: 'goisland-xf-head'});
            head.add_child(label('goisland-group', {text: title, x_expand: true}));
            if (extra)
                head.add_child(extra);
            card.add_child(head);
            const box = new St.BoxLayout({...VERTICAL, x_expand: true});
            box.add_child(child);
            card.add_child(scrollView(box));
            return card;
        };

        this._xfIn = multiline('goisland-notes goisland-xf-text', 'Paste or type text. Your selection or clipboard is filled in when you open this tab.');
        this._xfInfo = label('goisland-hint');
        page.add_child(pane('INPUT', this._xfIn, this._xfInfo));

        const chips = new St.BoxLayout({style_class: 'goisland-chips', x_align: Clutter.ActorAlign.CENTER});
        for (const [, name, fn] of TRANSFORMS) {
            const chip = new St.Button({style_class: 'goisland-chip', label: name, can_focus: true});
            chip.connect('clicked', () => this._transform(chip, name, fn));
            chips.add_child(chip);
        }
        page.add_child(chips);

        this._xfOut = multiline('goisland-notes goisland-xf-text goisland-xf-out', 'The result appears here and is copied.');
        const useAsInput = new St.Button({style_class: 'goisland-chip', label: 'Use as input', can_focus: true});
        useAsInput.connect('clicked', () => {
            if (this._xfOut.text)
                this._xfIn.text = this._xfOut.text;
        });
        page.add_child(pane('OUTPUT', this._xfOut, useAsInput));
        return page;
    }

    // Fill the input with the latest clipboard text. It comes from the
    // daemon's history, not a live clipboard read: reads are the one thing
    // that has crashed GNOME Shell, so the UI never does them on demand.
    _loadTransformInput() {
        this._ext.latestClip(text => {
            if (text && !this._xfIn.text) {
                this._xfIn.text = text;
                this._xfInfo.text = 'from clipboard';
            }
        });
    }

    _transform(chip, name, fn) {
        let out;
        try {
            if (!this._xfIn.text)
                throw new Error('empty');
            out = fn(this._xfIn.text);
        } catch {
            this._flash(chip, 'Invalid', name, 'bad');
            return;
        }
        this._xfOut.text = out;
        this._ext.copy(out);
        this._flash(chip, 'Copied', name, 'good');
    }

    _flash(btn, text, restore, kind) {
        btn.label = text;
        btn.add_style_class_name(kind);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1100, () => {
            if (btn.get_stage()) {
                btn.label = restore;
                btn.remove_style_class_name(kind);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // ----- Notes -----

    _buildNotesPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page', ...VERTICAL});
        const card = new St.BoxLayout({style_class: 'goisland-card goisland-notes-card', ...VERTICAL, x_expand: true, y_expand: true});
        this._notes = new St.Entry({
            style_class: 'goisland-notes', hint_text: 'Jot something down. It saves automatically.',
            can_focus: true, x_expand: true, y_align: Clutter.ActorAlign.START,
        });
        const ct = this._notes.clutter_text;
        ct.single_line_mode = false;
        ct.activatable = false;
        ct.line_wrap = true;
        ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._notesSaveId = 0;
        this._notesLoaded = false;
        ct.connect('text-changed', () => {
            if (!this._notesLoaded)
                return;
            this._notesStatus.text = 'Editing…';
            if (this._notesSaveId)
                GLib.source_remove(this._notesSaveId);
            this._notesSaveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                this._notesSaveId = 0;
                this._ext.call('NotesSave', [this._notes.text], (_r, err) => {
                    this._notesStatus.text = err ? 'Not saved' : 'Saved';
                });
                return GLib.SOURCE_REMOVE;
            });
        });
        const box = new St.BoxLayout({...VERTICAL, x_expand: true});
        box.add_child(this._notes);
        card.add_child(scrollView(box));
        this._notesStatus = label('goisland-hint goisland-notes-status', {text: '', x_align: Clutter.ActorAlign.END});
        page.add_child(card);
        page.add_child(this._notesStatus);
        return page;
    }

    _loadNotes() {
        this._notesLoaded = false;
        if (this._ext.presenting) {
            this._notes.text = '';
            this._notesStatus.text = 'Hidden while presenting';
            return;
        }
        this._ext.call('NotesGet', [], (res, err) => {
            this._notes.text = err ? '' : res[0];
            this._notesLoaded = !err;
            this._notesStatus.text = err ? 'Daemon not running' : '';
        });
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
        this._clipList.destroy_all_children();
        const items = this._filteredClips();
        let msg = '';
        if (this._ext.presenting) {
            this._message(this._clipMsg, 'Hidden while presenting');
            return;
        }
        if (error)
            msg = error;
        else if (!this._clipItems.length)
            msg = 'Copy something and it shows up here';
        else if (!items.length)
            msg = 'No matches';
        this._message(this._clipMsg, msg);
        for (const it of items.slice(0, 100)) {
            const box = new St.BoxLayout({x_expand: true});
            const preview = it.text.slice(0, 300).replace(/\s*\n\s*/g, ' ⏎ ');
            box.add_child(label('goisland-clip-text', {text: preview, x_expand: true}));
            box.add_child(iconButton('view-app-grid-symbolic', 'goisland-row-btn',
                () => this._showQR(it.text), 'Show as QR code'));
            box.add_child(iconButton('view-pin-symbolic', `goisland-row-btn${it.pinned ? ' pinned' : ''}`,
                () => this._ext.call('ClipboardPin', [it.id, !it.pinned], () => this._loadClipboard()),
                it.pinned ? 'Unpin' : 'Pin'));
            box.add_child(iconButton('edit-delete-symbolic', 'goisland-row-btn',
                () => this._ext.call('ClipboardDelete', [it.id], () => this._loadClipboard()), 'Delete'));
            const row = new St.Button({style_class: 'goisland-row goisland-clip-row', can_focus: true, child: box, x_expand: true});
            row.connect('clicked', () => this._copy(it.text));
            this._clipList.add_child(row);
        }
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

        const card = new St.BoxLayout({style_class: 'goisland-card goisland-sites-card', ...VERTICAL, x_expand: true, y_expand: true});
        const head = new St.BoxLayout({style_class: 'goisland-section-head'});
        head.add_child(label('goisland-group', {text: 'SAVED SITES', x_expand: true}));
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
        this._calcRow.visible = v !== null;
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
            if (this._addRow.visible)
                this._addUrl.grab_key_focus();
        });
        return btn;
    }

    // ---------- state ----------

    setState(state) {
        const prev = this._state;
        this._state = state ?? IDLE;
        const k = this._state.kind;
        if (k === 'media')
            this._media = this._state;
        else if (k === 'idle')
            this._media = null;
        // A running timer outranks media, so seeing media/idle means no timer.
        if (k === 'timer')
            this._timer = this._state;
        else if (k === 'idle' || k === 'media')
            this._timer = null;
        this._react(prev);
        this._render(prev);
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
        this._face.actor.visible = mode === 'idle';
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
            this.openDash(s.kind === 'agent' ? 'agents' : 'home');
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
        const valid = TABS.some(([id]) => id === tab);
        if (this._dashOpen) {
            if (valid && tab !== this._tab)
                this._showTab(tab);
            else
                this._closeDash();
            return;
        }
        this.openDash(valid ? tab : 'home');
    }

    openDash(tab) {
        if (this._dashOpen)
            return;
        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        if ((this._grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            Main.popModal(this._grab); // another grab is active (e.g. a menu)
            this._grab = null;
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
        this._tabName.text = TABS.find(([tid]) => tid === id)?.[1] ?? {qr: 'QR code', logs: 'Logs'}[id] ?? '';
        if (id === 'logs')
            this._tabButtons.docker.checked = true;

        this._stopDocker();
        let focus = this;
        if (id === 'logs') {
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
            this._xfOut.text = '';
            this._xfInfo.text = '';
            this._loadTransformInput();
            focus = this._xfIn;
        } else if (id === 'notes') {
            this._loadNotes();
            focus = this._notes;
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

    _stopDocker() {
        if (this._dockerId) {
            GLib.source_remove(this._dockerId);
            this._dockerId = 0;
        }
    }

    _message(lbl, text) {
        lbl.text = text ?? '';
        lbl.visible = !!text;
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
        if (this._dashOpen && (this._tab === 'clipboard' || this._tab === 'notes'))
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
        case 'dashboard':
            return [DASH_WIDTH * k, (DASH_HEIGHT[this._tab] ?? DASH_HEIGHT.default) * k];
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
        const osd = Main.osdWindowManager;
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
        if (this._clipTimer) {
            GLib.source_remove(this._clipTimer);
            this._clipTimer = 0;
        }
        if (this._origOsdShow) {
            Main.osdWindowManager.show = this._origOsdShow;
            this._origOsdShow = null;
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
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !source || !this._proxy || this.presenting)
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
            this._signalIds = [
                proxy.connectSignal('StateChanged', (_p, _sender, [json]) => this._applyState(json)),
                proxy.connectSignal('OpenDashboard', (_p, _sender, [tab]) => this._island?.toggleDash(tab)),
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
