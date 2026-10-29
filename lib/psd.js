'use strict';

/**
 * PSD（Photoshop）の「全レイヤーを重ねた合成画像」を読み取る。レイヤー個別は扱わない。
 * 対応: 8bit/16bit、RGB / グレースケール / インデックス / CMYK（ICC変換なしの簡易変換）、非圧縮 / RLE / ZIP。
 * 戻り値: { width, height, rgba: Buffer(RGBA 8bit), icc: Buffer|null }
 * 合成画像が保存されていないPSD（「互換性を優先」をオフにして保存したもの）は、真っ白などになることがあります。
 */

const fs = require('fs');
const zlib = require('zlib');

const MODE = { BITMAP: 0, GRAY: 1, INDEXED: 2, RGB: 3, CMYK: 4, MULTI: 7, DUOTONE: 8, LAB: 9 };

function unpackBits(src, srcStart, srcEnd, dst, dstStart, dstLen) {
  let s = srcStart, d = dstStart;
  const end = dstStart + dstLen;
  while (d < end && s < srcEnd) {
    const n = src[s++] << 24 >> 24;   // 符号つき1バイト
    if (n >= 0) {
      const cnt = n + 1;
      src.copy(dst, d, s, Math.min(s + cnt, srcEnd));
      s += cnt; d += cnt;
    } else if (n !== -128) {
      const cnt = 1 - n;
      const v = src[s++];
      dst.fill(v, d, Math.min(d + cnt, end));
      d += cnt;
    }
  }
}

function parsePsd(buf) {
  if (buf.length < 26 || buf.toString('latin1', 0, 4) !== '8BPS') throw new Error('PSDファイルではありません');
  const version = buf.readUInt16BE(4);
  if (version !== 1) throw new Error('PSB（大きなPSD）には対応していません');
  const channels = buf.readUInt16BE(12);
  const height = buf.readUInt32BE(14);
  const width = buf.readUInt32BE(18);
  const depth = buf.readUInt16BE(22);
  const mode = buf.readUInt16BE(24);
  if (!width || !height) throw new Error('画像の大きさが不正です');
  if (depth !== 8 && depth !== 16) throw new Error(`${depth}bit のPSDには対応していません`);
  if (![MODE.GRAY, MODE.INDEXED, MODE.RGB, MODE.CMYK].includes(mode)) throw new Error('このカラーモードのPSDには対応していません');

  let o = 26;
  const cmdLen = buf.readUInt32BE(o); o += 4;
  const colorTable = mode === MODE.INDEXED && cmdLen >= 768 ? buf.subarray(o, o + 768) : null;
  o += cmdLen;

  // 画像リソース（ICCプロファイルを探す）
  const resLen = buf.readUInt32BE(o); o += 4;
  const resEnd = o + resLen;
  let icc = null;
  let p = o;
  while (p + 12 <= resEnd) {
    if (buf.toString('latin1', p, p + 4) !== '8BIM') break;
    const id = buf.readUInt16BE(p + 4);
    const nameLen = buf[p + 6];
    let q = p + 7 + nameLen;
    if ((1 + nameLen) % 2 === 1) q++;          // 名前は偶数バイトにそろえる
    const size = buf.readUInt32BE(q); q += 4;
    if (id === 1039 && size > 0) icc = Buffer.from(buf.subarray(q, q + size));
    p = q + size + (size % 2);
  }
  o = resEnd;

  // レイヤー情報は読み飛ばす
  const layerLen = buf.readUInt32BE(o); o += 4 + layerLen;

  // 合成画像
  const compression = buf.readUInt16BE(o); o += 2;
  const bps = depth / 8;
  const rowBytes = width * bps;
  const chanBytes = rowBytes * height;
  const nCh = Math.min(channels, mode === MODE.CMYK ? 4 : mode === MODE.RGB ? 3 : 1);
  if (channels < nCh) throw new Error('チャンネル数が足りません');

  // 読むのは必要なチャンネルだけ（先頭から nCh 個）
  const planes = new Array(nCh);
  if (compression === 0) {
    for (let c = 0; c < nCh; c++) planes[c] = buf.subarray(o + c * chanBytes, o + (c + 1) * chanBytes);
  } else if (compression === 1) {
    const counts = new Array(channels * height);
    for (let i = 0; i < counts.length; i++) counts[i] = buf.readUInt16BE(o + i * 2);
    let d = o + counts.length * 2;
    for (let c = 0; c < channels; c++) {
      const plane = c < nCh ? Buffer.alloc(chanBytes) : null;
      for (let y = 0; y < height; y++) {
        const n = counts[c * height + y];
        if (plane) unpackBits(buf, d, d + n, plane, y * rowBytes, rowBytes);
        d += n;
      }
      if (plane) planes[c] = plane;
    }
  } else if (compression === 2 || compression === 3) {
    // ZIP: チャンネル全体が1本の圧縮データ。ここでは残り全部を1本として展開し、先頭から使う
    const raw = zlib.inflateSync(buf.subarray(o));
    for (let c = 0; c < nCh; c++) {
      const plane = Buffer.from(raw.subarray(c * chanBytes, (c + 1) * chanBytes));
      if (compression === 3) {   // 予測つき: 行ごとに差分を足していく
        for (let y = 0; y < height; y++) {
          const r = y * rowBytes;
          if (bps === 1) {
            for (let x = 1; x < width; x++) plane[r + x] = (plane[r + x] + plane[r + x - 1]) & 0xff;
          } else {
            for (let x = 1; x < width; x++) {
              const v = (plane.readUInt16BE(r + x * 2) + plane.readUInt16BE(r + (x - 1) * 2)) & 0xffff;
              plane.writeUInt16BE(v, r + x * 2);
            }
          }
        }
      }
      planes[c] = plane;
    }
  } else {
    throw new Error('このPSDの圧縮方式には対応していません');
  }
  for (let c = 0; c < nCh; c++) if (!planes[c] || planes[c].length < chanBytes) throw new Error('画像データが途中で切れています');

  const n = width * height;
  const rgba = Buffer.alloc(n * 4);
  const px = (c, i) => (bps === 1 ? planes[c][i] : planes[c][i * 2]);   // 16bitは上位バイトを使う
  for (let i = 0; i < n; i++) {
    let r, g, b;
    if (mode === MODE.RGB) { r = px(0, i); g = px(1, i); b = px(2, i); }
    else if (mode === MODE.GRAY) { r = g = b = px(0, i); }
    else if (mode === MODE.INDEXED) {
      const k = px(0, i);
      r = colorTable ? colorTable[k] : k; g = colorTable ? colorTable[256 + k] : k; b = colorTable ? colorTable[512 + k] : k;
    } else {   // CMYK（Photoshopは値を反転して保存している: 255 = インクなし）
      const cc = px(0, i), mm = px(1, i), yy = px(2, i), kk = px(3, i);
      r = (cc * kk) / 255; g = (mm * kk) / 255; b = (yy * kk) / 255;
    }
    const q = i * 4;
    rgba[q] = r; rgba[q + 1] = g; rgba[q + 2] = b; rgba[q + 3] = 255;
  }
  return { width, height, rgba, icc };
}

function readPsdComposite(filePath) {
  return parsePsd(fs.readFileSync(filePath));
}

module.exports = { parsePsd, readPsdComposite };
