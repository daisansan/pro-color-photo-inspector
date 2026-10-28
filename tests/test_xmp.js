'use strict';
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const X = require('../lib/xmp');
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xmp-'));
for (const n of ['IMG_0001.CR2', 'img_0002.cr2', 'IMG_0003.CR2', 'IMG_0003.DNG', 'IMG_0005.CR2', 'note.txt']) fs.writeFileSync(path.join(d, n), 'x');
// 既存xmp（現像設定入り）
const existing = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+0.50" crs:Temperature="5500"/></rdf:RDF></x:xmpmeta>`;
fs.writeFileSync(path.join(d, 'IMG_0005.xmp'), existing);
const items = [{ name: 'IMG_0001.jpg', rating: 3 }, { name: 'IMG_0002.JPG', rating: 5 }, { name: 'IMG_0003.jpg', rating: 2 }, { name: 'IMG_0004.jpg', rating: 4 }, { name: 'IMG_0005.jpg', rating: 1 }, { name: 'IMG_0006.jpg', rating: 0 }];
const plan = X.planSync(d, items, { createNew: true });
assert.strictEqual(plan.matches.length, 3);
assert.deepStrictEqual(plan.missing, ['IMG_0004.jpg']);
assert.strictEqual(plan.ambiguous.length, 1);
assert.strictEqual(plan.skippedZero, 1);
assert.strictEqual(plan.matches.find((m) => m.name === 'IMG_0005.jpg').hasXmp, true);
assert.strictEqual(plan.matches.find((m) => m.name === 'IMG_0002.JPG').xmpName, 'img_0002.xmp');
const r = X.applySync(d, plan.matches);
assert.strictEqual(r.written, 3); assert.strictEqual(r.created, 2); assert.strictEqual(r.updated, 1);
assert.ok(/xmp:Rating="3"/.test(fs.readFileSync(path.join(d, 'IMG_0001.xmp'), 'utf8')));
const u = fs.readFileSync(path.join(d, 'IMG_0005.xmp'), 'utf8');
assert.ok(/xmp:Rating="1"/.test(u) && u.includes('crs:Exposure2012="+0.50"') && u.includes('crs:Temperature="5500"') && /xmlns:xmp=/.test(u));
assert.strictEqual(fs.readFileSync(path.join(d, 'IMG_0005.xmp.bak'), 'utf8'), existing);
// 再実行: 評価の書き換え、バックアップは最初のまま
X.applySync(d, [{ ...plan.matches.find((m) => m.name === 'IMG_0005.jpg'), rating: 4 }]);
assert.ok(/xmp:Rating="4"/.test(fs.readFileSync(path.join(d, 'IMG_0005.xmp'), 'utf8')));
assert.strictEqual(fs.readFileSync(path.join(d, 'IMG_0005.xmp.bak'), 'utf8'), existing);
assert.strictEqual((fs.readFileSync(path.join(d, 'IMG_0005.xmp'), 'utf8').match(/xmp:Rating/g) || []).length, 1);
// 要素形式
assert.strictEqual(X.setRating('<a><xmp:Rating>2</xmp:Rating></a>', 5), '<a><xmp:Rating>5</xmp:Rating></a>');
// 0も書く
assert.strictEqual(X.planSync(d, items, { writeZero: true, createNew: true }).skippedZero, 0);
fs.rmSync(d, { recursive: true, force: true });
console.log('XMP TESTS PASSED');
// 新規作成は、指定したときだけ
{
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xmp2-'));
  fs.writeFileSync(path.join(d2, 'A.CR2'), 'x'); fs.writeFileSync(path.join(d2, 'B.CR2'), 'x'); fs.writeFileSync(path.join(d2, 'B.xmp'), existing);
  const it = [{ name: 'A.jpg', rating: 2 }, { name: 'B.jpg', rating: 3 }];
  const p1 = X.planSync(d2, it);
  assert.deepStrictEqual(p1.matches.map((m) => m.name), ['B.jpg']); assert.deepStrictEqual(p1.noXmp, ['A.jpg']);
  const p2 = X.planSync(d2, it, { createNew: true });
  assert.strictEqual(p2.matches.length, 2); assert.strictEqual(p2.noXmp.length, 0);
  X.applySync(d2, p1.matches); assert.ok(!fs.existsSync(path.join(d2, 'A.xmp')));
  fs.rmSync(d2, { recursive: true, force: true });
  console.log('XMP createNew OK');
}
