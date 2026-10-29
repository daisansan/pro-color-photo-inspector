'use strict';

/**
 * RAW（CR2 / CR3 / NEF / ARW / DNG など）に埋め込まれた、いちばん大きなJPEGプレビューを取り出す。
 * RAWを現像するのではなく、カメラが保存したプレビューをそのまま使う。
 * あわせて、TIFF系のRAWからは 向き・カメラ名・露出などを読み、プレビューにEXIFが無いときは付け足す。
 */

const { jpegEnd, jpegSize, insertSegments, stripExif } = require('./jpegutil');

// ---- いちばん大きいJPEGを探す（ファイル全体を走査）
function findLargestJpeg(buf) {
  let best = null;
  let pos = 0;
  while (pos + 4 < buf.length) {
    const i = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]), pos);
    if (i < 0) break;
    const end = jpegEnd(buf, i);
    if (end > i) {
      const size = jpegSize(buf, i, end);
      if (size && size.marker <= 0xc2 && size.width >= 160 && size.height >= 120) {   // 小さな縮小画像(サムネイル)と、センサーデータ(ロスレスJPEG)は除く
        const area = size.width * size.height;
        if (!best || area > best.area) best = { start: i, end, area, width: size.width, height: size.height };
      }
      pos = end;            // 見つけたJPEGの中にある入れ子のJPEG(サムネイル)は調べない
    } else {
      pos = i + 3;
    }
  }
  return best ? { jpeg: buf.subarray(best.start, best.end), width: best.width, height: best.height } : null;
}

// ---- TIFF(EXIF)の読み取り
function makeTiff(buf, base) {
  const sig = buf.toString('latin1', base, base + 2);
  if (sig !== 'II' && sig !== 'MM') return null;
  const le = sig === 'II';
  const u16 = (p) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
  const u32 = (p) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
  if (u16(base + 2) !== 42 && !(le && u16(base + 2) === 0x4f52) && !(le && u16(base + 2) === 0x5352)) return null;   // 42=TIFF, ORF/RW2は別の値
  return { le, u16, u32, base };
}

function readIfd(buf, t, off) {
  const out = {};
  try {
    const p = t.base + off;
    const n = t.u16(p);
    if (n > 500) return out;
    for (let i = 0; i < n; i++) {
      const e = p + 2 + i * 12;
      const tag = t.u16(e), type = t.u16(e + 2), cnt = t.u32(e + 4);
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 })[type] || 0;
      const total = size * cnt;
      const vp = total <= 4 ? e + 8 : t.base + t.u32(e + 8);
      if (!size || vp < 0 || vp + total > buf.length) continue;
      let v;
      if (type === 2) v = buf.toString('latin1', vp, vp + cnt).replace(/\0.*$/s, '').trim();
      else if (type === 3) v = t.u16(vp);
      else if (type === 4) v = t.u32(vp);
      else if (type === 5) { const d = t.u32(vp + 4); v = d ? [t.u32(vp), d] : null; }
      else continue;
      out[tag] = { type, v };
    }
  } catch (e) { /* 読めない所は無視 */ }
  return out;
}

function readRawExif(buf) {
  const t = makeTiff(buf, 0);
  if (!t) return null;
  const ifd0 = readIfd(buf, t, t.u32(4));
  const exifPtr = ifd0[0x8769] ? ifd0[0x8769].v : 0;
  const exif = exifPtr ? readIfd(buf, t, exifPtr) : {};
  const val = (m, tag) => (m[tag] ? m[tag].v : undefined);
  const o = val(ifd0, 0x0112);
  return {
    make: val(ifd0, 0x010f), model: val(ifd0, 0x0110), dateTime: val(ifd0, 0x0132),
    orientation: o >= 1 && o <= 8 ? o : 1,
    exposure: val(exif, 0x829a), fNumber: val(exif, 0x829d), iso: val(exif, 0x8827),
    dateOriginal: val(exif, 0x9003), focal: val(exif, 0x920a),
  };
}

