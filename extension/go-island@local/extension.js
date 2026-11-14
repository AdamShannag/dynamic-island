// Go Island: a thin view layer. All logic lives in the islandd daemon; this
// extension renders whatever View JSON it receives over D-Bus.
//
// - Replaces the top-bar clock. Idle, the pill shows the time.
// - Live activities (media, timers, notifications) grow out of the bar.
// - Left-click opens the dashboard (Now Playing / Docker / Clipboard /
//   Search); right-click opens the regular calendar menu.
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
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

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
    <signal name="StateChanged"><arg name="state" type="s"/></signal>
  </interface>
</node>`;
const IslandProxy = Gio.DBusProxy.makeProxyWrapper(IFACE_XML);

const MORPH_MS = 450;
const FADE_OUT_MS = 90;
const FADE_IN_MS = 220;
const DOCKER_REFRESH_MS = 3000;
const IDLE = {kind: 'idle'};
const MODES = ['idle', 'compact', 'notify', 'dashboard'];
const ACCENTS = ['ok', 'warn', 'error'];
const TABS = [
    ['media', 'Now Playing', 'audio-x-generic-symbolic'],
    ['docker', 'Docker', 'network-server-symbolic'],
    ['ports', 'Ports', 'network-wired-symbolic'],
    ['clipboard', 'Clipboard', 'edit-paste-symbolic'],
    ['search', 'Web', 'web-browser-symbolic'],
];
const SITE_COLS = 7;
const TILE_COLORS = ['#0a84ff', '#30d158', '#ff9f0a', '#ff375f', '#bf5af2', '#64d2ff', '#ff453a', '#5e5ce6'];
// Password managers mark secrets with this mime type; never record them.
const SECRET_MIME = 'x-kde-passwordManagerHint';

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

const Island = GObject.registerClass(
class Island extends St.BoxLayout {
    _init(ext) {
        super._init({
            style_class: 'goisland idle',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            opacity: 0,
        });
        this._ext = ext;
        this._state = IDLE;
        this._media = null; // last media view; survives notifications covering it
        this._mode = 'idle';
        this._dashOpen = false;
        this._tab = 'clipboard';
        this._grab = null;
        this._tickId = 0;
        this._dockerId = 0;
        this._shown = false;
        this._clipItems = [];
        this.set_pivot_point(0.5, 0);

        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connectObject('notify::clock', () => this._tick(), this);
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

        this._buildPill();
        this._buildDash();

        this.connect('button-release-event', (_a, event) => this._onClick(event));
        this.connect('captured-event', (_a, event) => this._onCapturedEvent(event));
        this.connect('destroy', () => {
            this._closeDash(false);
            this._stopTicker();
            this._wallClock = null;
        });
    }

    // ---------- construction ----------

    _buildPill() {
        this._content = new St.BoxLayout({style_class: 'goisland-content', x_expand: true, y_expand: true});
        this.add_child(this._content);

        this._art = new St.Bin({style_class: 'goisland-art', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'goisland-icon', y_align: Clutter.ActorAlign.CENTER});
        const text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = label('goisland-title');
        this._subtitle = label('goisland-subtitle');
        text.add_child(this._title);
        text.add_child(this._subtitle);
        this._trailing = label('goisland-trailing');

        // Tiny "now playing" equalizer for the compact media pill.
        this._eq = new St.BoxLayout({style_class: 'goisland-eq', y_align: Clutter.ActorAlign.CENTER});
        this._eqBars = [0, 1, 2, 3].map(() => {
            const bar = new St.Widget({style_class: 'goisland-eq-bar', y_expand: true});
            bar.set_pivot_point(0.5, 1);
            bar.scale_y = 0.35;
            this._eq.add_child(bar);
            return bar;
        });
        this._eqRunning = false;

        for (const a of [this._art, this._icon, text, this._eq, this._trailing])
            this._content.add_child(a);
    }

    _syncEqualizer() {
        const s = this._state;
        const show = s.kind === 'media' && this._mode === 'compact';
        this._eq.visible = show;
        const run = show && !!s.playing;
        if (run === this._eqRunning)
            return;
        this._eqRunning = run;
        this._eqBars.forEach((bar, i) => {
            bar.remove_all_transitions();
            bar.scale_y = 0.35;
            if (run) {
                bar.ease({
                    scale_y: 1,
                    duration: [420, 300, 520, 360][i],
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                    repeatCount: -1,
                    autoReverse: true,
                });
            }
        });
    }

    _buildDash() {
        this._dash = new St.BoxLayout({
            style_class: 'goisland-dash', vertical: true, x_expand: true, y_expand: true, visible: false,
        });
        this.add_child(this._dash);

        const tabs = new St.BoxLayout({style_class: 'goisland-tabs'});
        this._tabButtons = {};
        for (const [id, text, icon] of TABS) {
            const box = new St.BoxLayout({style_class: 'goisland-tab-box'});
            box.add_child(new St.Icon({icon_name: icon, style_class: 'goisland-tab-icon'}));
            box.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER}));
            const btn = new St.Button({style_class: 'goisland-tab', can_focus: true, child: box});
            btn.connect('clicked', () => this._showTab(id));
            tabs.add_child(btn);
            this._tabButtons[id] = btn;
        }
        this._dash.add_child(tabs);

        const body = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._pages = {
            media: this._buildMediaPage(),
            docker: this._buildDockerPage(),
            ports: this._buildPortsPage(),
            clipboard: this._buildClipboardPage(),
            search: this._buildSearchPage(),
        };
        for (const page of Object.values(this._pages)) {
            page.set({x_expand: true, y_expand: true, visible: false});
            body.add_child(page);
        }
        this._dash.add_child(body);
    }

    _buildMediaPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page goisland-media'});
        this._mArt = new St.Bin({style_class: 'goisland-dash-art', y_align: Clutter.ActorAlign.CENTER});
        this._mIcon = new St.Icon({
            style_class: 'goisland-dash-art-icon', icon_name: 'audio-x-generic-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const col = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._mTitle = label('goisland-dash-title');
        this._mSub = label('goisland-subtitle');

        this._progress = new St.BoxLayout({style_class: 'goisland-progress'});
        this._posLabel = label('goisland-time');
        this._lenLabel = label('goisland-time');
        this._track = new St.Widget({
            style_class: 'goisland-track', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.BinLayout(),
        });
        this._fill = new St.Widget({style_class: 'goisland-fill', x_align: Clutter.ActorAlign.START, y_expand: true});
        this._track.add_child(this._fill);
        for (const a of [this._posLabel, this._track, this._lenLabel])
            this._progress.add_child(a);

        const controls = new St.BoxLayout({style_class: 'goisland-controls', x_align: Clutter.ActorAlign.CENTER});
        controls.add_child(iconButton('media-skip-backward-symbolic', 'goisland-btn',
            () => this._ext.action('media.previous'), 'Previous'));
        this._playBtn = iconButton('media-playback-start-symbolic', 'goisland-btn goisland-btn-big',
            () => this._ext.action('media.play-pause'), 'Play/Pause');
        controls.add_child(this._playBtn);
        controls.add_child(iconButton('media-skip-forward-symbolic', 'goisland-btn',
            () => this._ext.action('media.next'), 'Next'));

        for (const a of [this._mTitle, this._mSub, this._progress, controls])
            col.add_child(a);
        this._mEmpty = label('goisland-empty', {text: 'Nothing playing', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        for (const a of [this._mArt, this._mIcon, col, this._mEmpty])
            page.add_child(a);
        this._mCol = col;
        return page;
    }

    _buildDockerPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page', vertical: true});
        this._dockerList = new St.BoxLayout({vertical: true, style_class: 'goisland-list'});
        this._dockerMsg = label('goisland-empty', {x_align: Clutter.ActorAlign.CENTER, visible: false});
        page.add_child(this._dockerMsg);
        page.add_child(scrollView(this._dockerList));
        return page;
    }

    _buildPortsPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page', vertical: true});
        this._portEntry = new St.Entry({
            style_class: 'goisland-entry',
            hint_text: 'Filter, or type a port and press Enter to kill it…',
            can_focus: true,
            x_expand: true,
        });
        this._portEntry.clutter_text.connect('text-changed', () => this._renderPorts());
        this._portEntry.clutter_text.connect('activate', () => {
            const port = Number(this._portEntry.text.trim().replace(/^:/, ''));
            if (Number.isInteger(port) && port > 0 && port < 65536) {
                this._portEntry.text = '';
                this._freePort(port);
            }
        });
        this._portList = new St.BoxLayout({vertical: true, style_class: 'goisland-list'});
        this._portMsg = label('goisland-empty', {x_align: Clutter.ActorAlign.CENTER, visible: false});
        page.add_child(this._portEntry);
        page.add_child(this._portMsg);
        page.add_child(scrollView(this._portList));
        this._ports = [];
        return page;
    }

    _buildClipboardPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page', vertical: true});
        const top = new St.BoxLayout({style_class: 'goisland-clip-top'});
        this._clipFilter = new St.Entry({
            style_class: 'goisland-entry', hint_text: 'Filter clipboard…', can_focus: true, x_expand: true,
        });
        this._clipFilter.clutter_text.connect('text-changed', () => this._renderClipboard());
        this._clipFilter.clutter_text.connect('activate', () => {
            const first = this._filteredClips()[0];
            if (first)
                this._copy(first.text);
        });
        const clear = new St.Button({style_class: 'goisland-pill-btn', label: 'Clear', can_focus: true});
        clear.connect('clicked', () => this._ext.call('ClipboardClear', [], () => this._loadClipboard()));
        top.add_child(this._clipFilter);
        top.add_child(clear);
        this._clipList = new St.BoxLayout({vertical: true, style_class: 'goisland-list'});
        this._clipMsg = label('goisland-empty', {x_align: Clutter.ActorAlign.CENTER, visible: false});
        page.add_child(top);
        page.add_child(this._clipMsg);
        page.add_child(scrollView(this._clipList));
        return page;
    }

    _buildSearchPage() {
        const page = new St.BoxLayout({style_class: 'goisland-page goisland-web', vertical: true});
        this._searchEntry = new St.Entry({
            style_class: 'goisland-entry goisland-search-entry',
            hint_text: 'Search Google or enter an address',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'system-search-symbolic', style_class: 'goisland-entry-icon'}),
        });
        this._searchEntry.clutter_text.connect('activate', () => {
            const q = this._searchEntry.text.trim();
            if (!q)
                return;
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
        page.add_child(this._searchEntry);

        const head = new St.BoxLayout({style_class: 'goisland-section-head'});
        head.add_child(label('goisland-group', {text: 'SAVED SITES', x_expand: true}));
        head.add_child(label('goisland-hint', {text: 'Right-click a site to remove it'}));
        page.add_child(head);

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
        page.add_child(this._addRow);

        this._siteGrid = new St.BoxLayout({vertical: true, style_class: 'goisland-site-grid'});
        page.add_child(scrollView(this._siteGrid));
        this._sites = [];
        return page;
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
        const box = new St.BoxLayout({vertical: true, style_class: 'goisland-site-box'});
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
        if (this._state.kind === 'media')
            this._media = this._state;
        else if (this._state.kind === 'idle')
            this._media = null;
        this._render(prev);
    }

    _targetMode() {
        const s = this._state;
        if (this._dashOpen)
            return 'dashboard';
        if (s.kind === 'idle')
            return 'idle';
        if (s.kind === 'media')
            return 'compact';
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
        this._content.remove_all_transitions();
        this._dash.remove_all_transitions();
        const target = this._mode === 'dashboard' ? this._dash : this._content;
        target.ease({
            opacity: 0,
            duration: FADE_OUT_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._wallClock)
                    return; // destroyed
                this._apply();
                this.relayout(true);
                const shown = this._mode === 'dashboard' ? this._dash : this._content;
                shown.opacity = 0;
                shown.ease({
                    opacity: 255,
                    delay: 100,
                    duration: FADE_IN_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            },
        });
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

        this._dash.visible = mode === 'dashboard';
        this._content.visible = mode !== 'dashboard';

        this._title.text = s.title ?? '';
        this._title.visible = mode !== 'idle';
        this._subtitle.text = s.subtitle ?? '';
        this._subtitle.visible = mode === 'notify' && !!s.subtitle;
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

        this._applyMedia();
        this._syncEqualizer();
        this._tick();
        this._syncTicker();
    }

    _applyMedia() {
        const m = this._media;
        this._mEmpty.visible = !m;
        this._mCol.visible = !!m;
        this._mArt.visible = !!m?.art;
        this._mIcon.visible = !!m && !m.art;
        if (!m)
            return;
        if (m.art)
            this._mArt.style = `background-image: url("file://${encodeURI(m.art)}");`;
        this._mTitle.text = m.title ?? '';
        this._mSub.text = m.subtitle ?? '';
        this._mSub.visible = !!m.subtitle;
        this._progress.visible = !!m.timing;
        this._playBtn.child.icon_name = m.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
    }

    // Live parts: clock, countdown/elapsed, media progress.
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
        else if (s.kind === 'media')
            trailing = this._shortTime();
        this._trailing.text = trailing;
        this._trailing.visible = trailing !== '';

        const m = this._media;
        const t = m?.timing;
        if (t && this._dashOpen && this._tab === 'media') {
            const elapsed = m.playing ? (now - t.at) / 1000 * (t.rate || 1) : 0;
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
            (this._dashOpen && this._tab === 'media' && this._media?.playing));
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

    // ---------- input ----------

    _onClick(event) {
        const button = event.get_button();
        if (this._dashOpen)
            return Clutter.EVENT_STOP; // clicks on dashboard background do nothing
        if (button === Clutter.BUTTON_SECONDARY) {
            Main.panel.statusArea.dateMenu?.menu.toggle();
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const s = this._state;
        if (s.kind !== 'media' && s.click) // e.g. dismiss a notification
            this._ext.action(s.click);
        else
            this.openDash(this._media ? 'media' : this._tab);
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
        this._render(this._state);
        this._showTab(tab);
    }

    _closeDash(render = true) {
        if (!this._dashOpen)
            return;
        this._dashOpen = false;
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

        this._stopDocker();
        if (id === 'docker') {
            this._loadDocker();
            this._dockerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DOCKER_REFRESH_MS, () => {
                this._loadDocker();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (id === 'ports') {
            this._portEntry.text = '';
            this._loadPorts();
            this._portEntry.grab_key_focus();
        } else if (id === 'clipboard') {
            this._clipFilter.text = '';
            this._loadClipboard();
            this._clipFilter.grab_key_focus();
        } else if (id === 'search') {
            this._addRow.hide();
            this._loadSites();
            this._searchEntry.grab_key_focus();
        } else {
            this._tabButtons[id].grab_key_focus();
        }
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

    // ----- Docker tab -----

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
            const col = new St.BoxLayout({vertical: true, x_expand: true});
            col.add_child(label('goisland-row-title', {text: c.name}));
            const meta = [c.status, c.ports && `:${c.ports}`, c.image].filter(Boolean).join('  ·  ');
            col.add_child(label('goisland-row-sub', {text: meta}));
            row.add_child(col);
            for (const [op, icon] of [['restart', 'view-refresh-symbolic'], ['stop', 'media-playback-stop-symbolic']]) {
                row.add_child(iconButton(icon, 'goisland-row-btn', () => {
                    row.opacity = 128;
                    this._ext.call('DockerAction', [c.id, op], () => this._loadDocker());
                }, `${op} ${c.name}`));
            }
            this._dockerList.add_child(row);
        }
    }

    // ----- Ports tab -----

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
        this._message(this._portMsg, error ?? (items.length ? '' : q ? 'No matches (Enter kills that port)' : 'Nothing listening'));
        for (const l of items) {
            const row = new St.BoxLayout({style_class: 'goisland-row'});
            row.add_child(label('goisland-port', {text: `:${l.port}`}));
            const col = new St.BoxLayout({vertical: true, x_expand: true});
            const owner = l.container ? `🐳 ${l.container}` : l.process ? `${l.process} · pid ${l.pid}` : 'other user (needs sudo)';
            col.add_child(label('goisland-row-title', {text: owner}));
            col.add_child(label('goisland-row-sub', {text: [l.addr, l.cmd].filter(Boolean).join('  ·  ')}));
            row.add_child(col);
            if (l.container || l.pid) {
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

    _freePort(port) {
        // The daemon also pops the island with the result once the dashboard closes.
        this._ext.call('PortFree', [port], () => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                if (this._dashOpen && this._tab === 'ports')
                    this._loadPorts();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // ----- Clipboard tab -----

    _loadClipboard() {
        this._ext.call('ClipboardList', [], (res, err) => {
            if (err) {
                this._clipItems = [];
                this._message(this._clipMsg, 'Daemon not running');
            } else {
                this._clipItems = JSON.parse(res[0]) ?? [];
            }
            this._renderClipboard();
        });
    }

    _filteredClips() {
        const q = this._clipFilter.text.trim().toLowerCase();
        return q ? this._clipItems.filter(it => it.text.toLowerCase().includes(q)) : this._clipItems;
    }

    _renderClipboard() {
        this._clipList.destroy_all_children();
        const items = this._filteredClips();
        if (this._clipItems.length && !items.length)
            this._message(this._clipMsg, 'No matches');
        else
            this._message(this._clipMsg, this._clipItems.length ? '' : 'Copy something and it shows up here');
        for (const it of items.slice(0, 100)) {
            const box = new St.BoxLayout({x_expand: true});
            const preview = it.text.slice(0, 300).replace(/\s*\n\s*/g, ' ⏎ ');
            box.add_child(label('goisland-clip-text', {text: preview, x_expand: true}));
            const pin = iconButton('view-pin-symbolic', `goisland-row-btn${it.pinned ? ' pinned' : ''}`,
                () => this._ext.call('ClipboardPin', [it.id, !it.pinned], () => this._loadClipboard()),
                it.pinned ? 'Unpin' : 'Pin');
            const del = iconButton('edit-delete-symbolic', 'goisland-row-btn',
                () => this._ext.call('ClipboardDelete', [it.id], () => this._loadClipboard()), 'Delete');
            box.add_child(pin);
            box.add_child(del);
            const row = new St.Button({style_class: 'goisland-row goisland-clip-row', can_focus: true, child: box, x_expand: true});
            row.connect('clicked', () => this._copy(it.text));
            this._clipList.add_child(row);
        }
    }

    _copy(text) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._closeDash();
    }

    // ---------- layout ----------

    _size() {
        const barH = Math.max(24, Main.panel.height - 6);
        switch (this._mode) {
        case 'idle': {
            const [, natural] = this._content.get_preferred_width(barH);
            return [Math.max(140, Math.ceil(natural) + 36), barH];
        }
        case 'notify':
            return [400, 64];
        case 'dashboard':
            return [660, 440];
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
            opacity: 255, scale_x: 1, scale_y: 1,
            duration: MORPH_MS, mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }
});

export default class GoIslandExtension extends Extension {
    enable() {
        this._island = new Island(this);
        Main.layoutManager.addTopChrome(this._island, {
            affectsInputRegion: true,
            trackFullscreen: true, // hide over fullscreen apps (like the top bar)
        });

        // Take over the clock: keep the dateMenu button (its menu still
        // anchors there, opened via right-click) but hide it under the pill.
        this._dateMenu = Main.panel.statusArea.dateMenu;
        this._dateMenu?.container.set_opacity(0);

        this._island.setState(IDLE);
        Main.layoutManager.connectObject('monitors-changed', () => this._island.relayout(false), this);
        Main.panel.connectObject('notify::height', () => this._island.relayout(false), this);

        // Clipboard history: only the compositor can read the clipboard on Wayland.
        global.display.get_selection().connectObject('owner-changed',
            (_sel, type, source) => this._onClipboardChanged(type, source), this);

        this._watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION, BUS_NAME, Gio.BusNameWatcherFlags.NONE,
            () => this._connect(),
            () => this._disconnect());
    }

    disable() {
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

    _onClipboardChanged(type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !source || !this._proxy)
            return;
        if (source.get_mimetypes().includes(SECRET_MIME))
            return;
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_cb, text) => {
            if (text && text.trim())
                this.call('ClipboardAdd', [text]);
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
            this._signalId = proxy.connectSignal('StateChanged',
                (_p, _sender, [json]) => this._applyState(json));
            this.call('GetState', [], (result, err) => {
                if (!err && !cancellable.is_cancelled())
                    this._applyState(result[0]);
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
        this._proxy[`${method}Remote`](...args, (result, err) => {
            if (err)
                console.error(`go-island: ${method}: ${err.message}`);
            cb?.(result, err);
        });
    }

    action(name) {
        this.call('Action', [name]);
    }
}
