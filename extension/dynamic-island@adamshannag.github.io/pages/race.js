import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {TILE_COLORS, featureOn} from '../lib/constants.js';
import {correctPrefix, hashColor} from '../lib/format.js';
import {springTo} from '../lib/motion.js';
import {
    EmptyState, badge, column, fillList, group, label, page, pillButton, rowText, scrollView,
    setText,
} from '../lib/widgets.js';
import {Page} from './page.js';

const SELF_CARET_COLOR = '#0a84ff';
const SELF_CARET_MS = 110;
const PEER_CARET_MS = 350;

function statusSpec(status) {
    if (status === 'accepted')
        return {glyph: '✓', color: '#30d158'};
    if (status === 'declined')
        return {glyph: '✕', color: '#ff453a'};
    return {glyph: '•', color: '#8e8e93'};
}

export class RacePage extends Page {
    static id = 'race';
    static title = '';
    static autoHeight = false;
    static interval = 1000;

    build() {
        const actor = page();

        this._idle = this._buildIdle();
        this._lobbyHost = this._buildLobbyHost();
        this._lobbyGuest = this._buildLobbyGuest();
        this._racing = this._buildRacing();
        this._result = this._buildResult();
        this._pageEmpty = new EmptyState();

        this._views = {
            idle: this._idle, lobbyHost: this._lobbyHost, lobbyGuest: this._lobbyGuest,
            racing: this._racing, result: this._result,
        };

        for (const view of Object.values(this._views))
            actor.add_child(view);
        actor.add_child(this._pageEmpty.actor);
        return actor;
    }