// ---- 読み取った項目から、小さなEXIF(APP1)を組み立てる
function buildExifApp1(info) {
  const le = false;   // ビッグエンディアンで書く
  const entries0 = [];   // {tag,type,count,data(Buffer)|inline}
  const ascii = (s) => Buffer.from(String(s) + '\0', 'latin1');
  const rat = (r) => { const b = Buffer.alloc(8); b.writeUInt32BE(r[0], 0); b.writeUInt32BE(r[1], 4); return b; };
  const short = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); return b; };
  if (info.make) entries0.push({ tag: 0x010f, type: 2, data: ascii(info.make) });
  if (info.model) entries0.push({ tag: 0x0110, type: 2, data: ascii(info.model) });
  entries0.push({ tag: 0x0112, type: 3, data: short(info.orientation || 1) });
  if (info.dateTime) entries0.push({ tag: 0x0132, type: 2, data: ascii(info.dateTime) });
  const entriesE = [];
  if (info.exposure) entriesE.push({ tag: 0x829a, type: 5, data: rat(info.exposure) });
  if (info.fNumber) entriesE.push({ tag: 0x829d, type: 5, data: rat(info.fNumber) });
  if (info.iso) entriesE.push({ tag: 0x8827, type: 3, data: short(info.iso) });
  if (info.dateOriginal) entriesE.push({ tag: 0x9003, type: 2, data: ascii(info.dateOriginal) });
  if (info.focal) entriesE.push({ tag: 0x920a, type: 5, data: rat(info.focal) });
  const hasE = entriesE.length > 0;
  if (hasE) entries0.push({ tag: 0x8769, type: 4, data: Buffer.alloc(4) });   // 後で位置を入れる
  entries0.sort((a, b) => a.tag - b.tag);

  const ifdSize = (n) => 2 + n * 12 + 4;
  const ifd0Off = 8;
  const ifdEOff = ifd0Off + ifdSize(entries0.length);
  let dataOff = hasE ? ifdEOff + ifdSize(entriesE.length) : ifdEOff;
  const dataParts = [];
  function layout(entries, ifdOff, exifOff) {
    const b = Buffer.alloc(ifdSize(entries.length));
    b.writeUInt16BE(entries.length, 0);
    entries.forEach((e, i) => {
      const p = 2 + i * 12;
      b.writeUInt16BE(e.tag, p); b.writeUInt16BE(e.type, p + 2);
      const count = e.type === 2 ? e.data.length : e.type === 3 ? 1 : e.type === 4 ? 1 : 1;
      b.writeUInt32BE(count, p + 4);
      if (e.tag === 0x8769) { b.writeUInt32BE(exifOff, p + 8); }
      else if (e.data.length <= 4) { e.data.copy(b, p + 8); }
      else { b.writeUInt32BE(dataOff, p + 8); dataParts.push(e.data); dataOff += e.data.length; if (dataOff % 2) { dataParts.push(Buffer.alloc(1)); dataOff++; } }
    });
    b.writeUInt32BE(0, 2 + entries.length * 12);
    return b;
  }
  const ifd0 = layout(entries0, ifd0Off, ifdEOff);
  const ifdE = hasE ? layout(entriesE, ifdEOff, 0) : Buffer.alloc(0);
  const head = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]);
  const tiff = Buffer.concat([head, ifd0, ifdE, ...dataParts]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  if (payload.length + 2 > 65535) return null;
  const seg = Buffer.alloc(4);
  seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([seg, payload]);
}

/**
 * RAWのファイル内容から、表示用JPEGを作る。見つからなければ null。
 * プレビュー側にEXIFが無ければ、RAWから読んだ向き・カメラ情報を付ける。
 */
function previewFromRaw(buf) {
  const found = findLargestJpeg(buf);
  if (!found) return null;
  let jpeg = Buffer.from(found.jpeg);
  // 向きとカメラ情報は、RAW本体(TIFF)の記録をもとにする。プレビュー側のEXIFは、向きが入っていないことがあるため置き換える
  const info = readRawExif(buf);
  if (info) {
    const seg = buildExifApp1(info);
    if (seg) jpeg = insertSegments(stripExif(jpeg), [seg]);
  }
  return { jpeg, width: found.width, height: found.height };
}

module.exports = { findLargestJpeg, readRawExif, buildExifApp1, previewFromRaw };
