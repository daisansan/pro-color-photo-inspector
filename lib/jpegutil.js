'use strict';

/** JPEGのバイト列を扱う小さな道具（外部ライブラリなし） */

// SOIの位置から、JPEGの終わり(EOIの次)までを数える。壊れていれば -1。
function jpegEnd(b, start) {
  if (b[start] !== 0xff || b[start + 1] !== 0xd8) return -1;
  let o = start + 2;
  while (o + 2 <= b.length) {
    if (b[o] !== 0xff) return -1;
    const m = b[o + 1];
    if (m === 0xff) { o++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
    if (m === 0xd9) return o + 2;
    if (o + 4 > b.length) return -1;
    const len = b.readUInt16BE(o + 2);
    if (len < 2) return -1;
    if (m === 0xda) {
      // 画像データ本体: FF のあとが 00 / RSTn 以外になる所が次のマーカー
      let p = o + 2 + len;
      while (p + 1 < b.length) {
        if (b[p] === 0xff) {
          const n = b[p + 1];
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { p += 2; continue; }
          if (n === 0xff) { p++; continue; }
          break;
        }
        p++;
      }
      o = p;
      continue;
    }
    o += 2 + len;
  }
  return -1;
}

// SOFから大きさを読む。 戻り値: { width, height } | null
function jpegSize(b, start, end) {
  let o = start + 2;
  while (o + 9 <= end) {
    if (b[o] !== 0xff) return null;
    const m = b[o + 1];
    if (m === 0xff) { o++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null;
    const len = b.readUInt16BE(o + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      // marker: 0xC0/C1/C2 は普通に表示できるJPEG。C3(ロスレス)などは、RAWのセンサーデータなので表示できない
      return { height: b.readUInt16BE(o + 5), width: b.readUInt16BE(o + 7), marker: m };
    }
    o += 2 + len;
  }
  return null;
}

// JPEGにAPP1(EXIF)が先頭付近にあるか
function hasExif(b) {
  let o = 2;
  while (o + 4 <= b.length && b[o] === 0xff) {
    const m = b[o + 1];
    if (m === 0xda || m === 0xd9) return false;
    const len = b.readUInt16BE(o + 2);
    if (m === 0xe1 && b.toString('latin1', o + 4, o + 10) === 'Exif\0\0') return true;
    o += 2 + len;
  }
  return false;
}

// SOIの直後(APP0があればその後ろ)に、指定のセグメントを挿入する
function insertSegments(jpeg, segments) {
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + jpeg.readUInt16BE(4);   // JFIF(APP0)の後ろ
  return Buffer.concat([jpeg.subarray(0, at), ...segments, jpeg.subarray(at)]);
}

// ICCプロファイルを、APP2 "ICC_PROFILE" として埋め込むセグメントに分けて作る
function iccSegments(icc) {
  const MAX = 65519;
  const n = Math.ceil(icc.length / MAX);
  const segs = [];
  for (let i = 0; i < n; i++) {
    const part = icc.subarray(i * MAX, (i + 1) * MAX);
    const head = Buffer.alloc(18);
    head[0] = 0xff; head[1] = 0xe2;
    head.writeUInt16BE(part.length + 16, 2);
    head.write('ICC_PROFILE\0', 4, 'latin1');
    head[16] = i + 1; head[17] = n;
    segs.push(head, part);
  }
  return segs;
}

// 先頭付近のAPP1(EXIF)を取り除く
function stripExif(jpeg) {
  let o = 2;
  while (o + 4 <= jpeg.length && jpeg[o] === 0xff) {
    const m = jpeg[o + 1];
    if (m === 0xda || m === 0xd9) break;
    const len = jpeg.readUInt16BE(o + 2);
    if (m === 0xe1 && jpeg.toString('latin1', o + 4, o + 10) === 'Exif\0\0') {
      return Buffer.concat([jpeg.subarray(0, o), jpeg.subarray(o + 2 + len)]);
    }
    o += 2 + len;
  }
  return jpeg;
}

module.exports = { jpegEnd, jpegSize, hasExif, insertSegments, iccSegments, stripExif };
