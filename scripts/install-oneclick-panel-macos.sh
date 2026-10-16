#!/bin/bash
# EditFlux ワンクリック編集パネルを Premiere Pro の CEP 拡張機能フォルダにインストールする (macOS)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_PANEL="$REPO_ROOT/cep-plugin-oneclick"
SRC_SERVER="$REPO_ROOT/automation-server"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/EditFluxOneClick"

if [ ! -d "$SRC_PANEL" ]; then
  echo "エラー: $SRC_PANEL が見つかりません" >&2
  exit 1
fi

echo "インストール先: $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC_PANEL"/. "$DEST"/
mkdir -p "$DEST/automation-server"
cp -R "$SRC_SERVER"/. "$DEST/automation-server"/

echo "CEP PlayerDebugMode を確認しています…"
for ver in 9 10 11 12; do
  plist="$HOME/Library/Preferences/com.adobe.CSXS.$ver.plist"
  if [ -f "$plist" ]; then
    /usr/libexec/PlistBuddy -c "Set :PlayerDebugMode 1" "$plist" 2>/dev/null \
      || /usr/libexec/PlistBuddy -c "Add :PlayerDebugMode string 1" "$plist" 2>/dev/null \
      || true
  fi
done

echo "完了しました。Premiere Proを再起動し、Window > Extensions > EditFlux ワンクリック編集 を開いてください。"
echo "ffmpegがPATHに必要です (jump-cut / telop の両方で使用します): brew install ffmpeg"
