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

// [id, label, fn]; fn throws on input it can't handle.
export const TRANSFORMS = [
    ['json', 'JSON', t => JSON.stringify(JSON.parse(t), null, 2)],
    ['b64e', 'Base64 ↑', b64encode],
    ['b64d', 'Base64 ↓', b64decode],
    ['urle', 'URL ↑', t => encodeURIComponent(t)],
    ['urld', 'URL ↓', t => decodeURIComponent(t)],
    ['upper', 'UPPER', t => t.toUpperCase()],
    ['lower', 'lower', t => t.toLowerCase()],
    ['title', 'Title', t => t.toLowerCase().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase())],
    ['snake', 'snake', t => words(t).join('_').toLowerCase()],
    ['camel', 'camel', t => words(t).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('')],
    ['kebab', 'kebab', t => words(t).join('-').toLowerCase()],
];
