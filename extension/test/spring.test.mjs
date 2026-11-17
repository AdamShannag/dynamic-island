import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    MAX_FRAME, MAX_SUBSTEP, OPACITY_SPRING, SIZE_SPRING, Spring, SpringSet, dashReveal, pillReveal,
} from '../dynamic-island@adamshannag.github.io/lib/spring.js';

const FRAME = 1 / 60;

function run(spring, frames, dt = FRAME) {
    const xs = [];
    for (let i = 0; i < frames; i++) {
        spring.step(dt);
        xs.push(spring.x);
    }
    return xs;
}

test('one semi-implicit Euler substep updates velocity before position', () => {
    const s = new Spring({k: 100, c: 10}, 0);
    s.target = 1;
    s.step(MAX_SUBSTEP);
    const v = 100 * MAX_SUBSTEP;
    assert.ok(Math.abs(s.v - v) < 1e-12);
    assert.ok(Math.abs(s.x - v * MAX_SUBSTEP) < 1e-12);
});

test('a frame is split into substeps of at most 1/240 s', () => {
    const a = new Spring(SIZE_SPRING, 0);
    a.target = 100;
    a.step(FRAME);
    const b = new Spring(SIZE_SPRING, 0);
    b.target = 100;
    for (let i = 0; i < 4; i++)
        b.step(FRAME / 4);
    assert.ok(Math.abs(a.x - b.x) < 1e-9);
    assert.ok(Math.abs(a.v - b.v) < 1e-9);
});

test('the size spring reaches its target, overshoots little and settles exactly', () => {
    const s = new Spring(SIZE_SPRING, 184);
    s.target = 640;
    const xs = run(s, 120);
    assert.equal(s.x, 640);
    assert.equal(s.v, 0);
    assert.ok(s.settled);
    assert.ok(Math.max(...xs) < 640 + 0.05 * 456);
    assert.equal(s.step(FRAME), false);
});

test('motion is continuous: no frame moves further than the velocity allows', () => {
    const s = new Spring(SIZE_SPRING, 32);
    s.target = 500;
    let prev = s.x;
    for (let i = 0; i < 90; i++) {
        s.step(FRAME);
        assert.ok(Math.abs(s.x - prev) < 60, `frame ${i} jumped ${s.x - prev}px`);
        prev = s.x;
    }
});

test('retargeting mid-flight keeps the velocity, so there is no jump', () => {
    const s = new Spring(SIZE_SPRING, 184);
    s.target = 640;
    run(s, 6);
    const {x, v} = s;
    assert.ok(v > 0);
    s.target = 184;
    assert.equal(s.x, x);
    assert.equal(s.v, v);
    s.step(FRAME);
    assert.ok(s.x > x, 'it keeps moving the old way for a moment');
    run(s, 200);
    assert.equal(s.x, 184);
});

test('settles only when both speed and distance are under 0.02', () => {
    const s = new Spring(OPACITY_SPRING, 0.99);
    s.target = 1;
    s.v = 0.5;
    assert.equal(s.settled, false);
    s.v = 0.01;
    assert.equal(s.settled, true);
    s.x = 0.9;
    assert.equal(s.settled, false);
});

test('a frame is capped at 50 ms', () => {
    assert.equal(MAX_FRAME, 0.05);
    const a = new Spring(SIZE_SPRING, 0), b = new Spring(SIZE_SPRING, 0);
    a.target = b.target = 100;
    a.step(0.4);
    b.step(0.05);
    assert.equal(a.x, b.x);
});

test('a huge frame after a stall is clamped instead of exploding', () => {
    const s = new Spring(SIZE_SPRING, 0);
    s.target = 100;
    s.step(5);
    assert.ok(Number.isFinite(s.x) && s.x > 0 && s.x < 140);
});

test('SpringSet steps every spring and reports when all are settled', () => {
    const set = new SpringSet({w: [SIZE_SPRING, 10], op: [OPACITY_SPRING, 0]});
    set.retarget({w: 20, op: 1});
    assert.equal(set.settled, false);
    for (let i = 0; i < 200 && set.step(FRAME); i++);
    assert.ok(set.settled);
    assert.equal(set.value('w'), 20);
    assert.equal(set.value('op'), 1);
    set.jump({w: 5});
    assert.equal(set.value('w'), 5);
    assert.equal(set.springs.w.v, 0);
});

test('dash content shows only above 0.35 and the pill only below it', () => {
    assert.equal(dashReveal(0), 0);
    assert.equal(dashReveal(0.35), 0);
    assert.equal(dashReveal(1), 1);
    assert.ok(Math.abs(dashReveal(0.675) - 0.5) < 1e-9);
    assert.equal(dashReveal(1.2), 1);
    assert.equal(pillReveal(0), 1);
    assert.equal(pillReveal(0.35), 0);
    assert.equal(pillReveal(-0.1), 1);
});
