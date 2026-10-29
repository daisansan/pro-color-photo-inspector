'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, protocol, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const { copyPickedFiles, copyOneToChoice, sanitizeFolderName, IMAGE_EXTS } = require('./lib/export');
const imginfo = require('./lib/imginfo');
const fsb = require('./lib/fsbrowse');
const selections = require('./lib/selections');
const { loadSettings, saveSettings } = require('./lib/settings');
const { createThumbService } = require('./lib/thumbs');
const { createConverter, isConvertible } = require('./lib/convert');

// サムネイル用の独自プロトコル（<img src="pci-thumb://..."> で縮小画像を表示するため）。
// app.ready より前に登録する必要がある。
protocol.registerSchemesAsPrivileged([
  { scheme: 'pci-thumb', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// テスト用: データの保存先を差し替えられる（通常は使わない）
if (process.env.PCI_USER_DATA) app.setPath('userData', process.env.PCI_USER_DATA);

const userDataDir = app.getPath('userData');
const settings = loadSettings(userDataDir);

// ---- モニタープロファイル ----
// 自前でモニター向けの色変換をするときは、Chromium側の色変換を止めて（sRGBとして素通しにして）
// 二重に補正されないようにする。この指定は起動時にしか変えられないので、変更時はアプリを再起動する。
let monitorProfilePath = null;
if (settings.monitorProfilePath && fs.existsSync(settings.monitorProfilePath)) {
  monitorProfilePath = settings.monitorProfilePath;
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
}

// ---- 描画をなるべくGPUに任せる（送りアニメーションを滑らかにする）
// GPUの利用を、グラフィックスドライバーの古さなどで控えめにされている環境でも、使えるようにする。
// テスト実行時(PCI_E2E)は、GPUのない環境で動かすので指定しない。
if (!process.env.PCI_E2E) {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
}

const COLOR_DIR = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'spool', 'drivers', 'color');
const PROFILE_EXTS = new Set(['.icc', '.icm']);

let mainWindow = null;

// 二重起動を防ぐ（2つ目を起動したら、既存のウィンドウを前面に出す）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // タスクバーで正しくグループ化・アイコン表示されるようにする
  app.setAppUserModelId('com.procolorphotoinspector.app');

  app.whenReady().then(() => {
    // メニューバーは使わない（Altキーなどでメニューが出て、キー操作の邪魔にならないように）
    Menu.setApplicationMenu(null);
    setupThumbnailProtocol();
    setTimeout(() => { converter.prune().catch(() => {}); }, 15000);   // PSD/RAWの変換キャッシュが2GBを超えたら、古いものから消す
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

// ------------------------------------------------------------------ サムネイル
let thumbService = null;
let thumbServiceBig = null;   // グリッド一覧の「中・大・最大」用の大きめサムネイル

// 縮小サイズ(px四方に収まる)を、縦横比を保って計算する
function fitSize(w, h, px) {
  const k = Math.min(1, px / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

// 画像を自分で読み込んで縮小する（縦横比と写真の向きを必ず正しく扱う）
function thumbFromDecode(filePath, px, info) {
  return thumbFromImage(nativeImage.createFromPath(filePath), px, info);
}

function thumbFromImage(img, px, info) {
  if (img.isEmpty()) return null;
  const s = img.getSize();
  const o = info ? info.orientation : 1;
  const target = fitSize(s.width, s.height, px);
  const small = (target.width === s.width && target.height === s.height) ? img : img.resize({ ...target, quality: 'good' });
  if (o === 1) return small.toJPEG(82);
  const ts = small.getSize();
  const r = imginfo.applyOrientation(small.toBitmap(), ts.width, ts.height, o);
  return nativeImage.createFromBitmap(r.data, { width: r.width, height: r.height }).toJPEG(82);
}

// PSD / RAW は、表示用のJPEG（PSDは全レイヤーを重ねた絵、RAWは埋め込みプレビュー）に変えてから縮小する
const converter = createConverter({
  cacheDir: path.join(userDataDir, 'converted'),
  encodeJpeg: (rgba, w, h) => {
    const bgra = Buffer.from(rgba);   // nativeImage は BGRA の並び
    for (let i = 0; i < bgra.length; i += 4) { const r = bgra[i]; bgra[i] = bgra[i + 2]; bgra[i + 2] = r; }
    return nativeImage.createFromBitmap(bgra, { width: w, height: h }).toJPEG(95);
  },
});

async function makeThumb(filePath, px) {
  if (isConvertible(filePath)) {
    try {
      const jpg = await converter.getViewableJpeg(filePath);
      return thumbFromImage(nativeImage.createFromBuffer(jpg), px, imginfo.parseImageInfo(jpg));
    } catch (e) { return null; }
  }
  const info = await imginfo.readImageInfo(filePath);

  // 1) OSのサムネイル機能（Windows/macOS）。速いが、縦横比がおかしい絵が返ることがあるので、
  //    元の写真の縦横比と合うときだけ使う
  try {
    if (typeof nativeImage.createThumbnailFromPath === 'function' && process.platform !== 'linux') {
      const img = await nativeImage.createThumbnailFromPath(filePath, { width: px, height: px });
      if (img && !img.isEmpty()) {
        const t = img.getSize();
        if (!info) {
          // 元の縦横比が分からないとき(WebPなど)は、OSの返した縦横比をそのまま信じる
          return img.toJPEG(82);
        }
        const want = info.dispW / info.dispH, got = t.width / t.height;
        if (Math.abs(got - want) / want < 0.04) return img.toJPEG(82);
      }
    }
  } catch (e) { /* 次の方法へ */ }

  // 2) 自分で縮小（JPEG/PNG）
  try {
    const buf = thumbFromDecode(filePath, px, info);
    if (buf) return buf;
  } catch (e) { /* 縮小できない形式 */ }

  return null; // 元画像をそのまま返す（lib/thumbs.js 側）
}

function setupThumbnailProtocol() {
  const cacheDir = process.env.PCI_USER_DATA
    ? path.join(userDataDir, 'thumbs')
    : path.join(app.getPath('cache'), 'pro-color-photo-inspector', 'thumbs');
  thumbService = createThumbService({ cacheDir, makeThumb, px: 256, concurrency: 4 });
  thumbServiceBig = createThumbService({ cacheDir, makeThumb, px: 800, concurrency: 3 });

  protocol.handle('pci-thumb', async (request) => {
    try {
      const p = new URL(request.url).searchParams.get('p');
      if (!p || !path.isAbsolute(p) || !fsb.isViewableImage(p)) {
        return new Response('bad request', { status: 400 });
      }
      const big = new URL(request.url).searchParams.get('b') === '1';
      const t = await (big ? thumbServiceBig : thumbService).getThumbnail(p);
      return new Response(t.data, {
        headers: {
          'content-type': t.mime,
          'cache-control': 'private, max-age=3600',
          // file:// の画面から fetch して画面サイズの仮表示に使うため、読み取りを許可する
          'access-control-allow-origin': '*',
        },
      });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  });
}

// ------------------------------------------------------------------ ウィンドウ
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#030712',
    title: 'Pro Color Photo Inspector',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // フルスクリーンが(Windows側の操作などで)解除されたら、画面側の大画面表示も戻す
  const notifyFullScreen = (on) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window:fullscreen', on);
  };
  mainWindow.on('enter-full-screen', () => notifyFullScreen(true));
  mainWindow.on('leave-full-screen', () => notifyFullScreen(false));

  // 画像ファイルをウィンドウへドロップしても、ページ遷移しないようにする
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // F11 で全画面の切り替え
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    }
  });

  // 自動テスト用のフック（環境変数を指定したときだけ動く。通常の利用では何も起きない）
  mainWindow.webContents.once('did-finish-load', () => {
    if (!process.env.PCI_E2E_SCRIPT) return;
    try {
      Promise.resolve(require(process.env.PCI_E2E_SCRIPT)({ app, win: mainWindow })).catch((e) => {
        console.error('E2E error:', e);
        app.exit(1);
      });
    } catch (e) {
      console.error('E2E load error:', e);
      app.exit(1);
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

// ------------------------------------------------------------------ IPC
// 呼び出し元がこのアプリのウィンドウであることを確認してから処理する
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('許可されていない呼び出しです');
    }
    return fn(...args);
  });
}

// --- 大画面表示に合わせて、ウィンドウをフルスクリーンにする/戻す（タイトルバーとタスクバーを隠す）
handle('window:set-fullscreen', async (on) => {
  if (mainWindow) mainWindow.setFullScreen(!!on);
  return mainWindow ? mainWindow.isFullScreen() : false;
});

// PNG画像を、JPEG(品質100)のデータにする。透明な部分は白にする。
async function pngToJpeg(filePath) {
  const img = nativeImage.createFromPath(filePath);
  if (img.isEmpty()) throw new Error('PNGを読み込めませんでした');
  const { width, height } = img.getSize();
  const bgra = img.toBitmap();                       // B,G,R,A の並び
  const out = Buffer.alloc(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    const a = bgra[i + 3] / 255;
    out[i] = Math.round(bgra[i] * a + 255 * (1 - a));
    out[i + 1] = Math.round(bgra[i + 1] * a + 255 * (1 - a));
    out[i + 2] = Math.round(bgra[i + 2] * a + 255 * (1 - a));
    out[i + 3] = 255;
  }
  return nativeImage.createFromBitmap(out, { width, height }).toJPEG(100);
}

// --- 選別した写真の書き出し: 保存先フォルダを選び、その中にサブフォルダを作ってコピーする
handle('export-picked', async (payload) => {
  const filePaths = Array.isArray(payload && payload.filePaths)
    ? payload.filePaths.filter((p) => typeof p === 'string')
    : [];
  const subName = sanitizeFolderName(payload && payload.subFolderName);

  if (filePaths.length === 0) {
    return { canceled: true, dir: '', copied: 0, failed: [] };
  }

  const picked = await dialog.showOpenDialog(mainWindow, {
    title: `書き出し先を選択（この中に「${subName}」フォルダを作ります）`,
    buttonLabel: 'ここに書き出す',
    defaultPath: path.dirname(filePaths[0]),
    properties: ['openDirectory', 'createDirectory'],
  });

  if (picked.canceled || picked.filePaths.length === 0) {
    return { canceled: true, dir: '', copied: 0, failed: [] };
  }

  const result = await copyPickedFiles(filePaths, picked.filePaths[0], subName, { jpegConverter: pngToJpeg });
  return { canceled: false, ...result };
});

// --- グリッド一覧で選んだ写真を、ごみ箱へ移す（確認の窓を出す。ごみ箱からは元に戻せる）
handle('trash-files', async (paths) => {
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && path.isAbsolute(p) && IMAGE_EXTS.has(path.extname(p).toLowerCase())) : [];
  if (list.length === 0) return { canceled: true, trashed: [], failed: [] };

  const e2eDir = process.env.PCI_E2E ? process.env.PCI_E2E_TRASH_DIR : '';   // 自動テスト用（通常は使われない）
  if (!e2eDir) {
    const names = list.slice(0, 8).map((p) => path.basename(p)).join('\n') + (list.length > 8 ? `\n…ほか ${list.length - 8} 枚` : '');
    const r = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['ごみ箱へ移動', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      title: '写真を削除',
      message: `${list.length} 枚の写真をごみ箱へ移動します。`,
      detail: names + '\n\n元の写真ファイルがフォルダから無くなります（ごみ箱から元に戻せます）。',
    });
    if (r.response !== 0) return { canceled: true, trashed: [], failed: [] };
  }

  const trashed = [];
  const failed = [];
  for (const p of list) {
    try {
      if (e2eDir) await fs.promises.rename(p, path.join(e2eDir, path.basename(p)));
      else await shell.trashItem(p);
      trashed.push(p);
    } catch (e) {
      failed.push({ name: path.basename(p), reason: e && e.message ? e.message : String(e) });
    }
  }
  return { canceled: false, trashed, failed };
});

