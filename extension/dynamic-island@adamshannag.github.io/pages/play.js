import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Cairo from 'gi://cairo';

import {TILE_COLORS, featureOn} from '../lib/constants.js';
import {correctPrefix, hashColor, hexToRgb} from '../lib/format.js';
import {springTo} from '../lib/motion.js';
import {
    EmptyState, badge, column, fillList, group, label, page, pillButton, scrollView,
    setText,
} from '../lib/widgets.js';
import {Page} from './page.js';

const SELF_CARET_COLOR = '#0a84ff';
const SELF_CARET_MS = 110;
const PEER_CARET_MS = 350;

const INK_COLOR = '#1c1c1e';
const INK_WIDTH = 3;
const CANVAS_BG = '#f5f5f7';
const STROKE_FLUSH_MS = 80;
const SWATCH_COLORS = ['#1c1c1e', '#ff453a', '#0a84ff', '#30d158', '#ff9f0a'];

function chipSpec(status) {
    if (status === 'accepted')
        return {text: 'Ready', kind: 'ready'};
    if (status === 'declined')
        return {text: 'Declined', kind: 'declined'};
    return {text: 'Waiting', kind: 'waiting'};
}

export class PlayPage extends Page {
    static id = 'play';
    static title = '';
    static autoHeight = false;
    static interval = 1000;

    build() {
        const actor = page();

        this._idle = this._buildIdle();
        this._lobbyHost = this._buildLobbyHost();
        this._lobbyGuest = this._buildLobbyGuest();
        this._racing = this._buildRacing();
        this._drawing = this._buildDrawing();
        this._guessing = this._buildGuessing();
        this._reveal = this._buildReveal();
        this._result = this._buildResult();
        this._pageEmpty = new EmptyState();

        this._views = {
            idle: this._idle, lobbyHost: this._lobbyHost, lobbyGuest: this._lobbyGuest,
            racing: this._racing, drawing: this._drawing, guessing: this._guessing,
            reveal: this._reveal, result: this._result,
        };

        for (const view of Object.values(this._views))
            actor.add_child(view);
        actor.add_child(this._pageEmpty.actor);
        return actor;
    }

    _playerColor(peerId) {
        return hashColor(peerId, TILE_COLORS);
    }

    _chip(status) {
        const spec = chipSpec(status);
        return label(`island-race-chip ${spec.kind}`, {text: spec.text});
    }

    // ---- Idle / invite ----------------------------------------------

