/**
 * 画像の高速表示まわり。
 *
 *  1. デコード済み画像のキャッシュ … 一度開いた画像は再デコードしない（メモリ上限つきのLRU）
 *  2. 先読み                     … 進む方向の次の画像を、操作の合間にバックグラウンドで準備する
 *  3. 表示用サーフェス           … 画面サイズに合わせて縮小済みの絵を作っておき、切り替え時は貼るだけにする
 *  4. 段階表示                   … 本画像がまだ出来ていないときは、縮小サムネイルで即座に切り替え、あとで差し替える
 *  5. 送りアニメーション         … 左右の送りをスライド/フェードで滑らかに見せる（連打時は短く、または省略）
 *  6. モニタープロファイル(ICC)  … 表示用サーフェスを作るときに、画素をモニターの色へ変換する
 *  7. 表示補正                   … 明るさ・コントラストなどを、画面に出す直前の絵にだけかける（元の写真は変えない）
 *
 * index.html のインラインスクリプトと同じグローバル(state など)を参照します。
 */
const Display = (() => {
  'use strict';

  const PX_BUDGET = 150e6;     // デコード済み画像として保持する合計画素数（約600MB分）
  const SURFACE_LIMIT = 10;    // 表示用サーフェスの保持数
  const HIST_SIDE = 320;       // ヒストグラム計算用に縮小する長辺
  const HEAD_BYTES = 262144;   // EXIF読み取り用に先頭だけ保持するバイト数
  const BG = '#0a0a0a';

  const entries = new Map();   // file -> {file,bitmap,w,h,px,head,hist}   （挿入順 = 使った順）
  const loading = new Map();   // file -> Promise<entry|null>
  const surfaces = new Map();  // file -> {canvas,w,h,sig}
  const protect = new Set();   // いま表示中・先読み中で、追い出してはいけない画像
  let totalPx = 0;
  let generation = 0;          // 先読みのやり直し判定

  let profile = null;          // ICC: {name, parsed}
  const transforms = {};       // ICC: 画像の色空間ごとの変換器
  let profileId = 0;
  let style = 'slide';         // 'slide' | 'fade' | 'none'
  let lastNav = 0;
  let rebuildTimer = 0;
  let rafId = 0;
  let zoomRaf = 0;

  // 表示補正: params が全部0か enabled=false のときは何もしない。ver は変更のたびに増える
  const adj = { enabled: true, params: Object.assign({}, Adjust.DEFAULTS), luts: null, ver: 0, raf: 0 };
  const adjActive = () => adj.enabled && !Adjust.isIdentity(adj.params);

  const panels = {
    A: { key: 'A', canvas: null, ctx: null, file: null, surf: null, anim: null, token: 0 },
    B: { key: 'B', canvas: null, ctx: null, file: null, surf: null, anim: null, token: 0 },
  };
  const panelList = [panels.A, panels.B];

  // ------------------------------------------------------------ ユーティリティ
  const idle = () => new Promise((r) => (window.requestIdleCallback ? window.requestIdleCallback(r, { timeout: 80 }) : setTimeout(r, 0)));
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const mimeOf = (name) => (/\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg');
  const native = () => (typeof window !== 'undefined' && window.nativeApp) || null;

  // ICC使用中は、画面に出す値そのもの(=sRGBとして素通し)で描く。使わないときは選択中の色空間で描く
  function panelCS() {
    if (profile) return 'srgb';
    return state.colorSpace === 'display-p3' ? 'display-p3' : 'srgb';
  }

  function makeCanvas(w, h, cs, willRead) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    let ctx = null;
    try {
      ctx = c.getContext('2d', { colorSpace: cs, willReadFrequently: !!willRead });
    } catch (e) {
      ctx = c.getContext('2d', { willReadFrequently: !!willRead });
    }
    return { c, ctx };
  }

  function ctxColorSpace(ctx) {
    try {
      const a = ctx.getContextAttributes && ctx.getContextAttributes();
      return a && a.colorSpace === 'display-p3' ? 'display-p3' : 'srgb';
    } catch (e) {
      return 'srgb';
    }
  }

  function fitRect(iw, ih, w, h) {
    const s = Math.min(w / iw, h / ih);
    const fw = Math.max(1, Math.round(iw * s));
    const fh = Math.max(1, Math.round(ih * s));
    return { x: Math.round((w - fw) / 2), y: Math.round((h - fh) / 2), w: fw, h: fh };
  }

  function surfaceDims() {
    const a = panels.A.canvas, b = panels.B.canvas;
    return {
      w: Math.max(1, Math.max(a ? a.width : 0, b ? b.width : 0)),
      h: Math.max(1, Math.max(a ? a.height : 0, b ? b.height : 0)),
    };
  }

  // ------------------------------------------------------------ パネル（描画先キャンバス）
  function attach(key, canvas) {
    const p = panels[key];
    p.canvas = canvas;
    p.ctx = null;
    try {
      p.ctx = canvas.getContext('2d', { colorSpace: panelCS() });
    } catch (e) {
      p.ctx = canvas.getContext('2d');
    }
    return p.ctx;
  }

  // ------------------------------------------------------------ 画像のデコードとキャッシュ
  async function readBlob(file) {
    const n = native();
    if (file.path && n && n.readImage) {
      const bytes = await n.readImage(file.path);
      return { blob: new Blob([bytes], { type: mimeOf(file.name) }), head: new Blob([bytes.subarray(0, HEAD_BYTES)]) };
    }
    return { blob: file, head: file.slice(0, HEAD_BYTES) };
  }

  // 全体のヒストグラムは、縮小した絵から1回だけ数える
  function computeHist(bitmap, cs) {
    const s = Math.min(1, HIST_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * s));
    const h = Math.max(1, Math.round(bitmap.height * s));
    const { ctx } = makeCanvas(w, h, cs, true);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      r[d[i]]++; g[d[i + 1]]++; b[d[i + 2]]++;
      l[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
    }
    return { r, g, b, l };
  }

  function workSpace() {
    return profile ? 'display-p3' : panelCS();
  }

  function evict() {
    if (totalPx <= PX_BUDGET) return;
    for (const [file, e] of entries) {
      if (totalPx <= PX_BUDGET) break;
      if (protect.has(file)) continue;
      entries.delete(file);
      totalPx -= e.px;
      try { e.bitmap.close(); } catch (err) { /* 閉じられなくても問題なし */ }
    }
  }

  function trimSurfaces() {
    for (const file of surfaces.keys()) {
      if (surfaces.size <= SURFACE_LIMIT) break;
      if (panels.A.file === file || panels.B.file === file) continue; // 表示中のものは残す
      surfaces.delete(file);
    }
  }

  function loadEntry(file) {
    if (!file) return Promise.resolve(null);
    const hit = entries.get(file);
    if (hit) { entries.delete(file); entries.set(file, hit); return Promise.resolve(hit); }
    if (loading.has(file)) return loading.get(file);

    const p = (async () => {
      try {
        const { blob, head } = await readBlob(file);
        const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
        const entry = { file, bitmap, w: bitmap.width, h: bitmap.height, px: bitmap.width * bitmap.height, head, hist: null };
        try { entry.hist = computeHist(bitmap, workSpace()); } catch (e) { entry.hist = null; }
        entries.set(file, entry);
        totalPx += entry.px;
        evict();
        return entry;
      } catch (e) {
        return null;
      } finally {
        loading.delete(file);
      }
    })();
    loading.set(file, p);
    return p;
  }

  // ------------------------------------------------------------ 表示用サーフェス
  function sigFor(w, h) {
    return `${w}x${h}|${panelCS()}|${profileId}`;
  }

  function transformFor(source) {
    if (!profile) return null;
    if (!transforms[source]) transforms[source] = ICC.createTransform(profile.parsed, source);
    return transforms[source];
  }

  // 画面サイズぴったりの絵を作る。ICCがあれば、ここで画素をモニターの色に変換する。
  function buildSurface(entry, w, h) {
    const cs = panelCS();
    const out = makeCanvas(w, h, cs, false);
    const octx = out.ctx;
    octx.fillStyle = BG;
    octx.fillRect(0, 0, w, h);
    const fit = fitRect(entry.w, entry.h, w, h);

    if (!profile) {
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(entry.bitmap, fit.x, fit.y, fit.w, fit.h);
    } else {
      const work = makeCanvas(fit.w, fit.h, 'display-p3', true);
      const src = ctxColorSpace(work.ctx);
      work.ctx.imageSmoothingEnabled = true;
      work.ctx.imageSmoothingQuality = 'high';
      work.ctx.drawImage(entry.bitmap, 0, 0, fit.w, fit.h);
      const img = work.ctx.getImageData(0, 0, fit.w, fit.h, { colorSpace: src });
      transformFor(src).apply(img.data, img.data);
      octx.putImageData(new ImageData(img.data, fit.w, fit.h, { colorSpace: 'srgb' }), fit.x, fit.y);
    }
    return { canvas: out.c, w, h, sig: sigFor(w, h) };
  }

  function getSurfaceSync(file, w, h) {
    const s = surfaces.get(file);
    const sig = sigFor(w, h);
    if (s && s.sig === sig) { surfaces.delete(file); surfaces.set(file, s); return s; }
    const entry = entries.get(file);
    if (!entry) return null;
    const built = buildSurface(entry, w, h);
    surfaces.set(file, built);
    trimSurfaces();
    return built;
  }

  async function ensureSurface(file) {
    const entry = await loadEntry(file);
    if (!entry) return null;
    const { w, h } = surfaceDims();
    if (!surfaces.has(file) || surfaces.get(file).sig !== sigFor(w, h)) await idle();
    return getSurfaceSync(file, w, h);
  }

  // 本画像がまだ無いときの仮表示（縮小サムネイルを引き伸ばした絵）
  async function placeholderSurface(file) {
    const n = native();
    if (!file.path || !n || !n.thumbUrl) return null;
    try {
      const res = await fetch(n.thumbUrl(file.path, file.mtimeMs, file.size));
      if (!res.ok) return null;
      const bmp = await createImageBitmap(await res.blob(), { imageOrientation: 'from-image' });
      const { w, h } = surfaceDims();
      const s = buildSurface({ bitmap: bmp, w: bmp.width, h: bmp.height }, w, h);
      bmp.close();
      return s;
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------ 表示補正
  // サーフェスに補正をかけた絵を返す（補正が要らなければ元の絵）。同じ補正値のあいだは使い回す
  function shownCanvas(surf) {
    if (!surf) return null;
    if (!adjActive()) return surf.canvas;
    if (surf.adjCanvas && surf.adjVer === adj.ver) return surf.adjCanvas;
    if (!adj.luts) adj.luts = Adjust.buildLuts(adj.params);
    const { c, ctx } = makeCanvas(surf.w, surf.h, panelCS(), true);
    ctx.drawImage(surf.canvas, 0, 0);
    const img = ctx.getImageData(0, 0, surf.w, surf.h);
    Adjust.apply(img.data, adj.luts);
    ctx.putImageData(img, 0, 0);
    surf.adjCanvas = c;
    surf.adjVer = adj.ver;
    return c;
  }

  // 画面に出ている絵そのものに補正をかける（等倍表示用）
  function adjustPanelCanvas(p) {
    if (!adjActive() || !p.ctx) return;
    if (!adj.luts) adj.luts = Adjust.buildLuts(adj.params);
    const img = p.ctx.getImageData(0, 0, p.canvas.width, p.canvas.height);
    Adjust.apply(img.data, adj.luts);
    p.ctx.putImageData(img, 0, 0);
  }

  function setAdjust(params, enabled) {
    if (params) adj.params = Object.assign({}, Adjust.DEFAULTS, params);
    if (typeof enabled === 'boolean') adj.enabled = enabled;
    adj.ver++;
    adj.luts = null;
    if (adj.raf) return;
    adj.raf = requestAnimationFrame(() => {
      adj.raf = 0;
      for (const p of panelList) {
        if (p.anim) continue;               // 動いている最中は、終わったときに補正つきで描かれる
        if (state.isZoomed) paintZoom(p); else paintStatic(p);
      }
    });
  }

  function getAdjust() {
    return { enabled: adj.enabled, params: Object.assign({}, adj.params), active: adjActive() };
  }

  // ------------------------------------------------------------ 描画
  function paintBlank(p) {
    if (!p.ctx) return;
    p.ctx.fillStyle = BG;
    p.ctx.fillRect(0, 0, p.canvas.width, p.canvas.height);
  }

  function paintMessage(p, text) {
    paintBlank(p);
    p.ctx.fillStyle = '#9ca3af';
    p.ctx.font = `${14 * (window.devicePixelRatio || 1)}px sans-serif`;
    p.ctx.textAlign = 'center';
    p.ctx.fillText(text, p.canvas.width / 2, p.canvas.height / 2);
  }

  function paintStatic(p) {
    if (!p.ctx) return;
    paintBlank(p);
    if (p.surf) p.ctx.drawImage(shownCanvas(p.surf), 0, 0);
  }

  // 100%等倍表示（クリック長押し）。ICC使用中は、見えている範囲だけを変換する。
  function paintZoom(p) {
    const entry = p.file ? entries.get(p.file) : null;
    if (!entry || !p.ctx) { paintStatic(p); return; }
    const dpr = window.devicePixelRatio || 1;
    const W = p.canvas.width, H = p.canvas.height;
    const drawW = entry.w * dpr, drawH = entry.h * dpr;
    const offX = W / 2 - state.zoomPoint.x * drawW;
    const offY = H / 2 - state.zoomPoint.y * drawH;

    if (!profile) {
      paintBlank(p);
      p.ctx.drawImage(entry.bitmap, offX, offY, drawW, drawH);
      adjustPanelCanvas(p);
      return;
    }
    const work = makeCanvas(W, H, 'display-p3', true);
    const src = ctxColorSpace(work.ctx);
    work.ctx.fillStyle = BG;
    work.ctx.fillRect(0, 0, W, H);
    work.ctx.drawImage(entry.bitmap, offX, offY, drawW, drawH);
    const img = work.ctx.getImageData(0, 0, W, H, { colorSpace: src });
    transformFor(src).apply(img.data, img.data);
    p.ctx.putImageData(new ImageData(img.data, W, H, { colorSpace: 'srgb' }), 0, 0);
    adjustPanelCanvas(p);
  }

  function drawAnim(p, a, t) {
    const ctx = p.ctx;
    const W = p.canvas.width, H = p.canvas.height;
    const e = easeOutCubic(t);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    if (a.style === 'slide') {
      // 新しい画像が進行方向から押し出すように入ってくる
      ctx.globalAlpha = 1 - 0.55 * e;
      ctx.drawImage(shownCanvas(a.from), Math.round(-a.dir * W * e), 0);
      ctx.globalAlpha = 0.55 + 0.45 * e;
      ctx.drawImage(shownCanvas(a.to), Math.round(a.dir * W * (1 - e)), 0);
    } else {
      ctx.drawImage(shownCanvas(a.from), 0, 0);
      ctx.globalAlpha = e;
      ctx.drawImage(shownCanvas(a.to), 0, 0);
    }
    ctx.restore();
  }

  function tick(now) {
    rafId = 0;
    let more = false;
    for (const p of panelList) {
      const a = p.anim;
      if (!a) continue;
      const t = Math.max(0, Math.min(1, (now - a.t0) / a.dur));
      if (t >= 1) {
        p.surf = a.to;
        p.anim = null;
        if (state.isZoomed) paintZoom(p); else paintStatic(p);
      } else {
        drawAnim(p, a, t);
        more = true;
      }
    }
    if (more) rafId = requestAnimationFrame(tick);
  }

  function startTransition(p, from, to, nav, fast) {
    const kind = nav.jump ? 'fade' : style;
    if (kind === 'none') { p.surf = to; paintStatic(p); return; }
    const base = kind === 'slide' ? 240 : (nav.jump ? 150 : 170);
    p.anim = { from, to, dir: nav.dir >= 0 ? 1 : -1, style: kind, t0: performance.now(), dur: fast ? Math.round(base * 0.45) : base };
    p.surf = to;
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  function finishAnim(p) {
    if (p.anim) { p.surf = p.anim.to; p.anim = null; }
  }

  function setSurface(p, surf, nav, fast) {
    finishAnim(p);
    const from = p.surf;
    if (nav && from && from !== surf && !state.isZoomed) {
      p.surf = surf;
      startTransition(p, from, surf, nav, fast);
    } else {
      p.surf = surf;
      if (state.isZoomed) paintZoom(p); else paintStatic(p);
    }
  }

  function replaceSurface(p, surf) {
    if (p.anim) { p.anim.to = surf; p.surf = surf; }
    else { p.surf = surf; if (state.isZoomed) paintZoom(p); else paintStatic(p); }
  }

  // ------------------------------------------------------------ 公開: 表示の切り替え
  /**
   * @param files {A: file|null, B: file|null}  各画面に出す写真
   * @param nav   {dir: 1|-1, jump?: bool} | null  送りの方向。null なら演出なしで切り替える
   */
  function show(files, nav) {
    const now = performance.now();
    const fast = now - lastNav < 160;
    lastNav = now;

    protect.clear();
    panelList.forEach((p) => { if (files[p.key]) protect.add(files[p.key]); });
    const { w, h } = surfaceDims();

    for (const p of panelList) {
      const file = files[p.key];
      if (p.file === file) continue;
      p.file = file;
      const tok = ++p.token;

      if (!file) { p.anim = null; p.surf = null; paintBlank(p); continue; }

      const ready = getSurfaceSync(file, w, h);
      if (ready) { setSurface(p, ready, nav, fast); continue; }

      // 本画像がまだ無い: まず縮小サムネイルで切り替え、出来しだい差し替える
      let fullDone = false;
      let placeholderShown = false;
      ensureSurface(file).then((s) => {
        fullDone = true;
        if (p.token !== tok) return; // その間に別の写真へ移った
        if (!s) { if (!placeholderShown) paintMessage(p, '画像を読み込めません'); return; }
        if (placeholderShown) replaceSurface(p, s);
        else setSurface(p, s, nav, fast);
      });
      placeholderSurface(file).then((s) => {
        if (!s || fullDone || p.token !== tok) return;
        placeholderShown = true;
        setSurface(p, s, nav, fast);
      });
    }
  }

  // 先読み: 渡された順に、デコードと表示用サーフェス作りを進める
  function prefetch(files) {
    const gen = ++generation;
    const list = files.filter(Boolean);
    list.forEach((f) => protect.add(f));
    (async () => {
      for (const f of list) {
        if (gen !== generation) return;
        await ensureSurface(f);
      }
    })();
  }

  // ------------------------------------------------------------ 公開: 再描画
  function paintAll() {
    for (const p of panelList) {
      if (p.anim) continue;
      if (state.isZoomed) {
        if (!zoomRaf) {
          zoomRaf = requestAnimationFrame(() => {
            zoomRaf = 0;
            for (const q of panelList) if (!q.anim) { if (state.isZoomed) paintZoom(q); else paintStatic(q); }
          });
        }
        return;
      }
      paintStatic(p);
    }
  }

  function rebuildAll() {
    rebuildTimer = 0;
    surfaces.clear();
    const { w, h } = surfaceDims();
    for (const p of panelList) {
      p.anim = null;
      p.surf = null;
      if (!p.file) { paintBlank(p); continue; }
      const s = getSurfaceSync(p.file, w, h);
      if (s) { p.surf = s; paintStatic(p); continue; }
      paintBlank(p);
      const f = p.file;
      ensureSurface(f).then((ns) => { if (ns && p.file === f) { p.surf = ns; paintStatic(p); } });
    }
  }

  // ウィンドウの大きさが変わった: すぐ古い絵を引き伸ばして出し、少し待ってから作り直す
  function onResize() {
    for (const p of panelList) {
      p.anim = null;
      if (p.surf && p.ctx) {
        paintBlank(p);
        p.ctx.drawImage(shownCanvas(p.surf), 0, 0, p.canvas.width, p.canvas.height);
      } else {
        paintBlank(p);
      }
    }
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuildAll, 140);
  }

  // ------------------------------------------------------------ 公開: 設定
  function setProfile(parsed, name) {
    profile = parsed ? { parsed, name: name || '' } : null;
    Object.keys(transforms).forEach((k) => delete transforms[k]);
    profileId++;
    surfaces.clear();
  }

  function setTransitionStyle(s) {
    style = s === 'fade' || s === 'none' ? s : 'slide';
  }

  // 色空間(P3/sRGB)の選択が変わったとき: 保持している画像の色再計算が必要
  function colorSpaceChanged() {
    surfaces.clear();
    entries.forEach((e) => { try { e.hist = computeHist(e.bitmap, workSpace()); } catch (err) { /* そのまま */ } });
  }

  function reset() {
    generation++;
    loading.clear();
    entries.forEach((e) => { try { e.bitmap.close(); } catch (err) { /* 無視 */ } });
    entries.clear();
    surfaces.clear();
    protect.clear();
    totalPx = 0;
    panelList.forEach((p) => { p.file = null; p.surf = null; p.anim = null; p.token++; paintBlank(p); });
  }

  function getHist(key) {
    const p = panels[key];
    const e = p && p.file ? entries.get(p.file) : null;
    return e ? e.hist : null;
  }

  // EXIF読み取り用のデータ（ネイティブ版は先頭だけのBlob、ブラウザ版はFile）
  async function getExifSource(file) {
    const e = await loadEntry(file);
    return e ? e.head : null;
  }

  return {
    attach, show, prefetch, paintAll, onResize, rebuildAll,
    setProfile, setTransitionStyle, setAdjust, getAdjust, colorSpaceChanged, reset, getHist, getExifSource,
    hasProfile: () => !!profile,
    profileName: () => (profile ? profile.name : ''),
    _debug: { entries, surfaces, panels },
  };
})();
