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
pip install --no-input -r requirements.txt      # flask + faster-whisper (CPU-бэкенд)

export PULSE_SERVER=unix:/mnt/wslg/PulseServer
python3 stt_server.py --model medium --port 8765
```

Сервер по умолчанию слушает `127.0.0.1` и стартует даже без `faster-whisper`, если используется GPU-бэкенд (whisper.cpp) — CPU-пакет импортируется лениво.

Плагин сам запускает этот сервер при загрузке OpenCode (если он ещё не запущен) и следит за его живостью — ручной запуск необязателен.

Модели: `tiny` / `base` / `small` / `medium` (по умолчанию) / `large`. Проверка: `curl -s localhost:8765/health`.

Без микрофона можно проверить весь пайплайн на готовом WAV:

```bash
OPENCODE_VOICE_FAKE_AUDIO=/tmp/test-voice.wav python3 stt_server.py --port 8765
```

Тесты маршрутов: `python3 test_stt_server.py --port 8765` (ручной, нужен запущенный сервер). Герметичные юнит-тесты: `cd voice-opencode-plugin && pip install -r stt-server/requirements-dev.txt && pytest`.

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
cp models/ggml-medium.bin $DEST/
```

Сервер сам обнаружит CLI и переключится на него (`curl -s localhost:8765/health` покажет `"backend":"whispercpp"`, `"device":"cuda"`). Команда `/voice` в плагине использует тот же CLI, когда доступна CUDA. Если видеокарты нет (нет `libcuda`) — и плагин, и сервер автоматически откатываются на `faster-whisper` (CPU). Выбрать устройство явно: `/voice device cpu|gpu|auto` или `OPENCODE_VOICE_DEVICE=cpu` (аналогично `OPENCODE_VOICE_STT_BACKEND=faster-whisper`).

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

Опционально: кнопку 🎤 прямо в prompt OpenCode даёт `.opencode/web/voice.tsx` — добавьте её в список `plugin` своего TUI-конфига (`~/.config/opencode/tui.json`).

### 5. Userscript (устарело)

⚠️ `voice-button.user.js` — **deprecated**: оставлен только для совместимости и не обновляется. Используйте расширение Chrome: юзерскрипт работает со старым API, не умеет RAM-запись/бипы/настройки и использует тот же `id` кнопки, что и расширение (не включайте оба).

## Команды `/voice`

| Команда | Действие |
|---------|----------|
| `/voice` | Push-to-talk: запись → распознавание → вставка текста в промпт |
| `/voice <file.wav>` | Распознать локальный аудиофайл (без микрофона) |
| `/voice backend [local\|api]` | Показать/сменить STT-бэкенд |
| `/voice lang [ru\|en\|auto]` | Показать/сменить язык |
| `/voice device [auto\|gpu\|cpu]` | Показать/сменить устройство: GPU (whisper.cpp) или CPU (faster-whisper) |
| `/voice doctor [--fix]` | Диагностика пути «кнопка/расширение» (сервер, CORS, зависшая запись, микрофон) с авторемонтом по `--fix` |

TUI: хоткей `<leader>v` (лидер по умолчанию `ctrl+x`) запускает push-to-talk.

## CPU или GPU (локальное распознавание)

Локальный бэкенд использует GPU, когда он есть, и **автоматически откатывается на CPU**.

| Устройство | Что запускается |
|------------|-----------------|
| `auto` (по умолчанию) + CUDA (есть `libcuda`) | `whisper.cpp` + `ggml-medium.bin` на GPU |
| `auto` без видеокарты | `faster-whisper` (medium) на CPU |
| `gpu` | только `whisper.cpp` на GPU (при недоступности — ошибка, без тихого отката) |
| `cpu` | только `faster-whisper` на CPU |

Для CPU-пути **не нужна** сборка whisper.cpp/CUDA.

### Как вручную переключиться на CPU

В рантайме, для текущей сессии `/voice` (синоним `/voice dev`):

```
/voice device          # показать текущее
/voice device cpu      # CPU: faster-whisper
/voice device gpu      # GPU: whisper.cpp
/voice device auto     # GPU, если есть, иначе CPU
```

Постоянно, через переменные окружения:

```bash
export OPENCODE_VOICE_DEVICE=cpu              # предпочтительно
# старый алиас, то же самое:
export OPENCODE_VOICE_STT_BACKEND=faster-whisper
```

