'use strict';
// ICC変換のテスト。合成したプロファイルで、既知の値と一致するか確認します。
const assert = require('assert');
const ICC = require('../src/icc.js');

// ---- テスト用の最小ICCプロファイル(matrix/TRC)を組み立てる
function s15(v) { const b = Buffer.alloc(4); b.writeInt32BE(Math.round(v * 65536)); return b; }
function xyzTag(v) { return Buffer.concat([Buffer.from('XYZ \0\0\0\0'), s15(v[0]), s15(v[1]), s15(v[2])]); }
function gammaTag(g) { const b = Buffer.alloc(14); b.write('curv', 0); b.writeUInt32BE(1, 8); b.writeUInt16BE(Math.round(g * 256), 12); return b; }
function paraTag(type, params) {
  const b = Buffer.alloc(12 + params.length * 4); b.write('para', 0); b.writeUInt16BE(type, 8);
  params.forEach((p, i) => s15(p).copy(b, 12 + i * 4)); return b;
}
function tableTag(arr) {
  const b = Buffer.alloc(12 + arr.length * 2); b.write('curv', 0); b.writeUInt32BE(arr.length, 8);
  arr.forEach((v, i) => b.writeUInt16BE(Math.round(v * 65535), 12 + i * 2)); return b;
}
function descTag(text) {
  const b = Buffer.alloc(12 + text.length + 1 + 80); b.write('desc', 0); b.writeUInt32BE(text.length + 1, 8); b.write(text, 12, 'ascii'); return b;
}
function pad4(b) { const n = (4 - (b.length % 4)) % 4; return n ? Buffer.concat([b, Buffer.alloc(n)]) : b; }

