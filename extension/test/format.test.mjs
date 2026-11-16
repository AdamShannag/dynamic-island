import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    ago, clipKind, correctPrefix, dockerProblem, fmtBytes, fmtClock, hashColor, hexToRgb, searchUri, stripMarkup,
} from '../dynamic-island@adamshannag.github.io/lib/format.js';

test('fmtClock', () => {
    assert.equal(fmtClock(5), '0:05');
    assert.equal(fmtClock(65), '1:05');
    assert.equal(fmtClock(3725), '1:02:05');
    assert.equal(fmtClock(-3), '0:00');
});

test('fmtBytes', () => {
    assert.equal(fmtBytes(512), '512 B');
    assert.equal(fmtBytes(2048), '2 KB');
    assert.equal(fmtBytes(5 * 1024 * 1024), '5.0 MB');
});

test('ago', () => {
    const now = 1_000_000_000;
    assert.equal(ago(now - 10_000, now), 'now');
    assert.equal(ago(now - 5 * 60_000, now), '5m ago');
    assert.equal(ago(now - 3 * 3_600_000, now), '3h ago');
});

test('hexToRgb and hashColor', () => {
    assert.deepEqual(hexToRgb('#ff0000'), [1, 0, 0]);
    const colors = ['a', 'b', 'c'];
    assert.equal(hashColor('Slack', colors), hashColor('Slack', colors));
    assert.ok(colors.includes(hashColor('Discord', colors)));
});

test('stripMarkup', () => {
    assert.equal(stripMarkup('<b>Hi</b> &amp;  there'), 'Hi & there');
    assert.equal(stripMarkup(null), '');
});

test('clipKind', () => {
    assert.match(clipKind('https://example.com/x').label, /^Link {2}· {2}example\.com/);
    assert.match(clipKind('{"a":1,"b":2}').label, /2 keys/);
    assert.equal(clipKind('SELECT * FROM t').label, 'SQL');
    assert.equal(clipKind('git status').label, 'Command');
    assert.match(clipKind('hello\nworld').label, /2 lines/);
});

test('dockerProblem', () => {
    assert.match(dockerProblem('x docker-not-running').title, /isn't running/);
    assert.match(dockerProblem('GDBus.Error:org.freedesktop.DBus.Error.Failed: boom').hint, /^boom/);
});

test('searchUri', () => {
    assert.equal(searchUri('example.com'), 'https://example.com');
    assert.equal(searchUri('localhost:3000/x'), 'http://localhost:3000/x');
    assert.equal(searchUri('ftp://a.b'), 'ftp://a.b');
    assert.equal(searchUri('go generics'), 'https://www.google.com/search?q=go%20generics');
});

test('correctPrefix', () => {
    assert.equal(correctPrefix('', 'hello'), 0);
    assert.equal(correctPrefix('hel', 'hello'), 3);
    assert.equal(correctPrefix('hex', 'hello'), 2);
    assert.equal(correctPrefix('hello world', 'hello'), 5);
    assert.equal(correctPrefix('xxxxxxxxxx', 'hello'), 0);
    assert.equal(correctPrefix('café', 'café au lait'), 4);
    assert.equal(correctPrefix(null, 'a'), 0);
});
