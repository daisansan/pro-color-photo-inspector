'use strict';
const assert = require('assert');
const { sharpen } = require('../src/sharpen');
const mk = (w, h, f) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = f(x, y); const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; } return d; };
// 平らな絵は変わらない
let d = mk(8, 8, () => 100); sharpen(d, 8, 8, 0.7); assert.ok(d.every((v, i) => (i % 4 === 3 ? v === 255 : v === 100)));
// amount 0 は何もしない
d = mk(8, 8, (x) => (x < 4 ? 50 : 200)); const c = d.slice(); sharpen(d, 8, 8, 0); assert.deepStrictEqual(Array.from(d), Array.from(c));
// 縁のそばでは、暗い側がより暗く・明るい側がより明るくなる(くっきり)
d = mk(8, 8, (x) => (x < 4 ? 50 : 200)); sharpen(d, 8, 8, 0.7);
const at = (x, y) => d[(y * 8 + x) * 4];
assert.ok(at(3, 4) < 50 && at(4, 4) > 200, `edge ${at(3, 4)} ${at(4, 4)}`);
// 縁から離れた所は変わらない、アルファは触らない
assert.strictEqual(at(0, 4), 50); assert.strictEqual(at(7, 4), 200); assert.strictEqual(d[3], 255);
// 強いほど縁が強調される
const e = (a) => { const t = mk(8, 8, (x) => (x < 4 ? 50 : 200)); sharpen(t, 8, 8, a); return t[(4 * 8 + 4) * 4] - t[(4 * 8 + 3) * 4]; };
assert.ok(e(0.7) > e(0.35) && e(0.35) > e(0));
// 小さすぎる絵でも壊れない
sharpen(mk(2, 2, () => 10), 2, 2, 0.5);
console.log('SHARPEN TESTS PASSED');
