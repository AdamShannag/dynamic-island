import {test} from 'node:test';
import assert from 'node:assert/strict';

import {glanceChips} from '../dynamic-island@adamshannag.github.io/lib/glance.js';

const now = 1_000_000;

test('no activity, no chips', () => {
    assert.deepEqual(glanceChips({now}), []);
    assert.deepEqual(glanceChips({agents: [{state: 'working'}], now}), []);
});

test('chips come in a fixed order with their labels', () => {
    const chips = glanceChips({
        agents: [{state: 'ready'}, {state: 'approval'}],
        tasks: [{kind: 'service', startedAt: now - 5000}, {kind: 'task', startedAt: now - 64_000, expectedMs: 100_000}],
        timer: {title: 'Focus', endsAt: now + (18 * 60 + 42) * 1000},
        containers: 3,
        now,
    });
    assert.deepEqual(chips.map(c => c.label), ['Claude is waiting', 'Build 64%', 'Focus 18:42', '3 containers']);
});

test('a build without an estimate shows elapsed time; one container is singular; breaks are named', () => {
    const chips = glanceChips({
        tasks: [{kind: 'task', startedAt: now - 72_000}], timer: {title: 'Break', endsAt: now + 61_000}, containers: 1, now,
    });
    assert.deepEqual(chips.map(c => c.label), ['Build 1:12', 'Break 1:01', '1 container']);
});
