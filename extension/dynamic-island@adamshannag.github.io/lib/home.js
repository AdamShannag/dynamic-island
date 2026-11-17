import {fmtClock} from './format.js';

export const FAVORITES_MAX = 5;
export const DEFAULT_FAVORITES = ['docker', 'ports', 'clipboard', 'notes', 'agents'];
export const CONTINUE_MAX = 3;
export const FOCUS_IDLE = '25 min';
export const FAVORITES_FULL = `Up to ${FAVORITES_MAX} favourites`;
export const NOTHING_RUNNING = 'Builds, timers and servers show up here.';

export function homeFavorites(settings, valid = null) {
    const raw = settings?.home?.favorites;
    const out = [];
    for (const id of Array.isArray(raw) ? raw : DEFAULT_FAVORITES) {
        if (out.length === FAVORITES_MAX)
            break;
        if (typeof id === 'string' && id !== 'home' && !out.includes(id) && (!valid || valid.includes(id)))
            out.push(id);
    }
    return out;
}

export function toggleFavorite(favorites, id) {
    const current = homeFavorites({home: {favorites: Array.isArray(favorites) ? favorites : []}});
    if (current.includes(id))
        return {favorites: current.filter(f => f !== id), refused: false};
    if (current.length >= FAVORITES_MAX || id === 'home')
        return {favorites: current, refused: true};
    return {favorites: [...current, id], refused: false};
}

export function taskProgress(task, now) {
    const elapsed = Math.max(0, (now - (task.startedAt ?? now)) / 1000);
    const expected = (task.expectedMs ?? 0) / 1000;
    if (task.kind === 'service') {
        const port = task.ports?.length ? `:${task.ports[0]} · ` : '';
        return {sub: `${port}up ${fmtClock(elapsed)}`, pct: null};
    }
    if (!expected || elapsed >= expected)
        return {sub: `Running ${fmtClock(elapsed)}`, pct: null};
    const pct = elapsed / expected;
    return {sub: `${Math.floor(pct * 100)}%, ${fmtClock(expected - elapsed)} left`, pct};
}

export function focusSubtitle(timer, now) {
    return timer ? `${fmtClock((timer.endsAt - now) / 1000)} left` : FOCUS_IDLE;
}

export function continueItems({tasks = [], docker = 0, focus = true} = {}) {
    const items = [];
    const run = tasks.find(t => t.kind === 'task') ?? tasks.find(t => t.kind === 'service');
    if (run)
        items.push({id: `run:${run.pid}`, kind: 'run', task: run});
    if (docker > 0)
        items.push({id: 'docker', kind: 'docker', count: docker});
    if (focus)
        items.push({id: 'focus', kind: 'focus'});
    return items.slice(0, CONTINUE_MAX);
}

export function signature(items) {
    return items.map(i => i.id).join('|');
}
