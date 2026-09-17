#!/usr/bin/env bash
# OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
# OpenCode Voice — установка "под ключ".
#
# По умолчанию (CPU): проверяет зависимости, ставит Python-пакеты (faster-whisper),
# генерирует entry-файлы плагина и показывает, что прописать в конфиге OpenCode.
# С --gpu дополнительно собирает whisper.cpp с CUDA и скачивает ggml-модель.
#
# Использование:
#   ./setup.sh                     # CPU: зависимости + проверки
#   ./setup.sh --gpu               # + собрать whisper.cpp (CUDA) + модель
#   ./setup.sh --model-size small  # размер ggml-модели для --gpu (tiny|base|small|medium|large-v3)
#   ./setup.sh --check             # только проверить окружение и показать план (ничего не менять)
#   ./setup.sh --configure         # показать, а с флагом --write-config — вписать пути в ~/.config/opencode/*.json (с бэкапом)
#   ./setup.sh --yes               # не задавать вопросов
#   ./setup.sh --no-pip            # не ставить Python-пакеты
#
# Переменные: OPENCODE_VOICE_HOME (по умолчанию ~/.local/share/opencode-voice),
#             OPENCODE_VOICE_WHISPER_DIR (по умолчанию $OPENCODE_VOICE_HOME/whisper),
#             CUDA_HOME/CUDA_PATH (если CUDA Toolkit в нестандартном месте).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

MODE_GPU=0
CHECK_ONLY=0
ASSUME_YES=0
DO_PIP=1
DO_SYNC=1
CONFIGURE=0
WRITE_CONFIG=0
MODEL_SIZE="${WHISPER_CPP_MODEL_SIZE:-medium}"

HOME_DIR="${OPENCODE_VOICE_HOME:-$HOME/.local/share/opencode-voice}"
WHISPER_DIR="${OPENCODE_VOICE_WHISPER_DIR:-$HOME_DIR/whisper}"
OPENCODE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"

C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_OFF" "$*"; }
err()  { printf '%s✗%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; }
info() { printf '%s·%s %s\n' "$C_DIM" "$C_OFF" "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

for arg in "$@"; do
  case "$arg" in
    --gpu) MODE_GPU=1 ;;
    --cpu) MODE_GPU=0 ;;
    --check) CHECK_ONLY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --no-pip) DO_PIP=0 ;;
    --no-sync) DO_SYNC=0 ;;
    --configure) CONFIGURE=1 ;;
    --write-config) CONFIGURE=1; WRITE_CONFIG=1 ;;
    --model-size) shift; MODEL_SIZE="${1:?--model-size требует значение}" ;;
    --model-size=*) MODEL_SIZE="${arg#*=}" ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "неизвестный флаг: $arg (см. --help)"; exit 2 ;;
  esac
done

ask() {
  # ask "вопрос" -> 0 (да) / 1 (нет)
  [ "$ASSUME_YES" = "1" ] && return 0
  read -r -p "$1 [y/N] " a || true
  case "${a:-n}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

in_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }

echo "OpenCode Voice — установка"
info "репозиторий:  $REPO"
info "модель/каталог: $WHISPER_DIR (размер: $MODEL_SIZE)"
[ "$MODE_GPU" = "1" ] && info "режим: GPU (whisper.cpp + CUDA)" || info "режим: CPU (faster-whisper)"
echo

# ---------------------------------------------------------------------------
# 1. Проверка окружения
# ---------------------------------------------------------------------------
echo "== Проверка зависимостей =="
MISSING=0
need() {
  local cmd="$1" hint="$2"
  if have "$cmd"; then ok "$cmd"; else warn "$cmd не найден — $hint"; MISSING=1; fi
}

if have python3; then
  PYVER="$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo 0.0)"
  case "$PYVER" in
    3.[0-8]) warn "Python $PYVER < 3.9 — нужен 3.9+"; MISSING=1 ;;
    *) ok "python3 $PYVER" ;;
  esac
