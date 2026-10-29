'use strict';

/**
 * PSD と RAW を、表示用のJPEGに変えて返す（元のファイルは変更しない）。
 *  - PSD: 全レイヤーを重ねた合成画像
 *  - RAW: カメラが埋め込んだ最大のJPEGプレビュー
 * 変換した結果は cacheDir に保存して、2回目からは速く返す。
 * JPEGへの書き出し(encodeJpeg)は main.js から渡す（Electronなしでテストできるように）。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parsePsd } = require('./psd');
const { previewFromRaw } = require('./rawpreview');
const { insertSegments, iccSegments } = require('./jpegutil');

const PSD_EXTS = ['.psd'];
const RAW_EXTS = ['.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.raf', '.orf', '.rw2', '.pef', '.dng', '.srw', '.3fr', '.iiq', '.erf', '.mrw', '.x3f'];
const CONVERT_EXTS = new Set([...PSD_EXTS, ...RAW_EXTS]);
const CACHE_VERSION = 'v1';

function isConvertible(name) {
  return CONVERT_EXTS.has(path.extname(String(name)).toLowerCase());
}

function cacheKey(filePath, st) {
  return crypto.createHash('sha1').update(`${CACHE_VERSION}|${filePath}|${Math.round(st.mtimeMs)}|${st.size}`).digest('hex');
}

// 同時に変換する数を制限する
function limiter(n) {
  let active = 0; const q = [];
  const next = () => {
    if (active >= n || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}

function createConverter({ cacheDir, encodeJpeg, concurrency = 2 }) {
  const limit = limiter(concurrency);
  const inflight = new Map();

  async function build(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (PSD_EXTS.includes(ext)) {
      const psd = parsePsd(await fs.promises.readFile(filePath));
      let jpeg = Buffer.from(await encodeJpeg(psd.rgba, psd.width, psd.height));
      if (psd.icc && psd.icc.length > 128) jpeg = insertSegments(jpeg, iccSegments(psd.icc));
      return jpeg;
    }
    const prev = previewFromRaw(await fs.promises.readFile(filePath));
    if (!prev) throw new Error('RAWの中にプレビュー画像が見つかりません');
    return prev.jpeg;
  }

  async function getViewableJpeg(filePath) {
    const st = await fs.promises.stat(filePath);
    const key = cacheKey(filePath, st);
    const cacheFile = path.join(cacheDir, key.slice(0, 2), `${key}.jpg`);
    try { return await fs.promises.readFile(cacheFile); } catch (e) { /* まだ無い */ }
    if (inflight.has(key)) return inflight.get(key);
    const p = limit(async () => {
      const jpeg = await build(filePath);
      try {
        await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true });
        const tmp = `${cacheFile}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, jpeg);
        await fs.promises.rename(tmp, cacheFile);
      } catch (e) { /* 保存できなくても表示はできる */ }
      return jpeg;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  // 古いキャッシュを消して、合計が maxBytes 以下になるようにする
  async function prune(maxBytes = 2 * 1024 * 1024 * 1024) {
    try {
      const files = [];
      for (const d of await fs.promises.readdir(cacheDir)) {
        const dd = path.join(cacheDir, d);
        let names; try { names = await fs.promises.readdir(dd); } catch (e) { continue; }
        for (const n of names) {
          try { const st = await fs.promises.stat(path.join(dd, n)); files.push({ f: path.join(dd, n), size: st.size, t: st.atimeMs || st.mtimeMs }); } catch (e) { /* skip */ }
        }
      }
      let total = files.reduce((a, x) => a + x.size, 0);
      files.sort((a, b) => a.t - b.t);
      for (const x of files) {
        if (total <= maxBytes) break;
        try { await fs.promises.unlink(x.f); total -= x.size; } catch (e) { /* skip */ }
      }
    } catch (e) { /* キャッシュが無ければ何もしない */ }
  }

  return { getViewableJpeg, prune };
}

module.exports = { createConverter, isConvertible, PSD_EXTS, RAW_EXTS, CONVERT_EXTS };