    _buildIdle() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        const eyebrow = label('island-igroup-title', {text: 'NEARBY'});
        const subtitle = label('island-race-subtitle', {text: 'Tap someone to invite them to play'});
        this._peerEmpty = new EmptyState();
        this._peerFlow = new St.Widget({
            layout_manager: new Clutter.FlowLayout({
                orientation: Clutter.Orientation.HORIZONTAL, homogeneous: false, column_spacing: 36, row_spacing: 22,
            }),
            x_align: Clutter.ActorAlign.CENTER,
        });
        const flowWrap = column({x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER});
        flowWrap.add_child(this._peerFlow);
        this._idleScroll = scrollView(flowWrap);
        view.add_child(eyebrow);
        view.add_child(subtitle);
        view.add_child(this._peerEmpty.actor);
        view.add_child(this._idleScroll);
        return view;
    }

    _peerAvatar(peer, onPick) {
        const col = column({x_align: Clutter.ActorAlign.CENTER});
        const badgeActor = badge({glyph: (peer.name[0] ?? '?').toUpperCase(), color: this._playerColor(peer.id)});
        badgeActor.add_style_class_name('island-race-peer-avatar');
        badgeActor.x_align = Clutter.ActorAlign.CENTER;
        badgeActor.y_align = Clutter.ActorAlign.CENTER;
        const ring = new St.Widget({style_class: 'island-race-peer-ring', layout_manager: new Clutter.BinLayout()});
        ring.add_child(badgeActor);
        const btn = new St.Button({style_class: 'island-race-peer-btn', can_focus: true, child: ring});
        const name = label('island-irow-title island-race-peer-name', {text: peer.name, x_align: Clutter.ActorAlign.CENTER});
        const addr = label('island-irow-sub island-race-peer-addr', {text: peer.addr, x_align: Clutter.ActorAlign.CENTER});
        const refs = {btn, addr};
        btn.connect('clicked', () => onPick(peer, refs));
        col.add_child(btn);
        col.add_child(name);
        col.add_child(addr);
        return col;
    }

    _peerRow(peer, onPick) {
        const row = new St.BoxLayout({style_class: 'island-irow island-irow-box', x_expand: true});
        const badgeActor = badge({glyph: (peer.name[0] ?? '?').toUpperCase(), color: this._playerColor(peer.id)});
        row.add_child(badgeActor);
        row.add_child(label('island-irow-title', {text: peer.name, x_expand: true}));
        const btn = pillButton('Invite', () => onPick(peer, btn));
        row.add_child(btn);
        return row;
    }

    _renderIdle(peers) {
        const on = featureOn(this.island.settings, 'play');
        const sig = `${on}:${peers.map(p => p.id).join('|')}`;
        if (sig === this._peerSig)
            return;
        this._peerSig = sig;
        if (!on || !peers.length) {
            this._idleScroll.hide();
            this._peerEmpty.show(on ? {
                icon: 'input-keyboard-symbolic', title: 'No one else found on this network yet',
                hint: 'Others show up here once they turn on LAN play',
            } : {
                icon: 'input-keyboard-symbolic', title: 'LAN play is off',
                hint: 'Turn it on in Settings to play with people on your network',
            });
            return;
        }
        this._peerEmpty.hide();
        this._idleScroll.show();
        fillList(this._peerFlow, peers, p => this._peerAvatar(p, (peer, refs) => this._invitePeer(peer, refs)));
    }

    _invitePeer(peer, refs) {
        refs.btn.reactive = false;
        setText(refs.addr, 'Inviting…');
        this.call('PartyCreate', [], () => {
            this.call('PartyInvite', [peer.id], (_result, err) => {
                if (err) {
                    refs.btn.reactive = true;
                    setText(refs.addr, peer.addr);
                    return;
                }
                this.refresh();
            });
        });
    }

    _inviteOnly(peer, btn) {
        btn.reactive = false;
        btn.label = 'Inviting…';
        this.call('PartyInvite', [peer.id], (_result, err) => {
            if (err) {
                btn.reactive = true;
                btn.label = 'Invite';
                return;
            }
            this.refresh();
        });
    }

    _toggleInvitePicker() {
        this._invitePickerOpen = !this._invitePickerOpen;
        this._inviteToggleBtn.label = this._invitePickerOpen ? 'Close' : 'Invite more';
        this._invitePickerActor.visible = this._invitePickerOpen;
        if (this._invitePickerOpen)
            this._refreshInvitePicker();
    }

    _refreshInvitePicker() {
        const invited = this._invitedIds;
        this.fetch('PartyPeers', [], (peers, err) => {
            if (!this._invitePickerOpen)
                return;
            const list = (err ? [] : (peers ?? [])).filter(p => !invited?.has(p.id));
            fillList(this._invitePickerList, list, p => this._peerRow(p, (peer, btn) => this._inviteOnly(peer, btn)));
        });
    }

    // ---- Lobby (host picks a mode; guest watches) --------------------

    _buildLobbyHost() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        const eyebrow = label('island-igroup-title', {text: 'LOBBY'});
        const subtitle = label('island-race-subtitle', {text: 'Waiting for players to accept'});

        const row = new St.BoxLayout({style_class: 'island-race-host-row', x_expand: true, y_expand: true});
        this._inviteToggleBtn = pillButton('Invite more', () => this._toggleInvitePicker());
        const playersGroup = group('PLAYERS', this._inviteToggleBtn);
        this._hostPlayerList = playersGroup.list;
        this._hostPlayerRefs = new Map();
        const pickerGroup = group('INVITE');
        this._invitePickerActor = pickerGroup.actor;
        this._invitePickerList = pickerGroup.list;
        this._invitePickerActor.hide();
        const groups = column({style_class: 'island-groups'});
        groups.add_child(playersGroup.actor);
        groups.add_child(pickerGroup.actor);
        const left = scrollView(groups);
        left.x_expand = true;

        const panel = column({style_class: 'island-race-host-panel', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});

        const modeRow = new St.BoxLayout({style_class: 'island-play-mode-row'});
        this._modeRaceBtn = pillButton('Race', () => this._pickMode('race'));
        this._modeDrawBtn = pillButton('Draw', () => this._pickMode('draw'));
        modeRow.add_child(this._modeRaceBtn);
        modeRow.add_child(this._modeDrawBtn);
        this._modeHint = label('island-race-ready-label', {text: 'Pick a game', x_align: Clutter.ActorAlign.CENTER});

        const ring = new St.Widget({
            style_class: 'island-race-ready-ring', layout_manager: new Clutter.BinLayout(),
            width: 86, height: 86, x_expand: false, y_expand: false, x_align: Clutter.ActorAlign.CENTER,
        });
        this._readyRingLabel = label('island-race-ready-ring-label', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        ring.add_child(this._readyRingLabel);
        this._readyLabel = label('island-race-ready-label', {text: '', x_align: Clutter.ActorAlign.CENTER});
        this._startBtn = pillButton('Start', () => this.call('PartyStart', [], () => this.refresh()), 'primary');
        this._startBtn.add_style_class_name('island-race-start-btn');
        this._startBtn.reactive = false;
        panel.add_child(modeRow);
        panel.add_child(this._modeHint);
        panel.add_child(ring);
        panel.add_child(this._readyLabel);
        panel.add_child(this._startBtn);
        panel.add_child(this._leaveButton('Cancel', 'link'));

        row.add_child(left);
        row.add_child(panel);
        view.add_child(eyebrow);
        view.add_child(subtitle);
        view.add_child(row);
        return view;
    }

    _pickMode(mode) {
        this.call('PartySetMode', [mode], () => this.refresh());
    }

    _buildLobbyGuest() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        this._guestEmpty = new EmptyState();
        this._guestModeLabel = label('island-race-subtitle', {x_align: Clutter.ActorAlign.CENTER});
        this._acceptBtn = pillButton('Accept', () => this._respond(true), 'primary');
        this._declineBtn = pillButton('Decline', () => this._respond(false));
        this._respondBar = new St.BoxLayout({style_class: 'island-toolbar'});
        this._respondBar.add_child(this._acceptBtn);
        this._respondBar.add_child(this._declineBtn);
        this._guestLeaveBar = new St.BoxLayout({style_class: 'island-toolbar'});
        this._guestLeaveBar.add_child(this._leaveButton('Leave'));
        view.add_child(this._guestEmpty.actor);
        view.add_child(this._guestModeLabel);
        view.add_child(this._respondBar);
        view.add_child(this._guestLeaveBar);
        return view;
    }

    _respond(accept) {
        this._acceptBtn.reactive = false;
        this._declineBtn.reactive = false;
        this.call('PartyRespond', [accept], (_result, err) => {
            this._acceptBtn.reactive = true;
            this._declineBtn.reactive = true;
            if (err)
                return;
            this._guestResponded = true;
            this.refresh();
        });
    }

    _renderLobbyHost(state) {
        const players = state.players ?? [];
        this._invitedIds = new Set(players.map(p => p.peerId));
        this._syncHostPlayerRows(players);
        const ready = players.filter(p => p.status === 'accepted').length;
        setText(this._readyRingLabel, `${ready}/${players.length}`);
        setText(this._readyLabel, `${ready} of ${players.length} ready to play`);
        this._modeRaceBtn.checked = state.mode === 'race';
        this._modeDrawBtn.checked = state.mode === 'draw';
        setText(this._modeHint, state.mode ? `Playing ${state.mode === 'race' ? 'Race' : 'Draw'}` : 'Pick a game');
        this._startBtn.reactive = !!state.mode;
        if (this._invitePickerOpen)
            this._refreshInvitePicker();
    }

    _syncHostPlayerRows(players) {
        const sig = players.map(p => p.peerId).join('|');
        if (sig !== this._hostSig) {
            this._hostSig = sig;
            this._hostPlayerList.destroy_all_children();
            this._hostPlayerRefs.clear();
            for (const p of players) {
                const row = new St.BoxLayout({style_class: 'island-irow island-irow-box', x_expand: true});
                const avatar = badge({glyph: (p.name[0] ?? '?').toUpperCase(), color: this._playerColor(p.peerId)});
                avatar.add_style_class_name('island-race-row-avatar');
                const name = label('island-irow-title', {text: p.name, x_expand: true});
                const chip = this._chip(p.status);
                row.add_child(avatar);
                row.add_child(name);
                row.add_child(chip);
                this._hostPlayerList.add_child(row);
                this._hostPlayerRefs.set(p.peerId, {name, row, chip, status: p.status});
            }
            return;
        }
        for (const p of players) {
            const refs = this._hostPlayerRefs.get(p.peerId);
            if (!refs)
                continue;
            setText(refs.name, p.name);
            if (refs.status !== p.status) {
                refs.status = p.status;
                refs.row.remove_child(refs.chip);
                refs.chip = this._chip(p.status);
                refs.row.add_child(refs.chip);
            }
        }
    }

    _renderLobbyGuest(state) {
        const host = (state.players ?? [])[0];
        this._guestEmpty.show({
            icon: 'input-keyboard-symbolic', title: 'Waiting for the host to start',
            hint: host ? `Invited by ${host.name}` : '',
        });
        setText(this._guestModeLabel, state.mode ? `Playing ${state.mode === 'race' ? 'a typing race' : 'draw & guess'}` : 'Waiting for the host to pick a game');
        this._respondBar.visible = !this._guestResponded;
        this._guestLeaveBar.visible = !!this._guestResponded;
    }

    _leaveButton(text, kind) {
        return pillButton(text, () => this.call('PartyLeave', [], () => this.refresh()), kind);
    }

    // ---- Racing --------------------------------------------------------

    _buildRacing() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});

        const top = new St.BoxLayout({x_expand: true});
        const eyebrow = label('island-igroup-title', {text: 'RACING', x_expand: true});
        this._racePresence = new St.Widget({layout_manager: new Clutter.FixedLayout(), height: 30});
        top.add_child(eyebrow);
        top.add_child(this._racePresence);

        const passageWrap = column({x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._passageStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(), width: 620,
            reactive: true, can_focus: true,
        });
        this._passageLabel = new St.Label({style_class: 'island-race-passage', width: 620});
        this._passageLabel.clutter_text.line_wrap = true;
        this._passageLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._passageLabel.reactive = false;
        this._markerLayer = new St.Widget({width: 620, clip_to_allocation: true, reactive: false});
        this._passageStack.add_child(this._passageLabel);
        this._passageStack.add_child(this._markerLayer);
        this._selfCaret = this._makeCaret(SELF_CARET_COLOR);
        this._markerLayer.add_child(this._selfCaret);
        this._raceMarkers = new Map();
        this._typed = '';
        this._racePresenceSig = null;
        this._passageStack.connect('key-press-event', (actor, event) => this._onKeyPress(event));
        passageWrap.add_child(this._passageStack);

        const leaveBtn = this._leaveButton('Leave', 'link');
        leaveBtn.x_align = Clutter.ActorAlign.CENTER;
        view.add_child(top);
        view.add_child(passageWrap);
        view.add_child(leaveBtn);
        return view;
    }

    _makeCaret(color) {
        const caret = new St.Widget({style_class: 'island-race-caret', visible: false});
        caret.set_style(`background-color: ${color}; box-shadow: 0 0 6px 1px ${color};`);
        return caret;
    }

    _passageMarkup(typed) {
        const chars = Array.from(this._passage ?? '');
        const correctLen = correctPrefix(typed, this._passage ?? '');
        const typedLen = Math.min(Array.from(typed ?? '').length, chars.length);
        let out = '', i = 0;
        const flush = (end, color) => {
            if (i >= end)
                return;
            out += `<span foreground="${color}">${GLib.markup_escape_text(chars.slice(i, end).join(''), -1)}</span>`;
            i = end;
        };
        flush(correctLen, '#f5f5f7');
        flush(typedLen, '#ff453a');
        flush(chars.length, '#6e6e73');
        return out;
    }

    _moveCaret(caret, index, duration) {
        if (caret._lastIndex === index)
            return;
        this._passageLabel.get_allocation_box();
        const [found, x, y, lineHeight] = this._passageLabel.clutter_text.position_to_coords(index);
        if (!found)
            return;
        caret.height = lineHeight;
        caret.visible = true;
        if (caret._lastIndex === undefined || duration === 0) {
            caret.x = x;
            caret.y = y;
        } else {
            springTo(caret, {x, y}, duration);
        }
        caret._lastIndex = index;
    }

    _charIndexForProgress(progress) {
        const len = Array.from(this._passage ?? '').length;
        return Math.max(0, Math.min(len, Math.round((progress ?? 0) * len)));
    }

    _onKeyPress(event) {
        if (this._phase !== 'playing' || this._mode !== 'race' || !this._passage)
            return Clutter.EVENT_PROPAGATE;
        const passageLen = Array.from(this._passage).length;
        if (event.get_key_symbol() === Clutter.KEY_BackSpace) {
            const chars = Array.from(this._typed);
            chars.pop();
            this._typed = chars.join('');
            this._applyTyped();
            return Clutter.EVENT_STOP;
        }
        if (event.get_state() & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK))
            return Clutter.EVENT_PROPAGATE;
        const unicode = event.get_key_unicode();
        if (!unicode || Array.from(unicode).length !== 1)
            return Clutter.EVENT_PROPAGATE;
        const code = unicode.codePointAt(0);
        if (code < 0x20 || code === 0x7f)
            return Clutter.EVENT_PROPAGATE;
        const typedLen = Array.from(this._typed).length;
        if (typedLen >= passageLen)
            return Clutter.EVENT_STOP;
        if (typedLen > correctPrefix(this._typed, this._passage))
            return Clutter.EVENT_STOP;
        this._typed += unicode;
        this._applyTyped();
        return Clutter.EVENT_STOP;
    }

    _applyTyped() {
        this._passageLabel.clutter_text.set_markup(this._passageMarkup(this._typed));
        const [, naturalHeight] = this._passageLabel.get_preferred_height(620);
        this._markerLayer.height = naturalHeight;
        this._moveCaret(this._selfCaret, Math.min(Array.from(this._typed).length, Array.from(this._passage).length), SELF_CARET_MS);
        this._submitProgress();
    }

    _submitProgress() {
        const len = correctPrefix(this._typed, this._passage ?? '');
        if (len === this._lastSubmittedLen)
            return;
        this._lastSubmittedLen = len;
        this.call('RaceProgress', [len]);
    }

    _syncRaceMarkers(race) {
        const seen = new Set();
        for (const r of race.racers ?? []) {
            if (r.peerId === this._selfId)
                continue;
            seen.add(r.peerId);
            let caret = this._raceMarkers.get(r.peerId);
            if (!caret) {
                caret = this._makeCaret(this._playerColor(r.peerId));
                this._markerLayer.add_child(caret);
                this._raceMarkers.set(r.peerId, caret);
            }
            const index = r.finishedAtMs ? Array.from(this._passage ?? '').length : this._charIndexForProgress(r.progress);
            this._moveCaret(caret, index, PEER_CARET_MS);
        }
        for (const [peerId, caret] of this._raceMarkers) {
            if (!seen.has(peerId)) {
                caret.destroy();
                this._raceMarkers.delete(peerId);
            }
        }
    }

    _renderRacing(race) {
        const incoming = race.passage ?? '';
        if (this._passage !== incoming) {
            this._passage = incoming;
            this._selfCaret._lastIndex = undefined;
            this._applyTyped();
        }
        this._syncRaceMarkers(race);
        this._syncRacePresence(race.racers ?? []);
    }

    _syncRacePresence(racers) {
        const sig = racers.map(r => r.peerId).join('|');
        if (sig === this._racePresenceSig)
            return;
        this._racePresenceSig = sig;
        this._racePresence.destroy_all_children();
        const selfId = this._selfId;
        const ordered = [...racers].sort((a, b) => (a.peerId === selfId ? -1 : b.peerId === selfId ? 1 : 0));
        const step = 22;
        let x = 0;
        for (const r of ordered) {
            const avatar = badge({glyph: (r.name[0] ?? '?').toUpperCase(), color: r.peerId === selfId ? SELF_CARET_COLOR : this._playerColor(r.peerId)});
            avatar.add_style_class_name('island-race-presence-avatar');
            if (r.peerId === selfId)
                avatar.add_style_class_name('island-race-presence-self');
            avatar.x = x;
            avatar.y = 0;
            this._racePresence.add_child(avatar);
            x += step;
        }
        this._racePresence.width = ordered.length ? x + (30 - step) : 1;
    }

    // ---- Drawing / guessing --------------------------------------------

    _buildPresenceRow() {
        return new St.Widget({layout_manager: new Clutter.FixedLayout(), height: 28});
    }

    _syncDrawPresence(row, players, guessedIds) {
        row.destroy_all_children();
        const step = 20;
        let x = 0;
        for (const p of players) {
            const a = badge({glyph: (p.name[0] ?? '?').toUpperCase(), color: this._playerColor(p.peerId)});
            a.add_style_class_name('island-draw-presence-avatar');
            if (guessedIds?.has(p.peerId))
                a.add_style_class_name('island-draw-presence-guessed');
            a.x = x;
            a.y = 0;
            row.add_child(a);
            x += step;
        }
        row.width = players.length ? x + (28 - step) : 1;
    }

    _buildCanvas() {
        const canvas = new St.DrawingArea({style_class: 'island-draw-canvas', x_expand: true, y_expand: true, reactive: true});
        canvas.connect('repaint', area => this._paint(area));
        canvas.connect('button-press-event', (actor, event) => this._onPressStart(actor, event));
        canvas.connect('motion-event', (actor, event) => this._onPointerMove(actor, event));
        canvas.connect('button-release-event', () => this._onPressEnd());
        canvas.connect('leave-event', () => this._onPressEnd());
        const wrap = new St.BoxLayout({style_class: 'island-draw-canvas-wrap', x_expand: true, y_expand: true});
        wrap.add_child(canvas);
        return {canvas, wrap};
    }

    _buildDrawing() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});

        const top = new St.BoxLayout({x_expand: true});
        this._drawRoundLabel = label('island-igroup-title', {text: '', x_expand: true});
        this._drawTimer = label('island-race-timer');
        this._drawPresence = this._buildPresenceRow();
        top.add_child(this._drawRoundLabel);
        top.add_child(this._drawTimer);
        top.add_child(this._drawPresence);

        this._wordPill = new St.BoxLayout({style_class: 'island-draw-word-pill', x_align: Clutter.ActorAlign.CENTER});
        this._wordLabel = label('island-draw-word-text');
        this._wordPill.add_child(this._wordLabel);
        const wordWrap = new St.Bin({child: this._wordPill, x_align: Clutter.ActorAlign.CENTER});
        this._wordHint = label('island-draw-word-hint', {text: 'Only you can see the word', x_align: Clutter.ActorAlign.CENTER});

        const {canvas: drawCanvas, wrap: canvasWrap} = this._buildCanvas();
        this._drawCanvas = drawCanvas;

        const toolsRow = new St.BoxLayout({x_expand: true});
        this._swatchRow = new St.BoxLayout({style_class: 'island-draw-tools'});
        this._swatchButtons = [];
        this._inkColor = SWATCH_COLORS[0];
        for (const color of SWATCH_COLORS) {
            const sw = new St.Button({style_class: 'island-draw-swatch', can_focus: true});
            sw.set_style(`background-color: ${color};`);
            sw.connect('clicked', () => this._selectColor(color, sw));
            this._swatchRow.add_child(sw);
            this._swatchButtons.push({btn: sw, color});
        }
        this._selectColor(this._inkColor, this._swatchButtons[0].btn);
        const drawLeave = this._leaveButton('Leave', 'link');
        toolsRow.add_child(this._swatchRow);
        const spacer = new St.Widget({x_expand: true});
        toolsRow.add_child(spacer);
        toolsRow.add_child(drawLeave);

        view.add_child(top);
        view.add_child(wordWrap);
        view.add_child(this._wordHint);
        view.add_child(canvasWrap);
        view.add_child(toolsRow);
        return view;
    }

    _selectColor(color, btn) {
        this._inkColor = color;
        for (const s of this._swatchButtons)
            s.btn.checked = s.btn === btn;
    }

    _buildGuessing() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});

        const top = new St.BoxLayout({x_expand: true});
        this._guessRoundLabel = label('island-igroup-title', {text: '', x_expand: true});
        this._guessTimer = label('island-race-timer');
        this._guessPresence = this._buildPresenceRow();
        top.add_child(this._guessRoundLabel);
        top.add_child(this._guessTimer);
        top.add_child(this._guessPresence);

        const drawerRow = new St.BoxLayout({style_class: 'island-draw-drawer-row', x_align: Clutter.ActorAlign.CENTER});
        this._drawerAvatar = badge({glyph: '?', color: '#8e8e93'});
        this._drawerAvatar.add_style_class_name('island-draw-drawer-avatar');
        this._drawerLabel = label('island-draw-drawer-label');
        drawerRow.add_child(this._drawerAvatar);
        drawerRow.add_child(this._drawerLabel);
        const drawerWrap = new St.Bin({child: drawerRow, x_align: Clutter.ActorAlign.CENTER});

        const {canvas: guessCanvas, wrap: guessCanvasWrap} = this._buildCanvas();
        this._guessCanvas = guessCanvas;

        this._guessEntry = new St.Entry({
            style_class: 'island-draw-guess-entry', hint_text: 'Type your guess…',
            can_focus: true, x_expand: true,
        });
        this._guessEntry.clutter_text.connect('activate', () => this._submitGuess());
        const guessLeave = this._leaveButton('Leave', 'link');
        guessLeave.x_align = Clutter.ActorAlign.CENTER;

        view.add_child(top);
        view.add_child(drawerWrap);
        view.add_child(guessCanvasWrap);
        view.add_child(this._guessEntry);
        view.add_child(guessLeave);
        return view;
    }

    _buildReveal() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        this._revealWord = label('island-race-finish-title', {x_align: Clutter.ActorAlign.CENTER});
        this._revealHint = label('island-race-subtitle', {x_align: Clutter.ActorAlign.CENTER, text: 'Next round starting…'});
        const scoresGroup = group('THIS ROUND');
        this._revealScoresList = scoresGroup.list;
        const groups = column({style_class: 'island-groups'});
        groups.add_child(scoresGroup.actor);
        view.add_child(this._revealWord);
        view.add_child(this._revealHint);
        view.add_child(scrollView(groups));
        return view;
    }

    _paint(area) {
        const cr = area.get_context();
        try {
            const [w, h] = area.get_surface_size();
            const [bgR, bgG, bgB] = hexToRgb(CANVAS_BG);
            cr.setSourceRGB(bgR, bgG, bgB);
            cr.rectangle(0, 0, w, h);
            cr.fill();
            for (const stroke of this._strokes ?? [])
                this._paintStroke(cr, stroke, w, h);
            if (this._liveStroke)
                this._paintStroke(cr, this._liveStroke, w, h);
        } finally {
            cr.$dispose();
        }
    }

    _paintStroke(cr, stroke, w, h) {
        const pts = stroke.points ?? [];
        if (pts.length === 0)
            return;
        const [r, g, b] = hexToRgb(stroke.color || INK_COLOR);
        const width = stroke.width || INK_WIDTH;
        cr.setSourceRGB(r, g, b);
        cr.setLineWidth(width);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        if (pts.length === 1) {
            cr.arc(pts[0].x * w, pts[0].y * h, width / 2, 0, 2 * Math.PI);
            cr.fill();
            return;
        }
        cr.moveTo(pts[0].x * w, pts[0].y * h);
        for (let i = 1; i < pts.length; i++)
            cr.lineTo(pts[i].x * w, pts[i].y * h);
        cr.stroke();
    }

    _localPoint(actor, event) {
        const [sx, sy] = event.get_coords();
        const [ok, lx, ly] = actor.transform_stage_point(sx, sy);
        if (!ok)
            return null;
        const box = actor.get_allocation_box();
        const w = box.get_width(), h = box.get_height();
        if (w <= 0 || h <= 0)
            return null;
        return {x: Math.min(1, Math.max(0, lx / w)), y: Math.min(1, Math.max(0, ly / h))};
    }

    _isSelfDrawing() {
        return this._phase === 'playing' && this._mode === 'draw' && this._drawerId && this._drawerId === this._selfId;
    }

    _onPressStart(actor, event) {
        if (!this._isSelfDrawing())
            return Clutter.EVENT_PROPAGATE;
        const p = this._localPoint(actor, event);
        if (!p)
            return Clutter.EVENT_PROPAGATE;
        this._liveStroke = {points: [p], color: this._inkColor, width: INK_WIDTH};
        this._lastFlushAt = GLib.get_monotonic_time() / 1000;
        actor.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    _onPointerMove(actor, event) {
        if (!this._liveStroke)
            return Clutter.EVENT_PROPAGATE;
        const p = this._localPoint(actor, event);
        if (!p)
            return Clutter.EVENT_PROPAGATE;
        this._liveStroke.points.push(p);
        actor.queue_repaint();
        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastFlushAt >= STROKE_FLUSH_MS) {
            this._flushLiveStroke(false);
            this._lastFlushAt = now;
        }
        return Clutter.EVENT_STOP;
    }

    _onPressEnd() {
        if (!this._liveStroke)
            return Clutter.EVENT_PROPAGATE;
        this._flushLiveStroke(true);
        return Clutter.EVENT_STOP;
    }

    _flushLiveStroke(final) {
        const stroke = this._liveStroke;
        if (!stroke)
            return;
        const last = stroke.points[stroke.points.length - 1];
        this._liveStroke = final ? null : {points: [last], color: stroke.color, width: stroke.width};
        if (stroke.points.length === 0)
            return;
        this._strokes = [...(this._strokes ?? []), stroke];
        this.call('DrawStroke', [JSON.stringify(stroke)]);
    }

    _submitGuess() {
        const text = this._guessEntry.text.trim();
        this._guessEntry.text = '';
        if (!text)
            return;
        this.call('DrawGuess', [text]);
    }

    _renderDrawing(draw, isDrawer) {
        this._strokes = draw.strokes ?? [];
        const secsLeft = Math.max(0, Math.round(((draw.roundEndsAtMs ?? 0) - Date.now()) / 1000));
        const players = draw.players ?? [];
        const guessedIds = new Set(draw.guessed ?? []);
        if (isDrawer) {
            setText(this._drawRoundLabel, `ROUND ${draw.round} OF ${draw.totalRounds} · YOU'RE DRAWING`);
            setText(this._drawTimer, `${secsLeft}s`);
            setText(this._wordLabel, (draw.word ?? '').toUpperCase());
            this._syncDrawPresence(this._drawPresence, players, guessedIds);
        } else {
            setText(this._guessRoundLabel, `ROUND ${draw.round} OF ${draw.totalRounds}`);
            setText(this._guessTimer, `${secsLeft}s`);
            this._drawerAvatar.set_style(`background-color: ${this._playerColor(draw.drawerId)};`);
            this._drawerAvatar.child.text = (draw.drawerName?.[0] ?? '?').toUpperCase();
            setText(this._drawerLabel, `${draw.drawerName} is drawing`);
            this._syncDrawPresence(this._guessPresence, players, guessedIds);
        }
        (isDrawer ? this._drawCanvas : this._guessCanvas).queue_repaint();
    }

    _renderReveal(draw) {
        const lr = draw.lastRound;
        setText(this._revealWord, lr ? `The word was "${lr.word}"` : '');
        fillList(this._revealScoresList, lr?.deltas ?? [], d => this._deltaRow(d));
    }

    _deltaRow(d) {
        const row = new St.BoxLayout({style_class: 'island-irow island-irow-box', x_expand: true});
        const avatar = badge({glyph: (d.name[0] ?? '?').toUpperCase(), color: this._playerColor(d.peerId)});
        avatar.add_style_class_name('island-race-row-avatar');
        row.add_child(avatar);
        row.add_child(label('island-irow-title', {text: d.name, x_expand: true}));
        row.add_child(label('island-irow-sub', {text: `+${d.points}`, x_align: Clutter.ActorAlign.END}));
        return row;
    }

    // ---- Shared result screen ------------------------------------------

    _buildResult() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        this._resultTitle = label('island-race-finish-title');
        this._resultHint = label('island-race-subtitle');

        this._winnerCard = new St.BoxLayout({style_class: 'island-race-winner-card', x_expand: true});
        this._winnerBadge = badge({glyph: '?', color: '#8e8e93'});
        this._winnerBadge.add_style_class_name('island-race-winner-avatar');
        const winnerText = column({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._winnerName = label('island-race-winner-name', {text: ''});
        this._winnerSub = label('island-race-winner-sub', {text: 'Winner'});
        winnerText.add_child(this._winnerName);
        winnerText.add_child(this._winnerSub);
        this._winnerValue = label('island-race-winner-wpm', {x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
        this._winnerCard.add_child(this._winnerBadge);
        this._winnerCard.add_child(winnerText);
        this._winnerCard.add_child(this._winnerValue);

        const resultGroup = group('RESULTS');
        this._resultGroupActor = resultGroup.actor;
        this._resultList = resultGroup.list;
        const doneBtn = this._leaveButton('Done', 'primary');
        doneBtn.x_expand = true;
        doneBtn.add_style_class_name('island-race-full-btn');
        view.add_child(this._resultTitle);
        view.add_child(this._resultHint);
        view.add_child(this._winnerCard);
        view.add_child(scrollView(resultGroup.actor));
        view.add_child(doneBtn);
        return view;
    }

    _renderResult(state) {
        const finished = state.phase === 'finished';
        const missed = state.phase === 'missed';
        if (state.mode === 'draw')
            this._renderDrawResult(state, finished, missed);
        else
            this._renderRaceResult(state, finished, missed);
    }

    _renderRaceResult(state, finished, missed) {
        const racers = state.race?.racers ?? [];
        const ranked = [...racers].sort((a, b) => (a.finishedAtMs || Infinity) - (b.finishedAtMs || Infinity));
        const winner = ranked[0];
        setText(this._resultTitle, finished ? 'Race finished' : missed ? 'That race already started' : 'The host left the race');
        setText(this._resultHint, finished
            ? (winner ? `${winner.name} crossed the line first` : '')
            : missed ? 'The host started before you joined.' : 'Your progress was not saved.');
        this._resultHint.visible = !finished || !!winner;
        this._winnerCard.visible = finished && !!winner;
        this._resultGroupActor.visible = finished && ranked.length > 1;
        if (!finished)
            return;
        const sig = `race:${ranked.map(r => r.peerId).join('|')}`;
        if (sig === this._resultSig)
            return;
        this._resultSig = sig;
        if (winner) {
            this._winnerBadge.set_style(`background-color: ${winner.peerId === state.selfId ? SELF_CARET_COLOR : this._playerColor(winner.peerId)};`);
            this._winnerBadge.child.text = (winner.name[0] ?? '?').toUpperCase();
            setText(this._winnerName, winner.name);
            setText(this._winnerValue, winner.finishedAtMs ? `${Math.round(winner.wpm)} wpm` : '—');
        }
        fillList(this._resultList, ranked.slice(1), (r, i) => this._raceResultRow(r, i + 2, state.selfId));
    }

    _raceResultRow(r, rank, selfId) {
        const row = new St.BoxLayout({style_class: 'island-irow island-irow-box', x_expand: true});
        row.add_child(label('island-race-rank', {text: `${rank}`, x_align: Clutter.ActorAlign.CENTER}));
        const avatar = badge({glyph: (r.name[0] ?? '?').toUpperCase(), color: r.peerId === selfId ? SELF_CARET_COLOR : this._playerColor(r.peerId)});
        avatar.add_style_class_name('island-race-list-avatar');
        row.add_child(avatar);
        row.add_child(label('island-irow-title', {text: r.name, x_expand: true}));
        row.add_child(label('island-irow-sub', {
            text: r.finishedAtMs ? `${Math.round(r.wpm)} wpm` : 'Did not finish',
            x_align: Clutter.ActorAlign.END,
        }));
        return row;
    }

    _renderDrawResult(state, finished, missed) {
        const players = state.draw?.players ?? [];
        const ranked = [...players].sort((a, b) => b.score - a.score);
        const winner = ranked[0];
        setText(this._resultTitle, finished ? 'Game finished' : missed ? 'That game already started' : 'The host left the game');
        setText(this._resultHint, finished
            ? (winner ? `${winner.name} finished with the most points` : '')
            : missed ? 'The host started before you joined.' : 'Your progress was not saved.');
        this._resultHint.visible = !finished || !!winner;
        this._winnerCard.visible = finished && !!winner;
        this._resultGroupActor.visible = finished && ranked.length > 1;
        if (!finished)
            return;
        const sig = `draw:${ranked.map(p => `${p.peerId}:${p.score}`).join('|')}`;
        if (sig === this._resultSig)
            return;
        this._resultSig = sig;
        if (winner) {
            this._winnerBadge.set_style(`background-color: ${this._playerColor(winner.peerId)};`);
            this._winnerBadge.child.text = (winner.name[0] ?? '?').toUpperCase();
            setText(this._winnerName, winner.name);
            setText(this._winnerValue, `${winner.score} pts`);
        }
        fillList(this._resultList, ranked.slice(1), (p, i) => this._drawResultRow(p, i + 2));
    }

    _drawResultRow(p, rank) {
        const row = new St.BoxLayout({style_class: 'island-irow island-irow-box', x_expand: true});
        row.add_child(label('island-race-rank', {text: `${rank}`, x_align: Clutter.ActorAlign.CENTER}));
        const avatar = badge({glyph: (p.name[0] ?? '?').toUpperCase(), color: this._playerColor(p.peerId)});
        avatar.add_style_class_name('island-race-list-avatar');
        row.add_child(avatar);
        row.add_child(label('island-irow-title', {text: p.name, x_expand: true}));
        row.add_child(label('island-irow-sub', {text: `${p.score} pts`, x_align: Clutter.ActorAlign.END}));
        return row;
    }

    // ---- Page lifecycle --------------------------------------------------

    onShow() {
        this.refresh();
        if (this._phase === 'playing' && this._mode === 'race')
            this._passageStack.grab_key_focus();
        else if (this._phase === 'playing' && this._mode === 'draw' && !this._isSelfDrawing())
            this._guessEntry.grab_key_focus();
        return null;
    }

    refresh() {
        this.fetch('PartyState', [], (state, err) => this._render(err ? null : state));
        if (this._phase === 'idle' || this._phase === undefined)
            this.fetch('PartyPeers', [], (peers, err) => this._renderIdle(err ? [] : (peers ?? [])));
    }

    _render(state) {
        if (!state) {
            this._phase = null;
            this._showView(null);
            this._pageEmpty.show({icon: 'input-keyboard-symbolic', title: 'Daemon not running'});
            return;
        }
        this._pageEmpty.hide();
        if (state.lobbyId !== this._lobbyId) {
            this._lobbyId = state.lobbyId;
            this._guestResponded = false;
            this._invitePickerOpen = false;
            this._invitePickerActor.hide();
            this._inviteToggleBtn.label = 'Invite more';
            this._lastSubmittedLen = 0;
            this._typed = '';
            this._hostSig = null;
            this._racePresenceSig = null;
            this._resultSig = null;
            this._peerSig = null;
            this._passage = null;
            this._strokes = [];
            this._liveStroke = null;
            this._selfCaret.visible = false;
            this._selfCaret._lastIndex = undefined;
            for (const caret of this._raceMarkers.values())
                caret.destroy();
            this._raceMarkers.clear();
        }
        const prevPhase = this._phase;
        const prevMode = this._mode;
        this._phase = state.phase;
        this._mode = state.mode;
        this._selfId = state.selfId;
        this._drawerId = state.draw?.drawerId;

        if (state.phase === 'idle') {
            this._showView('idle');
        } else if (state.phase === 'lobby' && state.isHost) {
            this._showView('lobbyHost');
            this._renderLobbyHost(state);
        } else if (state.phase === 'lobby') {
            this._showView('lobbyGuest');
            this._renderLobbyGuest(state);
        } else if (state.phase === 'playing' && state.mode === 'race') {
            this._showView('racing');
            this._renderRacing(state.race ?? {});
            if (!(prevPhase === 'playing' && prevMode === 'race'))
                this._passageStack.grab_key_focus();
        } else if (state.phase === 'playing' && state.mode === 'draw') {
            const draw = state.draw ?? {};
            if (draw.phase === 'reveal') {
                this._showView('reveal');
                this._renderReveal(draw);
            } else {
                const isDrawer = this._isSelfDrawing();
                this._showView(isDrawer ? 'drawing' : 'guessing');
                this._renderDrawing(draw, isDrawer);
                if (!(prevPhase === 'playing' && prevMode === 'draw') && !isDrawer)
                    this._guessEntry.grab_key_focus();
            }
        } else {
            this._showView('result');
            this._renderResult(state);
        }
    }

    _showView(name) {
        for (const [key, view] of Object.entries(this._views))
            view.visible = key === name;
    }

    onSettings() {
        this._peerSig = null;
        if (this.active && (this._phase === 'idle' || this._phase === undefined))
            this.refresh();
    }
}
