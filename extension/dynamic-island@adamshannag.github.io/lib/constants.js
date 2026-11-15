import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION, 10);
export const VERTICAL = SHELL_MAJOR >= 48 ? {orientation: Clutter.Orientation.VERTICAL} : {vertical: true};

export const scale = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

export const MORPH_MS = 480;
export const FADE_OUT_MS = 70;
export const REVEAL_DELAY_MS = 40;
export const FADE_IN_MS = 200;
export const OSD_MS = 1600;

export const IDLE = {kind: 'idle'};
export const MODES = ['idle', 'compact', 'notify', 'dashboard', 'osd'];
export const ACCENTS = ['ok', 'warn', 'error'];
export const LIVE_KINDS = new Set(['agent', 'task', 'service']);

export const TABS = [
    ['home', 'Home', 'user-home-symbolic'],
    ['inbox', 'Notifications', 'preferences-system-notifications-symbolic'],
    ['activity', 'Activity', 'utilities-system-monitor-symbolic'],
    ['agents', 'Agents', 'utilities-terminal-symbolic'],
    ['docker', 'Docker', 'network-server-symbolic'],
    ['ports', 'Ports', 'network-wired-symbolic'],
    ['clipboard', 'Clipboard', 'edit-paste-symbolic'],
    ['transform', 'Transform', 'edit-find-replace-symbolic'],
    ['notes', 'Notes', 'document-edit-symbolic'],
    ['search', 'Web', 'web-browser-symbolic'],
];
export const TAB_ALIASES = {media: 'home', web: 'search', claude: 'agents'};

export const DASH_WIDTH = 760;
export const DASH_DEFAULT_HEIGHT = 500;
export const AUTO_MIN_HEIGHT = 200;
export const ROWS_PER_FRAME = 4;

export const POINTER_MS = 33;
export const WATCH_ACTIVE_MS = 60;
export const WATCH_IDLE_MS = 150;
export const SLEEP_AFTER_MS = 3 * 60 * 1000;
export const CPU_DIZZY = 0.85;
export const HOVER_IN_MS = 450;
export const HOVER_OUT_MS = 350;
export const SHAKE_WINDOW_MS = 600;
export const SHAKE_REVERSALS = 5;
export const SHAKE_MIN_PX = 10;

export const CLIP_DEBOUNCE_MS = 400;
export const SECRET_MIME = 'x-kde-passwordManagerHint';

export const TILE_COLORS = ['#0a84ff', '#30d158', '#ff9f0a', '#ff375f', '#bf5af2', '#64d2ff', '#ff453a', '#5e5ce6'];

export const ACCENT_COLORS = {
    blue: '#0a84ff', purple: '#bf5af2', pink: '#ff375f', orange: '#ff9f0a',
    green: '#30d158', teal: '#40c8e0', graphite: '#8e8e93',
};
export const SURFACES = [['black', 'Black'], ['graphite', 'Graphite']];
export const FEATURES = [
    ['face', 'Face', 'Eyes next to the clock that follow your cursor', 'face-smile-symbolic'],
    ['mediaPill', 'Music in the pill', 'Show the playing track in the pill (Home always shows it)', 'audio-x-generic-symbolic'],
    ['osd', 'Volume & brightness', 'Show volume and brightness changes in the island', 'audio-volume-high-symbolic'],
    ['hideBanners', "Hide GNOME's banners", 'Only the island shows notifications', 'notification-disabled-symbolic'],
    ['mirrorNotifications', 'Notifications', 'Show app notifications in the island', 'preferences-system-notifications-symbolic'],
    ['clipboardHistory', 'Clipboard history', 'Remember what you copy', 'edit-paste-symbolic'],
    ['usb', 'USB devices', 'Pop up when a device is plugged in', 'media-removable-symbolic'],
    ['battery', 'Battery', 'Charging and low-battery popups', 'battery-good-symbolic'],
];
export const SETTING_COLORS = {
    'user-home-symbolic': '#0a84ff', 'preferences-system-notifications-symbolic': '#ff453a',
    'utilities-system-monitor-symbolic': '#30d158', 'utilities-terminal-symbolic': '#ff9f0a',
    'network-server-symbolic': '#0a84ff', 'network-wired-symbolic': '#40c8e0', 'edit-paste-symbolic': '#8e8e93',
    'edit-find-replace-symbolic': '#bf5af2', 'document-edit-symbolic': '#ffcc00', 'web-browser-symbolic': '#0a84ff',
    'face-smile-symbolic': '#ff9f0a', 'audio-x-generic-symbolic': '#ff375f', 'audio-volume-high-symbolic': '#0a84ff',
    'notification-disabled-symbolic': '#ff453a', 'media-removable-symbolic': '#40c8e0', 'battery-good-symbolic': '#30d158',
    'applications-graphics-symbolic': '#bf5af2', 'weather-clear-night-symbolic': '#5e5ce6',
};
export const DEFAULT_SETTINGS = {accent: 'blue', surface: 'black', tabs: {}, features: {}};
export const featureOn = (st, key) => st?.features?.[key] !== false;
export const tabOn = (st, id) => id === 'home' || st?.tabs?.[id] !== false;
