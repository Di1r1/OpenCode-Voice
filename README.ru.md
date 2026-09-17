# OpenCode Voice

Голосовой ввод для [OpenCode](https://opencode.ai): говорите — текст попадает в поле ввода. Работает локально (`faster-whisper` на CPU, `whisper.cpp` на GPU) или в облаке (OpenAI Whisper API): push-to-talk в TUI, кнопка 🎤 в веб-интерфейсе и встроенный `doctor` для диагностики.

[English](README.md) | **Русский**

История версий: [CHANGELOG.md](CHANGELOG.md).

## Компоненты

| Часть | Что делает |
|------|--------------|
| `voice-opencode-plugin/src/` | Плагин OpenCode (TypeScript): команда `/voice`, push-to-talk запись, STT-бэкенды, авто-запуск сервера |
| `voice-opencode-plugin/stt-server/` | Flask + faster-whisper / whisper.cpp: HTTP API, серверная запись через PulseAudio, распознавание |
| `voice-opencode-plugin/extension/` | Расширение Chrome (MV3): кнопка 🎤 в веб-интерфейсе (запись в браузере → сервер) |
| `voice-opencode-plugin/doctor.sh` | Диагностика и ремонт пути «кнопка/расширение» (сервер, CORS, зависшая запись, микрофон) |
| `voice-opencode-plugin/fix-mic.sh` | Пересоздаёт аудиоканал WSLg, если микрофон «умер» (WSL2) |
| `voice-opencode-plugin/sync-plugin.sh` | Генерирует локальные entry-точки плагина/TUI, которые загружает OpenCode |

## Требования

- **Linux (десктоп)** или **Windows 10/11 + WSL2 с WSLg** (в WSL2 звук идёт через WSLg PulseAudio).
- **Node.js 22+ и npm** — для плагина (и для `npm ci` / typecheck).
- **Python 3.9+** — для STT-сервера.
- Системные пакеты: `alsa-utils` (`arecord`), `libasound2-plugins`, `ffmpeg`, опционально `libnotify`.
- **Chrome/Chromium** — для кнопки 🎤 в веб-интерфейсе (TUI работает и без неё).
- Опционально: NVIDIA GPU с WSL-совместимым драйвером — для `whisper.cpp` + CUDA.

> **Папка `.opencode/` генерируется локально.** `sync-plugin.sh` создаёт `voice-opencode-plugin/.opencode/plugins/index.ts` и `.opencode/tui/voice.ts` (копирует `src/index.ts` и правит импорты). Папка в `.gitignore` — запускайте синк после каждого клона и после правок `src/index.ts`. Исключение: `.opencode/skills/` (навыки `ovi-*` для агентов/контрибьюторов) версионируется.

## Установка

### 0. Быстрый старт

```bash
git clone https://github.com/Di1r1/OpenCode-Voice.git
cd OpenCode-Voice/voice-opencode-plugin

# 1. зависимости сервера (CPU-бэкенд)
pip install --no-input -r stt-server/requirements.txt

# 2. зависимости плагина + локальные entry-точки
npm install
bash sync-plugin.sh

# 3. прописать плагин в конфиг OpenCode (см. шаг 3), затем:
opencode web --hostname 0.0.0.0
```

Плагин сам поднимает STT-сервер при загрузке и следит за ним через watchdog — отдельный `python3 stt_server.py` нужен только для ручного запуска. Проверка — `/voice doctor` (шаг 5).

### 1. Звук

**Linux (десктоп)** — дополнительная настройка не нужна, используется PulseAudio/ALSA. Найдите источник микрофона:

```bash
pactl list short sources        # напр. alsa_input.pci-0000_00_1f.3.analog-stereo
export OPENCODE_VOICE_SOURCE=$(pactl get-default-source)   # зафиксировать (см. «Конфигурация»)
arecord -D pulse -f S16_LE -r 16000 -c 1 -t wav -d 3 /tmp/t.wav && ls -la /tmp/t.wav
```

**WSL2:**

```bash
sudo apt-get update
sudo apt-get install -y alsa-utils libasound2-plugins ffmpeg
export PULSE_SERVER=unix:/mnt/wslg/PulseServer

# проверка (должен получиться файл ~500 КБ, а не заглушка 44 байта)
pactl info
arecord -D pulse -f S16_LE -r 16000 -c 1 -t wav -d 3 /tmp/t.wav && ls -la /tmp/t.wav
```

В WSL2 нет `/dev/snd` — это нормально; микрофон доступен только через `PULSE_SERVER=unix:/mnt/wslg/PulseServer`. Записи пишутся в ОЗУ (`/dev/shm/opencode-voice`, tmpfs).

### 2. STT-сервер

```bash
cd voice-opencode-plugin/stt-server
pip install --no-input -r requirements.txt      # flask + faster-whisper (CPU-бэкенд)

export PULSE_SERVER=unix:/mnt/wslg/PulseServer   # только WSL2
python3 stt_server.py --model medium --port 8765
```

- Слушает `127.0.0.1` по умолчанию; проверка: `curl -s 127.0.0.1:8765/health`.
- Запускается и без `faster-whisper`, если используется GPU-бэкенд (`whisper.cpp`) — CPU-пакет импортируется лениво.
- Модели: `tiny` / `base` / `small` / `medium` (по умолчанию) / `large`.
- При старте печатает проверки окружения (Python, CUDA-драйвер, рекордер, CLI/модель whisper.cpp, `PULSE_SERVER`).
- Проверка без микрофона: `OPENCODE_VOICE_FAKE_AUDIO=/tmp/test-voice.wav python3 stt_server.py --port 8765`.

### 3. Плагин OpenCode

```bash
cd voice-opencode-plugin
npm install
bash sync-plugin.sh        # создаёт .opencode/plugins/index.ts и .opencode/tui/voice.ts
npm run typecheck
```

Затем укажите OpenCode на сгенерированную entry-точку. Плагин и хоткей TUI подключаются **file-URL** в конфиге OpenCode (именно так это подключено в рабочей установке):

```jsonc
// ~/.config/opencode/opencode.json   (глобальный)  — или ./opencode.json (проектный)
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    // ... ваши другие плагины ...
    "file:///ABS/PATH/voice-opencode-plugin/.opencode/plugins/index.ts"
  ]
}
```

```jsonc
// ~/.config/opencode/tui.json   (глобальный) — опционально: хоткей <leader>v
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///ABS/PATH/voice-opencode-plugin/.opencode/tui/voice.ts"]
}
```

Замените `/ABS/PATH` на абсолютный путь к клону (например `/home/you/OpenCode-Voice`). Затем **перезапустите OpenCode** — конфиг и плагины читаются один раз при старте.

В репозитории есть `voice-opencode-plugin/opencode.json` — проектная привязка для локального запуска (удобно для разработки).

### 4. Расширение Chrome (кнопка 🎤)

1. Откройте `chrome://extensions` и включите **Режим разработчика**.
2. **Загрузить распакованное расширение** → выберите папку `voice-opencode-plugin/extension`.
3. Откройте веб-интерфейс OpenCode — кнопка 🎤 появится рядом с полем ввода.

Расширение обращается к STT-серверу по адресу `http(s)://<host>:8765` (`STT_PORT` в `extension/content.js`). В `extension/manifest.json` уже перечислены `localhost`/`127.0.0.1`; если хост другой — добавьте его в `host_permissions`. В popup есть настройки: **токен доступа** и **звуковые сигналы**.

### 5. Проверка

```bash
# полная проверка пути «кнопка/расширение» (сервер, CORS, зависшая запись, микрофон)
bash voice-opencode-plugin/doctor.sh          # добавьте --fix для авто-ремонта
# или из TUI:
/voice doctor --fix

# здоровье сервера (в ответе есть "version", "backend", "device", "auth")
curl -s 127.0.0.1:8765/health

# тесты (микрофон и модель не нужны)
cd voice-opencode-plugin
pip install --no-input -r stt-server/requirements-dev.txt
python3 -m pytest          # 37 тестов сервера
npm test                   # 12 тестов (stripNonSpeech)
npm run typecheck
bash sync-plugin.sh --check
```

### Опционально: ускорение на GPU (NVIDIA + CUDA)

По умолчанию сервер работает на CPU (`faster-whisper`). С NVIDIA GPU, проброшенной в WSL2 (или на Linux-хосте), можно использовать `whisper.cpp` с CUDA (проверено на GTX 950M / Maxwell, CC 5.0).

1. Обновите драйвер NVIDIA до WSL-совместимой ветки (R470+). После перезагрузки должен появиться `/usr/lib/wsl/lib/libcuda.so.1`.
2. Установите CUDA-тулкит в домашний каталог (без root). Берите версию, которая ещё поддерживает вашу GPU — CUDA 13 убрала Maxwell/Pascal, для них нужна 12.6:

```bash
sh cuda_12.6.0_560.28.03_linux.run --silent --toolkit --toolkitpath=$HOME/cuda-12.6 \
  --no-opengl-libs --no-man-page --override
```

3. Соберите whisper.cpp с CUDA (`<cc>` = compute capability: `50` Maxwell, `61` Pascal, `75` Turing, `86` Ampere):

```bash
git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp
cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=<cc> -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_BUILD_TESTS=OFF -DCUDAToolkit_ROOT=$HOME/cuda-12.6 \
  -DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler \
  -DCMAKE_EXE_LINKER_FLAGS="-L$HOME/cuda-12.6/lib64 -Wl,--copy-dt-needed-entries"
cmake --build build -j4 --target whisper-cli
```

4. Установите CLI и модель туда, где их ищут плагин и сервер:

```bash
DEST=$HOME/.local/share/opencode-voice/whisper
mkdir -p $DEST/bin
cp build/bin/whisper-cli build/bin/*.so* $DEST/bin/
cp models/ggml-medium.bin $DEST/
```

Сервер и команда `/voice` сами найдут CLI (`/health` покажет `"backend":"whispercpp"`, `"device":"cuda"`). Если GPU нет (нет `libcuda`), оба откатятся на `faster-whisper` (CPU). Принудительно: `/voice device cpu|gpu|auto` или `OPENCODE_VOICE_DEVICE`; legacy-алиас `OPENCODE_VOICE_STT_BACKEND=faster-whisper` тоже работает.

## Использование

### Команды `/voice`

| Команда | Действие |
|---------|--------|
| `/voice` | Push-to-talk: запись до ~1.5 с тишины (жёсткий предел `OPENCODE_VOICE_MAX_RECORD_SECONDS`, по умолчанию 300 с), распознавание, текст в поле ввода |
| `/voice <file.wav>` | Распознать локальный файл (`wav`/`mp3`/`m4a`/`ogg`/`flac`) |
| `/voice backend [local\|api]` | Показать/переключить бэкенд |
| `/voice lang [ru\|en\|auto]` | Показать/переключить язык |
| `/voice device [auto\|gpu\|cpu]` | Показать/переключить устройство: GPU (`whisper.cpp`) или CPU (`faster-whisper`) |
| `/voice doctor [--fix]` | Диагностика пути «кнопка/расширение» и авто-ремонт |
| `/voice help` | Список всех подкоманд |

TUI: хоткей `<leader>v` (leader по умолчанию `ctrl+x`) запускает push-to-talk. Веб-интерфейс: кнопка 🎤 из расширения.

Известные ограничения команды в TUI (особенность OpenCode): хук блокируется на время записи (живого таймера на экране нет), а неудачная попытка пишется как ERROR в лог OpenCode (плагин специально бросает исключение, чтобы не уходил пустой запрос).

## Конфигурация (переменные окружения)

### Плагин (TUI `/voice`)

| Переменная | Назначение | По умолчанию |
|----------|---------|---------|
| `OPENCODE_VOICE_BACKEND` | `local` \| `api` | `local` |
| `OPENCODE_VOICE_LANGUAGE` | `ru` \| `en` \| `auto` | `ru` |
| `OPENCODE_VOICE_DEVICE` | `auto` (GPU, иначе CPU) \| `gpu` \| `cpu` | `auto` |
| `OPENAI_API_KEY` | ключ для бэкенда `api` | — |
| `OPENCODE_VOICE_MODEL` | имя модели для `api` | `whisper-1` |
| `WHISPER_MODEL` | модель локального faster-whisper | `medium` |
| `OPENCODE_VOICE_SOURCE` | источник PulseAudio (микрофон); прибит, чтобы default не уехал на monitor воспроизведения | `RDPSource` (WSLg) |
| `OPENCODE_VOICE_TMP_DIR` | каталог записей (по умолчанию ОЗУ) | `/dev/shm/opencode-voice` |
| `OPENCODE_VOICE_RETAIN_SECONDS` | сколько хранить запись до авто-удаления, с (`0` — сразу после распознавания) | `300` |
| `OPENCODE_VOICE_MAX_UPLOAD_MB` | максимальный размер загружаемого файла (выше — `413`) | `25` |
| `OPENCODE_VOICE_MAX_AUDIO_SECONDS` | максимальная длительность аудио (выше — `400`) | `300` |
| `OPENCODE_VOICE_MAX_CONCURRENT` | сколько распознаваний одновременно (остальные — `429`) | `1` |
| `OPENCODE_VOICE_TRANSCRIBE_TIMEOUT` | таймаут распознавания, с (после — `504`) | `300` |
| `OPENCODE_VOICE_RATE_LIMIT` | запросов в минуту на IP/эндпоинт (`0` — выключено) | `60` |
| `OPENCODE_VOICE_PURGE_INTERVAL` | как часто чистить RAM-каталог, с | `600` |
| `OPENCODE_VOICE_KEEP_AUDIO` | если задано — записи не удалять (отладка) | — |
| `OPENCODE_VOICE_AUTO_RECOVER` | пересоздавать аудиоканал WSLg при молчащем источнике | `1` |
| `OPENCODE_VOICE_AUTO_RECOVER_COOLDOWN`, `OPENCODE_VOICE_RECOVER_WAIT_WESTON`, `OPENCODE_VOICE_RECOVER_WAIT_PULSE` | тайминги восстановления | `90`, `8000`, `5000` мс |
| `OPENCODE_VOICE_MAX_RECORD_SECONDS` | Жёсткий предел длины записи `/voice` (с); обычно запись завершается раньше — через ~1.5 с после окончания речи | `300` |

### STT-сервер

| Переменная | Назначение | По умолчанию |
|----------|---------|---------|
| `OPENCODE_VOICE_PORT` | порт сервера | `8765` |
| `OPENCODE_VOICE_HOST` | хост привязки; по умолчанию только localhost | `127.0.0.1` |
| `OPENCODE_VOICE_SERVER` | авто-запуск сервера при загрузке плагина | `1` |
| `OPENCODE_VOICE_SERVER_SCRIPT` | путь к `stt_server.py` (нестандартная раскладка) | авто |
| `OPENCODE_VOICE_SERVER_LOG` | файл лога сервера | `/tmp/opencode/stt_server.log` |
| `OPENCODE_VOICE_SERVER_WATCHDOG_MS` | период проверки/перезапуска, мс (`0` — выкл) | `120000` |
| `OPENCODE_VOICE_MAX_SECONDS` | максимальная длина серверной записи, с | `120` |
| `OPENCODE_VOICE_FAKE_AUDIO` | WAV вместо микрофона (тесты) | — |
| `OPENCODE_VOICE_TOKEN` | общий секрет; если задан, все эндпоинты кроме `/health` требуют `X-Voice-Token` (или `Authorization: Bearer`) | пусто (выкл) |
| `PULSE_SERVER` | сокет PulseAudio | `/mnt/wslg/PulseServer` в WSL2 |

### Качество распознавания и модели

| Переменная | Назначение | По умолчанию |
|----------|---------|---------|
| `WHISPER_CPP_BIN` | путь к CLI whisper.cpp | `~/.local/share/opencode-voice/whisper/bin/whisper-cli` |
| `WHISPER_CPP_MODEL` | ggml-модель whisper.cpp | `~/.local/share/opencode-voice/whisper/ggml-medium.bin` |
| `WHISPER_CPP_MODEL_FALLBACK` | ggml-модель для CPU, когда faster-whisper не установлен | `…/ggml-small.bin` |
| `WHISPER_CPP_LIB_DIR`, `WHISPER_CPP_EXTRA_LIBS` | доп. пути библиотек для CLI | авто |
| `WHISPER_BEAM_SIZE` | beam декодера (`1` = жадный/самый быстрый) | `1` |
| `WHISPER_VAD` | фильтр голосовой активности (`1`/`0`) | `1` |
| `WHISPER_INITIAL_PROMPT` | подсказка-контекст для Whisper | пусто (выкл) |
| `WHISPER_LANG_DETECT_SEGMENTS` / `WHISPER_LANG_DETECT_THRESHOLD` | тонкая настройка авто-определения языка | `3` / `0.6` |
| `OPENCODE_VOICE_SILENCE_PEAK` / `_RMS` | порог тишины: ниже обоих значений фрагмент считается «без речи» (Whisper галлюцинирует на тишине) | `700` / `80` |
| `OPENCODE_VOICE_STT_BACKEND` | `whispercpp` (GPU) \| `faster-whisper` (CPU); пусто = авто | авто |
| `OPENCODE_VOICE_LANGUAGE` | язык на стороне сервера (`ru`/`en`); пусто = авто-определение | авто |

На коротких фразах авто-определение языка ненадёжно — если говорите на одном языке, задайте его явно (`OPENCODE_VOICE_LANGUAGE=ru`).

**Безопасность:** сервер слушает только `127.0.0.1` и отдаёт CORS лишь локальным origin (интерфейс OpenCode, расширение). Задайте `OPENCODE_VOICE_TOKEN`, чтобы требовать общий секрет во всех запросах кроме `/health`. Без токена при выставлении сервера наружу (`--host 0.0.0.0` / `OPENCODE_VOICE_HOST=0.0.0.0`) любой в сети сможет писать с вашего микрофона и читать расшифровки.

## Логи и диагностика

| Файл | Содержимое |
|------|----------|
| `/tmp/opencode/stt_server.log` | Лог STT-сервера: проверки при старте и каждое распознавание (кнопка и серверная запись) |
| `/tmp/opencode/voice-recognized.log` | каждый распознанный текст с `source=` (`command` = `/voice`, `button` = расширение), бэкендом, моделью, языком, длительностью |
| `/tmp/opencode/voice-stt.log` | какой бэкенд/модель использовал плагин + уровни аудио |
| `/tmp/opencode/voice-requests.log` | входящие HTTP-запросы (путь кнопки): `/beep`, `/transcribe`, `/record/*` |
| `/dev/shm/opencode-voice/` | записи (ОЗУ); удаляются через `OPENCODE_VOICE_RETAIN_SECONDS` |
| `/mnt/wslg/wlog.log` | лог WSLg; строки `audin … error 1359` — известный артефакт завершения канала, не критерий |

`/voice doctor` (или `bash doctor.sh`) печатает сводку по всему перечисленному и умеет ремонтировать типовые проблемы с `--fix`.

## Решение проблем

### Микрофон недоступен

Сервер вернёт одну из двух ошибок:

- `Нет доступа к микрофону: PulseAudio не отвечает…` — рекордер не смог подключиться.
- `Аудиоисточник молчит: рекордер подключился, но данных нет (получено N байт)…` — подключился, но звук не идёт по каналу `audin` WSLg.

```bash
PULSE_SERVER=unix:/mnt/wslg/PulseServer pactl info
PULSE_SERVER=unix:/mnt/wslg/PulseServer arecord -D pulse -f S16_LE -r 16000 -c 1 -t wav -d 3 /tmp/t.wav
```

**Быстрый ремонт (WSL2):** `bash voice-opencode-plugin/fix-mic.sh` пересоздаёт внутренний RDP-канал WSLg (перезапускает weston и pulseaudio). Сервер также один раз самолечится при молчащем источнике (`OPENCODE_VOICE_AUTO_RECOVER=0` отключает это).

Убедитесь, что приложение имеет доступ к микрофону в Windows (Параметры → Конфиденциальность → Микрофон); в RDP-сессии включите «Записывать с этого компьютера». Крайняя мера из Windows: `wsl --shutdown`.

### Кнопка 🎤 пишет "Failed to fetch"

Обычно сервер не запущен или у него устаревший CORS. Запустите `bash voice-opencode-plugin/doctor.sh --fix`: он перезапустит сервер через watchdog и перепроверит preflight для `X-Voice-Source`/`X-Voice-Token`. Если задан токен — введите его же в popup расширения.

### Запись зависла / "already recording"

Зависшая серверная запись даёт `409`. Расширение восстанавливается само; вручную: `curl -X POST http://127.0.0.1:8765/record/stop`. `doctor.sh --fix` делает это тоже.

### Плохое распознавание по RDP

`/voice` пишет через RDP-канал `audin`, который может отдавать звук медленнее реального времени. Качество тогда зависит от захвата микрофона в RDP-клиенте. Помогает: клиент с корректным перенаправлением ввода, реальный микрофон (не «Стереомикшер»), отключённые AGC/шумоподавление, и предпочтительно кнопка 🎤 в браузере (она ловит звук на стороне Windows и загружает файл, минуя `audin`).

## Навыки (гайды для агентов)

В репозитории девять OpenCode-**навыков** (`ovi-*`) — короткие рабочие инструкции для агентов и контрибьюторов: продукт, плагин, сервер, расширение, модели, звук, безопасность, диагностика и цикл разработки/релиза. Лежат в `voice-opencode-plugin/.opencode/skills/<name>/SKILL.md` и **версионируются** (остальное `.opencode/` генерируется и игнорируется).

Чтобы OpenCode их увидел, укажите путь в своём конфиге — либо положите навыки в `<project>/.opencode/skills` и запускайте OpenCode из корня проекта:

```jsonc
// ~/.config/opencode/opencode.json
{
  "skills": { "paths": ["/ABS/PATH/voice-opencode-plugin/.opencode/skills"] }
}
```

Обнаружение происходит при старте — перезапустите OpenCode. Затем загрузите навык штатным инструментом `skill`, например `ovi-overview`. Как добавить/зарегистрировать новый навык — в [`voice-opencode-plugin/SKILLS_GUIDE.md`](voice-opencode-plugin/SKILLS_GUIDE.md).

## Структура

```
voice-opencode-plugin/
├── src/                     # код плагина (index.ts, lib/{config,stt,recorder,beep,server-launcher}.ts)
├── stt-server/              # Flask-сервер: stt_server.py, requirements*.txt, tests/
├── extension/               # расширение Chrome (MV3): content.js, popup, manifest
├── doctor.sh                # диагностика/ремонт (/voice doctor)
├── fix-mic.sh               # пересоздание аудиоканала WSLg
├── sync-plugin.sh           # генерация локальных entry-точек (--check для CI)
├── opencode.json            # проектная привязка плагина (для разработки)
├── tui.json                 # проектная привязка TUI-плагина (пример)
├── pytest.ini               # герметичные тесты сервера
├── AGENTS.md                # заметки по архитектуре для агентов/контрибьюторов
├── TEST_PLAN.md             # план ручного тестирования
├── SKILLS_GUIDE.md          # как подключены навыки: добавить/зарегистрировать/диагностировать
└── .opencode/               # генерируется sync-plugin.sh (в .gitignore; .opencode/skills/ версионируется)
```

В корне репозитория также `README.md`, `README.ru.md`, `AUDIT.md` (аудит готовности к продакшену), `CHANGELOG.md` (история версий), `LICENSE` и CI в `.github/workflows/ci.yml`.

## Разработка

```bash
cd voice-opencode-plugin
npm install
bash sync-plugin.sh            # после каждой правки src/index.ts
npm run typecheck
python3 -m pytest              # тесты сервера (герметично: без микрофона и модели)
npm test                       # TS-тесты (stripNonSpeech, node:test)
bash sync-plugin.sh --check    # защита CI: entry-точки актуальны
```

CI прогоняет те же проверки на каждый push. Для интерактивной разработки: `npm run dev` (`opencode --plugin .`).

## Лицензия

MIT
