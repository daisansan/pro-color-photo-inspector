'use strict';
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path'); const zlib = require('zlib');
const { parsePsd } = require('../lib/psd');
const { previewFromRaw, findLargestJpeg, readRawExif } = require('../lib/rawpreview');
const { parseImageInfo } = require('../lib/imginfo');
const { jpegEnd, iccSegments, insertSegments } = require('../lib/jpegutil');
const { createConverter, isConvertible } = require('../lib/convert');

// ---------- PSD を組み立てる（テスト用）
function packBits(row) {
  const out = [];
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && row[i + run] === row[i] && run < 128) run++;
    if (run > 2) { out.push(257 - run, row[i]); i += run; continue; }
    let lit = 1;
    while (i + lit < row.length && lit < 128 && !(i + lit + 2 < row.length && row[i + lit] === row[i + lit + 1] && row[i + lit] === row[i + lit + 2])) lit++;
    out.push(lit - 1, ...row.slice(i, i + lit)); i += lit;
  }
  return Buffer.from(out);
}
function buildPsd({ w, h, depth = 8, mode = 3, planes, compression = 0, icc = null, junkLayer = 40, colorTable = null }) {
  const bps = depth / 8;
  const head = Buffer.alloc(26);
  head.write('8BPS', 0, 'latin1'); head.writeUInt16BE(1, 4);
  head.writeUInt16BE(planes.length, 12); head.writeUInt32BE(h, 14); head.writeUInt32BE(w, 18); head.writeUInt16BE(depth, 22); head.writeUInt16BE(mode, 24);
  const cm = colorTable ? Buffer.concat([Buffer.from([0, 0, 3, 0]), colorTable]) : Buffer.alloc(4);
  if (colorTable) cm.writeUInt32BE(768, 0);
  const cmSec = colorTable ? Buffer.concat([(() => { const b = Buffer.alloc(4); b.writeUInt32BE(768, 0); return b; })(), colorTable]) : Buffer.alloc(4);
  let res = Buffer.alloc(0);
  const addRes = (id, data) => {
    const b = Buffer.alloc(12 + 2);   // 8BIM + id + 空の名前(パスカル 1+パディング1) + size
    b.write('8BIM', 0, 'latin1'); b.writeUInt16BE(id, 4); b[6] = 0; b[7] = 0; b.writeUInt32BE(data.length, 8);
    res = Buffer.concat([res, b.subarray(0, 12), data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  addRes(1005, Buffer.alloc(16));      // 関係ないリソース
  if (icc) addRes(1039, icc);
  const resSec = Buffer.concat([(() => { const b = Buffer.alloc(4); b.writeUInt32BE(res.length, 0); return b; })(), res]);
  const layer = Buffer.alloc(4 + junkLayer); layer.writeUInt32BE(junkLayer, 0);
  let data;
  const comp = Buffer.alloc(2); comp.writeUInt16BE(compression, 0);
  if (compression === 0) data = Buffer.concat(planes);
  else if (compression === 1) {
    const counts = []; const rows = [];
    for (const pl of planes) for (let y = 0; y < h; y++) { const r = packBits(pl.subarray(y * w * bps, (y + 1) * w * bps)); counts.push(r.length); rows.push(r); }
    const cb = Buffer.alloc(counts.length * 2); counts.forEach((c, i) => cb.writeUInt16BE(c, i * 2));
    data = Buffer.concat([cb, ...rows]);
  } else {
    const all = Buffer.concat(planes.map((pl) => {
      if (compression === 2) return pl;
      const d = Buffer.from(pl);
      for (let y = 0; y < h; y++) for (let x = w - 1; x >= 1; x--) {
        if (bps === 1) d[y * w + x] = (pl[y * w + x] - pl[y * w + x - 1]) & 0xff;
        else d.writeUInt16BE((pl.readUInt16BE((y * w + x) * 2) - pl.readUInt16BE((y * w + x - 1) * 2)) & 0xffff, (y * w + x) * 2);
      }
      return d;
    }));
    data = zlib.deflateSync(all);
  }
  return Buffer.concat([head, cmSec, resSec, layer, comp, data]);
}
const W = 7, H = 5;
const mk = (f) => { const b = Buffer.alloc(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) b[y * W + x] = f(x, y) & 255; return b; };
const R = mk((x, y) => x * 30 + y), G = mk((x, y) => y * 40 + 5), B = mk((x, y) => (x + y) * 10);
const pix = (rgba, x, y) => [...rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
const exp = (x, y) => [R[y * W + x], G[y * W + x], B[y * W + x], 255];

// 非圧縮 / RLE / ZIP / ZIP+予測 の4つ（アルファチャンネルつき）
const A = mk(() => 200);
for (const comp of [0, 1, 2, 3]) {
  const psd = parsePsd(buildPsd({ w: W, h: H, planes: [R, G, B, A], compression: comp }));
  assert.strictEqual(psd.width, W); assert.strictEqual(psd.height, H);
  for (const [x, y] of [[0, 0], [3, 2], [6, 4], [1, 3]]) assert.deepStrictEqual(pix(psd.rgba, x, y), exp(x, y), `圧縮${comp} (${x},${y})`);
}
// ICC
const icc = Buffer.alloc(300, 7);
assert.deepStrictEqual([...parsePsd(buildPsd({ w: W, h: H, planes: [R, G, B], icc })).icc], [...icc]);
assert.strictEqual(parsePsd(buildPsd({ w: W, h: H, planes: [R, G, B] })).icc, null);
// グレースケール
const g = parsePsd(buildPsd({ w: W, h: H, mode: 1, planes: [R] }));
assert.deepStrictEqual(pix(g.rgba, 2, 3), [R[3 * W + 2], R[3 * W + 2], R[3 * W + 2], 255]);
// 16bit (上位バイト)
const p16 = [R, G, B].map((pl) => { const b = Buffer.alloc(W * H * 2); for (let i = 0; i < pl.length; i++) b.writeUInt16BE(pl[i] * 257, i * 2); return b; });
for (const comp of [0, 1, 3]) {
  const d16 = parsePsd(buildPsd({ w: W, h: H, depth: 16, planes: p16, compression: comp }));
  assert.deepStrictEqual(pix(d16.rgba, 4, 2), exp(4, 2), '16bit 圧縮' + comp);
}
// CMYK（反転保存）: 全部255=インクなし→白、K=0→黒
const full = mk(() => 255), zero = mk(() => 0);
const white = parsePsd(buildPsd({ w: W, h: H, mode: 4, planes: [full, full, full, full] }));
assert.deepStrictEqual(pix(white.rgba, 1, 1), [255, 255, 255, 255]);
const black = parsePsd(buildPsd({ w: W, h: H, mode: 4, planes: [full, full, full, zero] }));
assert.deepStrictEqual(pix(black.rgba, 1, 1), [0, 0, 0, 255]);
// インデックス
const ct = Buffer.alloc(768); for (let i = 0; i < 256; i++) { ct[i] = 255 - i; ct[256 + i] = i; ct[512 + i] = 128; }
const ix = parsePsd(buildPsd({ w: W, h: H, mode: 2, planes: [R], colorTable: ct }));
assert.deepStrictEqual(pix(ix.rgba, 3, 0), [255 - R[3], R[3], 128, 255]);
// エラー
assert.throws(() => parsePsd(Buffer.from('not a psd file at all, just text....')), /PSD/);
assert.throws(() => parsePsd(buildPsd({ w: W, h: H, planes: [R, G, B] }).subarray(0, 120)), /切れて|RangeError|Invalid|範囲|out of range/i);
console.log('PSD TESTS PASSED');

// ---------- RAW（TIFF風）に、大小のJPEGを埋め込む
const big = fs.readFileSync(path.join(__dirname, '..', 'tests', 'data', 'big.jpg'));
const small = fs.readFileSync(path.join(__dirname, '..', 'tests', 'data', 'small.jpg'));
assert.ok(jpegEnd(big, 0) === big.length && jpegEnd(small, 0) === small.length, 'テスト画像');
function buildRaw(orientation) {
  const ascii = (s) => Buffer.from(s + '\0', 'latin1');
  const make = ascii('Canon'), model = ascii('Canon EOS TEST');
  // レイアウト: ヘッダ8 + IFD0 + ExifIFD + データ
  const n0 = 4, nE = 4;
  const ifd0Off = 8, ifdEOff = ifd0Off + 2 + n0 * 12 + 4;
  let dOff = ifdEOff + 2 + nE * 12 + 4;
  const parts = [];
  const put = (b) => { const o = dOff; parts.push(b); dOff += b.length; return o; };
  const ent = (tag, type, cnt, val) => { const e = Buffer.alloc(12); e.writeUInt16LE(tag, 0); e.writeUInt16LE(type, 2); e.writeUInt32LE(cnt, 4); if (type === 3) e.writeUInt16LE(val, 8); else e.writeUInt32LE(val, 8); return e; };
  const e0 = [ent(0x010f, 2, make.length, put(make)), ent(0x0110, 2, model.length, put(model)), ent(0x0112, 3, 1, orientation), ent(0x8769, 4, 1, ifdEOff)];
  const rat = (a, b) => { const r = Buffer.alloc(8); r.writeUInt32LE(a, 0); r.writeUInt32LE(b, 4); return r; };
  const eE = [ent(0x829a, 5, 1, put(rat(1, 250))), ent(0x829d, 5, 1, put(rat(28, 10))), ent(0x8827, 3, 1, 400), ent(0x920a, 5, 1, put(rat(50, 1)))];
  const ifd = (es) => { const h = Buffer.alloc(2); h.writeUInt16LE(es.length, 0); return Buffer.concat([h, ...es, Buffer.alloc(4)]); };
  const head = Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]);
  return Buffer.concat([head, ifd(e0), ifd(eE), ...parts, Buffer.alloc(100, 0x11), small, Buffer.alloc(64, 0x22), big, Buffer.alloc(300, 0x33)]);
}
// センサーデータ(ロスレスJPEG, SOF3)は、画素数が多くても選ばない
function fakeLossless(w, h) {
  const sof = Buffer.alloc(13); sof[0] = 0xff; sof[1] = 0xc3; sof.writeUInt16BE(11, 2); sof[4] = 14; sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7); sof[9] = 1; sof[10] = 0; sof[11] = 0x11; sof[12] = 0;
  const sos = Buffer.from([0xff, 0xda, 0, 8, 1, 0, 0, 1, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, sos, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), Buffer.from([0xff, 0xd9])]);
}
assert.strictEqual(jpegEnd(fakeLossless(6000, 4000), 0), fakeLossless(6000, 4000).length);
const raw = Buffer.concat([buildRaw(6), Buffer.alloc(16, 0x44), fakeLossless(6000, 4000), Buffer.alloc(16, 0x55)]);
const info = readRawExif(raw);
assert.strictEqual(info.make, 'Canon'); assert.strictEqual(info.model, 'Canon EOS TEST'); assert.strictEqual(info.orientation, 6);
assert.deepStrictEqual(info.fNumber, [28, 10]); assert.strictEqual(info.iso, 400);
const found = findLargestJpeg(raw);
assert.ok(found && found.jpeg.length === big.length, '大きい方のJPEGを選ぶ');
const prev = previewFromRaw(raw);
const pinfo = parseImageInfo(prev.jpeg);
assert.strictEqual(pinfo.orientation, 6, '向きがRAWから引き継がれる');
assert.strictEqual(pinfo.width, found.width);
assert.ok(prev.jpeg.toString('latin1').includes('Canon EOS TEST'));
assert.strictEqual(previewFromRaw(Buffer.alloc(2000, 1)), null);
// ICC挿入
const withIcc = insertSegments(big, iccSegments(Buffer.alloc(70000, 5)));
assert.strictEqual(jpegEnd(withIcc, 0), withIcc.length);
assert.ok(withIcc.toString('latin1').includes('ICC_PROFILE'));
console.log('RAW TESTS PASSED');