// --- 最後に開いていたフォルダ（設定ファイルに保存。次の起動で自動的に開く）
handle('settings:get-last-folder', async () => (typeof settings.lastFolder === 'string' ? settings.lastFolder : null));
handle('settings:set-last-folder', async (p) => {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  settings.lastFolder = p;
  try { saveSettings(userDataDir, settings); } catch (e) { return false; }
  return true;
});

// --- RAW連携: JPEGの星評価を、RAWフォルダの同名ファイルの .xmp（Lightroom用）へ書き出す
const xmpLib = require('./lib/xmp');
handle('raw:get-folder', async (jpegDir) => {
  const m = settings.rawFolders && typeof settings.rawFolders === 'object' ? settings.rawFolders : {};
  return typeof jpegDir === 'string' && typeof m[jpegDir] === 'string' ? m[jpegDir] : null;
});
handle('raw:choose-folder', async (jpegDir) => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'RAW（CR2など）が入っているフォルダを選択',
    buttonLabel: 'このフォルダを使う',
    defaultPath: typeof jpegDir === 'string' ? path.dirname(jpegDir) : undefined,
    properties: ['openDirectory'],
  });
  if (picked.canceled || picked.filePaths.length === 0) return null;
  const dir = picked.filePaths[0];
  if (typeof jpegDir === 'string' && path.isAbsolute(jpegDir)) {
    settings.rawFolders = { ...(settings.rawFolders || {}), [jpegDir]: dir };
    try { saveSettings(userDataDir, settings); } catch (e) { /* 保存できなくても続行 */ }
  }
  return dir;
});
function cleanRawItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && typeof it.name === 'string' && it.name === path.basename(it.name))
    .map((it) => ({ name: it.name, rating: it.rating }));
}
handle('raw:plan', async (payload) => {
  const rawDir = payload && payload.rawDir;
  if (typeof rawDir !== 'string' || !path.isAbsolute(rawDir)) return { error: 'フォルダが正しくありません' };
  try {
    return { plan: xmpLib.planSync(rawDir, cleanRawItems(payload.items), { writeZero: !!payload.writeZero, createNew: !!payload.createNew }) };
  } catch (e) { return { error: e && e.message ? e.message : String(e) }; }
});
handle('raw:apply', async (payload) => {
  const rawDir = payload && payload.rawDir;
  if (typeof rawDir !== 'string' || !path.isAbsolute(rawDir)) return { error: 'フォルダが正しくありません' };
  try {
    const plan = xmpLib.planSync(rawDir, cleanRawItems(payload.items), { writeZero: !!payload.writeZero, createNew: !!payload.createNew });   // 実行直前にもう一度、対応を調べる
    return { plan, result: xmpLib.applySync(rawDir, plan.matches) };
  } catch (e) { return { error: e && e.message ? e.message : String(e) }; }
});