else
  warn "python3 не найден — нужен Python 3.9+"; MISSING=1
fi
have node && ok "node $(node -v 2>/dev/null)" || warn "node не найден — нужен Node.js 20+ (для плагина)"
need npm "нужен для плагина"
need ffmpeg "нужен для конвертации WebM/Opus из браузера"
need curl "нужен для скачивания модели (--gpu)"
if have arecord; then ok "arecord (alsa-utils)"; else
  if in_wsl; then warn "arecord не найден — в WSLg: sudo apt-get install -y alsa-utils libasound2-plugins"; else
    warn "arecord не найден — sudo apt-get install -y alsa-utils"; fi
fi
in_wsl && ok "окружение WSL2 (микрофон через WSLg PulseAudio)" || info "не WSL2: задайте OPENCODE_VOICE_SOURCE (pactl get-default-source)"

if [ "$MODE_GPU" = "1" ]; then
  echo
  echo "== Проверка GPU-сборки =="
  need cmake "нужен для сборки whisper.cpp"
  need git "нужен для сборки whisper.cpp"
  CUDA_ROOT="${CUDA_HOME:-${CUDA_PATH:-}}"
  if [ -z "$CUDA_ROOT" ]; then
    for d in /usr/local/cuda ~/cuda-12.6 ~/cuda-12.4 ~/cuda /opt/cuda; do [ -d "$d" ] && { CUDA_ROOT="$d"; break; }; done
  fi
  if [ -n "$CUDA_ROOT" ] && [ -x "$CUDA_ROOT/bin/nvcc" ]; then
    export CUDA_HOME="$CUDA_ROOT"
    export PATH="$CUDA_ROOT/bin:$PATH"
    ok "CUDA Toolkit: $CUDA_ROOT ($("$CUDA_ROOT/bin/nvcc" --version 2>/dev/null | grep -oE 'release [0-9.]+' | head -1))"
  elif have nvcc; then
    CUDA_ROOT="$(dirname "$(dirname "$(command -v nvcc)")")"
    ok "CUDA Toolkit: $(command -v nvcc)"
  else
    warn "CUDA Toolkit (nvcc) не найден — установите CUDA 12.x или задайте CUDA_HOME"
  fi
  have nvidia-smi && info "GPU: $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo '?')"
fi

if [ "$CHECK_ONLY" = "1" ]; then
  echo
  [ "$MISSING" = "1" ] && warn "чего-то не хватает (см. выше) — установите и повторите" || ok "окружение готово"
  echo
  echo "== План (--check ничего не меняет) =="
  n=0
  if [ "$DO_PIP" = "1" ]; then n=$((n+1)); echo "  $n. python3 -m pip install -r voice-opencode-plugin/stt-server/requirements.txt (faster-whisper)"; fi
  if [ "$MODE_GPU" = "1" ]; then n=$((n+1)); echo "  $n. собрать whisper.cpp с CUDA и скачать ggml-$MODEL_SIZE.bin в $WHISPER_DIR"; fi
  if [ "$DO_SYNC" = "1" ]; then n=$((n+1)); echo "  $n. bash voice-opencode-plugin/sync-plugin.sh (сгенерировать entry-файлы)"; fi
  n=$((n+1)); echo "  $n. показать строки для ~/.config/opencode/opencode.json и tui.json"
  n=$((n+1)); echo "  $n. bash voice-opencode-plugin/doctor.sh"
  exit 0
fi

# ---------------------------------------------------------------------------
# 2. Python-зависимости (CPU-путь: faster-whisper)
# ---------------------------------------------------------------------------
echo
echo "== Python-зависимости =="
REQ="$HERE/stt-server/requirements.txt"
if [ "$DO_PIP" = "1" ] && [ "$CHECK_ONLY" != "1" ]; then
  if [ -f "$REQ" ]; then
    if python3 -m pip --version >/dev/null 2>&1; then
      info "pip install -r $REQ (может занять пару минут)"
      if python3 -m pip install -r "$REQ"; then ok "Python-пакеты установлены"; else
        warn "pip install не удался — поставьте вручную: python3 -m pip install -r $REQ"; fi
    else
      warn "pip недоступен (python3 -m ensurepip --upgrade, либо apt-get install python3-pip)"
    fi
  else
    warn "нет $REQ"
  fi
