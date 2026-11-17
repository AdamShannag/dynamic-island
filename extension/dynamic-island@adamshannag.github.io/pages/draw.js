import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Cairo from 'gi://cairo';

import {TILE_COLORS, featureOn} from '../lib/constants.js';
import {hashColor, hexToRgb} from '../lib/format.js';
import {
    EmptyState, badge, column, fillList, group, label, page, pillButton, scrollView,
    setText,
} from '../lib/widgets.js';
import {Page} from './page.js';

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

export class DrawPage extends Page {
    static id = 'draw';
    static title = '';
    static autoHeight = false;
    static height = 500;
    static interval = 1000;

    build() {
        const actor = page();

        this._idle = this._buildIdle();
        this._lobbyHost = this._buildLobbyHost();
        this._lobbyGuest = this._buildLobbyGuest();
        this._drawing = this._buildDrawing();
        this._guessing = this._buildGuessing();
        this._reveal = this._buildReveal();
        this._result = this._buildResult();
        this._pageEmpty = new EmptyState();

        this._views = {
            idle: this._idle, lobbyHost: this._lobbyHost, lobbyGuest: this._lobbyGuest,
            drawing: this._drawing, guessing: this._guessing, reveal: this._reveal, result: this._result,
        };

        for (const view of Object.values(this._views))
            actor.add_child(view);
        actor.add_child(this._pageEmpty.actor);
        return actor;
    }

    _playerColor(peerId) {
        return hashColor(peerId, TILE_COLORS);
    }

    _buildIdle() {
        const view = column({style_class: 'island-page', x_expand: true, y_expand: true});
        const eyebrow = label('island-igroup-title', {text: 'NEARBY'});
        const subtitle = label('island-race-subtitle', {text: 'Tap someone to invite them to draw'});
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

    _chip(status) {
        const spec = chipSpec(status);
        return label(`island-race-chip ${spec.kind}`, {text: spec.text});
    }

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
        const ring = new St.Widget({
            style_class: 'island-race-ready-ring', layout_manager: new Clutter.BinLayout(),
            width: 86, height: 86, x_expand: false, y_expand: false, x_align: Clutter.ActorAlign.CENTER,
        });
        this._readyRingLabel = label('island-race-ready-ring-label', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        ring.add_child(this._readyRingLabel);
        this._readyLabel = label('island-race-ready-label', {text: '', x_align: Clutter.ActorAlign.CENTER});
        const startBtn = pillButton('Start game', () => this.call('DrawStart', [], () => this.refresh()), 'primary');
        startBtn.add_style_class_name('island-race-start-btn');
        panel.add_child(ring);
        panel.add_child(this._readyLabel);
        panel.add_child(startBtn);
        panel.add_child(this._leaveButton('Cancel', 'link'));

        row.add_child(left);
        row.add_child(panel);
        view.add_child(eyebrow);
        view.add_child(subtitle);
        view.add_child(row);
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

    _buildPresenceRow() {
        return new St.Widget({layout_manager: new Clutter.FixedLayout(), height: 28});
    }

    _syncPresence(row, sig, players, guessedIds) {
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
        this._winnerScore = label('island-race-winner-wpm', {x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
        this._winnerCard.add_child(this._winnerBadge);
        this._winnerCard.add_child(winnerText);
        this._winnerCard.add_child(this._winnerScore);

        const resultGroup = group('LEADERBOARD');
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
        return this._phase === 'drawing' && this._drawerId && this._drawerId === this._selfId;
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
            const isDrawer = this._isSelfDrawing();
            this._showView(isDrawer ? 'drawing' : 'guessing');
            this._renderDrawing(state, isDrawer);
            if (prevPhase !== 'drawing' && !isDrawer)
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
        fillList(this._peerFlow, peers, p => this._peerAvatar(p, (peer, refs) => this._invitePeer(peer, refs)));
    }

    _invitePeer(peer, refs) {
        refs.btn.reactive = false;
        setText(refs.addr, 'Inviting…');
        this.call('DrawCreate', [], () => {
            this.call('DrawInvite', [peer.id], (_result, err) => {
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
        const ready = players.filter(p => p.status === 'accepted').length;
        setText(this._readyRingLabel, `${ready}/${players.length}`);
        setText(this._readyLabel, `${ready} of ${players.length} ready to play`);
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

    _renderDrawing(state, isDrawer) {
        this._strokes = state.strokes ?? [];
        const secsLeft = Math.max(0, Math.round(((state.roundEndsAtMs ?? 0) - Date.now()) / 1000));
        const players = state.players ?? [];
        const guessedIds = new Set(state.guessed ?? []);
        if (isDrawer) {
            setText(this._drawRoundLabel, `ROUND ${state.round} OF ${state.totalRounds} · YOU'RE DRAWING`);
            setText(this._drawTimer, `${secsLeft}s`);
            setText(this._wordLabel, (state.word ?? '').toUpperCase());
            this._syncPresence(this._drawPresence, null, players, guessedIds);
        } else {
            setText(this._guessRoundLabel, `ROUND ${state.round} OF ${state.totalRounds}`);
            setText(this._guessTimer, `${secsLeft}s`);
            this._drawerAvatar.set_style(`background-color: ${this._playerColor(state.drawerId)};`);
            this._drawerAvatar.child.text = (state.drawerName?.[0] ?? '?').toUpperCase();
            setText(this._drawerLabel, `${state.drawerName} is drawing`);
            this._syncPresence(this._guessPresence, null, players, guessedIds);
        }
        (isDrawer ? this._drawCanvas : this._guessCanvas).queue_repaint();
    }

    _renderReveal(state) {
        const lr = state.lastRound;
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

    _renderResult(state) {
        const finished = state.phase === 'finished';
        const missed = state.phase === 'missed';
        const ranked = [...(state.players ?? [])].sort((a, b) => b.score - a.score);
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
        const sig = ranked.map(p => `${p.peerId}:${p.score}`).join('|');
        if (sig === this._resultSig)
            return;
        this._resultSig = sig;
        if (winner) {
            this._winnerBadge.set_style(`background-color: ${this._playerColor(winner.peerId)};`);
            this._winnerBadge.child.text = (winner.name[0] ?? '?').toUpperCase();
            setText(this._winnerName, winner.name);
            setText(this._winnerScore, `${winner.score} pts`);
        }
        fillList(this._resultList, ranked.slice(1), (p, i) => this._resultRow(p, i + 2));
    }

    _resultRow(p, rank) {
        const row = new St.BoxLayout({style_class: 'island-irow island-irow-box', x_expand: true});
        row.add_child(label('island-race-rank', {text: `${rank}`, x_align: Clutter.ActorAlign.CENTER}));
        const avatar = badge({glyph: (p.name[0] ?? '?').toUpperCase(), color: this._playerColor(p.peerId)});
        avatar.add_style_class_name('island-race-list-avatar');
        row.add_child(avatar);
        row.add_child(label('island-irow-title', {text: p.name, x_expand: true}));
        row.add_child(label('island-irow-sub', {text: `${p.score} pts`, x_align: Clutter.ActorAlign.END}));
        return row;
    }
}