// --- 写真の上での右クリックメニュー（Windowsの標準的な操作: 開く / エクスプローラーで表示 / コピー / パスのコピー）
// 「削除」を選んだときだけ 'delete' を返し、画面側で今までの削除（確認の窓つき・ごみ箱へ）を行う
const { execFile } = require('child_process');
// 「他のアプリで開く」: 登録したアプリの一覧から選ぶ。「アプリを選んで開く…」でexeを選ぶと、開いて、次回から一覧に出る
function launchWithApp(exePath, filePath) {
  try {
    const child = require('child_process').spawn(exePath, [filePath], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', (e) => { dialog.showMessageBox(mainWindow, { type: 'error', title: '他のアプリで開く', message: 'アプリを起動できませんでした。', detail: `${exePath}\n${e && e.message ? e.message : e}` }).catch(() => {}); });
    child.unref();
  } catch (e) {
    dialog.showMessageBox(mainWindow, { type: 'error', title: '他のアプリで開く', message: 'アプリを起動できませんでした。', detail: String(e && e.message ? e.message : e) }).catch(() => {});
  }
}

function openAppsList() {
  return (Array.isArray(settings.openApps) ? settings.openApps : []).filter((a) => a && typeof a.path === 'string' && path.isAbsolute(a.path));
}

function saveOpenApps(list) {
  settings.openApps = list.slice(0, 20);
  try { saveSettings(userDataDir, settings); } catch (e) { /* 保存できなくても続行 */ }
}

function appLabel(p) { return path.basename(p, path.extname(p)); }

function openWithItem(filePath) {
  const apps = openAppsList();
  const sub = apps.map((a) => ({ label: appLabel(a.path), click: () => launchWithApp(a.path, filePath) }));
  if (sub.length) sub.push({ type: 'separator' });
  sub.push({
    label: 'アプリを選んで開く…',
    click: async () => {
      const r = await dialog.showOpenDialog(mainWindow, {
        title: '開くアプリ（.exe）を選択',
        buttonLabel: 'このアプリで開く',
        defaultPath: process.env['ProgramFiles'] || undefined,
        properties: ['openFile'],
        filters: [{ name: 'アプリ', extensions: ['exe', 'bat', 'cmd', 'lnk'] }, { name: 'すべてのファイル', extensions: ['*'] }],
      });
      if (r.canceled || !r.filePaths[0]) return;
      const exe = r.filePaths[0];
      if (!openAppsList().some((a) => a.path.toLowerCase() === exe.toLowerCase())) saveOpenApps([...openAppsList(), { path: exe }]);
      launchWithApp(exe, filePath);
    },
  });
  if (apps.length) {
    sub.push({
      label: '登録したアプリを一覧から外す',
      submenu: apps.map((a) => ({ label: appLabel(a.path), click: () => saveOpenApps(openAppsList().filter((x) => x.path !== a.path)) })),
    });
  }
  return { label: '他のアプリで開く', submenu: sub };
}

handle('file:context-menu', async (filePath) => {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !fsb.isViewableImage(filePath)) return null;
  return new Promise((resolve) => {
    let chosen = null;
    const done = () => resolve(chosen);
    const items = [
      openWithItem(filePath),
      { label: 'エクスプローラーで表示', click: () => shell.showItemInFolder(filePath) },
    ];
    if (process.platform === 'win32') {
      items.push({
        label: 'ファイルをコピー',
        click: () => {
          // ファイルそのものをクリップボードへ（エクスプローラーやメールに貼り付けられる）
          execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -LiteralPath $env:PCI_COPY_PATH'],
            { env: { ...process.env, PCI_COPY_PATH: filePath }, windowsHide: true }, () => {});
        },
      });
    }
    items.push(
      { label: 'ファイルのパスをコピー', click: () => clipboard.writeText(filePath) },
      { type: 'separator' },
      { label: '削除（ごみ箱へ）', click: () => { chosen = 'delete'; } },
    );
    if (process.env.PCI_E2E) {   // 自動テスト用
      Menu.buildFromTemplate(items);   // メニューの定義が正しいか確認
      if (process.env.PCI_E2E_RUN_FIRST_APP && items[0].submenu[0] && items[0].submenu[0].click) items[0].submenu[0].click();
      resolve({ e2eLabels: items.filter((i) => i.label).map((i) => i.label), openWith: items[0].submenu.map((i) => i.label || '-') });
      return;
    }
    Menu.buildFromTemplate(items).popup({ window: mainWindow, callback: done });
  });
});

