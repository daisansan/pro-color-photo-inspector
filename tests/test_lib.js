'use strict';
// lib/ 配下(フォルダ閲覧・選別結果の保存・サムネイル・設定)のテスト
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fsb = require('../lib/fsbrowse');
const sel = require('../lib/selections');
const { createThumbService, cacheKey, mimeFor } = require('../lib/thumbs');
const { loadSettings, saveSettings } = require('../lib/settings');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pci-test-'));
  const w = (rel, data = 'x') => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };

  // ---------- fsbrowse
  w('photos/IMG_10.jpg', 'a'); w('photos/IMG_2.JPG', 'bb'); w('photos/IMG_1.png', 'c'); w('photos/note.txt', 'n'); w('photos/._IMG_1.jpg', 'junk');
  w('photos/sub/b/x.webp', 'w'); w('photos/sub/a/y.jpg', 'y'); w('photos/$RECYCLE.BIN/z.jpg', 'z');
  fs.mkdirSync(path.join(root, 'photos/empty'));

  const li = await fsb.listImages(path.join(root, 'photos'));
  assert.strictEqual(li.error, null);
  assert.deepStrictEqual(li.files.map((f) => f.name), ['IMG_1.png', 'IMG_2.JPG', 'IMG_10.jpg'], '自然順・画像のみ・._ は除外');
  assert.strictEqual(li.files[1].size, 2);
  assert.ok(li.files[0].mtimeMs > 0 && li.files[0].dir === path.join(root, 'photos') && path.isAbsolute(li.files[0].path));

  const ld = await fsb.listDir(path.join(root, 'photos'));
  assert.deepStrictEqual(ld.folders.map((f) => f.name), ['empty', 'sub'], '$始まりのシステムフォルダは除外');
  const cnt = await fsb.countImages([path.join(root, 'photos'), path.join(root, 'photos/sub/a'), path.join(root, 'photos/empty'), path.join(root, 'nonexistent')]);
  assert.deepStrictEqual(Object.values(cnt), [3, 1, 0, -1]);
  assert.strictEqual((await fsb.listDir('relative/path')).error, 'EINVAL');
  assert.strictEqual((await fsb.listDir(path.join(root, 'nonexistent'))).error, 'ENOENT');
  assert.strictEqual((await fsb.listImages(path.join(root, 'nonexistent'))).error, 'ENOENT');
  assert.deepStrictEqual(fsb.ancestorsOf('/a/b/c'), ['/', '/a', '/a/b', '/a/b/c']);
  assert.deepStrictEqual(fsb.ancestorsOf('C:\\a\\b', path.win32), ['C:\\', 'C:\\a', 'C:\\a\\b']);
  assert.deepStrictEqual(fsb.ancestorsOf('relative'), []);
  assert.deepStrictEqual(await fsb.listDrives('linux'), [{ name: '/', path: '/' }]);

  // ---------- selections
  const sdir = path.join(root, 'sel');
  const folderA = path.join(root, 'photos');
  assert.deepStrictEqual(sel.loadSelections(sdir, folderA), {}, '未保存は空');
  let r = sel.saveSelections(sdir, folderA, {
    'IMG_1.png': { rating: 3, flag: 'pick' }, 'IMG_2.JPG': { rating: 0, flag: null }, 'IMG_10.jpg': { rating: 9, flag: 'bogus' }, '': { rating: 1 }, bad: 5,
  });
  assert.strictEqual(r.saved, 2, '評価0かつフラグなしは保存しない');
  assert.deepStrictEqual(sel.loadSelections(sdir, folderA), { 'IMG_1.png': { rating: 3, flag: 'pick' }, 'IMG_10.jpg': { rating: 5, flag: null } }, '評価は0-5に丸め、不正なフラグはnull');
  assert.deepStrictEqual(sel.loadSelections(sdir, path.join(root, 'photos', 'sub')), {}, '別フォルダとは混ざらない');
  assert.strictEqual(sel.fileFor(sdir, 'C:\\Photos\\A', 'win32'), sel.fileFor(sdir, 'c:\\photos\\a', 'win32'), 'Windowsは大文字小文字を区別しない');
  assert.ok(fs.readdirSync(sdir).every((f) => f.endsWith('.json')), '一時ファイルが残らない');
  r = sel.saveSelections(sdir, folderA, { 'C1.jpg': { rating: 0, flag: null, choice: true }, 'C2.jpg': { rating: 2, flag: 'pick', choice: true }, 'N.jpg': { rating: 1, flag: null, choice: 'yes' } });
  assert.strictEqual(r.saved, 3, 'Cだけでも保存する');
  assert.deepStrictEqual(sel.loadSelections(sdir, folderA), { 'C1.jpg': { rating: 0, flag: null, choice: true }, 'C2.jpg': { rating: 2, flag: 'pick', choice: true }, 'N.jpg': { rating: 1, flag: null } }, 'Cは真偽値trueのときだけ');
  r = sel.saveSelections(sdir, folderA, {});
  assert.strictEqual(r.saved, 0); assert.deepStrictEqual(sel.loadSelections(sdir, folderA), {}); assert.strictEqual(fs.readdirSync(sdir).length, 0, '空にしたらファイルも消える');
  fs.writeFileSync(sel.fileFor(sdir, folderA), '{壊れたJSON'); assert.deepStrictEqual(sel.loadSelections(sdir, folderA), {}, '壊れたファイルでも落ちない');

  // ---------- settings
  const setDir = path.join(root, 'settings');
  assert.deepStrictEqual(loadSettings(setDir), { monitorProfilePath: null, lastFolder: null });
  saveSettings(setDir, { monitorProfilePath: 'C:\\x.icc' });
  assert.strictEqual(loadSettings(setDir).monitorProfilePath, 'C:\\x.icc');
  fs.writeFileSync(path.join(setDir, 'settings.json'), 'null'); assert.deepStrictEqual(loadSettings(setDir), { monitorProfilePath: null, lastFolder: null });

  // ---------- thumbs
  let made = 0;
  const cacheDir = path.join(root, 'thumbcache');
  const svc = createThumbService({ cacheDir, px: 256, concurrency: 2, makeThumb: async (p) => { made++; await new Promise((r2) => setTimeout(r2, 20)); return p.endsWith('IMG_1.png') ? null : Buffer.from('JPEGDATA'); } });
  const a = path.join(root, 'photos/IMG_10.jpg');
  const [t1, t2, t3] = await Promise.all([svc.getThumbnail(a), svc.getThumbnail(a), svc.getThumbnail(a)]);
  assert.strictEqual(made, 1, '同じ画像の同時要求は1回だけ作る');
  assert.strictEqual(t1.mime, 'image/jpeg'); assert.strictEqual(t1.data.toString(), 'JPEGDATA'); assert.strictEqual(t2.data.toString(), 'JPEGDATA'); assert.ok(t3);
  await svc.getThumbnail(a); assert.strictEqual(made, 1, 'キャッシュから返す');
  const svc2 = createThumbService({ cacheDir, px: 256, makeThumb: async () => { throw new Error('呼ばれないはず'); } });
  assert.strictEqual((await svc2.getThumbnail(a)).data.toString(), 'JPEGDATA', 'アプリを再起動してもキャッシュが残る');
  const png = await svc.getThumbnail(path.join(root, 'photos/IMG_1.png'));
  assert.strictEqual(png.mime, 'image/png'); assert.strictEqual(png.data.toString(), 'c', '縮小できない形式は元画像を返す');
  fs.utimesSync(a, new Date(), new Date(Date.now() + 5000)); await svc.getThumbnail(a); assert.strictEqual(made, 3, '更新日時が変わったら作り直す');
  await assert.rejects(() => svc.getThumbnail(path.join(root, 'missing.jpg')));
  assert.notStrictEqual(cacheKey('a', 1, 1, 256), cacheKey('a', 1, 1, 512));
  assert.strictEqual(mimeFor('X.JPEG'), 'image/jpeg');

  // 同時実行数の上限
  let active = 0, peak = 0;
  const svc3 = createThumbService({ cacheDir: path.join(root, 'tc3'), px: 64, concurrency: 3, makeThumb: async () => { active++; peak = Math.max(peak, active); await new Promise((r2) => setTimeout(r2, 15)); active--; return Buffer.from('T'); } });
  const many = []; for (let i = 0; i < 12; i++) many.push(w(`many/${i}.jpg`, String(i)));
  await Promise.all(many.map((p) => svc3.getThumbnail(p)));
  assert.ok(peak <= 3, `同時実行が上限(3)を超えた: ${peak}`);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('LIB TESTS PASSED');
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

