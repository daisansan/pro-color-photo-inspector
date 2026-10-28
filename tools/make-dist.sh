#!/bin/bash
# 配布用フォルダとZIPを作る（元のソースは変更しない）。
# 使い方: tools/make-dist.sh [Electron(Windows x64)のzip] [出力先フォルダ]
#   例:   tools/make-dist.sh ~/dl/electron-v45.0.0-win32-x64.zip ~/dist
# できるもの: <出力先>/ProColorPhotoInspector/（そのまま動くフォルダ）と ProColorPhotoInspector-win-x64.zip
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON_ZIP="${1:-$HOME/dl/electron-v45.0.0-win32-x64.zip}"
OUT="${2:-$HOME/dist}"
APPNAME=ProColorPhotoInspector
DIR="$OUT/$APPNAME"
VER="$(node -p "require('$SRC/package.json').version")"

[ -f "$ELECTRON_ZIP" ] || { echo "Electronのzipが見つかりません: $ELECTRON_ZIP"; exit 1; }
rm -rf "$DIR" "$OUT/$APPNAME-win-x64.zip"
mkdir -p "$DIR"

echo "[1/6] Electron(実行環境)を展開"
unzip -q "$ELECTRON_ZIP" -d "$DIR"
mv "$DIR/electron.exe" "$DIR/$APPNAME.exe"
rm -f "$DIR/resources/default_app.asar"

echo "[2/6] 使わない言語ファイルを削除（日本語と英語だけ残す）"
find "$DIR/locales" -name '*.pak' ! -name 'ja.pak' ! -name 'en-US.pak' -delete

echo "[3/6] アプリ本体を resources/app へコピー"
APP="$DIR/resources/app"
mkdir -p "$APP/build"
cp "$SRC/main.js" "$SRC/preload.js" "$SRC/package.json" "$APP/"
cp -r "$SRC/lib" "$SRC/src" "$APP/"
cp "$SRC/build/icon.ico" "$SRC/build/icon.png" "$APP/build/"

echo "[4/6] exeのアイコンを変更"
node "$SRC/tools/patch-icon.js" "$DIR/$APPNAME.exe"

echo "[5/6] 説明書を追加"
cp "$SRC/tools/dist-readme.txt" "$DIR/README.txt"
sed -i "s/__VERSION__/$VER/" "$DIR/README.txt"

echo "[6/6] ZIPを作成"
( cd "$OUT" && zip -qr -9 "$APPNAME-win-x64.zip" "$APPNAME" )
echo "完了: $OUT/$APPNAME-win-x64.zip  ($(du -h "$OUT/$APPNAME-win-x64.zip" | cut -f1))"
