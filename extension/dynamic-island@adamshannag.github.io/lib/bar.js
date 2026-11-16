export const BAR_MAX = 4;
export const HOME_TAB = 'home';
export const DEFAULT_BAR = [HOME_TAB, 'inbox', 'notes'];
export const BAR_FULL = `Up to ${BAR_MAX} tabs on the bar`;
export const HOME_LOCKED = 'Home always stays on the bar';

export function normalizeBar(ids, valid = null) {
    const out = [HOME_TAB];
    for (const id of Array.isArray(ids) ? ids : []) {
        if (out.length === BAR_MAX)
            break;
        if (typeof id === 'string' && !out.includes(id) && (!valid || valid.includes(id)))
            out.push(id);
    }
    return out;
}

export function barTabs(settings, valid = null) {
    const bar = settings?.bar;
    return normalizeBar(Array.isArray(bar) ? bar : DEFAULT_BAR, valid);
}

export function togglePin(bar, id) {
    const current = normalizeBar(bar);
    if (id === HOME_TAB)
        return {bar: current, error: HOME_LOCKED};
    if (current.includes(id))
        return {bar: current.filter(t => t !== id), error: null};
    if (current.length >= BAR_MAX)
        return {bar: current, error: BAR_FULL};
    return {bar: [...current, id], error: null};
}

export function pinHint(bar) {
    return `Tap ★ to pin a tab to the bar (${normalizeBar(bar).length}/${BAR_MAX})`;
}
