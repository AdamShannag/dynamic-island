import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class OsdTakeover {
    constructor(handler) {
        this._handler = handler;
        this._orig = null;
    }

    set enabled(on) {
        const osd = Main.osdWindowManager;
        if (on && !this._orig) {
            const orig = osd.show;
            const handler = this._handler;
            this._orig = orig;
            osd.show = function (monitorIndex, icon, label, level, maxLevel) {
                if (!handler(monitorIndex, icon, label, level, maxLevel))
                    orig.call(this, monitorIndex, icon, label, level, maxLevel);
            };
        } else if (!on && this._orig) {
            osd.show = this._orig;
            this._orig = null;
        }
    }
}

export class BannerBlocker {
    constructor() {
        this._on = false;
    }

    set enabled(on) {
        const tray = Main.messageTray;
        if (!tray || on === this._on)
            return;
        this._on = on;
        if (on) {
            Object.defineProperty(tray, 'bannerBlocked', {
                configurable: true,
                get: () => true,
                set: () => {},
            });
            tray._bannerBlocked = true;
        } else {
            delete tray.bannerBlocked;
            tray._bannerBlocked = false;
        }
        tray._updateState?.();
    }
}

export class BannerMute {
    constructor() {
        this._was = undefined;
    }

    set muted(on) {
        const notif = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        if (on && this._was === undefined) {
            this._was = notif.get_boolean('show-banners');
            notif.set_boolean('show-banners', false);
        } else if (!on && this._was !== undefined) {
            notif.set_boolean('show-banners', this._was);
            this._was = undefined;
        }
    }
}

export class ScreenShareWatcher {
    constructor(onChange) {
        this._shares = new Set();
        this._controller = global.backend.get_remote_access_controller?.();
        this._controller?.connectObject('new-handle', (_c, handle) => {
            if (handle.is_recording)
                return;
            this._shares.add(handle);
            onChange(true);
            handle.connectObject('stopped', () => {
                this._shares.delete(handle);
                if (!this._shares.size)
                    onChange(false);
            }, this);
        }, this);
    }

    destroy() {
        this._controller?.disconnectObject(this);
        for (const h of this._shares)
            h.disconnectObject(this);
        this._shares.clear();
    }
}
