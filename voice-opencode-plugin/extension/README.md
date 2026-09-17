# OpenCode Voice Extension

Chrome-расширение (MV3) для голосового ввода в OpenCode Web UI: кнопка **🎤** и звуковые сигналы.

## Архитектура

Запись гибридная, с двумя путями:

1. **Основной — захват в браузере.** `MediaRecorder` (`getUserMedia`) пишет WebM/Opus на стороне Windows и отправляет файл на STT-сервер (`POST /transcribe`). Так звук **не идёт** через RDP-канал `audin`, поэтому по RDP качество лучше.
2. **Фолбэк — запись на сервере.** Если браузер не может писать (`MediaRecorder` недоступен), расширение дёргает `POST /record/start` и `POST /record/stop` — сервер пишет с микрофона через PulseAudio (`arecord -D pulse`), как команда `/voice`.

```
Chrome (Windows)                        WSL / Linux
┌──────────────────┐   HTTP    ┌─────────────────────────────┐
│ content.js       │ ────────► │ stt_server.py :8765          │
│  кнопка 🎤       │           │  POST /transcribe  (WebM)    │
│  MediaRecorder   │           │  POST /record/start|stop     │
│  popup (токен,   │ ◄──────── │  whisper.cpp (GPU) /         │
│  звуки)          │   текст   │  faster-whisper (CPU)        │
└──────────────────┘           └─────────────────────────────┘
```

- `extension/` — только файлы расширения.
- `../stt-server/` — Python-сервер (вне папки расширения: Chrome не любит каталоги вида `__pycache__`).

## Установка

### 1. STT-сервер

```bash
cd voice-opencode-plugin/stt-server
pip install --no-input -r requirements.txt
export PULSE_SERVER=unix:/mnt/wslg/PulseServer     # WSL2
python3 stt_server.py --model medium --port 8765
```

Обычно сервер поднимает сам плагин OpenCode (авто-старт + watchdog) — ручной запуск нужен только для отладки. Проверка:

```bash
curl -s http://127.0.0.1:8765/health
# {"status":"ok","backend":"whispercpp","device":"cuda","model":"ggml-medium.bin", ...}
```

### 2. Расширение в Chrome

1. `chrome://extensions/` → включить **Режим разработчика**.
2. **Загрузить распакованное расширение** → папка `voice-opencode-plugin/extension`.
3. Обновляйте расширение кнопкой **Reload** после правок `content.js` (Chrome держит старый скрипт в памяти).

### 3. Использование

1. Откройте OpenCode Web UI (например, `http://localhost:4096/`).
2. Кнопка **🎤** рядом с полем ввода.
3. Клик — запись, клик — остановка (или авто-стоп по тишине на сервере).
4. Распознанный текст вставляется в поле ввода.

Настройки в popup: **токен доступа** (`X-Voice-Token`) и переключатель **звуковых сигналов** (880 Гц старт, 520 Гц стоп, 660 Гц готово; есть кнопка «Проверить звук»).

## API STT-сервера

| Метод | Путь | Назначение |
|-------|------|------------|
| GET | `/health` | Статус, эффективный бэкенд, модель, рекордер, `auth` |
| POST | `/transcribe` | Распознать загруженный аудиофайл (основной путь расширения) |
| POST | `/record/start` | Начать серверную запись (фолбэк) |
| GET | `/record/status` | Идёт ли запись |
| POST | `/record/stop` | Остановить серверную запись, распознать, вернуть `{text}` |
| GET/POST | `/beep?freq=N` | Проиграть сигнал через PulseAudio (`freq=0` — только лог/пинг версии) |

- Заголовок **`X-Voice-Source: button`** — расширение помечает свои запросы; сервер пишет источник в `/tmp/opencode/voice-recognized.log`.
- Если задан `OPENCODE_VOICE_TOKEN`, все эндпоинты кроме `/health` требуют `X-Voice-Token` (или `Authorization: Bearer`). Тот же токен введите в popup.
- CORS — только для локальных origin (OpenCode UI, `chrome-extension://…`), не `*`. Если сервер запущен без `X-Voice-Source` в `Access-Control-Allow-Headers`, кнопка покажет `Failed to fetch` — перезапустите сервер (или `bash ../doctor.sh --fix`).

## Тесты

```bash
cd voice-opencode-plugin
pip install --no-input -r stt-server/requirements-dev.txt
python3 -m pytest          # герметично: без микрофона и модели
```

Диагностика пути кнопки целиком (сервер, CORS, зависшая запись, микрофон):

```bash
bash voice-opencode-plugin/doctor.sh --fix
```

### Fake-audio режим (без микрофона)

```bash
OPENCODE_VOICE_FAKE_AUDIO=/tmp/test-voice.wav python3 stt_server.py --port 8765
```

`/record/start|stop` в этом режиме берут готовый WAV; `/health` покажет `"fake_audio"`.

## Настройки

```bash
python3 stt_server.py --model medium --device cpu --compute-type int8 --port 8765
```

| Модель | Размер | Качество |
|--------|--------|----------|
| tiny | 39 MB | базовое |
| base | 74 MB | хорошее |
| small | 244 MB | очень хорошее |
| medium (по умолчанию) | 1.5 GB | лучшее из практичных |
| large | 3 GB | максимальное, медленное |

Порт расширение берёт из `STT_PORT` (`extension/content.js`, по умолчанию `8765`), адрес — `${location.protocol}//${location.hostname}:8765`.

## Если микрофон недоступен

```bash
PULSE_SERVER=unix:/mnt/wslg/PulseServer pactl info
PULSE_SERVER=unix:/mnt/wslg/PulseServer arecord -D pulse -f S16_LE -r 16000 -c 1 -t wav -d 3 /tmp/t.wav
```

- `Нет доступа к микрофону: PulseAudio не отвечает…` — рекордер не подключился.
- `Аудиоисточник молчит: рекордер подключился, но данных нет (получено N байт)…` — не идёт звук по каналу `audin` WSLg (частая причина — отвалившийся RDP/WSLg канал).

Быстрый ремонт (WSL2): `bash ../fix-mic.sh` (пересоздаёт канал WSLg). Сервер также один раз самолечится (`OPENCODE_VOICE_AUTO_RECOVER=0` отключает). Убедитесь, что у приложения есть доступ к микрофону в Windows (Параметры → Конфиденциальность → Микрофон), а в RDP включено «Запись с этого компьютера».

## Логи

- Content script: `F12` → Console → фильтр `[OpenCode Voice]` (там же версия, 1.0.7).
- Сервер: `/tmp/opencode/stt_server.log` (старт и каждое распознавание).
- Запросы кнопки: `/tmp/opencode/voice-requests.log`.
- Распознанный текст: `/tmp/opencode/voice-recognized.log` (с `source=button`).
