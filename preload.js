'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

// 画面側(index.html)から使える、最小限の機能だけを公開する
contextBridge.exposeInMainWorld('nativeApp', {
  isElectron: true,

  // ドラッグ/選択したFileオブジェクトから、元ファイルのフルパスを取得する
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (e) {
      return '';
    }
  },

  // ウィンドウのフルスクリーン（大画面表示に連動）
  setFullScreen: (on) => call('window:set-fullscreen', !!on),
  onFullScreenChange: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('window:fullscreen', (_event, on) => cb(!!on));
  },

  // 選別した写真をフォルダへ書き出す（保存先はダイアログで選ぶ）
  exportPicked: (filePaths, subFolderName) => call('export-picked', { filePaths, subFolderName }),

  // PC内のフォルダ閲覧
  getRoots: () => call('fs:roots'),
  listDir: (dirPath) => call('fs:list-dir', dirPath),
  countImages: (dirPaths) => call('fs:count-images', dirPaths),
  listImages: (dirPath) => call('fs:list-images', dirPath),
  ancestorsOf: (p) => call('fs:ancestors', p),
  chooseFolder: (defaultPath) => call('dialog:choose-folder', defaultPath),
  chooseFiles: () => call('dialog:choose-files'),

  // 画像本体の読み込み（Uint8Arrayで返る）
  readImage: (filePath) => call('images:read', filePath),

  // 縮小サムネイルのURL（main.js が pci-thumb:// を処理する）
  thumbUrl: (filePath, mtimeMs, size) =>
    `pci-thumb://t/?p=${encodeURIComponent(filePath)}&m=${mtimeMs || 0}&s=${size || 0}`,

  // 星評価・Pick/Rejectの保存と復元
  loadSelections: (folder) => call('selections:load', folder),
  saveSelections: (folder, items) => call('selections:save', folder, items),
  saveSelectionsSync: (folder, items) => ipcRenderer.sendSync('selections:save-sync', folder, items),

  // モニタープロファイル
  getMonitorProfile: () => call('profile:get'),
  listProfiles: () => call('profile:list'),
  readProfile: (p) => call('profile:read', p),
  chooseProfile: () => call('profile:choose'),
  setMonitorProfile: (p) => call('profile:set', p),
});