else
  info "пропущено (--no-pip)"
fi

# ---------------------------------------------------------------------------
# 3. whisper.cpp + ggml-модель (--gpu)
# ---------------------------------------------------------------------------
if [ "$MODE_GPU" = "1" ]; then
  echo
  echo "== whisper.cpp (CUDA) =="
  SRC_DIR="${OPENCODE_VOICE_WHISPER_SRC:-$HOME_DIR/src/whisper.cpp}"
  BIN_DIR="$WHISPER_DIR/bin"
  mkdir -p "$WHISPER_DIR" "$BIN_DIR"

  if [ ! -d "$SRC_DIR" ]; then
    mkdir -p "$(dirname "$SRC_DIR")"
    info "git clone whisper.cpp -> $SRC_DIR"
    git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$SRC_DIR" || warn "clone не удался"
  else
    info "использую существующий $SRC_DIR"
  fi

  if [ -d "$SRC_DIR" ]; then
    CUDA_ROOT="${CUDA_HOME:-${CUDA_PATH:-/usr/local/cuda}}"
    CC_ARCH="75"
    if have nvidia-smi; then
      CAP="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d ' ')"; [ -n "$CAP" ] && CC_ARCH="$(echo "$CAP" | tr -d '.')"
    fi
    info "CUDA arch: $CC_ARCH, toolkit: $CUDA_ROOT"
    JOBS="$(nproc 2>/dev/null || echo 4)"
    CMAKE_ARGS=(
      -S "$SRC_DIR" -B "$SRC_DIR/build-cuda"
      -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$CC_ARCH" -DCMAKE_BUILD_TYPE=Release
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON
      -DCUDAToolkit_ROOT="$CUDA_ROOT" -DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler
    )
    if [ -d "$CUDA_ROOT/lib64" ]; then
      CMAKE_ARGS+=( -DCMAKE_EXE_LINKER_FLAGS="-L$CUDA_ROOT/lib64 -Wl,--copy-dt-needed-entries -Wl,-rpath,$CUDA_ROOT/lib64" )
    fi
    if cmake "${CMAKE_ARGS[@]}" \
      && cmake --build "$SRC_DIR/build-cuda" --config Release -j"$JOBS" --target whisper-cli; then
      ok "whisper-cli собран"
      BB="$SRC_DIR/build-cuda/bin"
      [ -f "$BB/whisper-cli" ] && cp -af "$BB/whisper-cli" "$BIN_DIR/" || true
      cp -af "$BB"/*.so* "$BIN_DIR/" 2>/dev/null || true
      ok "бинарник и библиотеки -> $BIN_DIR"
    else
      warn "сборка whisper.cpp не удалась — останется CPU-путь (faster-whisper)"
    fi
  fi

  MODEL="$WHISPER_DIR/ggml-$MODEL_SIZE.bin"
  if [ -s "$MODEL" ]; then
    ok "модель уже есть: $MODEL"
  else
    URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL_SIZE.bin"
    info "скачиваю ggml-$MODEL_SIZE.bin ($URL)"
    if curl -fL --retry 3 -o "$MODEL.part" "$URL"; then mv -f "$MODEL.part" "$MODEL"; ok "модель: $MODEL"; else
      rm -f "$MODEL.part"; warn "не удалось скачать модель — скачайте вручную в $WHISPER_DIR"
    fi
  fi

  echo
  info "проверка GPU-пути:"
  if [ -x "$BIN_DIR/whisper-cli" ] && [ -s "$MODEL" ]; then
    if LD_LIBRARY_PATH="$BIN_DIR:${CUDA_ROOT}/lib64:/usr/lib/wsl/lib:${LD_LIBRARY_PATH:-}" \
        "$BIN_DIR/whisper-cli" --help >/dev/null 2>&1; then
      ok "whisper-cli запускается (LD_LIBRARY_PATH найден)"
    else
      warn "whisper-cli не запустился — проверьте CUDA-драйвер/библиотеки (doctor.sh)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 4. Entry-файлы плагина (sync) + проверка
# ---------------------------------------------------------------------------
if [ "$DO_SYNC" = "1" ] && [ "$CHECK_ONLY" != "1" ] && [ -x "$HERE/sync-plugin.sh" ]; then
  echo
  echo "== Плагин =="
  if bash "$HERE/sync-plugin.sh" >/dev/null 2>&1; then ok "entry-файлы сгенерированы ($HERE/.opencode/)"; else
    warn "sync-plugin.sh завершился с ошибкой — запустите вручную: bash $HERE/sync-plugin.sh"; fi
fi

# ---------------------------------------------------------------------------
# 5. Конфиг OpenCode: показать (или записать с --write-config)
# ---------------------------------------------------------------------------
PLUGIN_ENTRY="$HERE/.opencode/plugins/index.ts"
TUI_ENTRY="$HERE/.opencode/tui/voice.ts"

print_config() {
  cat <<EOF
Добавьте в ~/.config/opencode/opencode.json:

  "plugin": [
    ...,
    "file://$PLUGIN_ENTRY"
  ],
  "skills": { "paths": ["$HERE/.opencode/skills"] }

И в ~/.config/opencode/tui.json:

  "plugin": ["file://$TUI_ENTRY"]

После правки конфига перезапустите OpenCode.
EOF
}

echo
if [ "$CONFIGURE" = "1" ]; then
  echo "== Конфиг OpenCode =="
  if [ "$WRITE_CONFIG" != "1" ]; then
    print_config
  else
    python3 - "$OPENCODE_CONFIG_DIR/opencode.json" "$PLUGIN_ENTRY" "$HERE/.opencode/skills" <<'PY'
import json, os, shutil, sys
cfg, entry, skills = sys.argv[1], sys.argv[2], sys.argv[3]
plugin_url = "file://" + entry
data = {}
if os.path.exists(cfg):
    with open(cfg, encoding="utf-8") as f:
        data = json.load(f)
    shutil.copy2(cfg, cfg + ".bak")
plugins = data.get("plugin")
if not isinstance(plugins, list):
    plugins = []
if plugin_url not in plugins:
    plugins.append(plugin_url)
data["plugin"] = plugins
paths = (data.get("skills") or {}).get("paths")
if not isinstance(paths, list):
    paths = []
if skills not in paths:
    paths.append(skills)
data["skills"] = {**(data.get("skills") or {}), "paths": paths}
os.makedirs(os.path.dirname(cfg), exist_ok=True)
with open(cfg, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("обновлён:", cfg, "(бэкап: %s.bak)" % cfg)
PY
    ok "конфиг обновлён (перезапустите OpenCode)"
  fi
fi

# ---------------------------------------------------------------------------
# 6. Финал: doctor
# ---------------------------------------------------------------------------
echo
echo "== Проверка установки =="
if [ -x "$HERE/doctor.sh" ]; then
  bash "$HERE/doctor.sh" || true
else
  info "doctor.sh не найден — пропускаю"
fi

echo
echo "Готово. Что дальше:"
echo "  1) если меняли конфиг — перезапустите OpenCode;"
echo "  2) сервер поднимется сам при загрузке плагина (или: python3 -u $HERE/stt-server/stt_server.py --port 8765);"
echo "  3) в TUI: /voice  (push-to-talk), /voice doctor, /voice help;"
echo "  4) для кнопки в веб-UI установите расширение из $HERE/extension (chrome://extensions → Load unpacked)."
