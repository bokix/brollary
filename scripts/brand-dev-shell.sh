#!/bin/bash
# 给开发模式的 Electron 壳打上 Brollary 品牌（菜单栏名字）。
# electron 重装/升级后需要重跑一次。
set -e
cd "$(dirname "$0")/.."
APP="node_modules/electron/dist/Electron.app"
PLIST="$APP/Contents/Info.plist"
plutil -replace CFBundleName -string "Brollary" "$PLIST"
plutil -replace CFBundleDisplayName -string "Brollary" "$PLIST"
# 替换壳图标（「关于」窗口等处用）
cp assets/brollary.icns "$APP/Contents/Resources/electron.icns"
touch "$APP"
codesign --force --deep --sign - "$APP" 2>/dev/null
echo "✓ 开发壳已品牌化为 Brollary（含图标）"
