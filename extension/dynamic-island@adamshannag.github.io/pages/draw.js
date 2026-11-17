import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Cairo from 'gi://cairo';

import {featureOn} from '../lib/constants.js';
import {hexToRgb} from '../lib/format.js';
import {
    EmptyState, badge, column, fillList, group, label, page, pillButton, rowText, scrollView,
    setText,
} from '../lib/widgets.js';
import {Page} from './page.js';

const INK_COLOR = '#1c1c1e';
const INK_WIDTH = 3;
const CANVAS_BG = '#f5f5f7';
const STROKE_FLUSH_MS = 80;

function statusSpec(status) {
    if (status === 'accepted')
        return {glyph: '✓', color: '#30d158'};
    if (status === 'declined')
        return {glyph: '✕', color: '#ff453a'};
    return {glyph: '•', color: '#8e8e93'};
}

export class DrawPage extends Page {
    static id = 'draw';
    static title = '';
    static autoHeight = false;
    static height = 560;
    static interval = 1000;

    build() {
        const actor = page();

        this._idle = this._buildIdle();
        this._lobbyHost = this._buildLobbyHost();
        this._lobbyGuest = this._buildLobbyGuest();
        this._drawing = this._buildDrawing();
        this._reveal = this._buildReveal();
        this._result = this._buildResult();
        this._pageEmpty = new EmptyState();

        this._views = {
            idle: this._idle, lobbyHost: this._lobbyHost, lobbyGuest: this._lobbyGuest,
            drawing: this._drawing, reveal: this._reveal, result: this._result,
        };

        for (const view of Object.values(this._views))
            actor.add_child(view);
        actor.add_child(this._pageEmpty.actor);
        return actor;
    }