// --- Cキー: アクティブな写真を、その写真のあるフォルダの下の「choice」フォルダへ、すぐコピーする
handle('copy-to-choice', async (filePath) => copyOneToChoice(filePath, 'choice', { jpegConverter: pngToJpeg }));

// --- PC内のフォルダ閲覧
handle('fs:roots', async () => {
  const quickDefs = [
    ['pictures', 'ピクチャ'],
    ['desktop', 'デスクトップ'],
    ['documents', 'ドキュメント'],
    ['downloads', 'ダウンロード'],
  ];
  const quick = [];
  for (const [key, label] of quickDefs) {
    try {
      const p = app.getPath(key);
      if (p && fs.existsSync(p)) quick.push({ name: label, path: p });
    } catch (e) { /* その場所がないOSでは無視 */ }
  }
  const drives = await fsb.listDrives();
  return { quick, drives };
});
handle('fs:list-dir', (p) => fsb.listDir(p));
handle('fs:count-images', (paths) => fsb.countImages(paths));
handle('fs:list-images', (p) => fsb.listImages(p));
handle('fs:ancestors', (p) => fsb.ancestorsOf(p));

// --- フォルダ/ファイルの選択ダイアログ
handle('dialog:choose-folder', async (defaultPath) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '写真のフォルダを選択',
    defaultPath: typeof defaultPath === 'string' && path.isAbsolute(defaultPath) ? defaultPath : undefined,
    properties: ['openDirectory'],
  });
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
});

