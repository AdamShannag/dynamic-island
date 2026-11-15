export function fmtClock(secs) {
    secs = Math.max(0, Math.floor(secs));
    const h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, s = secs % 60;
    const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtBytes(n, digits = 1) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i < 2 ? 0 : digits)} ${u[i]}`;
}

export function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

export function ago(ms, now = Date.now()) {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60)
        return 'now';
    if (s < 3600)
        return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
}

export function hashColor(name, colors) {
    const hash = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    return colors[hash % colors.length];
}

export function stripMarkup(text) {
    return (text ?? '').replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

export function dockerProblem(message) {
    if (message.includes('docker-not-installed'))
        return {icon: 'dialog-information-symbolic', title: "Docker isn't installed", hint: 'Install it with: sudo apt install docker.io'};
    if (message.includes('docker-not-running'))
        return {icon: 'media-playback-stop-symbolic', title: "Docker isn't running", hint: 'Start it with: sudo systemctl start docker'};
    if (message.includes('docker-permission'))
        return {icon: 'dialog-password-symbolic', title: 'No permission to use Docker',
            hint: 'Run: sudo usermod -aG docker $USER, then log out and back in'};
    return {icon: 'dialog-warning-symbolic', title: "Couldn't reach Docker",
        hint: message.replace(/^.*?Error\.Failed: /, '').slice(0, 160)};
}

export function clipKind(text) {
    const t = text.trim();
    if (/^https?:\/\/\S+$/i.test(t))
        return {label: `Link  ·  ${t.split('/')[2] ?? ''}`, badge: {icon: 'web-browser-symbolic', color: '#0a84ff'}};
    if (/^[[{]/.test(t)) {
        try {
            const v = JSON.parse(t);
            const n = Array.isArray(v) ? `${v.length} items` : `${Object.keys(v).length} keys`;
            return {label: `JSON  ·  ${n}`, badge: {glyph: '{ }', color: '#ff9f0a'}, mono: true};
        } catch {}
    }
    if (/^(select|insert|update|delete|with|create|alter)\s/i.test(t))
        return {label: 'SQL', badge: {glyph: 'SQL', color: '#5e5ce6'}, mono: true};
    if (/^(\$ )?(sudo|kubectl|docker|git|go|npm|pnpm|yarn|curl|ssh|make|cd|ls|cat|grep|helm|terraform|psql|python3?|cargo)\b/.test(t))
        return {label: 'Command', badge: {icon: 'utilities-terminal-symbolic', color: '#636366'}, mono: true};
    const lines = t.split('\n').length;
    return {label: lines > 1 ? `Text  ·  ${lines} lines` : `Text  ·  ${t.length} characters`,
        badge: {glyph: 'Aa', color: '#8e8e93'}};
}

export function searchUri(q) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q))
        return q;
    if (/^localhost(:\d+)?(\/\S*)?$/.test(q))
        return `http://${q}`;
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(q))
        return `https://${q}`;
    return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}