    _buildIdle() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        const eyebrow = label('island-igroup-title', {text: 'NEARBY'});
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
        view.add_child(this._peerEmpty.actor);
        view.add_child(this._idleScroll);
        return view;
    }

    _buildLobbyHost() {
        const view = new St.BoxLayout({style_class: 'island-page island-race-host-row', x_expand: true, y_expand: true});
        this._inviteToggleBtn = pillButton('Invite more', () => this._toggleInvitePicker());
        const racersGroup = group('RACERS', this._inviteToggleBtn);
        this._hostRacerList = racersGroup.list;
        this._hostRacerRefs = new Map();
        const pickerGroup = group('INVITE');
        this._invitePickerActor = pickerGroup.actor;
        this._invitePickerList = pickerGroup.list;
        this._invitePickerActor.hide();
        const groups = column({style_class: 'island-groups'});
        groups.add_child(racersGroup.actor);
        groups.add_child(pickerGroup.actor);
        const left = scrollView(groups);
        left.x_expand = true;

        const panel = column({style_class: 'island-race-host-panel', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const track = new St.Widget({style_class: 'island-race-ready-track', layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
        this._readyFill = new St.Widget({style_class: 'island-race-ready-fill', x_align: Clutter.ActorAlign.START});
        track.add_child(this._readyFill);
        this._readyLabel = label('island-race-ready-label', {text: '', x_align: Clutter.ActorAlign.CENTER});
        const startBtn = pillButton('Start race', () => this.call('RaceStart', [], () => this.refresh()), 'primary');
        panel.add_child(track);
        panel.add_child(this._readyLabel);
        panel.add_child(startBtn);
        panel.add_child(this._leaveButton('Cancel', 'link'));

        view.add_child(left);
        view.add_child(panel);
        return view;
    }

    _buildLobbyGuest() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        this._guestEmpty = new EmptyState();
        this._acceptBtn = pillButton('Accept', () => this._respond(true), 'primary');
        this._declineBtn = pillButton('Decline', () => this._respond(false));
        this._respondBar = new St.BoxLayout({style_class: 'island-toolbar'});
        this._respondBar.add_child(this._acceptBtn);
        this._respondBar.add_child(this._declineBtn);
        this._guestLeaveBar = new St.BoxLayout({style_class: 'island-toolbar'});
        this._guestLeaveBar.add_child(this._leaveButton('Leave'));
        view.add_child(this._guestEmpty.actor);
        view.add_child(this._respondBar);
        view.add_child(this._guestLeaveBar);
        return view;
    }

    _buildRacing() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        const card = new St.BoxLayout({style_class: 'island-card island-race-card', x_expand: true, y_align: Clutter.ActorAlign.START});
        const cardCol = column({x_expand: true});

        this._passageStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true,
            reactive: true, can_focus: true,
        });
        this._passageLabel = new St.Label({style_class: 'island-race-passage', x_expand: true, y_expand: true});
        this._passageLabel.clutter_text.line_wrap = true;
        this._passageLabel.reactive = false;
        this._markerLayer = new St.Widget({x_expand: true, y_expand: true, clip_to_allocation: true, reactive: false});
        this._passageStack.add_child(this._passageLabel);
        this._passageStack.add_child(this._markerLayer);
        this._selfCaret = this._makeCaret(SELF_CARET_COLOR);
        this._markerLayer.add_child(this._selfCaret);
        this._raceMarkers = new Map();
        this._typed = '';
        this._passageStack.connect('key-press-event', (actor, event) => this._onKeyPress(event));

        cardCol.add_child(this._passageStack);
        card.add_child(cardCol);
        const raceGroup = group('RACERS');
        this._raceList = raceGroup.list;
        this._raceRefs = new Map();
        const groups = column({style_class: 'island-groups'});
        groups.add_child(raceGroup.actor);
        const toolbar = new St.BoxLayout({style_class: 'island-toolbar'});
        toolbar.add_child(this._leaveButton('Leave'));
        view.add_child(card);
        view.add_child(scrollView(groups));
        view.add_child(toolbar);
        return view;
    }

    _makeCaret(color) {
        const caret = new St.Widget({style_class: 'island-race-caret', visible: false});
        caret.set_style(`background-color: ${color}; box-shadow: 0 0 6px 1px ${color};`);
        return caret;
    }

    _racerColor(peerId) {
        return hashColor(peerId, TILE_COLORS);
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
        if (this._phase !== 'racing' || !this._passage)
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

    _syncRaceMarkers(state) {
        const seen = new Set();
        for (const r of state.racers ?? []) {
            if (r.peerId === state.selfId)
                continue;
            seen.add(r.peerId);
            let caret = this._raceMarkers.get(r.peerId);
            if (!caret) {
                caret = this._makeCaret(this._racerColor(r.peerId));
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

    _leaveButton(text, kind) {
        return pillButton(text, () => this.call('RaceLeave', [], () => this.refresh()), kind);
    }

    _buildResult() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        this._resultTitle = label('island-xf-title');
        this._resultHint = label('island-hint');

        this._winnerCard = new St.BoxLayout({style_class: 'island-race-winner-card', x_expand: true});
        this._winnerBadge = badge({glyph: '?', color: '#8e8e93'});
        this._winnerBadge.add_style_class_name('island-race-winner-avatar');
        const winnerText = column({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._winnerName = label('island-race-winner-name', {text: ''});
        this._winnerSub = label('island-race-winner-sub', {text: 'Winner'});
        winnerText.add_child(this._winnerName);
        winnerText.add_child(this._winnerSub);
        this._winnerWpm = label('island-race-winner-wpm', {x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
        this._winnerCard.add_child(this._winnerBadge);
        this._winnerCard.add_child(winnerText);
        this._winnerCard.add_child(this._winnerWpm);

        const resultGroup = group('RESULTS');
        this._resultGroupActor = resultGroup.actor;
        this._resultList = resultGroup.list;
        const toolbar = new St.BoxLayout({style_class: 'island-toolbar'});
        toolbar.add_child(this._leaveButton('Done', 'primary'));
        view.add_child(this._resultTitle);
        view.add_child(this._resultHint);
        view.add_child(this._winnerCard);
        view.add_child(scrollView(resultGroup.actor));
        view.add_child(toolbar);
        return view;
    }

    onShow() {
        this.refresh();
        if (this._phase === 'racing')
            this._passageStack.grab_key_focus();
        return null;
    }

    refresh() {
        this.fetch('RaceState', [], (state, err) => this._render(err ? null : state));
        if (this._phase === 'idle' || this._phase === undefined)
            this.fetch('RacePeers', [], (peers, err) => this._renderIdle(err ? [] : (peers ?? [])));
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
            this._raceSig = null;
            this._resultSig = null;
            this._peerSig = null;
            this._passage = null;
            this._selfCaret.visible = false;
            this._selfCaret._lastIndex = undefined;
            for (const caret of this._raceMarkers.values())
                caret.destroy();
            this._raceMarkers.clear();
        }
        const prevPhase = this._phase;
        this._phase = state.phase;
        if (state.phase === 'idle') {
            this._showView('idle');
        } else if (state.phase === 'lobby' && state.isHost) {
            this._showView('lobbyHost');
            this._renderLobbyHost(state);
        } else if (state.phase === 'lobby') {
            this._showView('lobbyGuest');
            this._renderLobbyGuest(state);
        } else if (state.phase === 'racing') {
            this._showView('racing');
            this._renderRacing(state);
            if (prevPhase !== 'racing')
                this._passageStack.grab_key_focus();
        } else {
            this._showView('result');
            this._renderResult(state);
        }
    }

    _showView(name) {
        for (const [key, view] of Object.entries(this._views))
            view.visible = key === name;
    }

    onSettings(st) {
        this._peerSig = null;
        if (this.active && (this._phase === 'idle' || this._phase === undefined))
            this.refresh();
    }

    _renderIdle(peers) {
        const on = featureOn(this.island.settings, 'race');
        const sig = `${on}:${peers.map(p => p.id).join('|')}`;
        if (sig === this._peerSig)
            return;
        this._peerSig = sig;
        if (!on || !peers.length) {
            this._idleScroll.hide();
            this._peerEmpty.show(on ? {
                icon: 'input-keyboard-symbolic', title: 'No one else found on this network yet',
                hint: 'Others show up here once they turn on LAN typing race',
            } : {
                icon: 'input-keyboard-symbolic', title: 'LAN typing race is off',
                hint: 'Turn it on in Settings to race people on your network',
            });
            return;
        }
        this._peerEmpty.hide();
        this._idleScroll.show();
        fillList(this._peerFlow, peers, p => this._peerAvatar(p, (peer, refs) => this._invitePeer(peer, refs)));
    }

    _peerAvatar(peer, onPick) {
        const col = column({x_align: Clutter.ActorAlign.CENTER});
        const badgeActor = badge({glyph: (peer.name[0] ?? '?').toUpperCase(), color: this._racerColor(peer.id)});
        badgeActor.add_style_class_name('island-race-peer-avatar');
        const btn = new St.Button({style_class: 'island-race-peer-btn', can_focus: true, child: badgeActor});
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
        const badgeActor = badge({glyph: (peer.name[0] ?? '?').toUpperCase(), color: this._racerColor(peer.id)});
        row.add_child(badgeActor);
        row.add_child(rowText(peer.name, peer.addr).col);
        const btn = pillButton('Race', () => onPick(peer, btn));
        row.add_child(btn);
        return row;
    }

    _invitePeer(peer, refs) {
        refs.btn.reactive = false;
        setText(refs.addr, 'Inviting…');
        this.call('RaceCreate', [], () => {
            this.call('RaceInvite', [peer.id], (_result, err) => {
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
        this.call('RaceInvite', [peer.id], (_result, err) => {
            if (err) {
                btn.reactive = true;
                btn.label = 'Race';
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
        this.fetch('RacePeers', [], (peers, err) => {
            if (!this._invitePickerOpen)
                return;
            const list = (err ? [] : (peers ?? [])).filter(p => !invited?.has(p.id));
            fillList(this._invitePickerList, list, p => this._peerRow(p, (peer, btn) => this._inviteOnly(peer, btn)));
        });
    }

    _renderLobbyHost(state) {
        const racers = state.racers ?? [];
        this._invitedIds = new Set(racers.map(r => r.peerId));
        this._syncHostRacerRows(racers);
        const ready = racers.filter(r => r.status === 'accepted').length;
        const total = Math.max(racers.length, 1);
        this._readyFill.width = Math.round(160 * (ready / total));
        setText(this._readyLabel, `${ready} of ${racers.length} ready to race`);
        if (this._invitePickerOpen)
            this._refreshInvitePicker();
    }

    _syncHostRacerRows(racers) {
        const sig = racers.map(r => r.peerId).join('|');
        if (sig !== this._hostSig) {
            this._hostSig = sig;
            this._hostRacerList.destroy_all_children();
            this._hostRacerRefs.clear();
            for (const r of racers) {
                const row = new St.BoxLayout({style_class: 'island-irow island-irow-box', x_expand: true});
                const name = label('island-irow-title', {text: r.name, x_expand: true});
                row.add_child(name);
                const badgeActor = badge(statusSpec(r.status));
                row.add_child(badgeActor);
                this._hostRacerList.add_child(row);
                this._hostRacerRefs.set(r.peerId, {name, row, badgeActor, status: r.status});
            }
            return;
        }
        for (const r of racers) {
            const refs = this._hostRacerRefs.get(r.peerId);
            if (!refs)
                continue;
            setText(refs.name, r.name);
            if (refs.status !== r.status) {
                refs.status = r.status;
                refs.row.remove_child(refs.badgeActor);
                refs.badgeActor = badge(statusSpec(r.status));
                refs.row.add_child(refs.badgeActor);
            }
        }
    }

    _renderLobbyGuest(state) {
        const host = (state.racers ?? [])[0];
        this._guestEmpty.show({
            icon: 'input-keyboard-symbolic', title: 'Waiting for the host to start',
            hint: host ? `Invited by ${host.name}` : '',
        });
        this._respondBar.visible = !this._guestResponded;
        this._guestLeaveBar.visible = !!this._guestResponded;
    }

    _respond(accept) {
        this._acceptBtn.reactive = false;
        this._declineBtn.reactive = false;
        this.call('RaceRespond', [accept], (_result, err) => {
            this._acceptBtn.reactive = true;
            this._declineBtn.reactive = true;
            if (err)
                return;
            this._guestResponded = true;
            this.refresh();
        });
    }

    _renderRacing(state) {
        const incoming = state.passage ?? '';
        if (this._passage !== incoming) {
            this._passage = incoming;
            this._selfCaret._lastIndex = undefined;
            this._applyTyped();
        }
        this._syncRaceMarkers(state);
        this._syncRaceRows(state.racers ?? [], state.selfId);
    }

    _syncRaceRows(racers, selfId) {
        const sig = racers.map(r => r.peerId).join('|');
        if (sig !== this._raceSig) {
            this._raceSig = sig;
            this._raceList.destroy_all_children();
            this._raceRefs.clear();
            for (const r of racers) {
                const row = new St.BoxLayout({style_class: 'island-irow island-irow-box', x_expand: true});
                const dot = badge({color: r.peerId === selfId ? SELF_CARET_COLOR : this._racerColor(r.peerId), glyph: ''});
                const name = label('island-irow-title', {text: r.name, x_expand: true});
                const value = label('island-irow-sub', {x_align: Clutter.ActorAlign.END});
                row.add_child(dot);
                row.add_child(name);
                row.add_child(value);
                this._raceList.add_child(row);
                this._raceRefs.set(r.peerId, {name, value});
            }
        }
        for (const r of racers) {
            const refs = this._raceRefs.get(r.peerId);
            if (!refs)
                continue;
            setText(refs.name, r.name);
            setText(refs.value, r.finishedAtMs ? `Finished · ${Math.round(r.wpm)} wpm` : '');
        }
    }

    _renderResult(state) {
        const finished = state.phase === 'finished';
        const missed = state.phase === 'missed';
        const ranked = [...(state.racers ?? [])].sort((a, b) => (a.finishedAtMs || Infinity) - (b.finishedAtMs || Infinity));
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
        const sig = ranked.map(r => r.peerId).join('|');
        if (sig === this._resultSig)
            return;
        this._resultSig = sig;
        if (winner) {
            this._winnerBadge.set_style(`background-color: ${winner.peerId === state.selfId ? SELF_CARET_COLOR : this._racerColor(winner.peerId)};`);
            this._winnerBadge.child.text = (winner.name[0] ?? '?').toUpperCase();
            setText(this._winnerName, winner.name);
            setText(this._winnerWpm, winner.finishedAtMs ? `${Math.round(winner.wpm)} wpm` : '—');
        }
        fillList(this._resultList, ranked.slice(1), (r, i) => this._resultRow(r, i + 2));
    }

    _resultRow(r, rank) {
        const row = new St.BoxLayout({style_class: 'island-irow island-irow-box', x_expand: true});
        row.add_child(label('island-race-rank', {text: `${rank}`, x_align: Clutter.ActorAlign.CENTER}));
        row.add_child(label('island-irow-title', {text: r.name, x_expand: true}));
        row.add_child(label('island-irow-sub', {
            text: r.finishedAtMs ? `${Math.round(r.wpm)} wpm` : 'Did not finish',
            x_align: Clutter.ActorAlign.END,
        }));
        return row;
    }
}
