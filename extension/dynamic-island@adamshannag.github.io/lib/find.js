export const GROUP_ROWS = 4;
export const FILTER_ROWS = 8;
export const GROUPS = [['tabs', 'Tabs'], ['actions', 'Actions'], ['clipboard', 'Clipboard'], ['notes', 'Notes']];

const fold = s => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

function subsequenceSpread(q, t) {
    let first = -1, at = -1;
    for (const ch of q) {
        at = t.indexOf(ch, at + 1);
        if (at < 0)
            return null;
        if (first < 0)
            first = at;
    }
    return at - first;
}

export function matchScore(query, text) {
    const q = fold(query), t = fold(text);
    if (!q)
        return 0;
    if (!t)
        return null;
    const i = t.indexOf(q);
    if (i === 0)
        return 3000 - t.length;
    if (i > 0)
        return (/[\s\-_.:/·]/.test(t[i - 1]) ? 2500 : 2000) - i;
    const spread = subsequenceSpread(q.replace(/ /g, ''), t);
    return spread === null ? null : 1000 - spread;
}

export function itemScore(query, item) {
    const title = matchScore(query, item.title);
    const extra = item.keywords ? matchScore(query, item.keywords) : null;
    if (extra === null)
        return title;
    return title === null ? extra - 100 : Math.max(title, extra - 100);
}

export function searchResults(groups, query) {
    const known = new Map(groups.map(g => [g.id, g]));
    const ordered = GROUPS.filter(([id]) => known.has(id)).map(([id, title]) => ({id, title, items: known.get(id).items ?? []}));
    if (!fold(query)) {
        return ordered.map(g => ({...g, items: g.items.slice(0, GROUP_ROWS)})).filter(g => g.items.length);
    }
    const hits = [];
    ordered.forEach((g, gi) => g.items.forEach((item, ii) => {
        const score = itemScore(query, item);
        if (score !== null)
            hits.push({g: gi, i: ii, score, item});
    }));
    hits.sort((a, b) => b.score - a.score || a.g - b.g || a.i - b.i);
    const kept = hits.slice(0, FILTER_ROWS);
    return ordered.map((g, gi) => ({
        ...g, items: kept.filter(h => h.g === gi).map(h => h.item),
    })).filter(g => g.items.length);
}

export function flatten(groups) {
    return groups.flatMap(g => g.items);
}

export function moveSelection(index, delta, count) {
    if (count <= 0)
        return -1;
    return Math.min(count - 1, Math.max(0, index + delta));
}

export function actionItems({ports = [], containers = []} = {}) {
    const items = [
        {id: 'focus', title: 'Start focus', sub: 'A 25 minute session', icon: 'alarm-symbolic', keywords: 'pomodoro timer', action: {kind: 'focus'}},
        {id: 'color', title: 'Pick a colour', sub: 'Copy any pixel as hex', icon: 'color-select-symbolic', keywords: 'color picker eyedropper', action: {kind: 'color'}},
        {id: 'lan', title: 'Copy LAN address', sub: 'Your IP on this network', icon: 'network-wired-symbolic', keywords: 'ip address network', action: {kind: 'lan'}},
    ];
    const seen = new Set();
    for (const p of ports) {
        if (!p?.port || !p.mine || seen.has(p.port))
            continue;
        seen.add(p.port);
        const owner = p.container || p.process || '';
        items.push({
            id: `port:${p.port}`, title: `Kill port ${p.port}`, sub: owner, icon: 'network-wired-symbolic',
            keywords: `free port ${owner}`, action: {kind: 'port', port: p.port},
        });
    }
    for (const c of containers) {
        if (!c?.id || c.state !== 'running')
            continue;
        items.push({
            id: `restart:${c.id}`, title: `Restart ${c.name}`, sub: c.image ?? '', icon: 'view-refresh-symbolic',
            keywords: `docker container ${c.image ?? ''}`, action: {kind: 'restart', id: c.id, name: c.name},
        });
    }
    return items;
}

export function firstLine(text, max = 80) {
    const line = (text ?? '').split('\n').find(l => l.trim()) ?? '';
    const t = line.trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