handle('dialog:choose-files', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '写真ファイルを選択',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '画像', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  });
  if (r.canceled) return [];
  const files = [];
  for (const full of r.filePaths) {
    try {
      const st = await fs.promises.stat(full);
      files.push({ name: path.basename(full), path: full, dir: path.dirname(full), size: st.size, mtimeMs: Math.round(st.mtimeMs) });
    } catch (e) { /* 読めないものは飛ばす */ }
  }
  return files;
});

// --- 画像本体の読み込み（表示用）
const MAX_IMAGE_BYTES = 1024 * 1024 * 1024;
handle('images:read', async (p) => {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !fsb.isViewableImage(p)) throw new Error('画像ファイルではありません');
  const st = await fs.promises.stat(p);
  if (!st.isFile() || st.size > MAX_IMAGE_BYTES) throw new Error('読み込めないファイルです');
  if (isConvertible(p)) return converter.getViewableJpeg(p);   // PSD / RAW は表示用JPEGにして返す
  return fs.promises.readFile(p);
});

// --- 選別結果（星・Pick/Reject）の保存と復元
const selectionsDir = path.join(userDataDir, 'selections');
handle('selections:load', (folder) => {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return {};
  return selections.loadSelections(selectionsDir, folder);
});
handle('selections:save', (folder, items) => {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return { saved: 0 };
  return selections.saveSelections(selectionsDir, folder, items);
});
// ウィンドウを閉じる直前の保存用（非同期だと間に合わないことがあるので、同期で受ける）
ipcMain.on('selections:save-sync', (event, folder, items) => {
  let result = { saved: 0 };
  try {
    if (mainWindow && event.sender === mainWindow.webContents && typeof folder === 'string' && path.isAbsolute(folder)) {
      result = selections.saveSelections(selectionsDir, folder, items);
    }
  } catch (e) { /* 保存に失敗しても終了は妨げない */ }
  event.returnValue = result;
});

