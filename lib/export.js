'use strict';

const fs = require('fs');
const path = require('path');

// 書き出しの対象にする画像の拡張子
const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.tif', '.tiff', '.heic', '.heif',
]);

/**
 * Windowsのフォルダ名として使える形に整える。
 * 使えない文字は「_」に置き換え、空になった場合は「choice」にする。
 */
function sanitizeFolderName(name) {
  let s = String(name == null ? '' : name)
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim();
  s = s.replace(/[. ]+$/, ''); // Windowsでは末尾のドットと空白が使えない
  if (!s || s === '.' || s === '..') s = 'choice';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = '_' + s; // 予約名
  return s.slice(0, 80);
}

/**
 * 選んだ写真を「保存先/サブフォルダ名」へコピーする。
 * - 元ファイルは変更しない（コピーのみ）
 * - 同名ファイルがあれば上書きせず「名前 (2).jpg」のように連番を付ける
 * - 1枚失敗しても残りは続行し、失敗分を返す
 */
async function copyPickedFiles(filePaths, destParent, subFolderName) {
  const destDir = path.join(destParent, sanitizeFolderName(subFolderName));
  await fs.promises.mkdir(destDir, { recursive: true });

  let copied = 0;
  const failed = [];

  for (const src of filePaths) {
    const name = typeof src === 'string' ? path.basename(src) : String(src);
    try {
      if (typeof src !== 'string' || !path.isAbsolute(src)) throw new Error('ファイルの場所が不正です');
      if (!IMAGE_EXTS.has(path.extname(src).toLowerCase())) throw new Error('画像ファイルではありません');

      const stat = await fs.promises.stat(src);
      if (!stat.isFile()) throw new Error('ファイルではありません');

      const ext = path.extname(name);
      const base = path.basename(name, ext);
      let target = path.join(destDir, name);

      // 書き出し先と元の場所が同じなら、すでにそこにあるので何もしない
      if (path.resolve(src).toLowerCase() === path.resolve(target).toLowerCase()) {
        copied++;
        continue;
      }

      for (let n = 2; ; n++) {
        try {
          await fs.promises.copyFile(src, target, fs.constants.COPYFILE_EXCL);
          break;
        } catch (e) {
          if (e && e.code === 'EEXIST' && n < 10000) {
            target = path.join(destDir, `${base} (${n})${ext}`);
            continue;
          }
          throw e;
        }
      }
      copied++;
    } catch (e) {
      failed.push({ name, reason: e && e.message ? e.message : String(e) });
    }
  }

  return { dir: destDir, copied, failed };
}

module.exports = { copyPickedFiles, sanitizeFolderName, IMAGE_EXTS };
