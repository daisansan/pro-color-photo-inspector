'use strict';
// exe のアイコン(カメラ)を差し替えます。 使い方: node patch-icon.js <exeのパス>
// 4つのアイコン画像(16/32/48/256px)を、元より小さいデータで上書きするだけなので、ファイルの大きさは変わりません。
const fs = require('fs');
const path = require('path');

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) { console.error('exeが見つかりません: ' + exe); process.exit(2); }
const res = JSON.parse(fs.readFileSync(path.join(__dirname, 'iconres.json'), 'utf8'));
const fd = fs.openSync(exe, 'r+');
const rd = (pos, len) => { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); if (n !== len) throw new Error('読み込み失敗'); return b; };

try {
  const dos = rd(0, 64);
  if (dos.readUInt16LE(0) !== 0x5a4d) throw new Error('exeではありません');
  const pe = dos.readUInt32LE(0x3c);
  const nt = rd(pe, 24 + 240);
  if (nt.readUInt32LE(0) !== 0x4550) throw new Error('PE形式ではありません');
  const nsec = nt.readUInt16LE(6), optSz = nt.readUInt16LE(20), magic = nt.readUInt16LE(24);
  const ddOff = 24 + (magic === 0x20b ? 112 : 96);
  const rsrcRva = nt.readUInt32LE(ddOff + 16);
  if (!rsrcRva) throw new Error('リソースがありません');
  const secs = [];
  const st = rd(pe + 24 + optSz, nsec * 40);
  for (let i = 0; i < nsec; i++) secs.push({ va: st.readUInt32LE(i * 40 + 12), vs: st.readUInt32LE(i * 40 + 8), rp: st.readUInt32LE(i * 40 + 20), rs: st.readUInt32LE(i * 40 + 16) });
  const r2o = (r) => { for (const s of secs) if (r >= s.va && r < s.va + Math.max(s.vs, s.rs)) return r - s.va + s.rp; throw new Error('RVA変換失敗'); };
  const base = r2o(rsrcRva);

  const found = []; // {type,id,entryOff,dataOff,size}
  const walk = (off, level, p) => {
    const dir = rd(off, 16);
    const n = dir.readUInt16LE(12) + dir.readUInt16LE(14);
    const ents = rd(off + 16, n * 8);
    for (let i = 0; i < n; i++) {
      const id = ents.readUInt32LE(i * 8), o = ents.readUInt32LE(i * 8 + 4);
      if (o & 0x80000000) {
        if (level === 0 && id !== 3 && id !== 14) continue;
        walk(base + (o & 0x7fffffff), level + 1, p.concat([id & 0x7fffffff]));
      } else {
        const e = rd(base + o, 16);
        found.push({ type: p[0], id: p[1], entryOff: base + o, dataOff: r2o(e.readUInt32LE(0)), size: e.readUInt32LE(4) });
      }
    }
  };
  walk(base, 0, []);

  const icons = found.filter((f) => f.type === 3);
  const groups = found.filter((f) => f.type === 14);
  if (!groups.length) throw new Error('アイコンのグループが見つかりません');
  const grp = groups[0];
  const gb = rd(grp.dataOff, grp.size);
  const cnt = gb.readUInt16LE(4);
  const plan = [];
  for (let i = 0; i < cnt; i++) {
    const w = gb[6 + i * 14] || 256;
    const idn = gb.readUInt16LE(6 + i * 14 + 12);
    const key = ({ 16: '1', 32: '2', 48: '3', 256: '4' })[w];
    if (!key) continue;
    const ic = icons.find((f) => f.id === idn);
    if (!ic) throw new Error('アイコン画像が見つかりません: ' + idn);
    const data = Buffer.from(res[key], 'base64');
    if (data.length > ic.size) throw new Error(`新しい画像(${w}px)が元より大きいため差し替えできません`);
    plan.push({ i, w, ic, data });
  }
  if (!plan.length) throw new Error('差し替え対象がありません');

  for (const p of plan) {
    fs.writeSync(fd, p.data, 0, p.data.length, p.ic.dataOff);                    // 画像本体
    if (p.data.length < p.ic.size) fs.writeSync(fd, Buffer.alloc(p.ic.size - p.data.length), 0, p.ic.size - p.data.length, p.ic.dataOff + p.data.length);
    const sz = Buffer.alloc(4); sz.writeUInt32LE(p.data.length);
    fs.writeSync(fd, sz, 0, 4, p.ic.entryOff + 4);                               // リソースのサイズ
    fs.writeSync(fd, sz, 0, 4, grp.dataOff + 6 + p.i * 14 + 8);                  // グループ内のサイズ
    // 16/32/48は32bit色に揃える
    const b = Buffer.from([32, 0]); fs.writeSync(fd, Buffer.from([1, 0]), 0, 2, grp.dataOff + 6 + p.i * 14 + 4); fs.writeSync(fd, b, 0, 2, grp.dataOff + 6 + p.i * 14 + 6);
  }
  console.log('アイコンを差し替えました: ' + plan.map((p) => p.w + 'px').join(', '));
} finally {
  fs.closeSync(fd);
}