// ---------- 変換サービス（キャッシュ）
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
  fs.writeFileSync(path.join(dir, 'a.CR2'), raw);
  fs.writeFileSync(path.join(dir, 'b.psd'), buildPsd({ w: W, h: H, planes: [R, G, B], icc: Buffer.alloc(400, 9) }));
  fs.writeFileSync(path.join(dir, 'c.CR2'), Buffer.alloc(5000, 1));
  let encoded = 0;
  const conv = createConverter({ cacheDir: path.join(dir, 'cache'), encodeJpeg: async (rgba, w, h) => { encoded++; assert.strictEqual(rgba.length, w * h * 4); return big; } });
  assert.ok(isConvertible('x.CR2') && isConvertible('Y.PSD') && !isConvertible('z.jpg'));
  const a1 = await conv.getViewableJpeg(path.join(dir, 'a.CR2'));
  assert.strictEqual(parseImageInfo(a1).orientation, 6);
  const b1 = await conv.getViewableJpeg(path.join(dir, 'b.psd'));
  assert.ok(b1.toString('latin1').includes('ICC_PROFILE') && encoded === 1);
  const b2 = await conv.getViewableJpeg(path.join(dir, 'b.psd'));
  assert.ok(b2.equals(b1) && encoded === 1, '2回目はキャッシュ');
  await assert.rejects(() => conv.getViewableJpeg(path.join(dir, 'c.CR2')), /プレビュー/);
  await conv.prune(1);   // 小さい上限で全部消える
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('CONVERT TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
