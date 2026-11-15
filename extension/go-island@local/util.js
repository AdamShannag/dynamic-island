// Pure helpers (no GNOME imports, so they can be tested with node):
// a safe calculator and the clipboard text transforms.

const FN = {
    sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan,
    log: Math.log10, ln: Math.log, round: Math.round, floor: Math.floor, ceil: Math.ceil,
};
const CONST = {pi: Math.PI, e: Math.E};

// calc evaluates arithmetic like "150*1.16", "(2+3)^2", "200*15%",
// "sqrt(2)". Returns a number, or null if the input isn't a calculation
// (plain numbers and words return null so searches aren't hijacked).
export function calc(input) {
    const s = input.replace(/×/g, '*').replace(/÷/g, '/').replace(/(\d),(\d{3})/g, '$1$2').trim();
    if (!s || !/^[\d\s.+\-*/%^()a-z]+$/i.test(s) || !/\d/.test(s))
        return null;
    if (!/[+\-*/%^(]/.test(s.replace(/^[-+]/, '')))
        return null; // needs an operator or a function call
    const toks = s.match(/\d*\.?\d+(?:e[+-]?\d+)?|[a-z]+|[+\-*/%^()]/gi);
    if (!toks || toks.join('') !== s.replace(/\s+/g, ''))
        return null;

    let i = 0;
    const peek = () => toks[i];
    const next = () => toks[i++];
    const fail = () => {
        throw new Error('syntax');
    };
    const expr = () => {
        let v = term();
        while (peek() === '+' || peek() === '-')
            v = next() === '+' ? v + term() : v - term();
        return v;
    };
    const term = () => {
        let v = unary();
        while (peek() === '*' || peek() === '/')
            v = next() === '*' ? v * unary() : v / unary();
        return v;
    };
    const unary = () => {
        if (peek() === '-') {
            next();
            return -unary();
        }
        if (peek() === '+') {
            next();
            return unary();
        }
        return power();
    };
    const power = () => {
        const base = postfix();
        if (peek() === '^') {
            next();
            return Math.pow(base, unary());
        }
        return base;
    };
    const postfix = () => {
        let v = primary();
        while (peek() === '%') {
            next();
            v /= 100;
        }
        return v;
    };
    const primary = () => {
        const t = next();
        if (t === undefined)
            fail();
        if (t === '(') {
            const v = expr();
            if (next() !== ')')
                fail();
            return v;
        }
        if (/^[a-z]+$/i.test(t)) {
            const k = t.toLowerCase();
            if (k in CONST)
                return CONST[k];
            if (!(k in FN) || next() !== '(')
                fail();
            const v = expr();
            if (next() !== ')')
                fail();
            return FN[k](v);
        }
        const n = Number(t);
        if (Number.isNaN(n))
            fail();
        return n;
    };
    try {
        const v = expr();
        return i === toks.length && Number.isFinite(v) ? v : null;
    } catch {
        return null;
    }
}

export function formatNumber(v) {
    if (Number.isInteger(v) && Math.abs(v) < 1e15)
        return String(v);
    return String(parseFloat(v.toPrecision(12)));
}

// ---------- text transforms ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64encode(text) {
    const bytes = new TextEncoder().encode(text);
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
        out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] +
            (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') +
            (i + 2 < bytes.length ? B64[n & 63] : '=');
    }
    return out;
}

function b64decode(text) {
    const s = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1)
        throw new Error('not base64');
    const bytes = [];
    for (let i = 0; i < s.length; i += 4) {
        const n = [0, 1, 2, 3].reduce((acc, k) => (acc << 6) | (i + k < s.length ? B64.indexOf(s[i + k]) : 0), 0);
        bytes.push((n >> 16) & 255);
        if (i + 2 < s.length)
            bytes.push((n >> 8) & 255);
        if (i + 3 < s.length)
            bytes.push(n & 255);
    }
    return new TextDecoder('utf-8', {fatal: true}).decode(new Uint8Array(bytes));
}

