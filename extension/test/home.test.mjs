import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_FAVORITES, FOCUS_IDLE, continueItems, focusSubtitle, homeFavorites, signature, taskProgress,
} from '../dynamic-island@adamshannag.github.io/lib/home.js';

const VALID = ['home', 'inbox', 'docker', 'ports', 'clipboard', 'notes', 'agents', 'play'];

test('homeFavorites defaults, filters, dedupes and caps at 5', () => {
    assert.deepEqual(homeFavorites({}, VALID), DEFAULT_FAVORITES);
    assert.deepEqual(homeFavorites({home: {favorites: []}}, VALID), []);
    assert.deepEqual(
        homeFavorites({home: {favorites: ['home', 'notes', 'notes', 'nope', 'inbox', 'play', 'docker', 'ports', 'agents']}}, VALID),
        ['notes', 'inbox', 'play', 'docker', 'ports']);
    assert.deepEqual(homeFavorites({home: {favorites: ['docker', 'agents']}}, ['docker']), ['docker']);
});

test('taskProgress estimates from the last run, else shows elapsed', () => {
    const now = 100_000;
    assert.deepEqual(taskProgress({kind: 'task', startedAt: now - 47_000, expectedMs: 100_000}, now),
        {sub: '47%, 0:53 left', pct: 0.47});
    assert.deepEqual(taskProgress({kind: 'task', startedAt: now - 72_000}, now), {sub: 'Running 1:12', pct: null});
    assert.deepEqual(taskProgress({kind: 'task', startedAt: now - 90_000, expectedMs: 60_000}, now),
        {sub: 'Running 1:30', pct: null});
    assert.deepEqual(taskProgress({kind: 'service', startedAt: now - 5_000, ports: [5173]}, now),
        {sub: ':5173 · up 0:05', pct: null});
});

test('focusSubtitle shows the idle length or time left', () => {
    assert.equal(focusSubtitle(null, 0), FOCUS_IDLE);
    assert.equal(focusSubtitle({endsAt: 1_122_000}, 0), '18:42 left');
});

test('continueItems orders run, docker, focus and handles 0 to 3 items', () => {
    const build = {pid: 7, kind: 'task'};
    const server = {pid: 8, kind: 'service'};
    assert.deepEqual(continueItems({focus: false}), []);
    assert.equal(signature(continueItems()), 'focus');
    assert.equal(signature(continueItems({docker: 2})), 'docker|focus');
    assert.equal(signature(continueItems({tasks: [server, build], docker: 4})), 'run:7|docker|focus');
    assert.equal(signature(continueItems({tasks: [server], docker: 0, focus: false})), 'run:8');
    assert.equal(continueItems({docker: 3})[0].count, 3);
});
