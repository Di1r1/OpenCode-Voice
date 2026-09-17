# OpenCode Voice

Голосовой ввод для [OpenCode](https://opencode.ai): говоришь — текст попадает в поле ввода промпта. Поддерживает локальное распознавание (`faster-whisper`) и облачное (OpenAI Whisper API), push-to-talk в TUI и кнопку 🎤 в web UI.

[English](README.md) | **Русский**

## Компоненты

| Часть | Что делает |
|-------|------------|
| `src/` | Плагин OpenCode (TS): команда `/voice`, запись push-to-talk, STT-бэкенды |
| `.opencode/` | Конфиг OpenCode (агенты, скиллы, команда `/voice`, TUI/web-плагины) |
| `stt-server/` | Flask + faster-whisper: серверная запись через PulseAudio (WSL) и распознавание |
| `extension/` | Расширение Chrome (MV3): кнопка 🎤 в web UI, гибридная запись (браузер → сервер) |
| `voice-button.user.js` | Альтернатива расширению — userscript для Tampermonkey |
| `sync-plugin.sh` | Синхронизация `src/index.ts` → `.opencode/plugins/index.ts` |

## Требования

- Windows 10/11 + WSL2 с WSLg (аудио идёт через WSLg-PulseAudio).
- Node.js + npm — для плагина.
- Python 3.9+ — для STT-сервера.
- Системные пакеты: `alsa-utils` (`arecord`), `libasound2-plugins`, `ffmpeg` (опционально).

## Установка

### 1. Аудио в WSL2

```bash
sudo apt-get update
sudo apt-get install -y alsa-utils libasound2-plugins ffmpeg
export PULSE_SERVER=unix:/mnt/wslg/PulseServer

# проверка
pactl info
arecord -D pulse -f cd -d 3 /tmp/t.wav && ls -la /tmp/t.wav   # файл должен быть ~500 КБ, не 44 байта
```

> В WSL2 нет `/dev/snd` — это нормально. Микрофон доступен только через `PULSE_SERVER=unix:/mnt/wslg/PulseServer`.

### 2. STT-сервер

```bash
cd voice-opencode-plugin/stt-server
pip install --no-input faster-whisper flask requests

export PULSE_SERVER=unix:/mnt/wslg/PulseServer
python3 stt_server.py --model small --port 8765
```

Плагин сам запускает этот сервер при загрузке OpenCode (если он ещё не запущен) и следит за его живостью — ручной запуск необязателен.

Модели: `tiny` / `base` / `small` (по умолчанию) / `medium`. Проверка: `curl -s localhost:8765/health`.

Без микрофона можно проверить весь пайплайн на готовом WAV:

```bash
OPENCODE_VOICE_FAKE_AUDIO=/tmp/test-voice.wav python3 stt_server.py --port 8765
```

Тесты маршрутов: `python3 test_stt_server.py --port 8765`.

### Опционально: ускорение на GPU (NVIDIA + CUDA, WSL2)

По умолчанию сервер считает на CPU через `faster-whisper`. Если в WSL2 проброшена NVIDIA-видеокарта, можно использовать `whisper.cpp` с CUDA (проверено на GTX 950M / Maxwell, CC 5.0).

1. Обнови драйвер NVIDIA в Windows до ветки с поддержкой WSL (R470+); после перезагрузки должен появиться `/usr/lib/wsl/lib/libcuda.so.1`.
2. Поставь CUDA Toolkit в домашний каталог (без root). Нужна версия, поддерживающая твою карту — CUDA 13 убрала Maxwell/Pascal, поэтому для них 12.6:

```bash
sh cuda_12.6.0_560.28.03_linux.run --silent --toolkit --toolkitpath=$HOME/cuda-12.6 --no-opengl-libs --no-man-page --override
```

3. Собери whisper.cpp с CUDA. Вместо `<cc>` — вычислительная способность (`50` Maxwell, `61` Pascal, `75` Turing, `86` Ampere):

```bash
git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp
cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=<cc> -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_BUILD_TESTS=OFF -DCUDAToolkit_ROOT=$HOME/cuda-12.6 \
  -DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler \
  -DCMAKE_EXE_LINKER_FLAGS="-L$HOME/cuda-12.6/lib64 -Wl,--copy-dt-needed-entries"
cmake --build build -j4 --target whisper-cli
```

4. Положи CLI и модель туда, где сервер их ищет:

```bash
DEST=$HOME/.local/share/opencode-voice/whisper
mkdir -p $DEST/bin
cp build/bin/whisper-cli build/bin/*.so* $DEST/bin/
cp models/ggml-small.bin $DEST/
```

Сервер сам обнаружит CLI и переключится на него (`curl -s localhost:8765/health` покажет `"backend":"whispercpp"`). Принудительно вернуть CPU: `OPENCODE_VOICE_STT_BACKEND=faster-whisper`.

### 3. Плагин OpenCode

```bash
cd voice-opencode-plugin
npm install
bash sync-plugin.sh     # после правок src/index.ts
npm run typecheck
```

`opencode.json` уже подключает плагин (`./.opencode/plugins/index.ts`), `tui.json` — TUI/web-части. Запуск:

```bash
export OPENCODE_VOICE_BACKEND=local OPENCODE_VOICE_LANGUAGE=ru PULSE_SERVER=unix:/mnt/wslg/PulseServer
opencode web --hostname 0.0.0.0
```

### 4. Расширение Chrome (кнопка 🎤)

1. Открыть `chrome://extensions`, включить **Developer mode**.
2. **Load unpacked** → выбрать папку `voice-opencode-plugin/extension`.
3. Открыть web UI OpenCode — кнопка 🎤 появится рядом с полем ввода.

Расширение обращается к STT-серверу по `http(s)://<host>:8765` (порт `STT_PORT` в `extension/content.js`). В `extension/manifest.json` уже прописаны `localhost`/`127.0.0.1`; при смене хоста добавьте его в `host_permissions`.

### 5. Userscript (альтернатива расширению)

Установить `voice-button.user.js` в Tampermonkey (или аналог) — добавляет кнопку 🎤 без расширения.

## Команды `/voice`

| Команда | Действие |
|---------|----------|
| `/voice` | Push-to-talk: запись → распознавание → вставка текста в промпт |
| `/voice <file.wav>` | Распознать локальный аудиофайл (без микрофона) |
| `/voice backend [local\|api]` | Показать/сменить STT-бэкенд |
| `/voice lang [ru\|en\|auto]` | Показать/сменить язык |

TUI: хоткей `<leader>v` (лидер по умолчанию `ctrl+x`) запускает push-to-talk.

## Конфигурация (переменные окружения)

| Переменная | Назначение | По умолчанию |
|------------|-----------|--------------|
| `OPENCODE_VOICE_BACKEND` | `local` \| `api` | `local` |
| `OPENCODE_VOICE_LANGUAGE` | `ru` \| `en` \| `auto`/пусто (авто) | `ru` |
| `OPENAI_API_KEY` | ключ для бэкенда `api` | — |
| `WHISPER_MODEL` | модель для локального бэкенда плагина | `small` |
| `WHISPER_BEAM_SIZE` | beam size декодера (`1` = greedy, быстрее всего) | `1` |
| `WHISPER_VAD` | VAD-фильтр (`1`/`0`) | `1` |
| `WHISPER_INITIAL_PROMPT` | подсказка-контекст для Whisper | пусто (выкл) |
| `WHISPER_LANG_DETECT_SEGMENTS` | сегментов для авто-определения языка | `3` |
| `WHISPER_LANG_DETECT_THRESHOLD` | порог уверенности языка | `0.6` |
| `OPENCODE_VOICE_STT_BACKEND` | `whispercpp` (GPU) \| `faster-whisper` (CPU); пусто = авто | авто |
| `WHISPER_CPP_BIN` | путь к CLI whisper.cpp | `~/.local/share/opencode-voice/whisper/bin/whisper-cli` |
| `WHISPER_CPP_MODEL` | путь к ggml-модели whisper.cpp | `~/.local/share/opencode-voice/whisper/ggml-small.bin` |
| `OPENCODE_VOICE_MAX_SECONDS` | максимум записи на сервере | `120` |
| `OPENCODE_VOICE_FAKE_AUDIO` | путь к WAV для теста без микрофона | — |
| `OPENCODE_VOICE_AUTO_RECOVER` | авто-пересоздание аудиоканала WSLg при молчащем источнике | `1` |
| `OPENCODE_VOICE_KEEP_AUDIO` | каталог для сохранения записанного аудио (отладка) | — |
| `OPENCODE_VOICE_SERVER` | авто-запуск STT-сервера при загрузке плагина | `1` |
| `OPENCODE_VOICE_SERVER_SCRIPT` | путь к `stt_server.py` (нестандартная раскладка) | авто |
| `OPENCODE_VOICE_PORT` | порт STT-сервера | `8765` |
| `OPENCODE_VOICE_SERVER_WATCHDOG_MS` | период проверки/перезапуска, `0` = выкл | `120000` |
| `PULSE_SERVER` | сокет PulseAudio | авто `/mnt/wslg/PulseServer` |

На коротких фразах авто-определение языка ограничено: если обычно говорите на одном языке, надёжнее задать его явно (`OPENCODE_VOICE_LANGUAGE=ru`).

## Если микрофон недоступен

Сервер отвечает одной из двух ошибок:

- `Нет доступа к микрофону: PulseAudio не отвечает…` — рекордер не смог подключиться.
- `Аудиоисточник молчит: рекордер подключился, но данных нет (получено N байт)…` — подключился, но WSLg не отдаёт звук по каналу `audin`.

Проверка:

```bash
PULSE_SERVER=unix:/mnt/wslg/PulseServer pactl info
PULSE_SERVER=unix:/mnt/wslg/PulseServer arecord -D pulse -f cd -r 16000 -c 1 -t wav -d 3 /tmp/t.wav
```

**Быстрый фикс:** запусти скрипт (пересоздаёт внутренний RDP-канал WSLg — перезапускает weston и pulseaudio):

```bash
bash voice-opencode-plugin/fix-mic.sh
```

STT-сервер умеет самовосстанавливаться: при молчащем источнике он один раз пересоздаёт аудиоканал WSLg и повторяет запись (отключается через `OPENCODE_VOICE_AUTO_RECOVER=0`).

Те же шаги вручную (без `wsl --shutdown`), выполнять из WSL:

```bash
# 1. пересоздать RDP-сессию WSLg (WSLGd сам поднимет weston); GUI WSLg перезапустится
/mnt/c/Windows/System32/wsl.exe --system -e sh -lc 'pkill -9 -x weston'
sleep 8
# 2. перезапустить PulseAudio, чтобы подключился к свежему каналу
/mnt/c/Windows/System32/wsl.exe --system -e sh -lc 'pkill -9 -x pulseaudio'
sleep 5
# 3. проверка: должен записаться реальный файл (~500 КБ), а не 44 байта
PULSE_SERVER=unix:/mnt/wslg/PulseServer arecord -D pulse -f cd -d 3 /tmp/t.wav && ls -la /tmp/t.wav
```

Также проверьте доступ приложения к микрофону в Windows (Параметры → Конфиденциальность → Микрофон); в RDP-сессии включите «Запись с этого компьютера». Если не помогло — полный рестарт: `wsl --shutdown` (из Windows PowerShell) и заново открыть WSL.

## Структура

```
voice-opencode-plugin/
├── src/                     # код плагина (index.ts, lib/config.ts, lib/stt.ts, lib/recorder.ts)
├── .opencode/               # конфиг OpenCode: agents, commands, plugins, skills, tui, web
├── stt-server/              # Flask + faster-whisper: stt_server.py, test_stt_server.py
├── extension/               # Chrome-расширение (MV3)
├── voice-button.user.js     # userscript
├── fix-mic.sh               # пересоздание аудиоканала WSLg (фикс микрофона)
├── sync-plugin.sh           # src/index.ts -> .opencode/plugins/index.ts
├── opencode.json            # подключение плагина + агенты
├── tui.json                 # TUI/web-плагины + хоткеи
├── AGENTS.md                # заметки по архитектуре
└── TEST_PLAN.md             # план тестирования
```

## Лицензия

MIT
