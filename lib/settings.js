'use strict';

/**
 * アプリの設定（settings.json）。
 * 起動直後、ウィンドウを作る前に読む必要があるため、同期処理にしています。
 * 現在の設定項目:
 *   monitorProfilePath: 使用するモニタープロファイル(ICC)のファイルパス。未設定は null。
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = { monitorProfilePath: null };

function loadSettings(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    return { ...DEFAULTS, ...(data && typeof data === 'object' ? data : {}) };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function saveSettings(dir, settings) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...DEFAULTS, ...settings }, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = { loadSettings, saveSettings, DEFAULTS };