function makeProfile({ matrix, curve, desc = 'test', omit = [], colorSpace = 'RGB ' }) {
  // matrix: 線形RGB→XYZ(D50) の行列。列が rXYZ gXYZ bXYZ
  const col = (j) => [matrix[j], matrix[3 + j], matrix[6 + j]];
  let tags = {
    desc: descTag(desc),
    rXYZ: xyzTag(col(0)), gXYZ: xyzTag(col(1)), bXYZ: xyzTag(col(2)),
    rTRC: curve, gTRC: curve, bTRC: curve,
  };
  omit.forEach((k) => delete tags[k]);
  const names = Object.keys(tags);
  const headerLen = 128 + 4 + names.length * 12;
  let offset = headerLen;
  const entries = []; const bodies = [];
  names.forEach((n) => { const body = pad4(tags[n]); entries.push([n, offset, tags[n].length]); bodies.push(body); offset += body.length; });
  const header = Buffer.alloc(128);
  header.writeUInt32BE(offset, 0);
  header.write('mntr', 12); header.write(colorSpace, 16); header.write('XYZ ', 20); header.write('acsp', 36);
  const table = Buffer.alloc(4 + names.length * 12); table.writeUInt32BE(names.length, 0);
  entries.forEach(([n, o, s], i) => { table.write(n, 4 + i * 12); table.writeUInt32BE(o, 8 + i * 12); table.writeUInt32BE(s, 12 + i * 12); });
  return new Uint8Array(Buffer.concat([header, table, ...bodies]));
}

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (許容 ${tol})`);
function run(transform, rgb) {
  const src = new Uint8ClampedArray([rgb[0], rgb[1], rgb[2], 255]);
  const dst = new Uint8ClampedArray(4);
  transform.apply(src, dst);
  return [dst[0], dst[1], dst[2], dst[3]];
}

// ---- 1) sRGB色度のD50行列が、広く知られた値と一致する
const sRGB_D50 = ICC.sourceToXyzD50('srgb');
const known = [0.4360747, 0.3850649, 0.1430804, 0.2225045, 0.7168786, 0.0606169, 0.0139322, 0.0971045, 0.7141733];
known.forEach((v, i) => near(sRGB_D50[i], v, 0.0008, `sRGB D50行列[${i}]`));

// ---- 2) sRGBカーブ + sRGB原色のモニター → ほぼ素通し
const srgbCurve = paraTag(3, [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045]);
const profSrgb = ICC.parseProfile(makeProfile({ matrix: sRGB_D50, curve: srgbCurve, desc: 'sRGB-like' }));
assert.strictEqual(profSrgb.description, 'sRGB-like');
const tIdentity = ICC.createTransform(profSrgb, 'srgb');
for (const c of [[0, 0, 0], [255, 255, 255], [128, 128, 128], [255, 0, 0], [0, 255, 0], [0, 0, 255], [30, 90, 200], [200, 150, 20], [10, 10, 10]]) {
  const o = run(tIdentity, c);
  [0, 1, 2].forEach((k) => near(o[k], c[k], 1, `素通し ${c} ch${k}`));
  assert.strictEqual(o[3], 255, 'アルファは保たれる');
}

// ---- 3) ガンマ2.2のモニター（原色はsRGB）: 中間グレー128 → 約 0.2158^(1/2.2)
const gamma22 = ICC.parseProfile(makeProfile({ matrix: sRGB_D50, curve: gammaTag(2.2) }));
const tG = ICC.createTransform(gamma22, 'srgb');
const lin128 = Math.pow((128 / 255 + 0.055) / 1.055, 2.4);
near(run(tG, [128, 128, 128])[0], Math.round(Math.pow(lin128, 1 / 2.2) * 255), 1, 'ガンマ2.2 グレー128');
// 黒と白は変わらない
assert.deepStrictEqual(run(tG, [0, 0, 0]).slice(0, 3), [0, 0, 0]);
assert.deepStrictEqual(run(tG, [255, 255, 255]).slice(0, 3), [255, 255, 255]);

// ---- 4) 広色域モニター(Display P3原色 + sRGBカーブ)にsRGBの赤を送る → 約 (234, 51, 35)
const p3_D50 = ICC.sourceToXyzD50('display-p3');
const wide = ICC.parseProfile(makeProfile({ matrix: p3_D50, curve: srgbCurve }));
const tWide = ICC.createTransform(wide, 'srgb');
const red = run(tWide, [255, 0, 0]);
near(red[0], 234, 2, 'sRGB赤→P3 R'); near(red[1], 51, 3, 'sRGB赤→P3 G'); near(red[2], 35, 3, 'sRGB赤→P3 B');
// 白は白のまま（色順応が正しい）
const white = run(tWide, [255, 255, 255]);
[0, 1, 2].forEach((k) => near(white[k], 255, 1, `広色域 白 ch${k}`));
// グレーはグレーのまま
const grey = run(tWide, [100, 100, 100]);
near(grey[0], grey[1], 1, 'グレーR=G'); near(grey[1], grey[2], 1, 'グレーG=B');

// ---- 5) 画像がDisplay P3のとき、P3原色のモニターでは素通し
const tP3 = ICC.createTransform(wide, 'display-p3');
for (const c of [[255, 0, 0], [12, 200, 90], [128, 128, 128]]) {
  const o = run(tP3, c); [0, 1, 2].forEach((k) => near(o[k], c[k], 1, `P3→P3 ${c}`));
}

// ---- 6) 色域の外は0〜255にクリップされ、例外にならない
const tNarrow = ICC.createTransform(profSrgb, 'display-p3');
const clipped = run(tNarrow, [0, 255, 0]); // P3の緑はsRGBの外
assert.ok(clipped[0] >= 0 && clipped[1] <= 255);

// ---- 7) テーブル型カーブ(curv, N点)とパラメトリック型の結果が一致
const N = 1024; const arr = []; for (let i = 0; i < N; i++) arr.push(Math.pow(i / (N - 1), 2.2));
const tabProf = ICC.parseProfile(makeProfile({ matrix: sRGB_D50, curve: tableTag(arr) }));
const tTab = ICC.createTransform(tabProf, 'srgb');
for (const v of [20, 64, 128, 200]) near(run(tTab, [v, v, v])[0], run(tG, [v, v, v])[0], 1, `テーブルカーブ ${v}`);

// ---- 8) 暗部の階調が潰れない（0〜40が段階的に増える）
let prev = -1; let distinct = new Set();
for (let v = 0; v <= 40; v++) { const o = run(tG, [v, v, v])[0]; assert.ok(o >= prev, '単調増加'); prev = o; distinct.add(o); }
assert.ok(distinct.size >= 20, `暗部の階調が潰れている: ${distinct.size}段階`);

// ---- 9) 壊れた/非対応ファイルは分かりやすいエラー
assert.throws(() => ICC.parseProfile(new Uint8Array(10)), /小さすぎ/);
assert.throws(() => ICC.parseProfile(new Uint8Array(200)), /ICCプロファイルではありません/);
assert.throws(() => ICC.parseProfile(makeProfile({ matrix: sRGB_D50, curve: srgbCurve, omit: ['rXYZ', 'gXYZ', 'bXYZ'] })), /LUT型のため未対応/);
assert.throws(() => ICC.parseProfile(makeProfile({ matrix: sRGB_D50, curve: srgbCurve, colorSpace: 'GRAY' })), /RGB用/);

// ---- 11) 白点合わせ: 原色の合計がD50でないプロファイルでも、画像の白がモニターの白(255)になる
const odd = sRGB_D50.slice(); odd[0] *= 0.97; odd[3] *= 0.97; odd[6] *= 0.97; // 赤原色を暗くして合計をD50から外す
const oddProf = ICC.parseProfile(makeProfile({ matrix: odd, curve: srgbCurve }));
const wOn = run(ICC.createTransform(oddProf, 'srgb'), [255, 255, 255]).slice(0, 3);
assert.deepStrictEqual(wOn, [255, 255, 255], '白合わせ: 白が255,255,255');
const wOff = run(ICC.createTransform(oddProf, 'srgb', { whiteMatch: false }), [255, 255, 255]);
assert.ok(wOff[0] > 255 - 1 || wOff[1] < 255, '白合わせなしでは白がずれうる');
const rep = ICC.whiteReport(oddProf, 'srgb');
assert.deepStrictEqual(rep.matched, [255, 255, 255]);
// 合計がD50のプロファイルでは、白合わせの有無で結果が同じ
const same = [[10, 200, 90], [255, 255, 255], [128, 128, 128]];
same.forEach((c) => assert.deepStrictEqual(run(ICC.createTransform(profSrgb, 'srgb'), c), run(ICC.createTransform(profSrgb, 'srgb', { whiteMatch: false }), c)));
// 診断情報
assert.ok(Array.isArray(profSrgb.info.tags) && profSrgb.info.tags.includes('rXYZ'));
assert.strictEqual(profSrgb.info.hasLut, false);
assert.strictEqual(profSrgb.info.whiteXYZ.length, 3);

// ---- 12) ディザ: 平均は変わらず、段差(同じ値の連続)が崩れる。白と黒は動かない
const tD = ICC.createTransform(profSrgb, 'srgb', { dither: true });
const tN = ICC.createTransform(profSrgb, 'srgb');
const flat = new Uint8ClampedArray(4 * 20000); for (let i = 0; i < flat.length; i += 4) { flat[i] = flat[i + 1] = flat[i + 2] = 250; flat[i + 3] = 255; }
const fN = new Uint8ClampedArray(flat), fD = new Uint8ClampedArray(flat);
tN.apply(flat, fN); tD.apply(flat, fD);
let sN = 0, sD = 0, vals = new Set(); for (let i = 0; i < flat.length; i += 4) { sN += fN[i]; sD += fD[i]; vals.add(fD[i]); }
assert.ok(Math.abs(sN - sD) / 20000 < 0.6, 'ディザで平均が大きく動かない');
assert.ok(vals.size <= 2, 'ディザの揺れは最大1段階');
assert.deepStrictEqual(run(tD, [255, 255, 255]).slice(0, 3), [255, 255, 255]);
assert.deepStrictEqual(run(tD, [0, 0, 0]).slice(0, 3), [0, 0, 0]);
// 同じ入力なら毎回同じ結果
const fD2 = new Uint8ClampedArray(flat); tD.apply(flat, fD2); assert.deepStrictEqual(fD, fD2);

// ---- 10) 性能の目安: 3メガピクセルの変換にかかる時間
const px = 3_000_000; const big = new Uint8ClampedArray(px * 4); for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 255;
const t0 = process.hrtime.bigint(); tWide.apply(big, big); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`3MPの変換: ${ms.toFixed(0)} ms`);
assert.ok(ms < 1500, '変換が遅すぎる');

console.log('ICC TESTS PASSED');
