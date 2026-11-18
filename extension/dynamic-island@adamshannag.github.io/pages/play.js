import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Cairo from 'gi://cairo';

import {TILE_COLORS, featureOn} from '../lib/constants.js';
import {correctPrefix, hashColor, hexToRgb} from '../lib/format.js';
import {CriticalSpring, frameLoop, springTo} from '../lib/motion.js';
import {
    EmptyState, badge, column, fillList, group, iconButton, label, page, pillButton, scrollView,
    setText,
} from '../lib/widgets.js';
import {Page} from './page.js';

const SELF_CARET_COLOR = '#0a84ff';
const SELF_CARET_MS = 110;
const PEER_CARET_MS = 350;

const INK_COLOR = '#1c1c1e';
const INK_WIDTH = 3;
const ERASER_WIDTH = 16;
const CANVAS_BG = '#f5f5f7';
const STROKE_FLUSH_MS = 80;
const SWATCH_COLORS = ['#1c1c1e', '#ff453a', '#0a84ff', '#30d158', '#ff9f0a'];
const MIN_ROUNDS = 1;
const MAX_ROUNDS = 10;

const SNAKE_INPUT_MS = 30;
const SNAKE_INTERP_MS = 45;
const SNAKE_BG = '#0b0e12';
const SNAKE_FOOD_COLOR = '#ffd60a';
const SNAKE_GRID_STEP = 28;
const SNAKE_BODY_WIDTH = 9;
const SNAKE_HEAD_RADIUS = 6;
const SNAKE_FOOD_RADIUS = 3;
const SNAKE_WALL_COLOR = '#ff453a';
const SNAKE_WALL_LINE_WIDTH = 3;
const SNAKE_WALL_STRIPE_STEP = 24;
const SNAKE_CAM_STIFFNESS = 14;

