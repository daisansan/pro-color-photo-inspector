@echo off
chcp 65001 >nul
rem ============================================================
rem  Pro Color Photo Inspector - Windows用exeをビルドするバッチ
rem  必要なもの: Node.js (https://nodejs.org/ja の LTS版) とインターネット接続
rem  使い方    : このファイルをダブルクリック
rem  できるもの: dist フォルダに
rem                ProColorPhotoInspector-portable.exe （インストール不要の単体exe）
rem                ProColorPhotoInspector-Setup.exe    （インストーラー）
rem ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [エラー] Node.js が見つかりません。https://nodejs.org/ja から LTS 版をインストールしてください。
  pause
  exit /b 1
)

echo.
echo === 1/2 必要なパッケージをインストールしています（初回は数分かかります） ===
call npm install
if errorlevel 1 goto :fail

echo.
echo === 2/2 exeを作成しています ===
call npm run dist
if errorlevel 1 goto :fail

echo.
echo 完了しました。dist フォルダを開きます。
start "" "%~dp0dist"
pause
exit /b 0

:fail
echo.
echo [エラー] ビルドに失敗しました。上のメッセージを確認してください。
pause
exit /b 1
