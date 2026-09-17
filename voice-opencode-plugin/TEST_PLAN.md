# План тестирования opencode-voice

Актуально для текущей реализации: запись `/voice` — до тишины (~1.5 с после речи, жёсткий предел 60 с аудио), остановка рекордера мягкая (SIGINT), файлы в ОЗУ, `doctor.sh` для пути кнопки.

## 0. Быстрые проверки (без микрофона и модели)

```bash
cd voice-opencode-plugin
npm install
bash sync-plugin.sh
npm run typecheck                 # tsc --noEmit
bash sync-plugin.sh --check       # entry-точки актуальны
python3 -m py_compile stt-server/stt_server.py
pip install --no-input -r stt-server/requirements-dev.txt
python3 -m pytest                 # 37 герметичных тестов (сервер)
npm test                          # 12 TS-тестов stripNonSpeech (node:test)
```

**Ожидается:** всё зелёное; pytest не требует микрофона и моделей (faster-whisper импортируется лениво), `npm test` — только Node 22+.

---

## 1. Локальный бэкенд (faster-whisper / whisper.cpp) — требует модели

### 1.1 Загрузка модели faster-whisper
```bash
python3 -c "
from faster_whisper import WhisperModel
WhisperModel('medium', device='cpu', compute_type='int8')
print('ok')
"
```

### 1.2 Распознавание файла
```bash
export OPENCODE_VOICE_BACKEND=local
export OPENCODE_VOICE_LANGUAGE=ru
opencode
# В TUI: /voice /tmp/voice_test.wav
```

**Ожидается:** текст распознан (для пустого/мусорного файла — понятная ошибка «речь не распознана»), тост «Готово».
Для тишины срабатывает порог `OPENCODE_VOICE_SILENCE_PEAK/_RMS` — Whisper не запускается.

---

## 2. Push-to-talk (микрофон)

### 2.1 Проверка аудио

Linux: `pactl info`, `pactl list short sources`, `arecord -D pulse -f S16_LE -r 16000 -c 1 -t wav -d 3 /tmp/t.wav`.
WSL2: `/dev/snd` отсутствует — это норма; работает только `PULSE_SERVER=unix:/mnt/wslg/PulseServer`.

### 2.2 Тест записи

```bash
export OPENCODE_VOICE_BACKEND=local
export OPENCODE_VOICE_LANGUAGE=ru
export OPENCODE_VOICE_SOURCE=$(pactl get-default-source)   # Linux; в WSL2 default RDPSource
export PULSE_SERVER=unix:/mnt/wslg/PulseServer               # WSL2
opencode
# В TUI: /voice — говорить; запись сама остановится через ~1.5 с тишины
```

**Ожидается:**
- бип 880 Гц на старте, 520 Гц на остановке, 660 Гц перед вставкой текста;
- файл в `/dev/shm/opencode-voice/voice-ptt-*.wav` (моно 16 кГц, заголовок финализирован);
- текст вставлен в prompt, тост «Готово»;
- файл удалится через `OPENCODE_VOICE_RETAIN_SECONDS` (по умолчанию 300 с);
- в `/tmp/opencode/voice-recognized.log` строка `source=command … text="…"`.

Крайние случаи: пустая запись/тишина → тост «речь не распознана», пустой запрос модели не уходит.

---

## 3. Разные форматы аудио

```bash
ffmpeg -f lavfi -i "sine=frequency=440:duration=3" -ac 1 -ar 16000 /tmp/test.mp3 -y
ffmpeg -f lavfi -i "sine=frequency=440:duration=3" -ac 1 -ar 16000 /tmp/test.ogg -y
ffmpeg -f lavfi -i "sine=frequency=440:duration=3" -ac 1 -ar 16000 /tmp/test.flac -y
# В TUI:
/voice /tmp/test.mp3
/voice /tmp/test.ogg
/voice /tmp/test.flac
```

**Ожидается:** понятный результат по каждому; whisper.cpp-путь сам конвертирует не-WAV через ffmpeg (`_to_wav`).

---

## 4. Переключение бэкенда/языка/устройства

```
/voice backend            # показать (local)
/voice backend local      # переключить
/voice lang               # показать (ru)
/voice lang en|auto|ru
/voice device             # показать (auto)
/voice device cpu|gpu|auto
/voice help
```

**Ожидается:** тост с текущим/новым значением, валидный ответ (без `UnknownError`); info-подкоманды не отправляют пустой запрос (кладётся служебный текст).

