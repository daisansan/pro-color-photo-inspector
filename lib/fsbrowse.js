'use strict';

const fs = require('fs');
const path = require('path');

// アプリで表示・選別できる画像の拡張子（元のブラウザ版と同じ）
const VIEW_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function isViewableImage(name) {
  return VIEW_EXTS.has(path.extname(String(name)).toLowerCase());
}

// ツリーに出さないフォルダ（システム用）
function isHiddenSystemFolder(name) {
  return name.startsWith('$') || name === 'System Volume Information' || name === 'Config.Msi';
}

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// 一定時間で諦める（応答のないネットワークドライブ対策）
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(fallback); }
    );
  });
}

// 同時実行数を制限して全件処理する
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * このPCのドライブ一覧。Windowsは A: ～ Z: のうち存在するもの。
 * それ以外のOSではルート("/")だけ返す。
 */
async function listDrives(platform = process.platform) {
  if (platform !== 'win32') return [{ name: '/', path: '/' }];

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(
    letters.map(async (l) => {
      const root = `${l}:\\`;
      const ok = await withTimeout(fs.promises.stat(root).then(() => true), 2500, false);
      return ok ? { name: `${l}:`, path: root } : null;
    })
  );
  return found.filter(Boolean);
}

/** 指定フォルダの直下にあるサブフォルダ一覧（読み取れない場合は error にコードを入れる） */
async function listDir(dirPath) {
  if (typeof dirPath !== 'string' || !path.isAbsolute(dirPath)) {
    return { path: String(dirPath), folders: [], error: 'EINVAL' };
  }
  let entries;
  try {
    // 応答のないネットワークドライブなどで固まらないよう、時間で打ち切る
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 8000); });
    try {
      // 失敗(権限なし等)はそのまま例外として受け取り、時間切れだけ null で区別する
      entries = await Promise.race([fs.promises.readdir(dirPath, { withFileTypes: true }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { path: dirPath, folders: [], error: (e && e.code) || 'EUNKNOWN' };
  }
  if (entries === null) return { path: dirPath, folders: [], error: 'ETIMEDOUT' };
  const folders = entries
    // シンボリックリンク/ジャンクションはたどらない（無限ループや権限エラーの回避）
    .filter((e) => e.isDirectory() && !isHiddenSystemFolder(e.name))
    .map((e) => ({ name: e.name, path: path.join(dirPath, e.name) }))
    .sort((a, b) => naturalCompare(a.name, b.name));
  return { path: dirPath, folders, error: null };
}

/** 各フォルダ直下の画像枚数を数える。数えられなかった場合は -1。 */
async function countImages(dirPaths) {
  const list = Array.isArray(dirPaths) ? dirPaths.filter((p) => typeof p === 'string') : [];
  const counts = await mapLimit(list, 8, (p) =>
    withTimeout(
      fs.promises
        .readdir(p, { withFileTypes: true })
        .then((es) => es.filter((e) => e.isFile() && isViewableImage(e.name) && !e.name.startsWith('._')).length),
      4000,
      -1
    )
  );
  const out = {};
  list.forEach((p, i) => { out[p] = counts[i]; });
  return out;
}

/** フォルダ直下の画像ファイル一覧（名前・サイズ・更新日時つき） */
async function listImages(dirPath) {
  if (typeof dirPath !== 'string' || !path.isAbsolute(dirPath)) {
    return { path: String(dirPath), files: [], error: 'EINVAL' };
  }
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (e) {
    return { path: dirPath, files: [], error: (e && e.code) || 'EUNKNOWN' };
  }
  const names = entries
    .filter((e) => e.isFile() && isViewableImage(e.name) && !e.name.startsWith('._'))
    .map((e) => e.name);

  const stats = await mapLimit(names, 32, async (name) => {
    const full = path.join(dirPath, name);
    try {
      const st = await fs.promises.stat(full);
      return { name, path: full, dir: dirPath, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    } catch (e) {
      return null;
    }
  });
  const files = stats.filter(Boolean).sort((a, b) => naturalCompare(a.name, b.name));
  return { path: dirPath, files, error: null };
}

/** 「C:\a\b」→ ["C:\", "C:\a", "C:\a\b"]（ツリーを目的のフォルダまで開くために使う） */
function ancestorsOf(p, pathLib = path) {
  if (typeof p !== 'string' || !pathLib.isAbsolute(p)) return [];
  const out = [];
  let cur = pathLib.resolve(p);
  for (let i = 0; i < 256; i++) {
    out.push(cur);
    const parent = pathLib.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out.reverse();
}

module.exports = {
  VIEW_EXTS,
  isViewableImage,
  listDrives,
  listDir,
  countImages,
  listImages,
  ancestorsOf,
  mapLimit,
  withTimeout,
};