`/voice device` сбрасывается при перезапуске OpenCode — чтобы закрепить выбор, используйте переменную окружения.
STT-сервер (путь кнопки 🎤) тоже читает `OPENCODE_VOICE_DEVICE=cpu`; после смены переменной перезапустите сервер.

### Пример: машина без NVIDIA GPU

```bash
cd voice-opencode-plugin/stt-server
pip install --no-input faster-whisper flask requests
export OPENCODE_VOICE_DEVICE=cpu
export OPENCODE_VOICE_LANGUAGE=ru
# medium — по умолчанию; на медленном CPU возьмите модель меньше:
# export WHISPER_MODEL=small
export PULSE_SERVER=unix:/mnt/wslg/PulseServer
opencode web --hostname 0.0.0.0
```

### Модель и настройки распознавания

- Размер модели на CPU: `WHISPER_MODEL=medium` (по умолчанию) — `tiny` | `base` | `small` | `medium` | `large`.
- Файл модели на GPU: `WHISPER_CPP_MODEL=…/ggml-medium.bin` — можно указать любой `ggml-*.bin`.
- `WHISPER_CPP_BIN` — путь к бинарнику `whisper-cli`.
- `WHISPER_CPP_MODEL_FALLBACK` — ggml-модель, если `faster-whisper` не установлен (по умолчанию `ggml-small.bin`).
- `WHISPER_BEAM_SIZE` — beam декодера (`1` = greedy/быстрее всего, больше = чуть точнее, но медленнее).
- `WHISPER_VAD` — VAD-фильтр (`1`/`0`).
- `OPENCODE_VOICE_SILENCE_PEAK` / `OPENCODE_VOICE_SILENCE_RMS` — порог тишины: если пик и RMS ниже обоих значений, запись считается «без речи» (Whisper галлюцинирует на тишине). По умолчанию `700` / `80`.
- Авто-стоп `/voice`: запись идёт, пока вы говорите, и останавливается через ~1.5 с тишины (жёсткий предел — 60 с аудио). Остановка мягкая (SIGINT), поэтому WAV-заголовок остаётся корректным. При медленном RDP-звуке запись может занять больше реального времени.
- `WHISPER_INITIAL_PROMPT` — подсказка-контекст для Whisper (по умолчанию выкл).
- `WHISPER_LANG_DETECT_SEGMENTS` / `WHISPER_LANG_DETECT_THRESHOLD` — тонкая настройка авто-определения языка.
- `/voice lang ru|en|auto` — смена языка в рантайме; `/voice backend local|api` — локальные модели или OpenAI API.