    _buildIdle() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        this._peerEmpty = new EmptyState();
        const peerGroup = group('NEARBY');
        this._peerList = peerGroup.list;
        const groups = column({style_class: 'island-groups'});
        groups.add_child(peerGroup.actor);
        this._idleScroll = scrollView(groups);
        view.add_child(this._peerEmpty.actor);
        view.add_child(this._idleScroll);
        return view;
    }

    _buildLobbyHost() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
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
        view.add_child(scrollView(groups));
        const toolbar = new St.BoxLayout({style_class: 'island-toolbar'});
        toolbar.add_child(pillButton('Start game', () => this.call('DrawStart', [], () => this.refresh()), 'primary'));
        toolbar.add_child(this._leaveButton('Cancel'));
        view.add_child(toolbar);
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

    _buildDrawing() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});

        const header = new St.BoxLayout({style_class: 'island-draw-header', x_expand: true});
        this._drawerLabel = label('island-irow-title', {x_expand: true});
        this._roundLabel = label('island-hint', {x_align: Clutter.ActorAlign.END});
        header.add_child(this._drawerLabel);
        header.add_child(this._roundLabel);

        this._canvas = new St.DrawingArea({style_class: 'island-draw-canvas', x_expand: true, y_expand: true, reactive: true});
        this._canvas.connect('repaint', area => this._paint(area));
        this._canvas.connect('button-press-event', (actor, event) => this._onPressStart(event));
        this._canvas.connect('motion-event', (actor, event) => this._onPointerMove(event));
        this._canvas.connect('button-release-event', () => this._onPressEnd());
        this._canvas.connect('leave-event', () => this._onPressEnd());

        this._guessedLabel = label('island-hint', {x_expand: true});
        this._drawHint = label('island-hint', {text: "You're drawing — ask the others to guess!", visible: false});

        this._guessEntry = new St.Entry({
            style_class: 'island-entry island-draw-guess', hint_text: 'Type your guess…',
            can_focus: true, x_expand: true,
        });
        this._guessEntry.clutter_text.connect('activate', () => this._submitGuess());
        this._guessBar = new St.BoxLayout({style_class: 'island-toolbar'});
        this._guessBar.add_child(this._guessEntry);

        const toolbar = new St.BoxLayout({style_class: 'island-toolbar'});
        toolbar.add_child(this._leaveButton('Leave'));

        view.add_child(header);
        view.add_child(this._canvas);
        view.add_child(this._guessedLabel);
        view.add_child(this._drawHint);
        view.add_child(this._guessBar);
        view.add_child(toolbar);
        return view;
    }

    _buildReveal() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        this._revealWord = label('island-xf-title', {x_align: Clutter.ActorAlign.CENTER});
        this._revealHint = label('island-hint', {x_align: Clutter.ActorAlign.CENTER, text: 'Next round starting…'});
        const scoresGroup = group('THIS ROUND');
        this._revealScoresList = scoresGroup.list;
        const groups = column({style_class: 'island-groups'});
        groups.add_child(scoresGroup.actor);
        view.add_child(this._revealWord);
        view.add_child(this._revealHint);
        view.add_child(scrollView(groups));
        return view;
    }

    _buildResult() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        this._resultTitle = label('island-xf-title');
        this._resultHint = label('island-hint');
        const resultGroup = group('LEADERBOARD');
        this._resultGroupActor = resultGroup.actor;
        this._resultList = resultGroup.list;
        const toolbar = new St.BoxLayout({style_class: 'island-toolbar'});
        toolbar.add_child(this._leaveButton('Done', 'primary'));
        view.add_child(this._resultTitle);
        view.add_child(this._resultHint);
        view.add_child(scrollView(resultGroup.actor));
        view.add_child(toolbar);
        return view;
    }

    _leaveButton(text, kind) {
        return pillButton(text, () => this.call('DrawLeave', [], () => this.refresh()), kind);
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

    _localPoint(event) {
        const [sx, sy] = event.get_coords();
        const [ok, lx, ly] = this._canvas.transform_stage_point(sx, sy);
        if (!ok)
            return null;
        const [w, h] = this._canvas.get_surface_size();
        if (w <= 0 || h <= 0)
            return null;
        return {x: Math.min(1, Math.max(0, lx / w)), y: Math.min(1, Math.max(0, ly / h))};
    }

    _isSelfDrawing() {
        return this._phase === 'drawing' && this._drawerId && this._drawerId === this._selfId;
    }

    _onPressStart(event) {
        if (!this._isSelfDrawing())
            return Clutter.EVENT_PROPAGATE;
        const p = this._localPoint(event);
        if (!p)
            return Clutter.EVENT_PROPAGATE;
        this._liveStroke = {points: [p], color: INK_COLOR, width: INK_WIDTH};
        this._lastFlushAt = GLib.get_monotonic_time() / 1000;
        this._canvas.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    _onPointerMove(event) {
        if (!this._liveStroke)
            return Clutter.EVENT_PROPAGATE;
        const p = this._localPoint(event);
        if (!p)
            return Clutter.EVENT_PROPAGATE;
        this._liveStroke.points.push(p);
        this._canvas.queue_repaint();
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

    onShow() {
        this.refresh();
        if (this._phase === 'drawing' && !this._isSelfDrawing())
            this._guessEntry.grab_key_focus();
        return null;
    }

    refresh() {
        this.fetch('DrawState', [], (state, err) => this._render(err ? null : state));
        if (this._phase === 'idle' || this._phase === undefined)
            this.fetch('DrawPeers', [], (peers, err) => this._renderIdle(err ? [] : (peers ?? [])));
    }

    _render(state) {
        if (!state) {
            this._phase = null;
            this._showView(null);
            this._pageEmpty.show({icon: 'applications-graphics-symbolic', title: 'Daemon not running'});
            return;
        }
        this._pageEmpty.hide();
        if (state.lobbyId !== this._lobbyId) {
            this._lobbyId = state.lobbyId;
            this._guestResponded = false;
            this._invitePickerOpen = false;
            this._invitePickerActor.hide();
            this._inviteToggleBtn.label = 'Invite more';
            this._hostSig = null;
            this._resultSig = null;
            this._peerSig = null;
            this._strokes = [];
            this._liveStroke = null;
        }
        const prevPhase = this._phase;
        this._phase = state.phase;
        this._drawerId = state.drawerId;
        this._selfId = state.selfId;
        if (state.phase === 'idle') {
            this._showView('idle');
        } else if (state.phase === 'lobby' && state.isHost) {
            this._showView('lobbyHost');
            this._renderLobbyHost(state);
        } else if (state.phase === 'lobby') {
            this._showView('lobbyGuest');
            this._renderLobbyGuest(state);
        } else if (state.phase === 'drawing') {
            this._showView('drawing');
            this._renderDrawing(state);
            if (prevPhase !== 'drawing' && !this._isSelfDrawing())
                this._guessEntry.grab_key_focus();
        } else if (state.phase === 'reveal') {
            this._showView('reveal');
            this._renderReveal(state);
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

    _renderIdle(peers) {
        const on = featureOn(this.island.settings, 'draw');
        const sig = `${on}:${peers.map(p => p.id).join('|')}`;
        if (sig === this._peerSig)
            return;
        this._peerSig = sig;
        if (!on || !peers.length) {
            this._idleScroll.hide();
            this._peerEmpty.show(on ? {
                icon: 'applications-graphics-symbolic', title: 'No one else found on this network yet',
                hint: 'Others show up here once they turn on the LAN drawing game',
            } : {
                icon: 'applications-graphics-symbolic', title: 'LAN drawing game is off',
                hint: 'Turn it on in Settings to draw and guess with people on your network',
            });
            return;
        }
        this._peerEmpty.hide();
        this._idleScroll.show();
        fillList(this._peerList, peers, p => this._peerRow(p, (peer, btn) => this._invitePeer(peer, btn)));
    }

    _peerRow(peer, onPick) {
        const row = new St.BoxLayout({style_class: 'island-irow island-irow-box', x_expand: true});
        row.add_child(rowText(peer.name, peer.addr).col);
        const btn = pillButton('Invite', () => onPick(peer, btn));
        row.add_child(btn);
        return row;
    }

    _invitePeer(peer, btn) {
        btn.reactive = false;
        btn.label = 'Inviting…';
        this.call('DrawCreate', [], () => {
            this.call('DrawInvite', [peer.id], (_result, err) => {
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
        this.call('DrawInvite', [peer.id], (_result, err) => {
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
        this.fetch('DrawPeers', [], (peers, err) => {
            if (!this._invitePickerOpen)
                return;
            const list = (err ? [] : (peers ?? [])).filter(p => !invited?.has(p.id));
            fillList(this._invitePickerList, list, p => this._peerRow(p, (peer, btn) => this._inviteOnly(peer, btn)));
        });
    }

    _renderLobbyHost(state) {
        const players = state.players ?? [];
        this._invitedIds = new Set(players.map(p => p.peerId));
        this._syncHostPlayerRows(players);
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
                const name = label('island-irow-title', {text: p.name, x_expand: true});
                row.add_child(name);
                const badgeActor = badge(statusSpec(p.status));
                row.add_child(badgeActor);
                this._hostPlayerList.add_child(row);
                this._hostPlayerRefs.set(p.peerId, {name, row, badgeActor, status: p.status});
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
                refs.row.remove_child(refs.badgeActor);
                refs.badgeActor = badge(statusSpec(p.status));
                refs.row.add_child(refs.badgeActor);
            }
        }
    }

    _renderLobbyGuest(state) {
        const host = (state.players ?? [])[0];
        this._guestEmpty.show({
            icon: 'applications-graphics-symbolic', title: 'Waiting for the host to start',
            hint: host ? `Invited by ${host.name}` : '',
        });
        this._respondBar.visible = !this._guestResponded;
        this._guestLeaveBar.visible = !!this._guestResponded;
    }

    _respond(accept) {
        this._acceptBtn.reactive = false;
        this._declineBtn.reactive = false;
        this.call('DrawRespond', [accept], (_result, err) => {
            this._acceptBtn.reactive = true;
            this._declineBtn.reactive = true;
            if (err)
                return;
            this._guestResponded = true;
            this.refresh();
        });
    }

    _nameFor(players, peerId) {
        return (players ?? []).find(p => p.peerId === peerId)?.name ?? '';
    }

    _renderDrawing(state) {
        this._strokes = state.strokes ?? [];
        const isDrawer = this._isSelfDrawing();
        setText(this._drawerLabel, isDrawer ? 'Your turn to draw!' : `${state.drawerName} is drawing`);
        const secsLeft = Math.max(0, Math.round(((state.roundEndsAtMs ?? 0) - Date.now()) / 1000));
        setText(this._roundLabel, `Round ${state.round}/${state.totalRounds}  ·  ${secsLeft}s`);
        const names = (state.guessed ?? []).map(id => this._nameFor(state.players, id)).filter(Boolean);
        setText(this._guessedLabel, names.length ? `Guessed: ${names.join(', ')}` : 'Nobody has guessed correctly yet');
        this._guessBar.visible = !isDrawer;
        this._drawHint.visible = isDrawer;
        this._canvas.queue_repaint();
    }

    _renderReveal(state) {
        const lr = state.lastRound;
        setText(this._revealWord, lr ? `The word was "${lr.word}"` : '');
        fillList(this._revealScoresList, lr?.deltas ?? [], d => this._deltaRow(d));
    }

    _deltaRow(d) {
        const row = new St.BoxLayout({style_class: 'island-irow island-irow-box', x_expand: true});
        row.add_child(label('island-irow-title', {text: d.name, x_expand: true}));
        row.add_child(label('island-irow-sub', {text: `+${d.points}`, x_align: Clutter.ActorAlign.END}));
        return row;
    }

    _renderResult(state) {
        const finished = state.phase === 'finished';
        const missed = state.phase === 'missed';
        setText(this._resultTitle, finished ? 'Game finished!' : missed ? 'That game already started' : 'The host left the game');
        setText(this._resultHint, finished ? '' : missed ? 'The host started before you joined.' : 'Your progress was not saved.');
        this._resultHint.visible = !finished;
        this._resultGroupActor.visible = finished;
        if (!finished)
            return;
        const ranked = [...(state.players ?? [])].sort((a, b) => b.score - a.score);
        const sig = ranked.map(p => `${p.peerId}:${p.score}`).join('|');
        if (sig === this._resultSig)
            return;
        this._resultSig = sig;
        fillList(this._resultList, ranked, (p, i) => this._resultRow(p, i));
    }

    _resultRow(p, i) {
        const row = new St.BoxLayout({style_class: 'island-irow island-irow-box', x_expand: true});
        row.add_child(label('island-irow-title', {text: `${i + 1}. ${p.name}`, x_expand: true}));
        row.add_child(label('island-irow-sub', {text: `${p.score} pts`, x_align: Clutter.ActorAlign.END}));
        return row;
    }
}
