'use strict';

/**
 * RAW写真の横に置く XMP サイドカー（.xmp）へ、星評価(xmp:Rating)を書き出す。
 * Lightroom Classic は、このファイルの評価を「ファイルからメタデータを読み込む」で取り込める。
 * RAW本体は一切変更しない。既存の .xmp がある場合は、評価の1項目だけを書き換え、ほかは残す。
 */

const fs = require('fs');
const path = require('path');

const RAW_EXTS = ['.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.raf', '.orf', '.rw2', '.pef', '.dng', '.srw', '.3fr', '.iiq', '.erf', '.mrw', '.x3f'];
const NS_XMP = 'http://ns.adobe.com/xap/1.0/';

function newXmp(rating) {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Pro Color Photo Inspector">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="${NS_XMP}"
   xmp:Rating="${rating}"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}

// 既存の XMP の文章で、評価だけを書き換える（ほかの内容は変えない）
function setRating(xml, rating) {
  const r = String(Math.max(-1, Math.min(5, Math.round(Number(rating) || 0))));
  if (/xmp:Rating\s*=\s*"-?\d+"/.test(xml)) return xml.replace(/xmp:Rating\s*=\s*"-?\d+"/, `xmp:Rating="${r}"`);
  if (/<xmp:Rating>\s*-?\d+\s*<\/xmp:Rating>/.test(xml)) return xml.replace(/<xmp:Rating>\s*-?\d+\s*<\/xmp:Rating>/, `<xmp:Rating>${r}</xmp:Rating>`);
  const m = /<rdf:Description\b[^>]*?(\/?)>/.exec(xml);
  if (!m) return newXmp(r);   // 読める形ではない → 新しく作る（呼び出し側で元ファイルは .bak に残す）
  let tag = m[0];
  const selfClose = m[1] === '/';
  let head = tag.slice(0, tag.length - (selfClose ? 2 : 1));
  if (!/xmlns:xmp\s*=/.test(head)) head += ` xmlns:xmp="${NS_XMP}"`;
  head += ` xmp:Rating="${r}"`;
  return xml.slice(0, m.index) + head + (selfClose ? '/>' : '>') + xml.slice(m.index + tag.length);
}

function isRawName(name) {
  return RAW_EXTS.includes(path.extname(name).toLowerCase());
}

// JPEG(items: [{name, rating}]) と、RAWフォルダ内の同名ファイルを対応づける
function planSync(rawDir, items, opts = {}) {
  const byBase = new Map();
  for (const e of fs.readdirSync(rawDir, { withFileTypes: true })) {
    if (!e.isFile() || e.name.startsWith('._') || !isRawName(e.name)) continue;
    const key = path.basename(e.name, path.extname(e.name)).toLowerCase();
    if (!byBase.has(key)) byBase.set(key, []);
    byBase.get(key).push(e.name);
  }
  const plan = { matches: [], missing: [], ambiguous: [], skippedZero: 0, noXmp: [] };
  for (const it of items) {
    const base = path.basename(String(it.name), path.extname(String(it.name)));
    const rating = Math.max(0, Math.min(5, Math.round(Number(it.rating) || 0)));
    if (rating === 0 && !opts.writeZero) { plan.skippedZero++; continue; }
    const hits = byBase.get(base.toLowerCase());
    if (!hits) { plan.missing.push(it.name); continue; }
    if (hits.length > 1) { plan.ambiguous.push({ name: it.name, raws: hits.slice() }); continue; }
    const raw = hits[0];
    const xmpName = path.basename(raw, path.extname(raw)) + '.xmp';
    const hasXmp = fs.existsSync(path.join(rawDir, xmpName));
    // .xmp がまだないRAWに新しく作ると、Lightroomで読み込んだとき現像設定が初期化される恐れがある。初期設定では作らない
    if (!hasXmp && !opts.createNew) { plan.noXmp.push(it.name); continue; }
    plan.matches.push({ name: it.name, raw, xmpName, rating, hasXmp });
  }
  return plan;
}

function writeOne(rawDir, m) {
  const file = path.join(rawDir, m.xmpName);
  let out;
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file, 'utf8');
    const bak = file + '.bak';
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, old, 'utf8');   // 最初の1回だけ、元の状態を残す
    out = setRating(old, m.rating);
  } else {
    out = newXmp(m.rating);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out, 'utf8');
  fs.renameSync(tmp, file);
}

function applySync(rawDir, matches) {
  const res = { written: 0, created: 0, updated: 0, failed: [] };
  for (const m of matches) {
    try {
      const existed = fs.existsSync(path.join(rawDir, m.xmpName));
      writeOne(rawDir, m);
      res.written++;
      if (existed) res.updated++; else res.created++;
    } catch (e) {
      res.failed.push({ name: m.name, reason: e && e.message ? e.message : String(e) });
    }
  }
  return res;
}

module.exports = { RAW_EXTS, newXmp, setRating, planSync, applySync, isRawName };
