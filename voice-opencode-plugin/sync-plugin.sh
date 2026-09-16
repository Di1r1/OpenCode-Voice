#!/usr/bin/env bash
# Синхронизирует src/index.ts -> .opencode/plugins/index.ts
# с заменой путей импортов ("./lib/ -> "../../src/lib/).
#
# Использование:
#   bash sync-plugin.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$DIR/src/index.ts"
DST="$DIR/.opencode/plugins/index.ts"

if [[ ! -f "$SRC" ]]; then
  echo "Нет файла: $SRC" >&2
  exit 1
fi

sed 's#"./lib/#"../../src/lib/#g' "$SRC" > "$DST"

echo "Синхронизировано: src/index.ts -> .opencode/plugins/index.ts"
grep -n 'import("' "$DST"
