'use strict';

/**
 * サムネイル（縮小画像）の生成とディスクキャッシュ。
 * 画像の生成そのもの（nativeImage）は main.js から makeThumb として渡します。
 * こうしておくと、Electronなしでキャッシュや同時実行の動作をテストできます。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

function mimeFor(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function cacheKey(filePath, mtimeMs, size, px) {
  return crypto.createHash('sha1').update(`v2|${filePath}|${Math.round(mtimeMs)}|${size}|${px}`).digest('hex');
}

// 同時に処理する数を制限するキュー
function createLimiter(limit) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= limit || waiting.length === 0) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next(); });
}

function createThumbService({ cacheDir, makeThumb, px = 256, concurrency = 4 }) {
  const limit = createLimiter(concurrency);
  const inflight = new Map(); // 同じ画像を同時に2回作らない

  async function produce(filePath, st, key) {
    const cacheFile = path.join(cacheDir, key.slice(0, 2), `${key}.jpg`);
    try {
      return { data: await fs.promises.readFile(cacheFile), mime: 'image/jpeg' };
    } catch (e) { /* キャッシュなし */ }

    let buf = null;
    try { buf = await makeThumb(filePath, px); } catch (e) { buf = null; }

    if (buf && buf.length > 0) {
      try {
        await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true });
        const tmp = `${cacheFile}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, buf);
        await fs.promises.rename(tmp, cacheFile);
      } catch (e) { /* キャッシュに書けなくても表示はできる */ }
      return { data: buf, mime: 'image/jpeg' };
    }

    // 縮小できない形式は、元の画像をそのまま返す（表示はされるが軽くはならない）
    return { data: await fs.promises.readFile(filePath), mime: mimeFor(filePath) };
  }

  async function getThumbnail(filePath) {
    const st = await fs.promises.stat(filePath);
    const key = cacheKey(filePath, st.mtimeMs, st.size, px);
    if (inflight.has(key)) return inflight.get(key);
    const p = limit(() => produce(filePath, st, key)).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return { getThumbnail };
}

module.exports = { createThumbService, cacheKey, mimeFor, createLimiter };
