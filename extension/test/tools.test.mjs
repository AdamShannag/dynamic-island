import {test} from 'node:test';
import assert from 'node:assert/strict';

import {TOOLS, calc, formatNumber} from '../dynamic-island@adamshannag.github.io/lib/tools.js';

const run = Object.fromEntries(TOOLS.flatMap(t => t.modes.map(m => [`${t.id}.${m.id}`, m.fn])));
const evaluate = s => {
    const v = calc(s);
    return v === null ? null : formatNumber(v);
};
const b64url = o => Buffer.from(JSON.stringify(o)).toString('base64url');

test('calc evaluates arithmetic', () => {
    assert.equal(evaluate('150*1.16'), '174');
    assert.equal(evaluate('-2^2'), '-4');
    assert.equal(evaluate('(2+3)^2'), '25');
    assert.equal(evaluate('200*15%'), '30');
    assert.equal(evaluate('sqrt(16)'), '4');
    assert.equal(evaluate('1,000*2'), '2000');
});

test('calc ignores things that are not calculations', () => {
    for (const s of ['go mod tidy', '42', 'hello', '', '2 +', 'foo(2)'])
        assert.equal(evaluate(s), null, s);
});

test('json format, minify and errors', () => {
    assert.equal(run['json.format']('{"a":1}'), '{\n  "a": 1\n}');
    assert.equal(run['json.minify']('{ "a" : [1, 2] }'), '{"a":[1,2]}');
    assert.throws(() => run['json.format']('{nope'), /Invalid JSON/);
});

test('base64 round-trips UTF-8', () => {
    for (const s of ['', 'a', 'héllo 🌍'])
        assert.equal(run['base64.decode'](run['base64.encode'](s)), s);
    assert.throws(() => run['base64.decode']('not base64!!'), /Not valid Base64/);
});

test('url encoding', () => {
    assert.equal(run['url.encode']('a b&c'), 'a%20b%26c');
    assert.throws(() => run['url.decode']('%E0%A4%A'), /Not valid URL encoding/);
});

test('case tools', () => {
    assert.equal(run['snake.snake']('myVariableName'), 'my_variable_name');
    assert.equal(run['camel.camel']('Hello big-world'), 'helloBigWorld');
    assert.equal(run['title.title']('the QUICK fox'), 'The Quick Fox');
    assert.equal(run['kebab.kebab']('Hello World'), 'hello-world');
});

test('jwt decode', () => {
    const jwt = `${b64url({alg: 'HS256', typ: 'JWT'})}.${b64url({sub: '1', exp: 1700000000})}.sig`;
    const out = run['jwt.decode'](jwt);
    assert.match(out, /"alg": "HS256"/);
    assert.match(out, /Expires: 2023-11-14 22:13:20 UTC/);
    assert.match(out, /expired/);
    assert.throws(() => run['jwt.decode']('abc'), /three parts/);
});

test('timestamps', () => {
    assert.match(run['timestamp.toDate']('1700000000'), /^2023-11-14 22:13:20 UTC/);
    assert.match(run['timestamp.toDate']('1700000000000'), /^2023-11-14 22:13:20 UTC/);
    assert.match(run['timestamp.toUnix']('2023-11-14T22:13:20Z'), /^1700000000\n/);
    assert.throws(() => run['timestamp.toUnix']('not a date'), /Enter a date/);
});
