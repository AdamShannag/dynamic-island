import {ActivityPage} from './activity.js';
import {AgentsPage} from './agents.js';
import {ClipboardPage} from './clipboard.js';
import {DockerPage, LogsPage} from './docker.js';
import {DrawPage} from './draw.js';
import {HomePage} from './home.js';
import {InboxPage} from './inbox.js';
import {NotesPage} from './notes.js';
import {PortsPage} from './ports.js';
import {QRPage} from './qr.js';
import {RacePage} from './race.js';
import {SearchPage} from './search.js';
import {SettingsPage} from './settings.js';
import {TransformPage} from './transform.js';

export const PAGES = [
    HomePage, ActivityPage, AgentsPage, DockerPage, LogsPage, PortsPage, ClipboardPage,
    TransformPage, NotesPage, InboxPage, QRPage, SearchPage, RacePage, DrawPage, SettingsPage,
];
