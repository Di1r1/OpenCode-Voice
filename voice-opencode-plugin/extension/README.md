# OpenCode Voice Extension

Chrome Extension для голосового ввода в OpenCode Web UI.

**Запись идёт на стороне WSL** (через PulseAudio, как в `/voice`), потому что
браузер Windows не видит микрофон WSL. Браузер только дёргает
`/record/start` и `/record/stop`.

## Архитектура

```
Chrome (Windows)                    WSL
┌──────────────────┐   HTTP   ┌─────────────────────────┐
│ content.js       │ ───────► │ stt_server.py :8765      │
│  кнопка 🎤       │          │  arecord -D pulse        │
│  /record/start   │          │  faster-whisper          │
│  /record/stop    │ ◄─────── │  → текст                 │
└──────────────────┘          └─────────────────────────┘
```

- `extension/` — только файлы Chrome Extension
- `../stt-server/` — Python-сервер (вне папки расширения, т.к. Chrome
  запрещает каталоги вида `__pycache__`)

## Установка

### 1. Запустить STT сервер (WSL)

```bash
cd /mnt/c/temp/openvi/voice-opencode-plugin/stt-server
python3 stt_server.py --model base --port 8765
```

Сервер сам подставит `PULSE_SERVER=unix:/mnt/wslg/PulseServer`, если не задан.
Требует: `pip install faster-whisper flask --break-system-packages`

Проверка:
```bash
curl http://localhost:8765/health
# {"status":"ok","model":"base","recorder":"arecord","pulse_server":"unix:/mnt/wslg/PulseServer"}
```

### 2. Установить расширение в Chrome

1. `chrome://extensions/`
2. Включить **Режим разработчика**
3. **Загрузить распакованное расширение** → папка `extension`

### 3. Использовать

1. Открой OpenCode Web UI (напр. `http://localhost:4096/`)
2. Кнопка **🎤** слева от кнопки отправки
3. Клик → говори → клик для остановки
4. Текст вставится в поле ввода

## API STT сервера

| Метод | Путь             | Назначение                                  |
|-------|------------------|---------------------------------------------|
| GET   | `/health`        | Статус, модель, найденный рекордер, pulse   |
| POST  | `/record/start`  | Начать запись (arecord/ffmpeg/sox)          |
| GET   | `/record/status` | Идёт ли запись + секунды                    |
| POST  | `/record/stop`   | Остановить, распознать, вернуть `{text}`    |
| POST  | `/transcribe`    | Распознать загруженный аудиофайл (fallback) |

Все ответы с CORS (`Access-Control-Allow-Origin: *`), т.к. браузер ходит
с другого порта.

## Тесты

```bash
# 1. Запустить сервер
cd /mnt/c/temp/openvi/voice-opencode-plugin/stt-server
python3 stt_server.py --model base --port 8765

# 2. В другом терминале — прогнать тесты
python3 test_stt_server.py --port 8765
```

Проверяются: `/health`, `/transcribe` (реальный WAV + без файла → 400),
`/record/stop` без старта → 409, полный цикл записи.
Запись пропускается (SKIP), если PulseAudio недоступен.

### Fake-audio режим (тест без микрофона)

Если аудиоустройства нет (например, RDP без перенаправления микрофона),
можно проверить **весь пайплайн** кнопки, подставив готовый WAV:

```bash
OPENCODE_VOICE_FAKE_AUDIO=/tmp/test-voice.wav \
  python3 stt_server.py --model base --port 8765
```

В этом режиме `/record/start` и `/record/stop` не пишут с микрофона, а берут
указанный файл. `health` покажет `"fake_audio": "/tmp/test-voice.wav"`.
Подходит для проверки UI + HTTP + распознавания без железа.

## Настройки

```bash
python3 stt_server.py --model base --device cpu --compute-type int8 --port 8765
```

| Модель | Размер | Качество       |
|--------|--------|----------------|
| tiny   | 39 MB  | базовое        |
| base   | 74 MB  | хорошее        |
| small  | 244 MB | очень хорошее  |

## Если микрофон недоступен

Сервер отвечает одной из двух ошибок:

- `Нет доступа к микрофону: PulseAudio не отвечает...` — рекордер не смог подключиться.
- `Аудиоисточник молчит: рекордер подключился, но данных нет (получено N байт)...` —
  подключился, но WSLg не отдаёт звук по каналу `audin` (частая причина — отвалившийся
  аудиоканал RDP/WSLg).

```bash
# Проверить PulseAudio
PULSE_SERVER=/mnt/wslg/PulseServer pactl info
PULSE_SERVER=/mnt/wslg/PulseServer arecord -D pulse -f cd -r 16000 -c 1 -t wav -d 3 /tmp/t.wav
```

Также проверь доступ приложения к микрофону в Windows (Параметры → Конфиденциальность →
Микрофон); в RDP-сессии включи «Запись с этого компьютера».

Если висит/ошибка — перезапусти WSLg (из Windows PowerShell):
```powershell
wsl --shutdown
```
и заново открой WSL.

## Логи

- Content script: F12 → Console → фильтр `[OpenCode Voice]`
- STT сервер: терминал с `stt_server.py`