Проверка выбора движка: `/tmp/opencode/voice-stt.log` — `whispercpp` для GPU, `faster-whisper` для CPU. Без GPU `auto`/`gpu` не должны падать (откат на CPU).

---

## 5. Кнопка расширения (браузерный путь)

1. `chrome://extensions` → Reload расширения (версия 1.0.7), открыть OpenCode Web UI, клик по 🎤, сказать, клик — стоп.

**Ожидается:** сигналы 880/520/660, текст в поле ввода; сервер доступен (`/voice doctor`).

Диагностика:
```bash
bash voice-opencode-plugin/doctor.sh          # полная проверка
bash voice-opencode-plugin/doctor.sh --fix    # + ремонт
curl -s 127.0.0.1:8765/health
```

Проверяемые сценарии:
- [ ] сервер не запущен → `Failed to fetch`; `doctor.sh --fix` поднимает сервер;
- [ ] устаревший CORS (нет `X-Voice-Source` в preflight) → `Failed to fetch`; фикс — рестарт сервера;
- [ ] задан `OPENCODE_VOICE_TOKEN` → без токена 401, с токеном 200; токен в popup;
- [ ] зависшая серверная запись (`/record/status`) → `409`; расширение само вызывает `/record/stop`;
- [ ] `GET /beep?freq=0` в `/tmp/opencode/voice-requests.log` (маркер версии);
- [ ] в `/tmp/opencode/voice-recognized.log` строка `source=button …`.

### Fake-audio (без микрофона)
```bash
OPENCODE_VOICE_FAKE_AUDIO=/tmp/test-voice.wav python3 stt-server/stt_server.py --port 8765
```
`/health` покажет `"fake_audio"`; `/record/start|stop` берут готовый WAV.

---

## 6. Тест с реальным голосом (TUI, WSL2)

Предусловия: WSL2, `ffmpeg`, Python + модель, доступный `PULSE_SERVER`.

1. `export OPENCODE_VOICE_BACKEND=local`
2. `export OPENCODE_VOICE_LANGUAGE=ru`
3. `cd voice-opencode-plugin && bash sync-plugin.sh`
4. `opencode`
5. `/voice` → говорить
6. Ожидать: авто-стоп, распознанный текст в поле ввода

---

## 7. Облачный API

```bash
export OPENCODE_VOICE_BACKEND=api
export OPENAI_API_KEY=sk-...
opencode
# /voice /tmp/voice_test.wav
```
**Ожидается:** текст распознан; при отсутствии ключа — понятная ошибка.

---

## 8. Doctor / диагностика

```bash
bash voice-opencode-plugin/doctor.sh
```
**Ожидается:** сводка по серверу (процесс/порт/health), CORS-preflight, зависшей записи, микрофону (пик/RMS и скорость доставки) и свежести логов; при проблемах — подсказки. `--fix` ремонтирует.

---

## 9. Изоляция сервера

- [ ] `OPENCODE_VOICE_TOKEN=secret` → `/health` без токена 200, остальные — 401; с `X-Voice-Token: secret` — 200.
- [ ] CORS: запрос с чужим `Origin` не получает `Access-Control-Allow-Origin`.
- [ ] `ss -ltn` → слушает `127.0.0.1:8765` (если не задан `OPENCODE_VOICE_HOST`).

---

## 10. Скиллы и агенты (если настроены локально)

- Скиллы `ovi-overview`, `ovi-plugin`, `ovi-server`, `ovi-extension`, `ovi-models`, `ovi-debug`, `ovi-dev` — в `.opencode/skills/` (генерируемая, git-ignored часть; подхватываются только если путь виден OpenCode).
- Агенты `voice-builder`, `voice-stt` — в проектном `voice-opencode-plugin/opencode.json` (`@voice-builder`, `@voice-stt` в TUI).

---

## 11. Проверка после изменений

После любой правки `src/index.ts`:

```bash
bash sync-plugin.sh            # генерирует .opencode/plugins/index.ts
bash sync-plugin.sh --check    # убедиться, что актуально
npm run typecheck
```

Затем перезапустить OpenCode и проверить:
- [ ] `/voice help` и `/voice backend` → тосты, без `UnknownError`;
- [ ] нет «failed to load plugin» в логах OpenCode;
- [ ] `/voice` записывает и вставляет текст;
- [ ] `/voice doctor` зелёный.