// ---- imginfo（画像の大きさと向き）
(async () => {
  const { parseImageInfo, applyOrientation } = require('../lib/imginfo');
  const assert2 = require('assert');
  // PNG 3x2
  const png = Buffer.alloc(33); png.write('\x89PNG\r\n\x1a\n', 0, 'latin1'); png.writeUInt32BE(3, 16); png.writeUInt32BE(2, 20);
  const pi = parseImageInfo(png); assert2.strictEqual(pi.width, 3); assert2.strictEqual(pi.height, 2);
  // JPEG: SOI + APP1(Exif, orientation 6) + SOF0 (幅400 高さ300)
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('MM\0*\0\0\0\x08', 'latin1'),
    Buffer.from([0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0])]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, exif.length + 2]), exif]);
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, 0x01, 0x2c, 0x01, 0x90, 1, 1, 0x11, 0]);
  const jp = parseImageInfo(Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof]));
  assert2.deepStrictEqual([jp.width, jp.height, jp.orientation], [400, 300, 6]);
  // 回転: 2x1 [A B] を向き6(右に90度)にすると 1x2 で上がA 下がB
  const src = Buffer.from([1, 1, 1, 1, 2, 2, 2, 2]);
  const r6 = applyOrientation(src, 2, 1, 6);
  assert2.deepStrictEqual([r6.width, r6.height, r6.data[0], r6.data[4]], [1, 2, 1, 2]);
  const r8 = applyOrientation(src, 2, 1, 8);
  assert2.deepStrictEqual([r8.width, r8.height, r8.data[0], r8.data[4]], [1, 2, 2, 1]);
  console.log('IMGINFO TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });

// ---- F10: 写真1枚を choice へコピー
(async () => {
  const { copyOneToChoice } = require('../lib/export');
  const os = require('os'); const fs2 = require('fs'); const path2 = require('path');
  const d = fs2.mkdtempSync(path2.join(os.tmpdir(), 'choice-'));
  fs2.writeFileSync(path2.join(d, 'a.jpg'), 'AAA');
  const r1 = await copyOneToChoice(path2.join(d, 'a.jpg'), 'choice');
  assert.strictEqual(r1.status, 'copied');
  assert.strictEqual(fs2.readFileSync(path2.join(d, 'choice', 'a.jpg'), 'utf8'), 'AAA');
  assert.ok(fs2.existsSync(path2.join(d, 'a.jpg')), '元の写真は残る');
  fs2.writeFileSync(path2.join(d, 'choice', 'a.jpg'), 'KEEP');
  const r2 = await copyOneToChoice(path2.join(d, 'a.jpg'), 'choice');
  assert.strictEqual(r2.status, 'exists');
  assert.strictEqual(fs2.readFileSync(path2.join(d, 'choice', 'a.jpg'), 'utf8'), 'KEEP', '上書きしない');
  // 絞り込みの繰り返し: choice の中の写真 → choice/choice
  const r3 = await copyOneToChoice(path2.join(d, 'choice', 'a.jpg'), 'choice');
  assert.strictEqual(r3.status, 'copied');
  assert.ok(fs2.existsSync(path2.join(d, 'choice', 'choice', 'a.jpg')));
  await assert.rejects(() => copyOneToChoice(path2.join(d, 'x.txt'), 'choice'));
  await assert.rejects(() => copyOneToChoice('relative.jpg', 'choice'));
  // PNG → JPEG変換（変換器を渡したときだけ）
  const conv = async (src) => Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  fs2.writeFileSync(path2.join(d, 'p.png'), 'PNGDATA');
  fs2.writeFileSync(path2.join(d, 'q.jpg'), 'JPGDATA');
  const rp = await copyOneToChoice(path2.join(d, 'p.png'), 'choice', { jpegConverter: conv });
  assert.strictEqual(rp.status, 'copied');
  assert.ok(fs2.existsSync(path2.join(d, 'choice', 'p.jpg')) && !fs2.existsSync(path2.join(d, 'choice', 'p.png')), 'PNGはJPEGとして保存');
  assert.strictEqual((await copyOneToChoice(path2.join(d, 'p.png'), 'choice', { jpegConverter: conv })).status, 'exists');
  await copyOneToChoice(path2.join(d, 'q.jpg'), 'choice', { jpegConverter: conv });
  assert.strictEqual(fs2.readFileSync(path2.join(d, 'choice', 'q.jpg'), 'utf8'), 'JPGDATA', 'JPEGはそのままコピー');
  await copyOneToChoice(path2.join(d, 'p.png'), 'choice');
  assert.ok(fs2.existsSync(path2.join(d, 'choice', 'p.png')), '変換器なしなら従来どおりコピー');
  const { copyPickedFiles } = require('../lib/export');
  const dest = fs2.mkdtempSync(path2.join(os.tmpdir(), 'exp-'));
  const rr = await copyPickedFiles([path2.join(d, 'p.png'), path2.join(d, 'q.jpg')], dest, 'out', { jpegConverter: conv });
  assert.strictEqual(rr.copied, 2);
  assert.deepStrictEqual(fs2.readdirSync(path2.join(dest, 'out')).sort(), ['p.jpg', 'q.jpg']);
  const rr2 = await copyPickedFiles([path2.join(d, 'p.png')], dest, 'out', { jpegConverter: conv });
  assert.ok(fs2.existsSync(path2.join(dest, 'out', 'p (2).jpg')), '同名は連番');
  console.log('CHOICE TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
