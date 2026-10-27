/**
 * フォルダツリー（別窓）のデスクトップ版。
 * このPCのドライブとクイックアクセスを最初から全部表示し、▶で下の階層を読み込みます（遅延読み込み）。
 * 「更新」で、開いている階層をすべて読み直します。
 * ネイティブ機能(window.nativeApp)は preload.js が提供します。
 */
const FolderTree = (() => {
  'use strict';

  const api = () => window.nativeApp;
  const roots = { quick: [], drives: [] };
  const children = new Map();   // path -> {folders:[{name,path}], error}
  const counts = new Map();     // path -> 画像の枚数（-1: 数えられない）
  const expanded = new Set();
  const pending = new Set();    // 読み込み中のフォルダ
  const rowEls = new Map();     // path -> 行の要素（枚数バッジの更新用）
  const badgeEls = new Map();   // path -> 枚数バッジの要素

  let treeEl = null, badgeEl = null, refreshBtn = null;
  let getCurrent = () => '';
  let onSelect = () => {};
  let onRefreshed = () => {};
  let gen = 0;                  // 更新のたびに増やし、古い読み込み結果を捨てる
  let loadedOnce = false;
  let counting = false, countAgain = false;

  const ERROR_TEXT = {
    EPERM: 'アクセスが許可されていません',
    EACCES: 'アクセスが許可されていません',
    ENOENT: 'フォルダが見つかりません',
    ETIMEDOUT: '応答がありません（ネットワークドライブなど）',
  };

  function init(opts) {
    treeEl = opts.tree;
    badgeEl = opts.badge;
    refreshBtn = opts.refreshBtn;
    if (opts.getCurrent) getCurrent = opts.getCurrent;
    if (opts.onSelect) onSelect = opts.onSelect;
    if (opts.onRefreshed) onRefreshed = opts.onRefreshed;
    if (refreshBtn) refreshBtn.addEventListener('click', refresh);
  }

  // ------------------------------------------------------------ 読み込み
  async function ensureRoots() {
    const r = await api().getRoots();
    roots.quick = r.quick || [];
    roots.drives = r.drives || [];
  }

  async function loadChildren(p) {
    if (children.has(p) || pending.has(p)) return;
    pending.add(p);
    const g = gen;
    try {
      const res = await api().listDir(p);
      if (g === gen) children.set(p, res);
    } catch (e) {
      if (g === gen) children.set(p, { path: p, folders: [], error: 'EUNKNOWN' });
    } finally {
      pending.delete(p);
    }
  }

  async function loadCounts() {
    if (counting) { countAgain = true; return; }
    counting = true;
    try {
      do {
        countAgain = false;
        const g = gen;
        const need = [];
        rowEls.forEach((el, p) => {
          if (!counts.has(p) && !el.dataset.noAccess) need.push(p);
        });
        for (let i = 0; i < need.length; i += 40) {
          if (g !== gen) break;
          const chunk = need.slice(i, i + 40);
          let res = {};
          try { res = await api().countImages(chunk); } catch (e) { res = {}; }
          if (g !== gen) break;
          chunk.forEach((p) => {
            const v = typeof res[p] === 'number' ? res[p] : -1;
            counts.set(p, v);
            paintCount(p);
          });
        }
      } while (countAgain);
    } finally {
      counting = false;
    }
  }

  function paintCount(p) {
    const el = badgeEls.get(p);
    if (!el) return;
    const v = counts.get(p);
    if (v === undefined) { el.textContent = ''; return; }
    el.textContent = v > 0 ? String(v) : (v < 0 ? '–' : '');
    el.classList.toggle('hidden', v === 0);
  }

  // ------------------------------------------------------------ 描画
  function makeRow(node, depth, kind) {
    const p = node.path;
    const info = children.get(p);
    const isOpen = expanded.has(p);
    const noAccess = !!(info && info.error);
    const isLeaf = !!(info && !info.error && info.folders.length === 0);
    const isCurrent = p === getCurrent();

    const row = document.createElement('div');
    row.className = 'tree-folder flex items-center gap-1.5 pr-2 py-1 rounded text-xs transition ' +
      (isCurrent ? 'active-folder ' : '') + (noAccess ? 'text-gray-500' : 'text-gray-300');
    row.style.paddingLeft = (depth * 14 + 4) + 'px';
    row.title = noAccess ? (ERROR_TEXT[info.error] || '開けません') + '\n' + p : p;
    row.dataset.path = p;
    if (noAccess) row.dataset.noAccess = '1';

    const chev = document.createElement('button');
    chev.type = 'button';
    chev.className = 'w-4 h-4 shrink-0 flex items-center justify-center text-gray-500 hover:text-white';
    if (noAccess || isLeaf) {
      chev.disabled = true;
      chev.innerHTML = '';
    } else if (isOpen && !info) {
      chev.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-[9px]"></i>';
    } else {
      chev.innerHTML = `<i class="fa-solid fa-chevron-${isOpen ? 'down' : 'right'} text-[9px]"></i>`;
    }
    chev.addEventListener('click', (e) => { e.stopPropagation(); toggle(p); });

    const icon = document.createElement('i');
    if (kind === 'drive') icon.className = 'fa-solid fa-hard-drive text-sky-400 shrink-0';
    else if (kind === 'quick') icon.className = 'fa-solid fa-star text-amber-400 shrink-0 text-[10px]';
    else icon.className = `fa-solid fa-folder${isOpen ? '-open text-amber-400' : ' text-amber-500/80'} shrink-0`;

    const name = document.createElement('span');
    name.className = 'truncate flex-1';
    name.textContent = node.name;

    const badge = document.createElement('span');
    badge.className = 'bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0 hidden';

    row.append(chev, icon, name, badge);
    row.addEventListener('click', () => { if (!noAccess) onSelect(p); });
    row.addEventListener('dblclick', () => { if (!noAccess && !isLeaf) toggle(p); });

    rowEls.set(p, row);
    badgeEls.set(p, badge);
    paintCount(p);
    return row;
  }

  function renderChildren(container, p, depth) {
    if (!expanded.has(p)) return;
    const info = children.get(p);
    if (!info) {
      const loading = document.createElement('div');
      loading.className = 'text-[11px] text-gray-500 py-1';
      loading.style.paddingLeft = (depth * 14 + 26) + 'px';
      loading.textContent = '読み込み中…';
      container.appendChild(loading);
      return;
    }
    info.folders.forEach((f) => {
      container.appendChild(makeRow(f, depth, 'folder'));
      renderChildren(container, f.path, depth + 1);
    });
  }

  function heading(text) {
    const h = document.createElement('div');
    h.className = 'text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-2 pt-2 pb-1';
    h.textContent = text;
    return h;
  }

  function render() {
    if (!treeEl) return;
    const top = treeEl.scrollTop;
    rowEls.clear();
    badgeEls.clear();
    const frag = document.createDocumentFragment();

    if (roots.quick.length) {
      frag.appendChild(heading('クイックアクセス'));
      roots.quick.forEach((q) => {
        frag.appendChild(makeRow(q, 0, 'quick'));
        renderChildren(frag, q.path, 1);
      });
    }
    frag.appendChild(heading('このPC'));
    roots.drives.forEach((d) => {
      frag.appendChild(makeRow(d, 0, 'drive'));
      renderChildren(frag, d.path, 1);
    });

    treeEl.replaceChildren(frag);
    treeEl.scrollTop = top;
    if (badgeEl) badgeEl.textContent = `${rowEls.size} フォルダ表示中`;
    loadCounts();
  }

  function scrollToCurrent() {
    const el = treeEl && treeEl.querySelector('.active-folder');
    if (el) el.scrollIntoView({ block: 'center' });
  }

  // ------------------------------------------------------------ 操作
  async function toggle(p) {
    if (expanded.has(p)) {
      expanded.delete(p);
      render();
      return;
    }
    expanded.add(p);
    render();
    await loadChildren(p);
    render();
  }

  // 指定のフォルダまで、上の階層をすべて開く
  async function reveal(target) {
    if (!target) return;
    let anc = [];
    try { anc = await api().ancestorsOf(target); } catch (e) { anc = []; }
    const parents = anc.slice(0, -1);
    parents.forEach((a) => expanded.add(a));
    await Promise.all(parents.map(loadChildren));
  }

  async function open() {
    if (!api()) return;
    if (!loadedOnce) {
      loadedOnce = true;
      treeEl.innerHTML = '<div class="text-center text-gray-500 mt-10 text-xs">読み込み中…</div>';
      try {
        await ensureRoots();
      } catch (e) {
        treeEl.innerHTML = '<div class="text-center text-rose-400 mt-10 text-xs">フォルダ一覧を取得できませんでした。「更新」を押してください。</div>';
        loadedOnce = false;
        return;
      }
      // 最初からすべてのドライブの1階層目を表示する
      roots.drives.forEach((d) => expanded.add(d.path));
      render();
      await Promise.all(roots.drives.map((d) => loadChildren(d.path)));
    }
    await reveal(getCurrent());
    render();
    scrollToCurrent();
  }

  async function refresh() {
    if (!api()) return;
    if (refreshBtn) {
      refreshBtn.disabled = true;
      const ic = refreshBtn.querySelector('i');
      if (ic) ic.classList.add('fa-spin');
    }
    gen++;
    const keep = Array.from(expanded);
    children.clear();
    counts.clear();
    pending.clear();
    try {
      await ensureRoots();
      await Promise.all(keep.map(loadChildren));
      // 消えたフォルダは、開いた状態の記憶からも外す
      keep.forEach((p) => {
        const info = children.get(p);
        if (info && info.error === 'ENOENT') expanded.delete(p);
      });
      loadedOnce = true;
      render();
      try { await onRefreshed(); } catch (e) { /* 一覧の更新に失敗してもツリーは更新済み */ }
    } finally {
      if (refreshBtn) {
        refreshBtn.disabled = false;
        const ic = refreshBtn.querySelector('i');
        if (ic) ic.classList.remove('fa-spin');
      }
    }
  }

  return { init, open, refresh, render, reveal, _state: { expanded, children, counts } };
})();
