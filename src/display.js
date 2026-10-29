/**
 * 画像の高速表示まわり。
 *
 *  1. デコード済み画像のキャッシュ … 一度開いた画像は再デコードしない（メモリ上限つきのLRU）
 *  2. 先読み                     … 進む方向の次の画像を、操作の合間にバックグラウンドで準備する
 *  3. 表示用サーフェス           … 画面サイズに合わせて縮小済みの絵を作っておき、切り替え時は貼るだけにする
 *  4. 段階表示                   … 本画像がまだ出来ていないときは、縮小サムネイルで即座に切り替え、あとで差し替える
 *  5. 送りアニメーション         … 左右の送りをスライド/フェードで滑らかに見せる（連打時は短く、または省略）
 *  6. モニタープロファイル(ICC)  … 表示用サーフェスを作るときに、画素をモニターの色へ変換する
 *  8. 縮小の画質                 … 「速い」は一気に縮める。「きれい」「くっきり」は、半分ずつ段階的に縮めてから、弱い/標準のシャープをかける
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
  let BG = '#0a0a0a';          // 写真の周りの背景色（設定で変更できる）

  const entries = new Map();   // file -> {file,bitmap,w,h,px,head,hist}   （挿入順 = 使った順）
  const loading = new Map();   // file -> Promise<entry|null>
  const surfaces = new Map();  // file -> {canvas,w,h,sig}
  const protect = new Set();   // いま表示中・先読み中で、追い出してはいけない画像
  let totalPx = 0;
  let generation = 0;          // 先読みのやり直し判定

  let profile = null;          // ICC: {name, parsed}
  const transforms = {};       // ICC: 画像の色空間ごとの変換器
  let profileId = 0;
  let ditherOn = true;         // ICC: 8bitに丸める前にディザ（微小ノイズ）を足す
  let whiteMatch = true;       // ICC: 画像の白をモニターの白にぴったり合わせる（相対的色域を維持）
  let style = 'slide';         // 'slide' | 'fade' | 'none'
  let sharpLevel = 'weak';     // 'off' | 'weak' | 'normal' | 'strong' | 'max' … 縮小後に足すシャープの強さ
  const SHARP_AMOUNT = { off: 0, weak: 0.35, normal: 0.7, strong: 1.1, max: 1.6 };
  let speedMs = 380;           // スライドの所要時間(ミリ秒)。フェードなどは、この比率で伸び縮みする
  let lastNav = 0;
  let rebuildTimer = 0;
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
    return `${w}x${h}|${panelCS()}|${profileId}|${sharpLevel}`;
  }

  // 大きな絵を小さくするとき、一度に縮めずに半分ずつ縮める（一気に縮めるより細部が残る）
  function stepDown(source, sw, sh, tw, th, cs) {
    let cur = source, cw = sw, ch = sh;
    while (cw > tw * 2 || ch > th * 2) {
      const nw = Math.max(tw, Math.ceil(cw / 2)), nh = Math.max(th, Math.ceil(ch / 2));
      const { c, ctx } = makeCanvas(nw, nh, cs, false);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
      cur = c; cw = nw; ch = nh;
    }
    return { img: cur, w: cw, h: ch };
  }

  function transformFor(source) {
    if (!profile) return null;
    if (!transforms[source]) transforms[source] = ICC.createTransform(profile.parsed, source, { whiteMatch, dither: ditherOn });
    return transforms[source];
  }

  // 画面サイズぴったりの絵を作る。ICCがあれば、ここで画素をモニターの色に変換する。
  // entry.noSharpen は、仮表示のサムネイル用（引き伸ばした絵にはシャープをかけない）
  function buildSurface(entry, w, h) {
    const cs = panelCS();
    const out = makeCanvas(w, h, cs, false);
    const octx = out.ctx;
    octx.fillStyle = BG;
    octx.fillRect(0, 0, w, h);
    const fit = fitRect(entry.w, entry.h, w, h);
    const amount = entry.noSharpen ? 0 : SHARP_AMOUNT[sharpLevel] || 0;
    // 画質「速い」(off)のときは、従来どおり一気に縮める（いちばん速い）
    const stepped = (entry.noSharpen || sharpLevel === 'off') ? null : stepDown(entry.bitmap, entry.w, entry.h, fit.w, fit.h, profile ? 'display-p3' : cs);
    const srcImg = stepped ? stepped.img : entry.bitmap;
    const sw = stepped ? stepped.w : entry.w, sh = stepped ? stepped.h : entry.h;

    if (!profile) {
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(srcImg, 0, 0, sw, sh, fit.x, fit.y, fit.w, fit.h);
      if (amount > 0 && typeof Sharpen !== 'undefined') {
        const img = octx.getImageData(fit.x, fit.y, fit.w, fit.h);
        Sharpen.sharpen(img.data, fit.w, fit.h, amount);
        octx.putImageData(img, fit.x, fit.y);
      }
    } else {
      const work = makeCanvas(fit.w, fit.h, 'display-p3', true);
      const src = ctxColorSpace(work.ctx);
      work.ctx.imageSmoothingEnabled = true;
      work.ctx.imageSmoothingQuality = 'high';
      work.ctx.drawImage(srcImg, 0, 0, sw, sh, 0, 0, fit.w, fit.h);
      const img = work.ctx.getImageData(0, 0, fit.w, fit.h, { colorSpace: src });
      if (amount > 0 && typeof Sharpen !== 'undefined') Sharpen.sharpen(img.data, fit.w, fit.h, amount);
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
      const s = buildSurface({ bitmap: bmp, w: bmp.width, h: bmp.height, noSharpen: true }, w, h);
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
    p.ctx.fillStyle = bgIsLight() ? '#4b5563' : '#9ca3af';
    p.ctx.font = `${14 * (window.devicePixelRatio || 1)}px sans-serif`;
    p.ctx.textAlign = 'center';
    p.ctx.fillText(text, p.canvas.width / 2, p.canvas.height / 2);
  }

  function paintStatic(p) {
    if (!p.ctx) return;
    paintBlank(p);
    if (p.surf) p.ctx.drawImage(shownCanvas(p.surf), 0, 0);
  }

  // 100%表示にも、選んだ画質のシャープをかける（見えている範囲だけ）。「速い」のときは、元の画素そのまま
  function sharpenPanelCanvas(p) {
    const amount = SHARP_AMOUNT[sharpLevel] || 0;
    if (!(amount > 0) || typeof Sharpen === 'undefined' || !p.ctx) return;
    const img = p.ctx.getImageData(0, 0, p.canvas.width, p.canvas.height);
    Sharpen.sharpen(img.data, p.canvas.width, p.canvas.height, amount);
    p.ctx.putImageData(img, 0, 0);
  }

  // 100%等倍表示（クリック長押し）。ICC使用中は、見えている範囲だけを変換する。
  function paintZoom(p) {
    const entry = p.file ? entries.get(p.file) : null;
    if (!entry || !p.ctx) { paintStatic(p); return; }
    const W = p.canvas.width, H = p.canvas.height;
    // 100%表示 = 写真の1画素を、画面の物理1画素にそのまま対応させる（拡大も縮小もしない）。
    // Windowsの表示倍率(125%など)を掛けたり、小数の位置に描いたりすると、画素が混ざってぼけるので、整数の位置に等倍で描く。
    const drawW = entry.w, drawH = entry.h;
    const offX = Math.round(W / 2 - state.zoomPoint.x * drawW);
    const offY = Math.round(H / 2 - state.zoomPoint.y * drawH);

    if (!profile) {
      paintBlank(p);
      p.ctx.imageSmoothingEnabled = false;
      p.ctx.drawImage(entry.bitmap, offX, offY);
      p.ctx.imageSmoothingEnabled = true;
      sharpenPanelCanvas(p);
      adjustPanelCanvas(p);
      return;
    }
    const work = makeCanvas(W, H, 'display-p3', true);
    const src = ctxColorSpace(work.ctx);
    work.ctx.fillStyle = BG;
    work.ctx.fillRect(0, 0, W, H);
    work.ctx.imageSmoothingEnabled = false;
    work.ctx.drawImage(entry.bitmap, offX, offY);
    const img = work.ctx.getImageData(0, 0, W, H, { colorSpace: src });
    const zAmount = SHARP_AMOUNT[sharpLevel] || 0;
    if (zAmount > 0 && typeof Sharpen !== 'undefined') Sharpen.sharpen(img.data, W, H, zAmount);
    transformFor(src).apply(img.data, img.data);
    p.ctx.putImageData(new ImageData(img.data, W, H, { colorSpace: 'srgb' }), 0, 0);
    adjustPanelCanvas(p);
  }

  // ------------------------------------------------------------ 送りアニメーション
  // 動かす2枚の絵を専用のキャンバス(レイヤー)に1回だけ描き、あとは位置と透明度の変化をブラウザに任せる。
  // 位置・透明度の動きはGPU側(コンポジター)で進むので、メインスレッドが忙しくても止まらず滑らかに動く。
  function ensureLayers(p) {
    const cs = panelCS();
    const parent = p.canvas && p.canvas.parentNode;
    if (!parent) return null;
    if (p.layers && p.layers.cs !== cs) { p.layers.from.remove(); p.layers.to.remove(); p.layers = null; }
    if (!p.layers) {
      const mk = (z) => {
        const c = document.createElement('canvas');
        c.style.cssText = `position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;display:none;z-index:${z};will-change:transform,opacity;`;
        parent.appendChild(c);
        return c;
      };
      p.layers = { from: mk(1), to: mk(2), cs, ctxFrom: null, ctxTo: null };
      try { p.layers.ctxFrom = p.layers.from.getContext('2d', { colorSpace: cs }); } catch (e) { p.layers.ctxFrom = p.layers.from.getContext('2d'); }
      try { p.layers.ctxTo = p.layers.to.getContext('2d', { colorSpace: cs }); } catch (e) { p.layers.ctxTo = p.layers.to.getContext('2d'); }
    }
    const L = p.layers;
    [L.from, L.to].forEach((c) => {
      if (c.width !== p.canvas.width || c.height !== p.canvas.height) { c.width = p.canvas.width; c.height = p.canvas.height; }
    });
    return L;
  }

  function drawLayer(ctx, c, surf) {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, c.width, c.height);
    if (surf) ctx.drawImage(shownCanvas(surf), 0, 0);
  }

  function hideLayers(p) {
    if (p.animHandles) { p.animHandles.forEach((h) => { try { h.cancel(); } catch (e) { /* 無視 */ } }); p.animHandles = null; }
    if (p.layers) { p.layers.from.style.display = 'none'; p.layers.to.style.display = 'none'; }
  }

  // アニメーションを途中で打ち切る（表示は到着先の絵にする）
  function cancelAnim(p) {
    if (p.anim) p.surf = p.anim.to;
    p.anim = null;
    hideLayers(p);
  }

  function startTransition(p, from, to, nav, fast) {
    const kind = nav.jump ? 'fade' : style;
    if (kind === 'none') { p.surf = to; paintStatic(p); return; }
    const k = speedMs / 240;
    const base = Math.round((kind === 'slide' ? 240 : (nav.jump ? 150 : 170)) * k);
    const dur = fast ? Math.round(base * 0.45) : base;
    const dir = nav.dir >= 0 ? 1 : -1;
    const a = { from, to, dir, style: kind, t0: performance.now(), dur };
    p.surf = to;

    const L = typeof Element !== 'undefined' && Element.prototype.animate ? ensureLayers(p) : null;
    if (!L) { p.anim = null; paintStatic(p); return; }   // アニメーションを使えない環境では、すぐ切り替える

    drawLayer(L.ctxFrom, L.from, from);
    drawLayer(L.ctxTo, L.to, to);
    L.from.style.display = 'block';
    L.to.style.display = 'block';
    p.anim = a;

    const ease = 'cubic-bezier(0.215, 0.61, 0.355, 1)';   // 終わりに向かってなめらかに減速（easeOutCubic）
    const opts = { duration: dur, easing: ease, fill: 'forwards' };
    const handles = [];
    if (kind === 'slide') {
      // 透明度は変えず、絵をそのまま動かす（半透明にすると、残像のように見えるため）
      handles.push(L.from.animate([
        { transform: 'translate3d(0,0,0)' },
        { transform: `translate3d(${-dir * 100}%,0,0)` },
      ], opts));
      handles.push(L.to.animate([
        { transform: `translate3d(${dir * 100}%,0,0)` },
        { transform: 'translate3d(0,0,0)' },
      ], opts));
    } else {
      L.from.style.opacity = '1';
      handles.push(L.to.animate([{ opacity: 0 }, { opacity: 1 }], opts));
    }
    p.animHandles = handles;
    const last = handles[handles.length - 1];
    const done = () => {
      if (p.anim !== a) return;            // 途中で別の切り替えに置き換わった
      p.anim = null;
      p.surf = a.to;
      if (state.isZoomed) paintZoom(p); else paintStatic(p);   // 先に本体の絵を最新にしてから、レイヤーを外す
      hideLayers(p);
    };
    last.onfinish = done;
    last.oncancel = () => { /* cancelAnim / hideLayers 側で後始末済み */ };
  }

  function finishAnim(p) {
    if (p.anim) cancelAnim(p);
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
    if (p.anim) {
      p.anim.to = surf; p.surf = surf;
      if (p.layers) drawLayer(p.layers.ctxTo, p.layers.to, surf);   // 動いている最中に、本画像へ差し替え
    }
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

      if (!file) { cancelAnim(p); p.surf = null; paintBlank(p); continue; }

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
      cancelAnim(p);
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
      cancelAnim(p);
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

  function setWhiteMatch(on) {
    const v = !!on;
    if (v === whiteMatch) return;
    whiteMatch = v;
    Object.keys(transforms).forEach((k) => delete transforms[k]);
    profileId++;
    surfaces.clear();
  }

  function bgIsLight() {
    const n = parseInt(BG.slice(1), 16);
    return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) > 140;
  }

  function setBackground(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex) || hex.toLowerCase() === BG.toLowerCase()) return;
    BG = hex;
    profileId++;
    surfaces.clear();
  }

  function setDither(on) {
    const v = !!on;
    if (v === ditherOn) return;
    ditherOn = v;
    Object.keys(transforms).forEach((k) => delete transforms[k]);
    profileId++;
    surfaces.clear();
  }

  function getProfileParsed() {
    return profile ? profile.parsed : null;
  }

  // 縮小後のシャープの強さ: 'off' | 'weak' | 'normal'。変えたら、表示用の絵を作り直す
  function setSharpness(level) {
    const l = Object.prototype.hasOwnProperty.call(SHARP_AMOUNT, level) ? level : 'weak';
    if (l === sharpLevel) return;
    sharpLevel = l;
    surfaces.clear();
  }

  function setTransitionSpeed(ms) {
    speedMs = Math.max(120, Math.min(600, ms || 380));
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
    panelList.forEach((p) => { cancelAnim(p); p.file = null; p.surf = null; p.token++; paintBlank(p); });
  }

  function getHist(key) {
    const p = panels[key];
    const e = p && p.file ? entries.get(p.file) : null;
    return e ? e.hist : null;
  }

  // 100%表示の位置合わせ用: 写真の大きさと、キャンバスの画素数・写真が収まる枠
  function geom(key) {
    const p = panels[key];
    const e = p && p.file && p.canvas ? entries.get(p.file) : null;
    if (!e) return null;
    return { iw: e.w, ih: e.h, cw: p.canvas.width, ch: p.canvas.height, fit: fitRect(e.w, e.h, p.canvas.width, p.canvas.height) };
  }

  // EXIF読み取り用のデータ（ネイティブ版は先頭だけのBlob、ブラウザ版はFile）
  async function getExifSource(file) {
    const e = await loadEntry(file);
    return e ? e.head : null;
  }

  return {
    attach, show, prefetch, paintAll, onResize, rebuildAll,
    setProfile, setWhiteMatch, setDither, setBackground, getProfileParsed, setTransitionStyle, setTransitionSpeed, setSharpness, setAdjust, getAdjust, colorSpaceChanged, reset, getHist, getExifSource, geom,
    hasProfile: () => !!profile,
    profileName: () => (profile ? profile.name : ''),
    _debug: { entries, surfaces, panels, buildSurface, stepDown, dims: surfaceDims },
  };
})();