function words(text) {
    return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function caseTool(id, name, glyph, fn) {
    return {id, name, group: 'Case', glyph, desc: `Convert text to ${name}`, modes: [{id, name, fn}]};
}

function base64urlJson(part) {
    return JSON.parse(b64decode(part));
}

function fmtDate(ms) {
    const d = new Date(ms);
    return `${d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}`;
}

function relative(ms, now = Date.now()) {
    const s = Math.round((ms - now) / 1000), a = Math.abs(s);
    const v = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
    return s >= 0 ? `in ${v}` : `${v} ago`;
}

// Each tool: id, name, group, glyph (sidebar badge), desc, and one or more
// modes; a mode's fn throws an Error with a friendly message on bad input.
export const TOOLS = [
    {
        id: 'json', name: 'JSON', group: 'Format', glyph: '{ }', desc: 'Validate, pretty-print or minify JSON',
        modes: [
            {id: 'format', name: 'Format', fn: t => fmtJson(t, 2)},
            {id: 'minify', name: 'Minify', fn: t => fmtJson(t, 0)},
        ],
    },
    {
        id: 'jwt', name: 'JWT', group: 'Format', glyph: 'JWT', desc: 'Decode a JSON Web Token (the signature is not verified)',
        modes: [{id: 'decode', name: 'Decode', fn: decodeJwt}],
    },
    {
        id: 'timestamp', name: 'Timestamp', group: 'Format', glyph: '⏱', desc: 'Convert between Unix time and dates',
        modes: [
            {id: 'toDate', name: 'Unix → Date', fn: unixToDate},
            {id: 'toUnix', name: 'Date → Unix', fn: dateToUnix},
        ],
    },
    {
        id: 'base64', name: 'Base64', group: 'Encode', glyph: '64', desc: 'Encode or decode Base64 (UTF-8, URL-safe input accepted)',
        modes: [
            {id: 'encode', name: 'Encode', fn: b64encode},
            {id: 'decode', name: 'Decode', fn: t => wrapErr(() => b64decode(t), 'Not valid Base64')},
        ],
    },
    {
        id: 'url', name: 'URL', group: 'Encode', glyph: '%', desc: 'Percent-encode or decode text for URLs',
        modes: [
            {id: 'encode', name: 'Encode', fn: t => encodeURIComponent(t)},
            {id: 'decode', name: 'Decode', fn: t => wrapErr(() => decodeURIComponent(t), 'Not valid URL encoding')},
        ],
    },
    caseTool('upper', 'UPPERCASE', 'AA', t => t.toUpperCase()),
    caseTool('lower', 'lowercase', 'aa', t => t.toLowerCase()),
    caseTool('title', 'Title Case', 'Aa', t => t.toLowerCase().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase())),
    caseTool('snake', 'snake_case', 'a_b', t => words(t).join('_').toLowerCase()),
    caseTool('camel', 'camelCase', 'aB', t => words(t).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('')),
    caseTool('kebab', 'kebab-case', 'a-b', t => words(t).join('-').toLowerCase()),
];

function wrapErr(fn, message) {
    try {
        return fn();
    } catch {
        throw new Error(message);
    }
}

function fmtJson(t, indent) {
    try {
        return JSON.stringify(JSON.parse(t), null, indent);
    } catch (e) {
        throw new Error(`Invalid JSON: ${e.message.replace(/^JSON\.parse: /, '')}`);
    }
}

function decodeJwt(t) {
    const parts = t.trim().replace(/^Bearer\s+/i, '').split('.');
    if (parts.length !== 3)
        throw new Error('Not a JWT: expected three parts separated by dots');
    let header, payload;
    try {
        header = base64urlJson(parts[0]);
        payload = base64urlJson(parts[1]);
    } catch {
        throw new Error('Not a JWT: the header or payload is not Base64-encoded JSON');
    }
    const lines = ['// Header', JSON.stringify(header, null, 2), '', '// Payload', JSON.stringify(payload, null, 2)];
    const notes = [];
    for (const [k, label] of [['iat', 'Issued'], ['nbf', 'Not before'], ['exp', 'Expires']]) {
        if (typeof payload[k] === 'number')
            notes.push(`${label}: ${fmtDate(payload[k] * 1000)} (${relative(payload[k] * 1000)})`);
    }
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now())
        notes.push('⚠ This token has expired');
    return notes.length ? `${lines.join('\n')}\n\n${notes.join('\n')}` : lines.join('\n');
}

function unixToDate(t) {
    const s = t.trim();
    const n = s === '' ? Date.now() : Number(s);
    if (!Number.isFinite(n))
        throw new Error('Enter a Unix time, e.g. 1731700000 (seconds) or 1731700000000 (ms)');
    const ms = Math.abs(n) >= 1e12 ? n : n * 1000;
    const d = new Date(ms);
    return `${fmtDate(ms)}\nLocal: ${d.toString()}\nISO 8601: ${d.toISOString()}\n${relative(ms)}`;
}

function dateToUnix(t) {
    const ms = t.trim() === '' ? Date.now() : Date.parse(t.trim());
    if (!Number.isFinite(ms))
        throw new Error('Enter a date, e.g. 2026-11-15 21:40 or 2026-11-15T18:40:00Z');
    return `${Math.floor(ms / 1000)}\nMilliseconds: ${ms}`;
}
