import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LOG_PREFIX} from './dbus.js';
import {stripMarkup} from './format.js';

export function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        console.error(`${LOG_PREFIX}: open ${uri}: ${e.message}`);
    }
}

export function focusPids(pids) {
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

export function lookupApp({app, desktopEntry}) {
    const apps = Shell.AppSystem.get_default();
    for (const id of [desktopEntry, app?.toLowerCase(), app].filter(Boolean)) {
        const info = apps.lookup_app(`${id}.desktop`) ?? apps.lookup_desktop_wmclass(id) ?? apps.lookup_startup_wmclass(id);
        if (info)
            return info;
    }
    return null;
}

export function lookupProcessApp(name) {
    if (!name)
        return null;
    const exact = lookupApp({app: name});
    if (exact)
        return exact;
    const apps = Shell.AppSystem.get_default();
    const low = name.toLowerCase();
    for (const group of Shell.AppSystem.search(low)) {
        for (const id of group) {
            if (id.toLowerCase().startsWith(low))
                return apps.lookup_app(id);
        }
    }
    return null;
}

export function activateNotification(view) {
    let match = null;
    for (const source of Main.messageTray.getSources()) {
        for (const n of source.notifications ?? []) {
            if (stripMarkup(n.title) === view.title && (!view.subtitle || stripMarkup(n.body) === view.subtitle))
                match = n;
        }
    }
    if (match) {
        match.activate();
        return true;
    }
    const app = lookupApp(view);
    if (app) {
        app.activate();
        Main.overview.hide();
        return true;
    }
    return false;
}

export function clock24() {
    return new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('clock-format') !== '12h';
}
