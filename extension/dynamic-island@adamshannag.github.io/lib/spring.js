export const SIZE_SPRING = {k: 320, c: 30};
export const OPACITY_SPRING = {k: 260, c: 30};
export const MAX_SUBSTEP = 1 / 240;
export const MAX_FRAME = 0.05;
export const REST_VELOCITY = 0.02;
export const REST_DISTANCE = 0.02;

export class Spring {
    constructor({k, c}, x = 0) {
        this.k = k;
        this.c = c;
        this.x = x;
        this.v = 0;
        this.target = x;
    }

    get settled() {
        return Math.abs(this.v) < REST_VELOCITY && Math.abs(this.x - this.target) < REST_DISTANCE;
    }

    jump(x) {
        this.x = x;
        this.target = x;
        this.v = 0;
    }

    step(dt) {
        if (this.settled) {
            this.x = this.target;
            this.v = 0;
            return false;
        }
        let left = Math.min(dt, MAX_FRAME);
        while (left > 1e-9) {
            const h = Math.min(MAX_SUBSTEP, left);
            this.v += (-this.k * (this.x - this.target) - this.c * this.v) * h;
            this.x += this.v * h;
            left -= h;
        }
        if (this.settled) {
            this.x = this.target;
            this.v = 0;
            return false;
        }
        return true;
    }
}

export class SpringSet {
    constructor(defs) {
        this.springs = {};
        for (const [name, [params, x]] of Object.entries(defs))
            this.springs[name] = new Spring(params, x);
    }

    get settled() {
        return Object.values(this.springs).every(s => s.settled);
    }

    value(name) {
        return this.springs[name].x;
    }

    retarget(targets) {
        for (const [name, t] of Object.entries(targets))
            this.springs[name].target = t;
    }

    jump(targets) {
        for (const [name, t] of Object.entries(targets))
            this.springs[name].jump(t);
    }

    step(dt) {
        let moving = false;
        for (const s of Object.values(this.springs))
            moving = s.step(dt) || moving;
        return moving;
    }
}

export const clamp01 = v => Math.min(1, Math.max(0, v));

export function dashReveal(op) {
    return clamp01((op - 0.35) / 0.65);
}

export function pillReveal(op) {
    return clamp01(1 - op / 0.35);
}
