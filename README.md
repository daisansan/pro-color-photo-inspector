# Pro Color Photo Inspector（Windows版）

Geminiで作成したブラウザ版アプリを、Electronで Windows デスクトップアプリにしたものです。
画面・操作はブラウザ版と同じです。インターネット接続なしでも動きます。

## 変更点（ブラウザ版との違い）

- Tailwind CSS / Font Awesome / exif-js を CDN ではなく同梱（オフライン動作）
- 「選別済み写真を書き出し」は、保存先フォルダを選ぶと、その中に「保存フォルダ名」（初期値 `choice`）のフォルダを作って **元の写真をコピー** します。
  同名ファイルは上書きせず `名前 (2).jpg` のように連番が付きます。
- メニューバーは非表示（`F10` を書き出しショートカットとして使えるようにするため）
- `F11` で全画面の切り替え

## フォルダ構成

| 場所 | 内容 |
|---|---|
| `src/index.html` | アプリ本体（Geminiで作ったHTMLをベースに修正） |
| `src/vendor/` | 同梱ライブラリ（`tailwind.css` は自動生成） |
| `main.js` / `preload.js` / `lib/export.js` | Electron側の処理（ウィンドウ、書き出し） |
| `original/gemini-original.html` | 変更前の元HTML（参照用） |

## 自分でexeを作り直す（Windows）

1. [Node.js](https://nodejs.org/ja) の LTS 版をインストール
2. `build.bat` をダブルクリック
3. `dist` フォルダにできあがり
   - `ProColorPhotoInspector-portable.exe` … インストール不要の単体exe
   - `ProColorPhotoInspector-Setup.exe` … インストーラー

`src/index.html` を直した後は、`npm run build:css`（スタイル再生成）→ `npm run dist` の順で実行します。
開発中の動作確認は `npm install` の後に `npm start`。

## ライセンス

同梱ライブラリ: Electron (MIT) / Tailwind CSS (MIT) / Font Awesome Free (`src/vendor/fontawesome/LICENSE.txt`) / exif-js (MIT)