// --- モニタープロファイル
function isProfilePath(p) {
  return typeof p === 'string' && path.isAbsolute(p) && PROFILE_EXTS.has(path.extname(p).toLowerCase());
}

handle('profile:get', async () => {
  if (!monitorProfilePath) return null;
  try {
    const bytes = await fs.promises.readFile(monitorProfilePath);
    return { path: monitorProfilePath, name: path.basename(monitorProfilePath), bytes };
  } catch (e) {
    return null;
  }
});

handle('profile:list', async () => {
  try {
    const names = await fs.promises.readdir(COLOR_DIR);
    const list = [];
    for (const name of names) {
      if (!PROFILE_EXTS.has(path.extname(name).toLowerCase())) continue;
      const full = path.join(COLOR_DIR, name);
      try {
        const st = await fs.promises.stat(full);
        list.push({ name, path: full, mtimeMs: Math.round(st.mtimeMs) });
      } catch (e) { /* 飛ばす */ }
    }
    // 新しい順（キャリブレーションで作ったプロファイルが上に来やすい）
    return list.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 300);
  } catch (e) {
    return [];
  }
});

handle('profile:read', async (p) => {
  if (!isProfilePath(p)) throw new Error('ICCプロファイル(.icc/.icm)ではありません');
  const st = await fs.promises.stat(p);
  if (!st.isFile() || st.size > 32 * 1024 * 1024) throw new Error('読み込めないファイルです');
  return { path: p, name: path.basename(p), bytes: await fs.promises.readFile(p) };
});

handle('profile:choose', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'モニタープロファイル(ICC)を選択',
    defaultPath: fs.existsSync(COLOR_DIR) ? COLOR_DIR : undefined,
    properties: ['openFile'],
    filters: [{ name: 'ICCプロファイル', extensions: ['icc', 'icm'] }],
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  return { path: r.filePaths[0], name: path.basename(r.filePaths[0]) };
});

// 使うプロファイルを保存して、アプリを再起動する（null で「OS標準に戻す」）
handle('profile:set', async (p) => {
  if (p !== null && !isProfilePath(p)) throw new Error('ICCプロファイル(.icc/.icm)ではありません');
  if (p !== null && !fs.existsSync(p)) throw new Error('ファイルが見つかりません');
  saveSettings(userDataDir, { ...settings, monitorProfilePath: p });
  if (process.env.PCI_E2E) return { ok: true, relaunch: false };
  setTimeout(() => { app.relaunch(); app.exit(0); }, 300);
  return { ok: true, relaunch: true };
});
