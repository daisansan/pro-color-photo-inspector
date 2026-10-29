'use strict';

const fs = require('fs');
const path = require('path');

// 書き出しの対象にする画像の拡張子
const { CONVERT_EXTS } = require('./convert');
const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.tif', '.tiff', '.heic', '.heif',
  ...CONVERT_EXTS,
]);

function isPng(file) {
  return path.extname(String(file)).toLowerCase() === '.png';
}

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
async function copyPickedFiles(filePaths, destParent, subFolderName, opts = {}) {
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

      // PNGは、JPEG(最高画質)に変換して書き出す（変換できる仕組みが渡されたときだけ）
      const asJpeg = isPng(src) && typeof opts.jpegConverter === 'function';
      const outName = asJpeg ? path.basename(name, path.extname(name)) + '.jpg' : name;
      const ext = path.extname(outName);
      const base = path.basename(outName, ext);
      let target = path.join(destDir, outName);
      const jpegData = asJpeg ? await opts.jpegConverter(src) : null;

      // 書き出し先と元の場所が同じなら、すでにそこにあるので何もしない
      if (path.resolve(src).toLowerCase() === path.resolve(target).toLowerCase()) {
        copied++;
        continue;
      }

      for (let n = 2; ; n++) {
        try {
          if (jpegData) await fs.promises.writeFile(target, jpegData, { flag: 'wx' });
          else await fs.promises.copyFile(src, target, fs.constants.COPYFILE_EXCL);
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

/**
 * 写真1枚を、その写真のあるフォルダの下の「choice」フォルダへコピーする（なければ作る）。
 * 同じ名前のファイルがすでにあれば上書きせず、'exists' を返す。
 */
async function copyOneToChoice(src, folderName, opts = {}) {
  if (typeof src !== 'string' || !path.isAbsolute(src)) throw new Error('ファイルの場所が不正です');
  if (!IMAGE_EXTS.has(path.extname(src).toLowerCase())) throw new Error('画像ファイルではありません');
  const stat = await fs.promises.stat(src);
  if (!stat.isFile()) throw new Error('ファイルではありません');

  const destDir = path.join(path.dirname(src), sanitizeFolderName(folderName || 'choice'));
  await fs.promises.mkdir(destDir, { recursive: true });
  // PNGは、JPEG(最高画質)に変換して保存する
  const asJpeg = isPng(src) && typeof opts.jpegConverter === 'function';
  const target = path.join(destDir, asJpeg ? path.basename(src, path.extname(src)) + '.jpg' : path.basename(src));
  try {
    if (asJpeg) {
      // 同じ名前があれば、変換する前に分かるようにする
      if (fs.existsSync(target)) return { status: 'exists', dir: destDir };
      await fs.promises.writeFile(target, await opts.jpegConverter(src), { flag: 'wx' });
    } else {
      await fs.promises.copyFile(src, target, fs.constants.COPYFILE_EXCL);
    }
  } catch (e) {
    if (e && e.code === 'EEXIST') return { status: 'exists', dir: destDir };
    throw e;
  }
  return { status: 'copied', dir: destDir };
}

module.exports = { copyPickedFiles, copyOneToChoice, sanitizeFolderName, IMAGE_EXTS };
