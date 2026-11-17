import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    BAR_FULL, BAR_MAX, DEFAULT_BAR, HOME_LOCKED, barTabs, normalizeBar, pinHint, togglePin,
} from '../dynamic-island@adamshannag.github.io/lib/bar.js';

const VALID = ['home', 'inbox', 'activity', 'docker', 'ports', 'notes', 'play'];

test('normalizeBar puts home first, dedupes, filters and caps', () => {
    assert.deepEqual(normalizeBar(['notes', 'home', 'notes', 'bogus', 'inbox'], VALID), ['home', 'notes', 'inbox']);
    assert.deepEqual(normalizeBar(['inbox', 'docker', 'ports', 'notes', 'play'], VALID), ['home', 'inbox', 'docker', 'ports']);
    assert.deepEqual(normalizeBar(null), ['home']);
    assert.deepEqual(normalizeBar(['inbox', 7, {}]), ['home', 'inbox']);
});

test('barTabs falls back to the default bar', () => {
    assert.deepEqual(barTabs(null, VALID), DEFAULT_BAR);
    assert.deepEqual(barTabs({}, VALID), DEFAULT_BAR);
    assert.deepEqual(barTabs({bar: []}, VALID), ['home']);
    assert.deepEqual(barTabs({bar: ['docker']}, VALID), ['home', 'docker']);
    assert.ok(barTabs({bar: VALID}, VALID).length <= BAR_MAX);
});

test('togglePin pins, unpins and refuses', () => {
    assert.deepEqual(togglePin(['home', 'inbox'], 'docker'), {bar: ['home', 'inbox', 'docker'], error: null});
    assert.deepEqual(togglePin(['home', 'inbox', 'docker'], 'inbox'), {bar: ['home', 'docker'], error: null});
    assert.deepEqual(togglePin(['home', 'inbox'], 'home'), {bar: ['home', 'inbox'], error: HOME_LOCKED});
    const full = ['home', 'inbox', 'docker', 'notes'];
    assert.deepEqual(togglePin(full, 'ports'), {bar: full, error: BAR_FULL});
    assert.deepEqual(togglePin(full, 'notes'), {bar: ['home', 'inbox', 'docker'], error: null});
});

test('pinHint counts pinned tabs', () => {
    assert.equal(pinHint(['home', 'inbox', 'notes']), 'Tap ★ to pin a tab to the bar (3/4)');
    assert.equal(BAR_FULL, 'Up to 4 tabs on the bar');
});
