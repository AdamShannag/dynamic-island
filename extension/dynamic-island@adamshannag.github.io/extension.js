import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Island} from './island.js';
import {ClipboardWatcher} from './lib/clipboard.js';
import {DEFAULT_SETTINGS, IDLE, featureOn} from './lib/constants.js';
import {DaemonClient, LOG_PREFIX} from './lib/dbus.js';
import {BannerBlocker, BannerMute, OsdTakeover, ScreenShareWatcher} from './lib/gnome.js';
import {activateNotification} from './lib/shell.js';

const PREWARM_DELAY_S = 3;

export default class DynamicIslandExtension extends Extension {
    enable() {
        this.agentIcon = Gio.icon_new_for_string(`${this.path}/icons/agent.svg`);
        this.spyIcon = Gio.icon_new_for_string(`${this.path}/icons/spy.svg`);
        this.presenting = false;
        this.settings = DEFAULT_SETTINGS;
        this._autoPresent = false;

        this._island = new Island(this);
        Main.layoutManager.addTopChrome(this._island, {trackFullscreen: true});
        this._dateMenu = Main.panel.statusArea.dateMenu;
        this._dateMenu?.container.set_opacity(0);

        const relayout = () => this._island.relayout(false);
        Main.layoutManager.connectObject('monitors-changed', relayout, this);
        Main.panel.connectObject('notify::height', relayout, this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor', relayout, this);

        this._island.setState(IDLE);
        this._island.applySettings(this.settings);

        this._osd = new OsdTakeover((monitor, icon, label, level, maxLevel) => this._showOsd(monitor, icon, label, level, maxLevel));
        this._osd.enabled = true;
        this._banners = new BannerBlocker();
        this._bannerMute = new BannerMute();
        this._shares = new ScreenShareWatcher(sharing => {
            if (sharing)
                this.setPresenting(true, true);
            else if (this._autoPresent)
                this.setPresenting(false, false);
        });
        this._clipboard = new ClipboardWatcher({
            shouldRecord: () => this._daemon.connected && !this.presenting && featureOn(this.settings, 'clipboardHistory'),
            record: text => this.call('ClipboardAdd', [text]),
        });
        this._daemon = new DaemonClient({
            onConnect: cancellable => this._onConnect(cancellable),
            onDisconnect: () => this._onDisconnect(),
            signals: {
                StateChanged: json => this._applyState(json),
                OpenDashboard: tab => this._island?.toggleDash(tab),
                SettingsChanged: json => this.applySettings(JSON.parse(json)),
                ColorPicked: hex => this.copy(hex),
            },
        });
    }

    disable() {
        this._daemon.destroy();
        this._daemon = null;
        this._clipboard.destroy();
        this._clipboard = null;
        this._shares.destroy();
        this._shares = null;
        this._osd.enabled = false;
        this._banners.enabled = false;
        this.setPresenting(false, false);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.panel.disconnectObject(this);
        this._dateMenu?.container.set_opacity(255);
        this._dateMenu = null;
        Main.layoutManager.removeChrome(this._island);
        this._island.destroy();
        this._island = null;
    }

    call(method, args = [], cb = null) {
        if (this._daemon)
            this._daemon.call(method, args, cb);
        else
            cb?.(null, new Error('daemon not running'));
    }

    callJson(method, args, cb) {
        if (this._daemon)
            this._daemon.callJson(method, args, cb);
        else
            cb(null, new Error('daemon not running'));
    }

    action(name) {
        this.call('Action', [name]);
    }

    activateNotification(view) {
        return activateNotification(view);
    }

    setPresenting(on, auto) {
        if (on === this.presenting) {
            if (!auto)
                this._autoPresent = false;
            return;
        }
        this.presenting = on;
        this._autoPresent = on && auto;
        this._bannerMute.muted = on;
        this.call('SetPresenting', [on]);
        this._island?.setPresenting(on);
    }

    applySettings(st) {
        this.settings = st;
        this._island?.applySettings(st);
        this._osd.enabled = featureOn(st, 'osd');
        this._banners.enabled = !!this._daemon?.connected && featureOn(st, 'hideBanners');
    }

    updateSettings(patch) {
        this.callJson('SetSettings', [JSON.stringify(patch)], (st, err) => {
            if (!err)
                this.applySettings(st);
            else
                this._island?.applySettings(this.settings);
        });
    }

    copy(text) {
        this._clipboard.copy(text);
        if (!this.presenting)
            this.call('ClipboardAdd', [text]);
    }

    latestClip(cb) {
        this.callJson('ClipboardList', [], (items, err) => {
            if (err)
                return cb(null);
            const sorted = [...items ?? []].sort((a, b) => b.at - a.at);
            return cb(sorted[0]?.text ?? null);
        });
    }

    _showOsd(monitorIndex, icon, label, level, maxLevel) {
        const island = this._island;
        const primary = Main.layoutManager.primaryMonitor;
        if (!island || island.dashOpen || !primary || primary.inFullscreen)
            return false;
        if (monitorIndex !== -1 && monitorIndex !== Main.layoutManager.primaryIndex)
            return false;
        island.showOsd(icon, label, level, maxLevel);
        return true;
    }

    _onConnect(cancellable) {
        this._banners.enabled = featureOn(this.settings, 'hideBanners');
        this.callJson('GetSettings', [], (st, err) => {
            if (!err && !cancellable.is_cancelled())
                this.applySettings(st);
        });
        GLib.timeout_add_seconds(GLib.PRIORITY_LOW, PREWARM_DELAY_S, () => {
            this._island?.prewarm();
            return GLib.SOURCE_REMOVE;
        });
        if (this.presenting)
            this.call('SetPresenting', [true]);
        this.call('GetState', [], (result, err) => {
            if (!err && !cancellable.is_cancelled())
                this._applyState(result[0]);
        });
    }

    _onDisconnect() {
        this._banners.enabled = false;
        this._island?.setState(IDLE);
    }

    _applyState(json) {
        try {
            this._island?.setState(JSON.parse(json));
        } catch (e) {
            console.error(`${LOG_PREFIX}: bad state: ${e.message}`);
        }
    }
}