Полный список переменных: [Конфигурация](#конфигурация-переменные-окружения) ниже.

## Конфигурация (переменные окружения)

| Переменная | Назначение | По умолчанию |
|------------|-----------|--------------|
| `OPENCODE_VOICE_BACKEND` | `local` \| `api` | `local` |
| `OPENCODE_VOICE_LANGUAGE` | `ru` \| `en` \| `auto`/пусто (авто) | `ru` |
| `OPENCODE_VOICE_DEVICE` | устройство: `auto` (GPU, иначе CPU) \| `gpu` \| `cpu` | `auto` |
| `OPENAI_API_KEY` | ключ для бэкенда `api` | — |
| `WHISPER_MODEL` | модель локального бэкенда плагина (faster-whisper) | `medium` |
| `WHISPER_BEAM_SIZE` | beam size декодера (`1` = greedy, быстрее всего) | `1` |
| `WHISPER_VAD` | VAD-фильтр (`1`/`0`) | `1` |
| `OPENCODE_VOICE_SILENCE_PEAK` | Порог тишины: пик ниже значения — запись считается тишиной | `700` |
| `OPENCODE_VOICE_SILENCE_RMS` | Порог тишины: RMS ниже значения — запись считается тишиной | `80` |
| `OPENCODE_VOICE_RECOGNIZED_LOG` | Файл, куда пишется каждый распознанный текст с источником (`command`/`button`), бэкендом, моделью, языком и длительностью | `/tmp/opencode/voice-recognized.log` |
| `WHISPER_INITIAL_PROMPT` | подсказка-контекст для Whisper | пусто (выкл) |
| `WHISPER_LANG_DETECT_SEGMENTS` | сегментов для авто-определения языка | `3` |
| `WHISPER_LANG_DETECT_THRESHOLD` | порог уверенности языка | `0.6` |
| `OPENCODE_VOICE_STT_BACKEND` | `whispercpp` (GPU) \| `faster-whisper` (CPU); пусто = авто | авто |
| `OPENCODE_VOICE_SOURCE` | Источник PulseAudio (микрофон) для записи; задаётся явно, чтобы default не съезжал на `RDPSink.monitor` (лупбек воспроизведения) | `RDPSource` |
| `OPENCODE_VOICE_TMP_DIR` | Каталог для записей; по умолчанию tmpfs — **ОЗУ**, а не диск | `/dev/shm/opencode-voice` |
| `OPENCODE_VOICE_RETAIN_SECONDS` | Сколько секунд хранить запись до авто-удаления; `0` — удалять сразу после распознавания | `300` |
| `WHISPER_CPP_BIN` | путь к CLI whisper.cpp | `~/.local/share/opencode-voice/whisper/bin/whisper-cli` |
| `WHISPER_CPP_MODEL` | путь к ggml-модели whisper.cpp | `~/.local/share/opencode-voice/whisper/ggml-medium.bin` |
| `WHISPER_CPP_MODEL_FALLBACK` | CPU ggml-модель, если faster-whisper не установлен | `…/ggml-small.bin` |
| `OPENCODE_VOICE_MAX_SECONDS` | максимум записи на сервере | `120` |
| `OPENCODE_VOICE_FAKE_AUDIO` | путь к WAV для теста без микрофона | — |
| `OPENCODE_VOICE_AUTO_RECOVER` | авто-пересоздание аудиоканала WSLg при молчащем источнике | `1` |
| `OPENCODE_VOICE_KEEP_AUDIO` | каталог для сохранения записанного аудио (отладка) | — |
| `OPENCODE_VOICE_SERVER` | авто-запуск STT-сервера при загрузке плагина | `1` |
| `OPENCODE_VOICE_SERVER_SCRIPT` | путь к `stt_server.py` (нестандартная раскладка) | авто |
| `OPENCODE_VOICE_PORT` | порт STT-сервера | `8765` |
| `OPENCODE_VOICE_HOST` | адрес привязки STT-сервера; по умолчанию только localhost. `0.0.0.0` — только если нужен доступ по сети (лучше вместе с `OPENCODE_VOICE_TOKEN`) | `127.0.0.1` |
| `OPENCODE_VOICE_TOKEN` | необязательный общий секрет; если задан, все эндпоинты кроме `/health` требуют заголовок `X-Voice-Token` (или `Authorization: Bearer`). В popup расширения есть поле для токена | пусто (выкл) |
| `OPENCODE_VOICE_SERVER_WATCHDOG_MS` | период проверки/перезапуска, `0` = выкл | `120000` |
| `PULSE_SERVER` | сокет PulseAudio | авто `/mnt/wslg/PulseServer` |

**Безопасность:** STT-сервер слушает только `127.0.0.1` и отдаёт CORS лишь локальным origin (UI OpenCode, расширение). Задай `OPENCODE_VOICE_TOKEN`, чтобы требовать общий секрет на всех запросах кроме `/health`. Без токена, если открыть его наружу (`--host 0.0.0.0` / `OPENCODE_VOICE_HOST=0.0.0.0`), любой в сети сможет писать с твоего микрофона и читать расшифровки.

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
├── stt-server/              # Flask-сервер: stt_server.py, requirements*.txt, tests/, ручной скрипт тестов
├── extension/               # расширение Chrome (MV3)
├── voice-button.user.js     # userscript (deprecated)
├── fix-mic.sh               # пересоздание аудиоканала WSLg (починка микрофона)
├── sync-plugin.sh           # src/index.ts -> .opencode/plugins/index.ts (--check для CI)
├── opencode.json            # подключение плагина + агенты
├── tui.json                 # TUI/web плагины (пример; глобально не загружается)
├── pytest.ini               # герметичные тесты сервера
├── AGENTS.md                # заметки по архитектуре
└── TEST_PLAN.md             # план тестирования
```

В корне репозитория также: `README.md`, `README.ru.md`, `AUDIT.md` (аудит готовности к продакшену), `LICENSE` и CI в `.github/workflows/ci.yml`.

## Лицензия

MIT
