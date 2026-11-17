import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    FILTER_ROWS, GROUP_ROWS, actionItems, firstLine, flatten, itemScore, matchScore, moveSelection, searchResults,
} from '../dynamic-island@adamshannag.github.io/lib/find.js';

const items = (prefix, n) => Array.from({length: n}, (_, i) => ({title: `${prefix} ${i}`}));

test('substring beats subsequence, prefix beats a later substring', () => {
    const prefix = matchScore('doc', 'Docker');
    const word = matchScore('port', 'Kill port 3000');
    const inner = matchScore('ock', 'Docker');
    const subseq = matchScore('dkr', 'Docker');
    assert.ok(prefix > word && word > inner && inner > subseq);
    assert.equal(matchScore('xyz', 'Docker'), null);
    assert.equal(matchScore('', 'Docker'), 0);
    assert.equal(matchScore('DOCK', 'docker'), matchScore('dock', 'Docker'));
});

test('subsequence prefers tighter matches', () => {
    assert.ok(matchScore('ntf', 'Notifications') !== null);
    assert.ok(matchScore('clp', 'Clipboard') > matchScore('clp', 'Colour picker'));
});

test('keywords match but rank below the title', () => {
    const item = {title: 'Pick a colour', keywords: 'color picker'};
    assert.ok(itemScore('color', item) !== null);
    assert.ok(itemScore('pick', item) > itemScore('picker', item));
    assert.equal(itemScore('zzz', item), null);
});

test('an empty query shows at most 4 rows per group in the fixed group order', () => {
    const groups = [
        {id: 'notes', items: items('note', 2)},
        {id: 'tabs', items: items('tab', 9)},
        {id: 'actions', items: []},
        {id: 'clipboard', items: items('clip', 6)},
    ];
    const out = searchResults(groups, '  ');
    assert.deepEqual(out.map(g => g.id), ['tabs', 'clipboard', 'notes']);
    assert.deepEqual(out.map(g => g.items.length), [GROUP_ROWS, GROUP_ROWS, 2]);
    assert.equal(out[0].title, 'Tabs');
});

test('filtering keeps at most 8 rows in total, the best ones, still grouped', () => {
    const groups = [
        {id: 'tabs', items: items('alpha', 6)},
        {id: 'clipboard', items: [...items('xalpha', 6), {title: 'alpha exact'}]},
        {id: 'notes', items: [{title: 'beta'}]},
    ];
    const out = searchResults(groups, 'alpha');
    assert.equal(flatten(out).length, FILTER_ROWS);
    assert.deepEqual(out.map(g => g.id), ['tabs', 'clipboard']);
    assert.ok(flatten(out).every(i => i.title.includes('alpha')));
    assert.ok(out[1].items.some(i => i.title === 'alpha exact'));
    assert.deepEqual(searchResults(groups, 'qqq'), []);
});

test('results within a group are ranked by score', () => {
    const out = searchResults([{id: 'tabs', items: [{title: 'Import report'}, {title: 'Port scanner'}, {title: 'Ports'}]}], 'port');
    assert.deepEqual(out[0].items.map(i => i.title), ['Ports', 'Port scanner', 'Import report']);
});

test('selection moves and clamps', () => {
    assert.equal(moveSelection(0, -1, 5), 0);
    assert.equal(moveSelection(0, 1, 5), 1);
    assert.equal(moveSelection(4, 1, 5), 4);
    assert.equal(moveSelection(3, 1, 0), -1);
});

test('actions: fixed ones first, then one per port and running container', () => {
    const out = actionItems({
        ports: [{port: 3000, process: 'node'}, {port: 3000, process: 'node'}, {port: 5432, container: 'db'}],
        containers: [{id: 'a1', name: 'api', image: 'api:1', state: 'running'}, {id: 'b2', name: 'old', state: 'exited'}],
    });
    assert.deepEqual(out.map(i => i.title), [
        'Start focus', 'Pick a colour', 'Copy LAN address', 'Kill port 3000', 'Kill port 5432', 'Restart api',
    ]);
    assert.deepEqual(out[3].action, {kind: 'port', port: 3000});
    assert.equal(out[4].sub, 'db');
    assert.deepEqual(out[5].action, {kind: 'restart', id: 'a1', name: 'api'});
    assert.equal(actionItems().length, 3);
});

test('firstLine skips blank lines and truncates', () => {
    assert.equal(firstLine('\n\n  hello world \nnext'), 'hello world');
    assert.equal(firstLine('x'.repeat(100), 10), `${'x'.repeat(9)}…`);
    assert.equal(firstLine(null), '');
});
