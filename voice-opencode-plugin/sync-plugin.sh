#!/usr/bin/env bash
# OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
# Синхронизирует src/index.ts -> .opencode/plugins/index.ts
# с заменой путей импортов ("./lib/ -> "../../src/lib/).
#
# Использование:
#   bash sync-plugin.sh           # записать
#   bash sync-plugin.sh --check   # только проверить, что файл актуален (для CI)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$DIR/src/index.ts"
DST="$DIR/.opencode/plugins/index.ts"
MODE="${1:-write}"

if [[ ! -f "$SRC" ]]; then
  echo "Нет файла: $SRC" >&2
  exit 1
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
sed 's#"./lib/#"../../src/lib/#g' "$SRC" > "$TMP"

if [[ "$MODE" == "--check" ]]; then
  if diff -q "$TMP" "$DST" >/dev/null 2>&1; then
    echo "OK: .opencode/plugins/index.ts синхронизирован с src/index.ts"
    exit 0
  fi
  echo "FAIL: .opencode/plugins/index.ts устарел — запусти: bash sync-plugin.sh" >&2
  diff -u "$DST" "$TMP" | head -40 >&2 || true
  exit 1
fi

mkdir -p "$(dirname "$DST")"
cp "$TMP" "$DST"
echo "Синхронизировано: src/index.ts -> .opencode/plugins/index.ts"
grep -n 'import("' "$DST"
