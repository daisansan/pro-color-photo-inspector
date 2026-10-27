'use strict';
const assert = require('assert');
const A = require('../src/adjust');
const px = (rgb, p) => { const d = new Uint8ClampedArray([rgb[0], rgb[1], rgb[2], 255]); A.apply(d, A.buildLuts(p)); return Array.from(d.slice(0, 3)); };

assert.ok(A.isIdentity({}) && A.isIdentity(A.DEFAULTS) && !A.isIdentity({ temp: 5 }));
// 何もしなければ素通し
assert.deepStrictEqual(px([10, 128, 250], {}), [10, 128, 250]);
// 露出+1EV: 128 → 約175、0と255は動かない/飽和
const e = px([128, 128, 128], { exposure: 100 })[0]; assert.ok(Math.abs(e - 175) <= 2, 'exp ' + e);
assert.deepStrictEqual(px([0, 0, 0], { exposure: 100 }), [0, 0, 0]);
assert.strictEqual(px([128, 128, 128], { exposure: -100 })[0] < 128, true);
// コントラスト: 中間は動かず、暗い所はより暗く、明るい所はより明るく
assert.ok(Math.abs(px([128, 128, 128], { contrast: 50 })[0] - 128) <= 2);
assert.ok(px([60, 60, 60], { contrast: 50 })[0] < 60 && px([200, 200, 200], { contrast: 50 })[0] > 200);
// 色温度: +で赤が増え青が減る、-で逆
let w = px([128, 128, 128], { temp: 50 }); assert.ok(w[0] > w[1] && w[1] > w[2], 'warm ' + w);
let c = px([128, 128, 128], { temp: -50 }); assert.ok(c[2] > c[1] && c[1] > c[0], 'cool ' + c);
// 色合い: +でマゼンタ(緑が減る)、-で緑
let mg = px([128, 128, 128], { tint: 50 }); assert.ok(mg[1] < mg[0] && mg[1] < mg[2], 'magenta ' + mg);
let gr = px([128, 128, 128], { tint: -50 }); assert.ok(gr[1] > gr[0] && gr[1] > gr[2], 'green ' + gr);
// 彩度: -100でグレー、+でより鮮やか
let g0 = px([200, 100, 50], { sat: -100 }); assert.ok(g0[0] === g0[1] && g0[1] === g0[2], 'gray ' + g0);
let s1 = px([200, 100, 50], { sat: 50 }); assert.ok(s1[0] - s1[2] > 150, 'vivid ' + s1);
// シャドウ+で暗部が持ち上がり、明部はほぼ動かない。ハイライト-で明部が下がる
assert.ok(px([50, 50, 50], { shadows: 80 })[0] > 60 && Math.abs(px([240, 240, 240], { shadows: 80 })[0] - 240) <= 6);
assert.ok(px([210, 210, 210], { highlights: -80 })[0] < 195 && Math.abs(px([20, 20, 20], { highlights: -80 })[0] - 20) <= 6);
// 黒と白は大きくは壊れない(階調が逆転しない): 全変換で単調
for (const p of [{ exposure: 150, contrast: 80, shadows: 100, highlights: -100 }, { contrast: -100, shadows: -100 }, { temp: 100, tint: 100, sat: 100 }]) {
  const L = A.buildLuts(p);
  for (let i = 1; i < 256; i++) for (const ch of ['r', 'g', 'b']) assert.ok(L[ch][i] >= L[ch][i - 1] - 1, `mono ${JSON.stringify(p)} ${ch} ${i}`);
}
console.log('ADJUST TESTS PASSED');