function statusSpec(status) {
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
    static interval = 40;

    build() {
        const actor = page();

        this._idle = this._buildIdle();
        this._lobbyHost = this._buildLobbyHost();
        this._lobbyGuest = this._buildLobbyGuest();
        this._racing = this._buildRacing();
        this._drawing = this._buildDrawing();
        this._guessing = this._buildGuessing();
        this._reveal = this._buildReveal();
        this._snake = this._buildSnake();
        this._result = this._buildResult();
        this._pageEmpty = new EmptyState();

        this._views = {
            idle: this._idle, lobbyHost: this._lobbyHost, lobbyGuest: this._lobbyGuest,
            racing: this._racing, drawing: this._drawing, guessing: this._guessing,
            reveal: this._reveal, snake: this._snake, result: this._result,
        };

        for (const view of Object.values(this._views))
            actor.add_child(view);
        actor.add_child(this._pageEmpty.actor);
        return actor;
    }

    _playerColor(peerId) {
        return hashColor(peerId, TILE_COLORS);
    }

    _statusRow(kind, text) {
        const row = new St.BoxLayout({style_class: 'island-status'});
        const dot = new St.Widget({style_class: `island-status-dot ${kind}`, y_align: Clutter.ActorAlign.CENTER});
        row.add_child(dot);
        row.add_child(label(`island-status-text ${kind}`, {text}));
        return row;
    }

    _statusChip(status) {
        const spec = statusSpec(status);
        return this._statusRow(spec.kind, spec.text);
    }

    // ---- Idle / invite ----------------------------------------------

    _buildIdle() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        const head = new St.BoxLayout({style_class: 'island-idle-head', x_expand: true});
        const titles = column({x_expand: true});
        const eyebrow = label('island-igroup-title', {text: 'NEARBY'});
        const subtitle = label('island-race-subtitle', {text: 'Open a lobby, then invite people to it'});
        titles.add_child(eyebrow);
        titles.add_child(subtitle);
        this._newLobbyBtn = pillButton('New Lobby', () => this._openLobby(), 'primary');
        head.add_child(titles);
        head.add_child(this._newLobbyBtn);
        this._peerEmpty = new EmptyState();
        const peerGroup = group('ON YOUR NETWORK');
        this._peerList = peerGroup.list;
        const groups = column({style_class: 'island-groups'});
        groups.add_child(peerGroup.actor);
        this._idleScroll = scrollView(groups);
        view.add_child(head);
        view.add_child(this._peerEmpty.actor);
        view.add_child(this._idleScroll);
        return view;
    }

    _openLobby() {
        this._newLobbyBtn.reactive = false;
        this.call('PartyCreate', [], (_result, err) => {
            this._newLobbyBtn.reactive = true;
            if (err)
                return;
            this.refresh();
        });
    }

    _peerRow(peer, onPick, invited = false) {
        const row = new St.BoxLayout({style_class: 'island-irow island-irow-box', x_expand: true});
        const badgeActor = badge({glyph: (peer.name[0] ?? '?').toUpperCase(), color: this._playerColor(peer.id)});
        row.add_child(badgeActor);
        const text = column({x_expand: true});
        text.add_child(label('island-irow-title', {text: peer.name}));
        text.add_child(label('island-irow-sub', {text: peer.addr ?? ''}));
        row.add_child(text);
        if (invited) {
            row.add_child(label('island-row-note', {text: 'Invited'}));
        } else {
            const btn = pillButton('Invite', () => onPick(peer, btn), 'link');
            row.add_child(btn);
        }
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
        fillList(this._peerList, peers, p => this._peerRow(p, (peer, refs) => this._invitePeer(peer, refs)));
    }

    _invitePeer(peer, btn) {
        btn.reactive = false;
        btn.label = 'Inviting…';
        this.call('PartyCreate', [], () => {
            this.call('PartyInvite', [peer.id], (_result, err) => {
                if (err) {
                    btn.reactive = true;
                    btn.label = 'Invite';
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
        this._inviteToggleBtn.label = this._invitePickerOpen ? 'Back' : '+ Invite';
        this._invitePickerActor.visible = this._invitePickerOpen;
        if (this._invitePickerOpen)
            this._refreshInvitePicker();
    }

    _refreshInvitePicker() {
        const invited = this._invitedIds;
        this.fetch('PartyPeers', [], (peers, err) => {
            if (!this._invitePickerOpen)
                return;
            const list = err ? [] : (peers ?? []);
            const sig = list.map(p => `${p.id}:${invited?.has(p.id) ?? false}`).join('|');
            if (sig === this._invitePickerSig)
                return;
            this._invitePickerSig = sig;
            fillList(this._invitePickerList, list,
                p => this._peerRow(p, (peer, btn) => this._inviteOnly(peer, btn), invited?.has(p.id)));
        });
    }

    // ---- Lobby (host picks a mode; guest watches) --------------------

    _buildLobbyHost() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        const eyebrow = label('island-igroup-title', {text: 'LOBBY'});
        const subtitle = label('island-race-subtitle', {text: 'Waiting for players to accept'});

        const row = new St.BoxLayout({style_class: 'island-race-host-row', x_expand: true, y_expand: true});
        this._inviteToggleBtn = pillButton('+ Invite', () => this._toggleInvitePicker());
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

        const gameLabel = label('island-igroup-title', {text: 'GAME'});
        const gameBlock = column({style_class: 'island-game-block'});
        const segmented = new St.BoxLayout({style_class: 'island-segmented'});
        this._modeRaceBtn = pillButton('Race', () => this._pickMode('race'));
        this._modeDrawBtn = pillButton('Draw', () => this._pickMode('draw'));
        this._modeSnakeBtn = pillButton('Snake', () => this._pickMode('snake'));
        this._modeRaceBtn.x_expand = true;
        this._modeDrawBtn.x_expand = true;
        this._modeSnakeBtn.x_expand = true;
        segmented.add_child(this._modeRaceBtn);
        segmented.add_child(this._modeDrawBtn);
        segmented.add_child(this._modeSnakeBtn);

        this._roundsRow = new St.BoxLayout({style_class: 'island-rounds-row'});
        this._roundsRow.add_child(label('island-rounds-label', {text: 'Passes', x_expand: true}));
        const stepper = new St.BoxLayout({style_class: 'island-rounds-stepper'});
        stepper.add_child(iconButton('list-remove-symbolic', 'island-rounds-stepper-btn',
            () => this._changeRounds(-1), 'Fewer rounds'));
        stepper.add_child(new St.Widget({style_class: 'island-rounds-stepper-div'}));
        this._roundsVal = label('island-rounds-stepper-val', {text: '3', x_align: Clutter.ActorAlign.CENTER});
        stepper.add_child(this._roundsVal);
        stepper.add_child(new St.Widget({style_class: 'island-rounds-stepper-div'}));
        stepper.add_child(iconButton('list-add-symbolic', 'island-rounds-stepper-btn',
            () => this._changeRounds(1), 'More rounds'));
        this._roundsRow.add_child(stepper);
        this._roundsRow.hide();

        gameBlock.add_child(segmented);
        gameBlock.add_child(this._roundsRow);

        this._readyLabel = label('island-ready-note', {text: 'Pick a game', x_align: Clutter.ActorAlign.CENTER});
        this._startBtn = pillButton('Start', () => this.call('PartyStart', [], () => this.refresh()), 'primary');
        this._startBtn.add_style_class_name('island-race-start-btn');
        this._startBtn.reactive = false;
        panel.add_child(gameLabel);
        panel.add_child(gameBlock);
        panel.add_child(new St.Widget({y_expand: true}));
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

    _changeRounds(delta) {
        const next = Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, (this._rounds ?? 3) + delta));
        if (next === this._rounds)
            return;
        this._rounds = next;
        setText(this._roundsVal, `${next}`);
        this.call('PartySetRounds', [next]);
    }

    _buildLobbyGuest() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        const eyebrow = label('island-igroup-title', {text: 'LOBBY'});
        this._guestSubtitle = label('island-race-subtitle', {text: ''});

        const row = new St.BoxLayout({style_class: 'island-race-host-row', x_expand: true, y_expand: true});
        const playersGroup = group('PLAYERS');
        this._guestPlayerList = playersGroup.list;
        this._guestPlayerRefs = new Map();
        const groups = column({style_class: 'island-groups'});
        groups.add_child(playersGroup.actor);
        const left = scrollView(groups);
        left.x_expand = true;

        const panel = column({style_class: 'island-race-host-panel', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._guestModeLabel = label('island-race-ready-label', {text: '', x_align: Clutter.ActorAlign.CENTER});
        this._acceptBtn = pillButton('Accept', () => this._respond(true), 'primary');
        this._declineBtn = pillButton('Decline', () => this._respond(false), 'secondary');
        this._acceptBtn.x_expand = true;
        this._declineBtn.x_expand = true;
        this._respondBar = new St.BoxLayout({style_class: 'island-toolbar'});
        this._respondBar.add_child(this._declineBtn);
        this._respondBar.add_child(this._acceptBtn);
        this._guestLeaveBar = new St.BoxLayout({style_class: 'island-toolbar'});
        this._guestLeaveBar.add_child(this._leaveButton('Leave'));
        panel.add_child(this._guestModeLabel);
        panel.add_child(this._respondBar);
        panel.add_child(this._guestLeaveBar);

        row.add_child(left);
        row.add_child(panel);
        view.add_child(eyebrow);
        view.add_child(this._guestSubtitle);
        view.add_child(row);
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
        const hostId = players[0]?.peerId;
        this._invitedIds = new Set(players.map(p => p.peerId));
        this._hostSig = this._syncPlayerRows(this._hostPlayerList, this._hostPlayerRefs, this._hostSig, players, state.selfId, hostId);
        const ready = players.filter(p => p.status === 'accepted').length;
        setText(this._readyLabel, `${ready} of ${players.length} ready to play`);
        this._modeRaceBtn.checked = state.mode === 'race';
        this._modeDrawBtn.checked = state.mode === 'draw';
        this._modeSnakeBtn.checked = state.mode === 'snake';
        this._startBtn.reactive = !!state.mode;
        this._startBtn.opacity = state.mode ? 255 : 110;
        this._rounds = state.rounds ?? this._rounds ?? 3;
        setText(this._roundsVal, `${this._rounds}`);
        this._roundsRow.visible = state.mode === 'draw';
        if (this._invitePickerOpen)
            this._refreshInvitePicker();
    }

    _syncPlayerRows(list, refs, prevSig, players, selfId, hostId) {
        const sig = players.map(p => `${p.peerId}:${p.status}`).join('|');
        if (sig !== prevSig) {
            list.destroy_all_children();
            refs.clear();
            for (const p of players) {
                const row = new St.BoxLayout({style_class: 'island-irow island-irow-box', x_expand: true});
                const avatar = badge({glyph: (p.name[0] ?? '?').toUpperCase(), color: this._playerColor(p.peerId)});
                avatar.add_style_class_name('island-race-row-avatar');
                const name = label('island-irow-title', {text: p.peerId === selfId ? `${p.name} (You)` : p.name, x_expand: true});
                const chip = p.peerId === hostId ? this._statusRow('host', 'Host') : this._statusChip(p.status);
                row.add_child(avatar);
                row.add_child(name);
                row.add_child(chip);
                list.add_child(row);
                refs.set(p.peerId, {name, chip});
            }
        } else {
            for (const p of players) {
                const r = refs.get(p.peerId);
                if (r)
                    setText(r.name, p.peerId === selfId ? `${p.name} (You)` : p.name);
            }
        }
        return sig;
    }

    _renderLobbyGuest(state) {
        const host = (state.players ?? [])[0];
        setText(this._guestSubtitle, this._guestResponded
            ? 'Waiting for the host to start'
            : (host ? `Invited by ${host.name}` : ''));
        const players = state.players ?? [];
        this._guestSig = this._syncPlayerRows(this._guestPlayerList, this._guestPlayerRefs, this._guestSig, players, state.selfId, host?.peerId);
        const modeText = state.mode === 'race' ? 'a typing race'
            : state.mode === 'snake' ? 'snake'
                : state.mode === 'draw' ? 'a drawing chain' : '';
        setText(this._guestModeLabel, state.mode
            ? `Playing ${modeText}${state.mode === 'draw' ? ` · ${state.rounds ?? 3} passes` : ''}`
            : 'Waiting for the host to pick a game');
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
        const eyebrow = label('island-igroup-title', {text: 'TYPING RACE', x_expand: true});
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

        const leaveRow = new St.BoxLayout({x_expand: true});
        const leaveSpacer = new St.Widget({x_expand: true});
        leaveRow.add_child(leaveSpacer);
        leaveRow.add_child(this._leaveButton('Leave', 'link'));
        view.add_child(top);
        view.add_child(passageWrap);
        view.add_child(leaveRow);
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

    _buildCanvas(interactive = true) {
        const canvas = new St.DrawingArea({style_class: 'island-draw-canvas', x_expand: true, y_expand: true, reactive: interactive});
        if (interactive) {
            canvas.connect('repaint', area => this._paint(area));
            canvas.connect('button-press-event', (actor, event) => this._onPressStart(actor, event));
            canvas.connect('motion-event', (actor, event) => this._onPointerMove(actor, event));
            canvas.connect('button-release-event', () => this._onPressEnd());
            canvas.connect('leave-event', () => this._onPressEnd());
        } else {
            canvas.connect('repaint', area => this._paintGuessDrawing(area));
        }
        const wrap = new St.BoxLayout({style_class: 'island-draw-canvas-wrap', x_expand: true, y_expand: true});
        wrap.add_child(canvas);
        return {canvas, wrap};
    }

    _buildPips() {
        return new St.BoxLayout({style_class: 'island-draw-pips', x_align: Clutter.ActorAlign.END});
    }

    _syncPips(row, pass, totalPasses) {
        if (row._n !== totalPasses) {
            row.destroy_all_children();
            row._n = totalPasses;
            for (let i = 0; i < totalPasses; i++)
                row.add_child(new St.Widget({style_class: 'island-draw-pip'}));
        }
        const children = row.get_children();
        for (let i = 0; i < children.length; i++) {
            children[i].remove_style_class_name('done');
            children[i].remove_style_class_name('current');
            if (i < pass - 1)
                children[i].add_style_class_name('done');
            else if (i === pass - 1)
                children[i].add_style_class_name('current');
        }
    }

    _buildWaitOverlay() {
        const overlay = new St.Bin({
            style_class: 'island-draw-overlay', x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        const col = column({x_align: Clutter.ActorAlign.CENTER});
        overlay._msg = label('island-draw-overlay-msg', {text: '', x_align: Clutter.ActorAlign.CENTER});
        overlay._list = column({style_class: 'island-draw-overlay-list', x_align: Clutter.ActorAlign.CENTER});
        col.add_child(overlay._msg);
        col.add_child(overlay._list);
        overlay.child = col;
        overlay.hide();
        return overlay;
    }

    _syncWaitOverlay(overlay, waiting, selfId) {
        const others = (waiting ?? []).filter(w => w.peerId !== selfId);
        const remaining = others.filter(w => !w.done).length;
        setText(overlay._msg, remaining > 0
            ? `Waiting on ${remaining} more player${remaining === 1 ? '' : 's'}…`
            : 'Everyone is ready…');
        overlay._list.destroy_all_children();
        for (const w of others)
            overlay._list.add_child(this._statusRow(w.done ? 'ready' : 'waiting', w.done ? `${w.name} — done` : `${w.name} — waiting`));
    }

    _buildDrawing() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});

        const top = new St.BoxLayout({x_expand: true});
        this._drawPassLabel = label('island-igroup-title', {text: '', x_expand: true});
        this._drawPips = this._buildPips();
        top.add_child(this._drawPassLabel);
        top.add_child(this._drawPips);

        this._wordPromptLabel = label('island-draw-prompt-label', {text: 'DRAW THIS', x_align: Clutter.ActorAlign.CENTER});
        this._wordLabel = label('island-draw-word-text');
        this._wordLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const promptWrap = new St.Bin({child: this._wordPromptLabel, x_align: Clutter.ActorAlign.CENTER});
        const wordWrap = new St.Bin({child: this._wordLabel, x_align: Clutter.ActorAlign.CENTER});

        const {canvas: drawCanvas, wrap: canvasWrap} = this._buildCanvas();
        this._drawCanvas = drawCanvas;
        const canvasStack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        canvasStack.add_child(canvasWrap);
        this._drawWaitOverlay = this._buildWaitOverlay();
        canvasStack.add_child(this._drawWaitOverlay);

        const toolsRow = new St.BoxLayout({x_expand: true});
        this._swatchRow = new St.BoxLayout({style_class: 'island-draw-tools'});
        this._swatchButtons = [];
        this._inkColor = SWATCH_COLORS[0];
        this._inkWidth = INK_WIDTH;
        for (const color of SWATCH_COLORS) {
            const sw = new St.Button({style_class: 'island-draw-swatch', can_focus: true});
            sw.set_style(`background-color: ${color};`);
            sw.connect('clicked', () => this._selectColor(color, sw, INK_WIDTH));
            this._swatchRow.add_child(sw);
            this._swatchButtons.push({btn: sw, color});
        }
        this._swatchRow.add_child(new St.Widget({style_class: 'island-draw-tool-div'}));
        const eraser = new St.Button({
            style_class: 'island-draw-swatch island-draw-eraser', can_focus: true,
            child: new St.Icon({icon_name: 'edit-clear-symbolic', style_class: 'island-draw-eraser-icon'}),
        });
        eraser.connect('clicked', () => this._selectColor(CANVAS_BG, eraser, ERASER_WIDTH));
        this._swatchRow.add_child(eraser);
        this._swatchButtons.push({btn: eraser, color: CANVAS_BG});
        this._selectColor(this._inkColor, this._swatchButtons[0].btn, INK_WIDTH);
        this._drawDoneBtn = pillButton('Done', () => this._submitDrawing(), 'primary');
        toolsRow.add_child(this._swatchRow);
        toolsRow.add_child(new St.Widget({x_expand: true}));
        toolsRow.add_child(this._drawDoneBtn);

        const leaveRow = new St.BoxLayout({x_expand: true});
        leaveRow.add_child(new St.Widget({x_expand: true}));
        leaveRow.add_child(this._leaveButton('Leave', 'link'));

        view.add_child(top);
        view.add_child(promptWrap);
        view.add_child(wordWrap);
        view.add_child(canvasStack);
        view.add_child(toolsRow);
        view.add_child(leaveRow);
        return view;
    }

    _selectColor(color, btn, width) {
        this._inkColor = color;
        this._inkWidth = width;
        for (const s of this._swatchButtons)
            s.btn.checked = s.btn === btn;
    }

    _buildGuessing() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});

        const top = new St.BoxLayout({x_expand: true});
        this._guessPassLabel = label('island-igroup-title', {text: '', x_expand: true});
        this._guessPips = this._buildPips();
        top.add_child(this._guessPassLabel);
        top.add_child(this._guessPips);

        const {canvas: guessCanvas, wrap: guessCanvasWrap} = this._buildCanvas(false);
        this._guessCanvas = guessCanvas;

        const drawerRow = new St.BoxLayout({style_class: 'island-draw-drawer-row', x_align: Clutter.ActorAlign.CENTER});
        this._guessDrawerAvatar = badge({glyph: '?', color: '#8e8e93'});
        this._guessDrawerAvatar.add_style_class_name('island-draw-drawer-avatar');
        this._guessDrawerLabel = label('island-draw-drawer-label');
        drawerRow.add_child(this._guessDrawerAvatar);
        drawerRow.add_child(this._guessDrawerLabel);
        const drawerWrap = new St.Bin({child: drawerRow, x_align: Clutter.ActorAlign.CENTER});

        this._guessActive = column();
        this._guessPromptLabel = label('island-draw-guess-prompt', {text: '', x_align: Clutter.ActorAlign.CENTER});
        this._guessEntry = new St.Entry({
            style_class: 'island-draw-guess-entry', hint_text: 'Type your guess…',
            can_focus: true, x_expand: true,
        });
        this._guessEntry.clutter_text.connect('activate', () => this._submitGuess());
        this._guessActive.add_child(new St.Bin({child: this._guessPromptLabel, x_align: Clutter.ActorAlign.CENTER}));
        this._guessActive.add_child(this._guessEntry);

        this._guessDoneCard = column({style_class: 'island-draw-confirm-card', x_align: Clutter.ActorAlign.CENTER});
        this._guessDoneLabel = label('island-draw-confirm-label', {text: 'YOU GUESSED', x_align: Clutter.ActorAlign.CENTER});
        this._guessDoneLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._guessDoneValue = label('island-draw-confirm-value', {x_align: Clutter.ActorAlign.CENTER});
        this._guessDoneCard.add_child(this._guessDoneLabel);
        this._guessDoneCard.add_child(this._guessDoneValue);
        this._guessDoneCard.hide();
        this._guessWaitList = column({x_align: Clutter.ActorAlign.CENTER});
        this._guessWaitList.hide();

        const guessLeave = this._leaveButton('Leave', 'link');
        guessLeave.x_align = Clutter.ActorAlign.CENTER;

        view.add_child(top);
        view.add_child(guessCanvasWrap);
        view.add_child(drawerWrap);
        view.add_child(this._guessActive);
        view.add_child(this._guessDoneCard);
        view.add_child(this._guessWaitList);
        view.add_child(guessLeave);
        return view;
    }

    _buildReveal() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        const eyebrow = label('island-igroup-title', {text: 'THE REVEAL'});

        const grid = new St.BoxLayout({style_class: 'island-reveal-grid', x_expand: true, y_expand: true});
        this._chainList = column({style_class: 'island-reveal-chainlist'});
        const chainScroll = scrollView(this._chainList);
        this._threadColumn = column({style_class: 'island-reveal-thread'});
        const threadScroll = scrollView(this._threadColumn);
        threadScroll.x_expand = true;
        grid.add_child(chainScroll);
        grid.add_child(threadScroll);

        const leaveRow = new St.BoxLayout({x_expand: true});
        leaveRow.add_child(new St.Widget({x_expand: true}));
        leaveRow.add_child(this._leaveButton('Leave lobby', 'link'));

        view.add_child(eyebrow);
        view.add_child(grid);
        view.add_child(leaveRow);
        this._chainRowRefs = new Map();
        return view;
    }

    _paintStrokesBg(cr, w, h, strokes) {
        const [bgR, bgG, bgB] = hexToRgb(CANVAS_BG);
        cr.setSourceRGB(bgR, bgG, bgB);
        cr.rectangle(0, 0, w, h);
        cr.fill();
        for (const stroke of strokes ?? [])
            this._paintStroke(cr, stroke, w, h);
    }

    _paint(area) {
        const cr = area.get_context();
        try {
            const [w, h] = area.get_surface_size();
            this._paintStrokesBg(cr, w, h, this._strokes);
            if (this._liveStroke)
                this._paintStroke(cr, this._liveStroke, w, h);
        } finally {
            cr.$dispose();
        }
    }

    _paintGuessDrawing(area) {
        const cr = area.get_context();
        try {
            const [w, h] = area.get_surface_size();
            this._paintStrokesBg(cr, w, h, this._guessPromptStrokes);
        } finally {
            cr.$dispose();
        }
    }

    _paintThumbStrokes(area, strokes) {
        const cr = area.get_context();
        try {
            const [w, h] = area.get_surface_size();
            this._paintStrokesBg(cr, w, h, strokes);
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

    _canDraw() {
        return this._phase === 'playing' && this._mode === 'draw' &&
            this._drawSubPhase === 'drawing' && !this._drawSelfDone;
    }

    _onPressStart(actor, event) {
        if (!this._canDraw())
            return Clutter.EVENT_PROPAGATE;
        const p = this._localPoint(actor, event);
        if (!p)
            return Clutter.EVENT_PROPAGATE;
        this._liveStroke = {points: [p], color: this._inkColor, width: this._inkWidth};
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
    }

    _submitDrawing() {
        if (this._liveStroke)
            this._flushLiveStroke(true);
        this._drawCanvas.queue_repaint();
        this.call('DrawSubmitDrawing', [JSON.stringify(this._strokes ?? [])]);
    }

    _submitGuess() {
        const text = this._guessEntry.text.trim();
        if (!text)
            return;
        this._guessEntry.text = '';
        this._lastGuessSubmitted = text;
        this.call('DrawSubmitGuess', [text]);
    }

    _selfDoneThisStep(waiting) {
        return (waiting ?? []).find(w => w.peerId === this._selfId)?.done ?? false;
    }

    _renderDraw(draw) {
        const pass = draw.pass ?? 1, total = draw.totalPasses ?? 3;
        const stepKey = `draw:${pass}`;
        if (this._drawStepKey !== stepKey) {
            this._drawStepKey = stepKey;
            this._strokes = [];
            this._liveStroke = null;
        }
        const selfDone = this._selfDoneThisStep(draw.waiting);
        this._drawSubPhase = 'drawing';
        this._drawSelfDone = selfDone;

        setText(this._drawPassLabel, `PASS ${pass} OF ${total} · DRAW`);
        this._syncPips(this._drawPips, pass, total);
        setText(this._wordLabel, (draw.prompt?.word ?? '').toUpperCase());
        this._drawDoneBtn.reactive = !selfDone;
        this._drawDoneBtn.opacity = selfDone ? 140 : 255;
        this._drawDoneBtn.label = selfDone ? 'Waiting…' : 'Done';
        this._drawWaitOverlay.visible = selfDone;
        if (selfDone)
            this._syncWaitOverlay(this._drawWaitOverlay, draw.waiting, this._selfId);
        this._drawCanvas.queue_repaint();
    }

    _renderGuess(draw) {
        const pass = draw.pass ?? 1, total = draw.totalPasses ?? 3;
        const stepKey = `guess:${pass}`;
        const isNewStep = this._guessStepKey !== stepKey;
        this._guessStepKey = stepKey;
        const selfDone = this._selfDoneThisStep(draw.waiting);
        this._drawSubPhase = 'guessing';
        this._drawSelfDone = selfDone;

        setText(this._guessPassLabel, `PASS ${pass} OF ${total} · GUESS`);
        this._syncPips(this._guessPips, pass, total);
        const prompt = draw.prompt;
        this._guessPromptStrokes = prompt?.strokes ?? [];
        this._guessDrawerAvatar.set_style(`background-color: ${this._playerColor(prompt?.fromPeerId)};`);
        this._guessDrawerAvatar.child.text = (prompt?.fromName?.[0] ?? '?').toUpperCase();
        setText(this._guessDrawerLabel, `Drawn by ${prompt?.fromName ?? ''}`);
        setText(this._guessPromptLabel, `What did ${prompt?.fromName ?? 'they'} draw?`);
        this._guessActive.visible = !selfDone;
        this._guessDoneCard.visible = selfDone;
        this._guessWaitList.visible = selfDone;
        if (selfDone) {
            setText(this._guessDoneValue, `"${this._lastGuessSubmitted ?? ''}"`);
            this._guessWaitList.destroy_all_children();
            for (const w of (draw.waiting ?? []).filter(x => x.peerId !== this._selfId))
                this._guessWaitList.add_child(this._statusRow(w.done ? 'ready' : 'waiting', w.done ? `${w.name} — done` : `${w.name} — guessing`));
        }
        this._guessCanvas.queue_repaint();
        if (isNewStep && !selfDone)
            this._guessEntry.grab_key_focus();
    }

    _renderDrawReveal(state) {
        const chains = state.draw?.chains ?? [];
        const sig = chains.map(c => c.ownerId).join('|');
        if (sig !== this._revealChainsSig) {
            this._revealChainsSig = sig;
            this._chainList.destroy_all_children();
            this._chainRowRefs.clear();
            for (const c of chains) {
                const row = this._chainRow(c, state.selfId);
                this._chainList.add_child(row);
                this._chainRowRefs.set(c.ownerId, row);
            }
            const preferred = chains.find(c => c.ownerId === state.selfId) ?? chains[0];
            this._revealSelectedChain = preferred?.ownerId ?? null;
            this._revealThreadSig = null;
        }
        this._syncChainSelection();
        const selected = chains.find(c => c.ownerId === this._revealSelectedChain) ?? chains[0];
        if (selected)
            this._renderChainThread(selected);
    }

    _chainRow(chain, selfId) {
        const row = new St.BoxLayout({
            style_class: 'island-irow island-irow-box island-reveal-chainrow', x_expand: true,
            reactive: true, track_hover: true, can_focus: true,
        });
        const avatar = badge({glyph: (chain.ownerName[0] ?? '?').toUpperCase(), color: this._playerColor(chain.ownerId)});
        row.add_child(avatar);
        const text = column({x_expand: true});
        text.add_child(label('island-irow-title', {text: chain.entries[0]?.word ?? '', x_expand: true}));
        text.add_child(label('island-irow-sub', {text: chain.ownerId === selfId ? 'Started by you' : `Started by ${chain.ownerName}`}));
        row.add_child(text);
        row.connect('button-press-event', () => {
            this._revealSelectedChain = chain.ownerId;
            this._syncChainSelection();
            this._renderChainThread(chain);
            return Clutter.EVENT_STOP;
        });
        return row;
    }

    _syncChainSelection() {
        for (const [ownerId, row] of this._chainRowRefs) {
            if (ownerId === this._revealSelectedChain)
                row.add_style_class_name('selected');
            else
                row.remove_style_class_name('selected');
        }
    }

    _renderChainThread(chain) {
        const sig = `${chain.ownerId}:${chain.entries.length}`;
        if (sig === this._revealThreadSig)
            return;
        this._revealThreadSig = sig;
        this._threadColumn.destroy_all_children();
        chain.entries.forEach((entry, i) => {
            this._threadColumn.add_child(this._stepRow(entry, i === chain.entries.length - 1));
        });
    }

    _stepRow(entry, isLast) {
        const row = new St.BoxLayout({style_class: 'island-reveal-step', x_expand: true});
        const rail = new St.BoxLayout({style_class: 'island-reveal-rail', vertical: true, x_align: Clutter.ActorAlign.CENTER});
        rail.add_child(new St.Widget({style_class: `island-reveal-dot ${entry.kind === 'word' ? 'word' : 'draw'}`}));
        if (!isLast)
            rail.add_child(new St.Widget({style_class: 'island-reveal-line', y_expand: true}));

        const body = column({x_expand: true, style_class: 'island-reveal-step-body'});
        const who = new St.BoxLayout({style_class: 'island-reveal-who'});
        const avatar = badge({glyph: (entry.name[0] ?? '?').toUpperCase(), color: this._playerColor(entry.peerId)});
        avatar.add_style_class_name('island-reveal-who-avatar');
        who.add_child(avatar);
        who.add_child(label('island-reveal-who-text', {text: `${entry.name} ${entry.kind === 'word' ? 'wrote' : 'drew'}`}));
        body.add_child(who);
        if (entry.kind === 'word') {
            body.add_child(label(`island-reveal-word-card${entry.final ? ' final' : ''}`, {text: entry.word ?? ''}));
        } else {
            // A DrawingArea's own preferred size isn't reliable once a
            // parent layout stretches it, so size it via a plain wrapper
            // widget (CSS width/height work fine there) and let the canvas
            // just fill that fixed box.
            const cardWrap = new St.Widget({style_class: 'island-reveal-draw-card', layout_manager: new Clutter.BinLayout()});
            const canvas = new St.DrawingArea({x_expand: true, y_expand: true});
            canvas.connect('repaint', area => this._paintThumbStrokes(area, entry.strokes ?? []));
            cardWrap.add_child(canvas);
            body.add_child(cardWrap);
        }
        row.add_child(rail);
        row.add_child(body);
        return row;
    }

    // ---- Snake ----------------------------------------------------------

    _buildSnake() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});

        const top = new St.BoxLayout({x_expand: true});
        const hudLeft = column();
        hudLeft.add_child(label('island-snake-hud-label', {text: 'LENGTH'}));
        this._snakeLengthLabel = label('island-snake-hud-value', {text: '0'});
        hudLeft.add_child(this._snakeLengthLabel);
        const hudSpacer = new St.Widget({x_expand: true});
        const hudRight = column({x_align: Clutter.ActorAlign.END});
        hudRight.add_child(label('island-snake-hud-label', {text: 'SCORE', x_align: Clutter.ActorAlign.END}));
        this._snakeScoreLabel = label('island-snake-hud-value', {text: '0', x_align: Clutter.ActorAlign.END});
        hudRight.add_child(this._snakeScoreLabel);
        top.add_child(hudLeft);
        top.add_child(hudSpacer);
        top.add_child(hudRight);

        const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._snakeCanvas = new St.DrawingArea({style_class: 'island-snake-arena', x_expand: true, y_expand: true, reactive: true});
        this._snakeCanvas.connect('repaint', area => this._paintSnake(area));
        this._snakeCanvas.connect('motion-event', (actor, event) => this._onSnakeMove(actor, event));
        stack.add_child(this._snakeCanvas);

        // BinLayout only honors x_expand/y_expand (fill); it ignores a
        // child's x_align/y_align, so corner/centered overlays need their
        // own FixedLayout with explicitly computed positions (see
        // _layoutSnakeOverlay) rather than relying on alignment here.
        const overlay = new St.Widget({layout_manager: new Clutter.FixedLayout(), x_expand: true, y_expand: true});
        stack.add_child(overlay);

        this._snakeLeaderboard = column({style_class: 'island-snake-leaderboard'});
        this._snakeLeaderboard.add_child(label('island-igroup-title', {text: 'LEADERBOARD'}));
        this._snakeLeaderboardList = column();
        this._snakeLeaderboard.add_child(this._snakeLeaderboardList);
        overlay.add_child(this._snakeLeaderboard);

        this._snakeDeadOverlay = column({style_class: 'island-snake-dead'});
        this._snakeDeadTitle = label('island-race-finish-title', {text: 'You died', x_align: Clutter.ActorAlign.CENTER});
        this._snakeDeadScore = label('island-race-subtitle', {x_align: Clutter.ActorAlign.CENTER});
        this._snakeDeadOverlay.add_child(this._snakeDeadTitle);
        this._snakeDeadOverlay.add_child(this._snakeDeadScore);
        this._snakeDeadOverlay.hide();
        overlay.add_child(this._snakeDeadOverlay);

        overlay.connect('notify::allocation', () => this._layoutSnakeOverlay(overlay));

        const leaveRow = new St.BoxLayout({x_expand: true});
        const leaveSpacer = new St.Widget({x_expand: true});
        leaveRow.add_child(leaveSpacer);
        leaveRow.add_child(this._leaveButton('Leave', 'link'));

        view.add_child(top);
        view.add_child(stack);
        view.add_child(leaveRow);
        return view;
    }

    _layoutSnakeOverlay(overlay) {
        const box = overlay.get_allocation_box();
        const w = box.get_width(), h = box.get_height();
        if (w <= 0 || h <= 0)
            return;
        const [, lbW] = this._snakeLeaderboard.get_preferred_width(-1);
        this._snakeLeaderboard.set_position(Math.round(w - lbW - 10), 10);
        const [, doW] = this._snakeDeadOverlay.get_preferred_width(-1);
        const [, doH] = this._snakeDeadOverlay.get_preferred_height(-1);
        this._snakeDeadOverlay.set_position(Math.round((w - doW) / 2), Math.round((h - doH) / 2));
    }

    _onSnakeMove(actor, event) {
        if (this._phase !== 'playing' || this._mode !== 'snake')
            return Clutter.EVENT_PROPAGATE;
        const [sx, sy] = event.get_coords();
        const [ok, lx, ly] = actor.transform_stage_point(sx, sy);
        if (!ok)
            return Clutter.EVENT_PROPAGATE;
        const box = actor.get_allocation_box();
        const cx = box.get_width() / 2, cy = box.get_height() / 2;
        if (box.get_width() <= 0 || box.get_height() <= 0)
            return Clutter.EVENT_PROPAGATE;
        const heading = Math.atan2(ly - cy, lx - cx);
        const now = GLib.get_monotonic_time() / 1000;
        if (now - (this._lastHeadingSentAt ?? 0) >= SNAKE_INPUT_MS) {
            this._lastHeadingSentAt = now;
            this.call('SnakeInput', [heading]);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _interpSnakeBody(curBody, prevBody, t) {
        if (!prevBody || prevBody.length === 0 || t >= 1)
            return curBody;
        return curBody.map((c, i) => {
            const pp = prevBody[i];
            return pp ? {x: pp.x + (c.x - pp.x) * t, y: pp.y + (c.y - pp.y) * t} : c;
        });
    }

    // Paints the world edge as a hazard border - a diagonally striped band
    // over whatever out-of-bounds area is in view, plus a crisp line right
    // on the boundary - so a player can see a wall coming before they die
    // on it instead of it being invisible.
    _paintSnakeWalls(cr, w, h, left, top, right, bottom) {
        const [r, g, b] = hexToRgb(SNAKE_WALL_COLOR);
        const strips = [
            [0, 0, w, Math.min(top, h)],
            [0, Math.max(bottom, 0), w, h - Math.max(bottom, 0)],
            [0, 0, Math.min(left, w), h],
            [Math.max(right, 0), 0, w - Math.max(right, 0), h],
        ];
        for (const [sx, sy, sw, sh] of strips) {
            if (sw <= 0 || sh <= 0)
                continue;
            cr.save();
            cr.rectangle(sx, sy, sw, sh);
            cr.clip();
            cr.setSourceRGBA(r, g, b, 0.16);
            cr.rectangle(0, 0, w, h);
            cr.fill();
            cr.setSourceRGBA(r, g, b, 0.3);
            cr.setLineWidth(10);
            const diag = w + h;
            for (let o = -diag; o < diag; o += SNAKE_WALL_STRIPE_STEP) {
                cr.moveTo(o, 0);
                cr.lineTo(o + h, h);
            }
            cr.stroke();
            cr.restore();
        }
        cr.setSourceRGBA(r, g, b, 0.85);
        cr.setLineWidth(SNAKE_WALL_LINE_WIDTH);
        cr.rectangle(left, top, right - left, bottom - top);
        cr.stroke();
    }

    _paintSnake(area) {
        const cr = area.get_context();
        try {
            const [w, h] = area.get_surface_size();
            const [bgR, bgG, bgB] = hexToRgb(SNAKE_BG);
            cr.setSourceRGB(bgR, bgG, bgB);
            cr.rectangle(0, 0, w, h);
            cr.fill();

            const snake = this._snakeState;
            if (!snake)
                return;
            const prev = this._snakePrevState ?? snake;
            const elapsed = GLib.get_monotonic_time() / 1000 - (this._snakeStateAt ?? 0);
            const t = Math.max(0, Math.min(1, elapsed / (this._snakeInterpMs ?? SNAKE_INTERP_MS)));
            const prevByID = new Map((prev.players ?? []).map(p => [p.peerId, p]));

            const players = snake.players ?? [];
            const self = players.find(p => p.peerId === this._selfId);
            const selfBody = self ? this._interpSnakeBody(self.body ?? [], prevByID.get(this._selfId)?.body, t) : [];
            const head = selfBody[0] ?? {x: (snake.worldW ?? w) / 2, y: (snake.worldH ?? h) / 2};
            if (!this._snakeCamSpring)
                this._snakeCamSpring = new CriticalSpring(2, SNAKE_CAM_STIFFNESS);
            if (!this._snakeCamReady) {
                this._snakeCamSpring.jump([head.x, head.y]);
                this._snakeCamReady = true;
            } else {
                this._snakeCamSpring.step([head.x, head.y]);
            }
            const [camCx, camCy] = this._snakeCamSpring.pos;
            const camX = camCx - w / 2, camY = camCy - h / 2;
            const worldW = snake.worldW ?? w, worldH = snake.worldH ?? h;
            this._paintSnakeWalls(cr, w, h, -camX, -camY, worldW - camX, worldH - camY);

            cr.setSourceRGBA(1, 1, 1, 0.07);
            const startX = Math.floor(camX / SNAKE_GRID_STEP) * SNAKE_GRID_STEP;
            const startY = Math.floor(camY / SNAKE_GRID_STEP) * SNAKE_GRID_STEP;
            for (let gx = startX; gx < camX + w + SNAKE_GRID_STEP; gx += SNAKE_GRID_STEP) {
                for (let gy = startY; gy < camY + h + SNAKE_GRID_STEP; gy += SNAKE_GRID_STEP) {
                    cr.arc(gx - camX, gy - camY, 1.1, 0, 2 * Math.PI);
                    cr.fill();
                }
            }

            const [foodR, foodG, foodB] = hexToRgb(SNAKE_FOOD_COLOR);
            cr.setSourceRGB(foodR, foodG, foodB);
            for (const f of snake.food ?? []) {
                cr.arc(f.x - camX, f.y - camY, SNAKE_FOOD_RADIUS, 0, 2 * Math.PI);
                cr.fill();
            }

            for (const p of players) {
                if (!p.alive)
                    continue;
                const pts = p.peerId === this._selfId
                    ? selfBody : this._interpSnakeBody(p.body ?? [], prevByID.get(p.peerId)?.body, t);
                if (!pts || pts.length === 0)
                    continue;
                const [r, g, b] = hexToRgb(p.peerId === this._selfId ? SELF_CARET_COLOR : this._playerColor(p.peerId));
                cr.setSourceRGB(r, g, b);
                cr.setLineWidth(SNAKE_BODY_WIDTH);
                cr.setLineCap(Cairo.LineCap.ROUND);
                cr.setLineJoin(Cairo.LineJoin.ROUND);
                cr.moveTo(pts[0].x - camX, pts[0].y - camY);
                for (let i = 1; i < pts.length; i++)
                    cr.lineTo(pts[i].x - camX, pts[i].y - camY);
                cr.stroke();
                cr.arc(pts[0].x - camX, pts[0].y - camY, SNAKE_HEAD_RADIUS, 0, 2 * Math.PI);
                cr.fill();
            }
        } finally {
            cr.$dispose();
        }
    }

    _renderSnake(snake) {
        const now = GLib.get_monotonic_time() / 1000;
        // Interpolate toward each new snapshot over however long the last
        // gap between snapshots actually was, not a fixed guess: polling
        // and the server's tick don't line up exactly, so a fixed window
        // either finishes early (the snake visibly pauses before the next
        // update) or lags behind when a poll is briefly late.
        this._snakeInterpMs = Math.max(16, Math.min(200, now - (this._snakeStateAt ?? now)));
        this._snakePrevState = this._snakeState ?? snake;
        this._snakeState = snake;
        this._snakeStateAt = now;
        const players = snake.players ?? [];
        const self = players.find(p => p.peerId === this._selfId);
        setText(this._snakeLengthLabel, `${self?.body?.length ?? 0}`);
        setText(this._snakeScoreLabel, `${self?.score ?? 0}`);
        this._snakeDeadOverlay.visible = !!self && !self.alive;
        if (self && !self.alive)
            setText(this._snakeDeadScore, `Final score: ${self.score}`);
        this._syncSnakeLeaderboard(players);
        if (!this._snakeFrameLoop) {
            this._snakeFrameLoop = frameLoop(this._snakeCanvas, () => {
                this._snakeCanvas.queue_repaint();
                const active = this._phase === 'playing' && this._mode === 'snake';
                if (!active)
                    this._snakeFrameLoop = null;
                return active;
            });
        }
    }

    _snakeRankCompare(a, b) {
        if (!!a.alive !== !!b.alive)
            return a.alive ? -1 : 1;
        return b.score - a.score;
    }

    _syncSnakeLeaderboard(players) {
        const ranked = [...players].sort((a, b) => this._snakeRankCompare(a, b)).slice(0, 5);
        const sig = ranked.map(p => `${p.peerId}:${p.score}:${p.alive}`).join('|');
        if (sig === this._snakeLbSig)
            return;
        this._snakeLbSig = sig;
        this._snakeLeaderboardList.destroy_all_children();
        ranked.forEach((p, i) => {
            const isSelf = p.peerId === this._selfId;
            const classes = `island-snake-lb-row${isSelf ? ' self' : ''}${p.alive ? '' : ' dead'}`;
            const row = new St.BoxLayout({style_class: classes});
            row.add_child(label('island-snake-lb-rank', {text: `${i + 1}`}));
            const dot = new St.Widget({style_class: 'island-snake-lb-dot', y_align: Clutter.ActorAlign.CENTER});
            dot.set_style(`background-color: ${isSelf ? SELF_CARET_COLOR : this._playerColor(p.peerId)};`);
            row.add_child(dot);
            row.add_child(label('island-snake-lb-name', {text: isSelf ? 'You' : p.name, x_expand: true}));
            row.add_child(label('island-snake-lb-score', {text: `${p.score}`}));
            this._snakeLeaderboardList.add_child(row);
        });
    }

    // ---- Shared result screen ------------------------------------------

    _buildResult() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        this._resultTitle = label('island-race-finish-title', {x_align: Clutter.ActorAlign.CENTER});
        this._resultHint = label('island-race-subtitle', {x_align: Clutter.ActorAlign.CENTER});

        const resultGroup = group('RESULTS');
        this._resultGroupActor = resultGroup.actor;
        this._resultList = resultGroup.list;
        this._resultWaitingLabel = label('island-race-subtitle', {
            text: 'Waiting for the host to start a new round', x_align: Clutter.ActorAlign.CENTER,
        });
        const doneBtn = this._leaveButton('Leave lobby', 'link');
        doneBtn.x_expand = true;
        this._rematchBtn = pillButton('Play Again', () => this._rematch(), 'primary');
        this._rematchBtn.x_expand = true;
        this._rematchBtn.add_style_class_name('island-race-full-btn');
        const actionsRow = new St.BoxLayout({style_class: 'island-toolbar', x_expand: true});
        actionsRow.add_child(this._rematchBtn);
        actionsRow.add_child(doneBtn);
        this._resultRoster = new St.BoxLayout({style_class: 'island-result-roster', x_expand: true});
        this._resultRosterAvatars = this._buildPresenceRow();
        this._resultRosterNote = label('island-result-roster-note', {
            text: 'Still in the lobby — play again or invite more without leaving.', x_expand: true,
        });
        this._resultRoster.add_child(this._resultRosterAvatars);
        this._resultRoster.add_child(this._resultRosterNote);
        view.add_child(this._resultTitle);
        view.add_child(this._resultHint);
        view.add_child(scrollView(resultGroup.actor));
        view.add_child(this._resultRoster);
        view.add_child(this._resultWaitingLabel);
        view.add_child(actionsRow);
        return view;
    }

    _rematch() {
        this._rematchBtn.reactive = false;
        this.call('PartyRematch', [], (_result, err) => {
            this._rematchBtn.reactive = true;
            if (err)
                return;
            this.refresh();
        });
    }

    _renderResult(state) {
        const finished = state.phase === 'finished';
        const missed = state.phase === 'missed';
        this._rematchBtn.visible = finished && !!state.isHost;
        this._resultWaitingLabel.visible = finished && !state.isHost;
        this._resultRoster.visible = finished;
        if (finished) {
            const players = state.players ?? [];
            const rosterSig = players.map(p => p.peerId).join('|');
            if (rosterSig !== this._resultRosterSig) {
                this._resultRosterSig = rosterSig;
                this._syncDrawPresence(this._resultRosterAvatars, players, new Set());
            }
        }
        if (state.mode === 'draw')
            this._renderDrawResult(state, finished, missed);
        else if (state.mode === 'snake')
            this._renderSnakeResult(state, finished, missed);
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
        this._resultGroupActor.visible = finished && ranked.length > 0;
        if (!finished)
            return;
        const sig = `race:${ranked.map(r => r.peerId).join('|')}`;
        if (sig === this._resultSig)
            return;
        this._resultSig = sig;
        fillList(this._resultList, ranked, (r, i) => this._raceResultRow(r, i + 1, state.selfId));
    }

    _winnerIcon() {
        return new St.Icon({icon_name: 'starred-symbolic', style_class: 'island-race-star'});
    }

    _raceResultRow(r, rank, selfId) {
        const isWinner = rank === 1;
        const row = new St.BoxLayout({style_class: `island-irow island-irow-box${isWinner ? ' winner' : ''}`, x_expand: true});
        row.add_child(label('island-race-rank', {text: `${rank}`, x_align: Clutter.ActorAlign.CENTER}));
        const avatar = badge({glyph: (r.name[0] ?? '?').toUpperCase(), color: r.peerId === selfId ? SELF_CARET_COLOR : this._playerColor(r.peerId)});
        avatar.add_style_class_name(isWinner ? 'island-race-winner-avatar' : 'island-race-list-avatar');
        row.add_child(avatar);
        const nameRow = new St.BoxLayout({x_expand: true});
        nameRow.add_child(label(isWinner ? 'island-irow-title island-race-winner-name' : 'island-irow-title', {text: r.name}));
        if (isWinner)
            nameRow.add_child(this._winnerIcon());
        row.add_child(nameRow);
        row.add_child(label(isWinner ? 'island-irow-sub island-race-winner-wpm' : 'island-irow-sub', {
            text: r.finishedAtMs ? `${Math.round(r.wpm)} wpm` : 'Did not finish',
            x_align: Clutter.ActorAlign.END,
        }));
        return row;
    }

    // A finished draw game is routed to the chain reveal before it ever
    // reaches _renderResult, so this only ever handles the missed/host-left
    // cases - there is no score list to show for those.
    _renderDrawResult(state, finished, missed) {
        setText(this._resultTitle, missed ? 'That game already started' : 'The host left the game');
        setText(this._resultHint, missed ? 'The host started before you joined.' : 'Your progress was not saved.');
        this._resultHint.visible = true;
        this._resultGroupActor.visible = false;
    }

    _renderSnakeResult(state, finished, missed) {
        const players = state.snake?.players ?? [];
        const ranked = [...players].sort((a, b) => this._snakeRankCompare(a, b));
        const winner = ranked[0];
        setText(this._resultTitle, finished ? 'Game finished' : missed ? 'That game already started' : 'The host left the game');
        setText(this._resultHint, finished
            ? (winner ? `${winner.name} ${winner.alive ? 'survived with the highest score' : 'had the highest score'}` : '')
            : missed ? 'The host started before you joined.' : 'Your progress was not saved.');
        this._resultHint.visible = !finished || !!winner;
        this._resultGroupActor.visible = finished && ranked.length > 0;
        if (!finished)
            return;
        const sig = `snake:${ranked.map(p => `${p.peerId}:${p.score}:${p.alive}`).join('|')}`;
        if (sig === this._resultSig)
            return;
        this._resultSig = sig;
        fillList(this._resultList, ranked, (p, i) => this._snakeResultRow(p, i + 1));
    }

    _snakeResultRow(p, rank) {
        const isWinner = rank === 1;
        const row = new St.BoxLayout({style_class: `island-irow island-irow-box${isWinner ? ' winner' : ''}`, x_expand: true});
        row.add_child(label('island-race-rank', {text: `${rank}`, x_align: Clutter.ActorAlign.CENTER}));
        const avatar = badge({glyph: (p.name[0] ?? '?').toUpperCase(), color: this._playerColor(p.peerId)});
        avatar.add_style_class_name(isWinner ? 'island-race-winner-avatar' : 'island-race-list-avatar');
        row.add_child(avatar);
        const nameRow = new St.BoxLayout({x_expand: true});
        nameRow.add_child(label(isWinner ? 'island-irow-title island-race-winner-name' : 'island-irow-title', {text: p.name}));
        if (isWinner)
            nameRow.add_child(this._winnerIcon());
        row.add_child(nameRow);
        row.add_child(label(isWinner ? 'island-irow-sub island-race-winner-wpm' : 'island-irow-sub', {
            text: `${p.score} pts${p.alive ? '' : ' · Died'}`, x_align: Clutter.ActorAlign.END,
        }));
        return row;
    }

    // ---- Page lifecycle --------------------------------------------------

    onShow() {
        this.refresh();
        if (this._phase === 'playing' && this._mode === 'race')
            this._passageStack.grab_key_focus();
        else if (this._phase === 'playing' && this._mode === 'draw' && this._drawSubPhase === 'guessing' && !this._drawSelfDone)
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
            this._inviteToggleBtn.label = '+ Invite';
            this._lastSubmittedLen = 0;
            this._typed = '';
            this._hostSig = null;
            this._guestSig = null;
            this._invitePickerSig = null;
            this._racePresenceSig = null;
            this._resultSig = null;
            this._resultRosterSig = null;
            this._snakeLbSig = null;
            this._snakeState = null;
            this._snakePrevState = null;
            this._snakeStateAt = 0;
            this._snakeCamReady = false;
            this._peerSig = null;
            this._passage = null;
            this._strokes = [];
            this._liveStroke = null;
            this._drawStepKey = null;
            this._guessStepKey = null;
            this._guessPromptStrokes = [];
            this._lastGuessSubmitted = '';
            this._drawSubPhase = null;
            this._drawSelfDone = false;
            this._revealChainsSig = null;
            this._revealThreadSig = null;
            this._revealSelectedChain = null;
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
            if (draw.phase === 'drawing') {
                this._showView('drawing');
                this._renderDraw(draw);
            } else {
                this._showView('guessing');
                this._renderGuess(draw);
            }
        } else if (state.phase === 'playing' && state.mode === 'snake') {
            this._showView('snake');
            this._renderSnake(state.snake ?? {});
        } else if (state.phase === 'finished' && state.mode === 'draw') {
            this._showView('reveal');
            this._renderDrawReveal(state);
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
