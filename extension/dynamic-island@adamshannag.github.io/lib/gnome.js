import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SHELL_MAJOR} from './constants.js';

export class OsdTakeover {
    constructor(handler) {
        this._handler = handler;
        this._orig = null;
        this._origAll = null;
    }

    set enabled(on) {
        const osd = Main.osdWindowManager;
        const handler = this._handler;
        if (on && !this._orig) {
            const origShow = osd.show;
            this._orig = origShow;
            osd.show = SHELL_MAJOR >= 50 ? function (icon, label, levels) {
                const rest = {};
                for (const [idx, lv] of Object.entries(levels)) {
                    if (!handler(Number(idx), icon, label, lv.level, lv.maxLevel ?? -1))
                        rest[idx] = lv;
                }
                if (Object.keys(rest).length)
                    origShow.call(this, icon, label, rest);
            } : function (monitorIndex, icon, label, level, maxLevel) {
                if (!handler(monitorIndex, icon, label, level, maxLevel))
                    origShow.call(this, monitorIndex, icon, label, level, maxLevel);
            };
            if (SHELL_MAJOR >= 50) {
                const origAll = osd.showAll;
                this._origAll = origAll;
                osd.showAll = function (icon, label, level, maxLevel) {
                    if (!handler(-1, icon, label, level, maxLevel))
                        origAll.call(this, icon, label, level, maxLevel);
                };
            }
        } else if (!on && this._orig) {
            osd.show = this._orig;
            this._orig = null;
            if (this._origAll) {
                osd.showAll = this._origAll;
                this._origAll = null;
            }
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

export class PanelTransparency {
    static styleClass = 'island-transparent-panel';

    constructor() {
        this._on = false;
    }

    set enabled(on) {
        const panel = Main.panel;
        if (!panel || on === this._on)
            return;
        this._on = on;
        if (on)
            panel.add_style_class_name(PanelTransparency.styleClass);
        else
            panel.remove_style_class_name(PanelTransparency.styleClass);
    }
}
