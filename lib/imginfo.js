'use strict';

/**
 * 画像ファイルの先頭だけを読んで、幅・高さ・EXIFの向きを調べます（画像全体は読み込みません）。
 * 対応: JPEG / PNG / WebP。
 */

const fs = require('fs');

function parseJpeg(b) {
  let o = 2, w = 0, h = 0, orientation = 1;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) { o++; continue; }
    const m = b[o + 1];
    if (m === 0xff) { o++; continue; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { o += 2; continue; }
    if (m === 0xd9 || m === 0xda) break;
    const len = b.readUInt16BE(o + 2);
    if (m === 0xe1 && b.toString('latin1', o + 4, o + 10) === 'Exif\0\0') {
      const t = o + 10;
      const le = b.toString('latin1', t, t + 2) === 'II';
      const u16 = (p) => (le ? b.readUInt16LE(p) : b.readUInt16BE(p));
      const u32 = (p) => (le ? b.readUInt32LE(p) : b.readUInt32BE(p));
      try {
        const ifd = t + u32(t + 4);
        const n = u16(ifd);
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (u16(e) === 0x0112) { const v = u16(e + 8); if (v >= 1 && v <= 8) orientation = v; break; }
        }
      } catch (err) { /* 向きなし */ }
    }
    if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      h = b.readUInt16BE(o + 5); w = b.readUInt16BE(o + 7);
      break;
    }
    o += 2 + len;
  }
  return w && h ? { width: w, height: h, orientation } : null;
}

function parsePng(b) {
  if (b.length < 24) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), orientation: 1 };
}

function parseWebp(b) {
  if (b.length < 30) return null;
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), orientation: 1 };
  if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, orientation: 1 };
  if (kind === 'VP8L') {
    const v = b.readUInt32LE(21);
    return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1, orientation: 1 };
  }
  return null;
}

function parseImageInfo(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return parseJpeg(b);
  if (b.length > 8 && b.toString('latin1', 1, 4) === 'PNG') return parsePng(b);
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return parseWebp(b);
  return null;
}

// 戻り値: { width, height, orientation, dispW, dispH }  dispW/dispH は向きを直したあとの見た目の大きさ。調べられなければ null
async function readImageInfo(filePath) {
  let fh;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const info = parseImageInfo(buf.subarray(0, bytesRead));
    if (!info) return null;
    const swap = info.orientation >= 5;
    return { ...info, dispW: swap ? info.height : info.width, dispH: swap ? info.width : info.height };
  } catch (e) {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// 4バイト/画素の画像データを、EXIFの向きの番号どおりに回転・反転します。戻り値: { data, width, height }
function applyOrientation(data, w, h, orientation) {
  if (!orientation || orientation === 1) return { data, width: w, height: h };
  const swap = orientation >= 5;
  const ow = swap ? h : w, oh = swap ? w : h;
  const out = Buffer.alloc(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx, dy;
      switch (orientation) {
        case 2: dx = w - 1 - x; dy = y; break;
        case 3: dx = w - 1 - x; dy = h - 1 - y; break;
        case 4: dx = x; dy = h - 1 - y; break;
        case 5: dx = y; dy = x; break;
        case 6: dx = h - 1 - y; dy = x; break;
        case 7: dx = h - 1 - y; dy = w - 1 - x; break;
        case 8: dx = y; dy = w - 1 - x; break;
        default: dx = x; dy = y;
      }
      data.copy(out, (dy * ow + dx) * 4, (y * w + x) * 4, (y * w + x) * 4 + 4);
    }
  }
  return { data: out, width: ow, height: oh };
}

module.exports = { readImageInfo, parseImageInfo, applyOrientation };
