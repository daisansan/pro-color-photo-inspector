'use strict';

/**
 * 星評価・Pick/Reject の保存と復元。
 * アプリのデータフォルダ内に「フォルダごとに1ファイル」で保存します。
 * 写真のあるフォルダには何も書き込みません。
 *   <baseDir>/<フォルダパスのハッシュ>.json
 *   { "folder": "C:\\Photos\\2026", "savedAt": "...", "items": { "IMG_0001.JPG": { "rating": 3, "flag": "pick" } } }
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function normalizeFolder(folder, platform = process.platform) {
  const resolved = path.resolve(String(folder));
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function fileFor(baseDir, folder, platform = process.platform) {
  const key = crypto.createHash('sha1').update(normalizeFolder(folder, platform)).digest('hex');
  return path.join(baseDir, `${key}.json`);
}

// 保存するデータを安全な形に整える（評価0かつフラグなしは保存しない）
function sanitizeItems(items) {
  const clean = {};
  if (!items || typeof items !== 'object') return clean;
  for (const [name, meta] of Object.entries(items)) {
    if (typeof name !== 'string' || !name || !meta || typeof meta !== 'object') continue;
    let rating = Number.isInteger(meta.rating) ? meta.rating : 0;
    rating = Math.max(0, Math.min(5, rating));
    const flag = meta.flag === 'pick' || meta.flag === 'reject' ? meta.flag : null;
    if (rating === 0 && flag === null) continue;
    clean[name] = { rating, flag };
  }
  return clean;
}

function loadSelections(baseDir, folder, platform = process.platform) {
  try {
    const raw = fs.readFileSync(fileFor(baseDir, folder, platform), 'utf8');
    const data = JSON.parse(raw);
    return sanitizeItems(data && data.items);
  } catch (e) {
    return {};
  }
}

// 同期で書く（アプリを閉じる直前の保存でも取りこぼさないため。ファイルは小さい）
function saveSelections(baseDir, folder, items, platform = process.platform) {
  const file = fileFor(baseDir, folder, platform);
  const clean = sanitizeItems(items);

  if (Object.keys(clean).length === 0) {
    try { fs.unlinkSync(file); } catch (e) { /* なければ何もしない */ }
    return { saved: 0 };
  }

  fs.mkdirSync(baseDir, { recursive: true });
  const body = JSON.stringify({ folder: path.resolve(String(folder)), savedAt: new Date().toISOString(), items: clean }, null, 1);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file); // 書きかけのファイルが残らないよう、書いてから置き換える
  return { saved: Object.keys(clean).length };
}

module.exports = { loadSelections, saveSelections, sanitizeItems, fileFor, normalizeFolder };
