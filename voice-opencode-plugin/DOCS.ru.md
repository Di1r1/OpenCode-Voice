# OpenCode Voice v1 — полная документация

> © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
> Срез: сервер `0.4.4`, расширение `1.0.52`. Язык документа — русский.

Локальное голосовое управление OpenCode: надиктовать промпт, распознать файл,
озвучить ответ. Всё работает офлайн (кроме опционального `api`-бэкенда),
микрофон виден через WSLg/PulseAudio.

---

## Оглавление

1. [Компоненты и схема](#1-компоненты-и-схема)
2. [Потоки данных](#2-потоки-данных)
3. [STT-сервер (`stt-server/stt_server.py`)](#3-stt-сервер) — включая [3.5. GPU vs CPU](#35-видеокарта-vs-процессор-как-выбирается-автооткат-чего-нет)
4. [Плагин (`src/`)](#4-плагин-src)
5. [Расширение (`extension/`)](#5-расширение)
6. [Как что переключается](#6-как-что-переключается)
7. [Скрипты](#7-скрипты)
8. [Общие спеки (`shared/`) и тесты](#8-общие-спеки-и-тесты)
9. [Логи, диагностика, известные ловушки](#9-логи-диагностика-известные-ловушки)

---

## 1. Компоненты и схема

| Компонент | Файлы | Роль |
|---|---|---|
| **Плагин OpenCode** | `src/index.ts`, `src/lib/*.ts` | Команда `/voice`, автозапуск и watchdog сервера, запись, STT direct-путь |
| **STT-сервер** | `stt-server/stt_server.py` (Flask) | HTTP API: запись, транскрибация, синтез, heal — всё в одном процессе |
| **Расширение Chrome** | `extension/{content,popup,tts}.js` | Кнопка 🎤 в веб-UI, popup настроек, озвучка ответов |
| **Скрипты** | `doctor.sh`, `fix-mic.sh`, `setup.sh`, `sync-plugin.sh` | Диагностика, ремонт канала, установка, поставка плагина |

```
                        ┌─────────────────────────────┐
 Микрофон ──PulseAudio──│  STT-сервер :PORT           │
 (WSLg)                 │  /record/* /transcribe      │
                        │  /speak /voices /heal       │
                        │  /model /engine /health     │
                        └──────┬──────────────┬───────┘
                               │ HTTP         │ HTTP
              ┌────────────────┘              └───────────────┐
              ▼                                               ▼
   ┌─────────────────────┐                        ┌─────────────────────┐
   │ Плагин (TUI/CLI)    │                        │ Расширение (Chrome) │
   │ /voice — PTT до     │                        │ 🎤 в веб-UI, popup  │
   │ тишины → текст      │                        │ настроек, TTS-слой  │
   │ в промпт            │                        │ озвучки ответов     │
   └─────────────────────┘                        └─────────────────────┘
```

Сервер поднимается сам при загрузке плагина (`ensureSttServer`, detached-про-Schastia,
stdout/stderr в `/tmp/opencode/stt_server.log`) и держится вотчдогом каждые 120 с
(`startServerWatchdog`). Переменные — см. [раздел 6](#6-как-что-переключается).

---

## 2. Потоки данных

### 2.1. `/voice` — push-to-talk из TUI/CLI

```
beep 880 → startPushToTalk (arecord/ffmpeg, mono 16 кГц S16_LE)
  → waitPushToTalkAuto (стоп после ~1.5 с тишины; кап OPENCODE_VOICE_MAX_RECORD_SECONDS=300)
  → SIGINT рекордеру (WAV-заголовок всегда финализируется; SIGKILL рвал длинные записи)
  → beep 520 → transcribe → stripNonSpeech → текст в поле ввода (appendPrompt + setParts)
  → beep 660 → строка в OPENCODE_VOICE_RECOGNIZED_LOG с source=command
```

Записи лежат в RAM (`/dev/shm/opencode-voice`, tmpfs), автоудаление через
`OPENCODE_VOICE_RETAIN_SECONDS=300`. Файл `<2000B` → `recoverMic()` + повтор.
Ошибка → `heal()` (doctor.sh --fix) + 2-я попытка, иначе `throw`, чтобы OpenCode
не слал модели пустой запрос. Хук блокирует весь цикл: OpenCode всегда вызывает
модель после `command.execute.before`, поэтому неблокирующий старт невозможен.

### 2.2. Кнопка 🎤 в веб-UI (расширение)

Гибридная запись: сначала пробуется микрофон браузера (`getUserMedia`), при
неудаче — серверная запись в WSL (`POST /record/start` … `/record/stop`, 409 если
уже идёт). Стоп → `/transcribe` с `X-Voice-Source: button` → текст вставляется в
промпт (`source=button` в логе). Бипы 880/520/660 играет сервер в WSL.

### 2.3. Озвучка ответов (TTS-слой)

`extension/tts.js` (грузится до `content.js`) опрашивает same-origin API веб-UI
(`GET /api/session` → свежайшая сессия → `GET /session/{id}/message`, опционально
живой SSE `/api/event`), находит видимый `[data-message-id]`, чистит текст
(`cleanForSpeech`, паритет с `src/lib/text.ts` и Python через `shared/tts-cases.json`)
и озвучивает: движок `browser` (Web Speech) или `server` (`POST /speak` → WAV).
Режимы `brief` (первые N предложений) / `full`, дедуп `messageID`+hash, пауза
пока `uiPhase !== 'idle'`.

Управление речью (расширение `1.0.50+`):

| Действие | Хоткей (дефолт) | Смысл |
|---|---|---|
| Стоп | `Ctrl+C` (`ttsHotkey`, настраивается: Ctrl+C / Alt+C / Esc) | прервать **текущую** речь, не запоминая |
| Mute | `Alt+M` (`ttsMuteHotkey`) | заглушить всё; повторное нажатие возвращает и **досказывает** заглушённый текст (`mutedText`) |

Оба хоткея не зависят от раскладки: сравнение идёт по физической клавише
(`e.code` через `comboCode()`), поэтому `Alt+М` работает и в русской раскладке
(иначе `e.key` дал бы «м», а не «m»). Mute перехватывается и когда молчит — иначе
включить обратно было бы нечем. В тосте начала речи показывается подсказка с
актуальными хоткеями: «🔊 Говорю… · Ctrl+C стоп · Alt+M mute».

Ограничение длины речи — **бюджет от текста** (`speechBudget`), а не плоские
60 секунд: `60 с + 70 мс/символ ÷ rate`, потолок 30 минут (страховка от зависшего
синтеза). `ttsMaxSeconds`, если задан, — нижняя граница, а не кап. Раньше плоский
таймер `ttsMaxSeconds=60` обрывал длинный ответ в режиме `full` ровно на минуте.
Отдельно живёт сторож залипшего utterance (`utteranceBudget`, 10–60 с на чанк) —
он не режет речь, а перезапускает зависший чанк.

---

## 3. STT-сервер

Файл `stt-server/stt_server.py`, Flask, `threaded=True`. Бинд
`OPENCODE_VOICE_HOST` (дефолт `127.0.0.1`) + `OPENCODE_VOICE_PORT` (дефолт `8765`).

### 3.1. Роуты

| Метод/путь | Назначение |
|---|---|
| `GET /health` | Статус: `version/backend/model/models/device/recorder/pulse_server/fake_audio/python/auth/limits/tts` |
| `POST /transcribe` | `multipart audio=@file` → `{text, language, language_probability, backend, model, duration}` |
| `POST /record/start` | Серверная запись (409 если идёт; 500 нет рекордера) |
| `GET /record/status` | `{recording, seconds}` |
| `POST /record/stop` | Graceful-стоп (SIGINT) + транскрибация, возврат `{text}` |
| `POST /speak` | JSON `{text, voice?, rate?, mode?}` → `audio/wav` (кэш, 400/413/429/501) |
| `GET /voices` | Read-only каталог `{engine, default, voices, enabled, available}` |
| `POST /model` | `{"model": "<name>"}` → проверка `ggml-<name>.bin` + рестарт (см. 3.4) |
| `POST /engine` | `{"engine": "piper"\|"silero"}` + рестарт (наследует env через `execv`) |
| `POST /heal[?restart=1]` | Сброс зависшей записи + purge tmp; с `restart=1` — рестарт процесса |
| `POST /device` | `{"device": "auto"\|"gpu"\|"cpu"}` — смена устройства **без рестарта** (см. 3.5); `device_mode` отдаётся в `/health` |
| `GET /health` (фрагмент) | `model_risk`/`model_mb` — крупнее ~1 ГБ рискованно для слабой VRAM; `gpu_fallback_streak` — серия откатов на CPU |
| `GET/POST /beep?freq=` | Бип в WSL; `freq=0` — только лог (пинг версии от content.js) |

### 3.2. Пайплайн транскрибации

1. Не-WAV конвертируется ffmpeg в 16 кГц mono (`_to_wav`).
2. **Silence gate**: ниже `peak 700 / rms 80` → `text=""`, Whisper не запускается
   (иначе галлюцинации на тишине).
3. Бэкенд `OPENCODE_VOICE_STT_BACKEND` (`whispercpp|faster-whisper|auto`):
   whisper.cpp CLI с `-mc 0 -sns` (меньше галлюцинаций) на GPU, иначе
   faster-whisper на CPU (ленивый импорт — сервер стартует и без него).
4. `_strip_non_speech()` режет `[музыка]`/`(смех)`/`♪`.
5. Итог дописывается в `OPENCODE_VOICE_RECOGNIZED_LOG` с `X-Voice-Source`
   (`api` для `/transcribe`, `button` для `/record/stop`).

Выбор backend: `OPENCODE_VOICE_DEVICE=auto|gpu|cpu` (auto = whisper.cpp+CUDA при
наличии `libcuda`, иначе CPU). Явный `gpu` молча не откатывается.
Ограничения: аплоад ≤25 МБ (413), аудио ≤300 с (400), конкурентность 1 (429),
таймаут 300 с (504), rate 60/мин с IP (429), purge tmp каждые 600 с.
Безопасность: опциональный `OPENCODE_VOICE_TOKEN` (всё кроме `/health` и
preflight — 401), CORS только для локальных origin + `chrome-extension://…`
(чужой `Origin` на POST — 403).

### 3.3. TTS-движки

- **Piper** (дефолт): CLI `piper --model <голос>.onnx`, каталог — `*.onnx` в
  voices dir; `rate` через `--length_scale`. Русских `high` не существует —
  только `medium` (проверено по репозиторию голосов).
- **Silero** (`OPENCODE_VOICE_TTS_ENGINE=silero`): torch CPU + `v4_ru.pt`
  (setup.sh качает ~40 МБ), спикеры `aidar/baya/eugene/kseniya/xenia`
  (дефолт `kseniya`), 48 кГц; `rate` игнорируется.
- Тесты используют контракт `OPENCODE_VOICE_TTS_BIN`: `<bin> <out.wav>`, текст на stdin.

### 3.4. Рестарт и защита от дубликатов

- `_restart_soon()` (1.5 с) → `_respawn()`: detached-хелпер ждёт освобождения
  порта через `connect` (до 60 с) и делает `execv` того же `argv` — env
  наследуется, поэтому `/model` и `/engine` работают простой записью в
  `os.environ` + рестарт.
- Дубликатный запуск (второй процесс при живом сервере) выходит сразу с кодом 2,
  а не спамит «Address already in use». После 40 неудачных попыток — код 1 с
  подсказкой про резерв портов Windows (см. 9.3).
- `POST /model`: имя строго `^[A-Za-z0-9][A-Za-z0-9._-]*$`, `realpath` обязан
  остаться в каталоге моделей, файл `ggml-<name>.bin` обязан существовать.

### 3.5. Видеокарта vs процессор: как выбирается, автооткат, чего нет

Ручное переключение (два независимых контура — direct-путь `/voice` и сервер):
- `/voice device [auto|gpu|cpu]` → `state.ts` (env `OPENCODE_VOICE_DEVICE` важнее
  файла). Direct-путь (`stt.ts` + `whisper.ts`) читает это при каждом вызове:
  `auto` = whisper.cpp+CUDA при наличии `libcuda`, иначе faster-whisper CPU.
- Сервер читает устройство **один раз при старте** (`__main__`):
  `OPENCODE_VOICE_DEVICE=cpu` форсит `faster-whisper`, иначе `whispercpp`, если
  есть бинарник и модель (`whispercpp_available()`), иначе CPU. Смена через
  `/voice device` на серверный путь **не действует до рестарта сервера**
  (только `POST /model|/engine` + рестарт или рестарт процесса).
- Тонкая настройка CPU-фолбэка: `--device/--compute-type` сервера
  (`FT_DEVICE` дефолт `cpu`, `FT_COMPUTE` дефолт `int8`), `WHISPER_BEAM_SIZE=1`,
  `WHISPER_VAD=1`. CUDA для faster-whisper не используется никогда.

Автоматика (три штуки):
1. **Выбор при старте** — GPU, если `libcuda` на месте; иначе CPU. Явного
   `gpu` молча на CPU не роняет (упадёт с ошибкой вместо тихого отката).
2. **Откат в рантайме** (`transcribe_file`): любая ошибка whisper.cpp (включая
   краш CLI на GPU) → `WARNING … откат на faster-whisper (CPU)` → CPU-модель
   грузится **лениво при первом откате и остаётся в RAM** до рестарта.
   Размер CPU-модели следует за выбранной ggml (`_fw_size_for_ggml`:
   `large-v3-q5_0` → `large`, `medium-q5_0` → `medium`; при смене выбора —
   перезагрузка, в памяти всегда одна). Первое обращение к новому размеру
   докачивает его из HuggingFace (~3 ГБ для large). Признак отката: лог +
   поле `backend` в ответе и в `voice-recognized.log`.
3. **Автолечение серии откатов** (`_note_fallback`): счётчик `_FB_STREAK`
   растёт на каждом откате; на пороге `OPENCODE_VOICE_FB_STREAK` (дефолт **2**,
   `0` = выключить) сервер **сам перезапускает процесс** — это возвращает его на
   GPU. Модель и настройки не меняются: выбранную пользователем модель он не
   трогает. `OPENCODE_VOICE_FB_HEAL_PAUSE` (дефолт 1.5 с) — пауза перед
   рестартом, чтобы отдать `/heal`-ответ. Логи: `GPU-откат #N подряд` и
   `серия откатов N — перезапускаю процесс`. Текущее значение видно в
   `/health` → `gpu_fallback_streak` (popup подсвечивает красным), порог риска
   модели — в `model_risk`/`model_mb` (popup показывает жёлтую плашку).

Как понять, где посчиталось: поле `backend` в ответе (`whispercpp` vs
`faster-whisper`) и в `voice-recognized.log`; живьём — `nvidia-smi`
(100%/~1 ГБ на large, ~950 МБ на medium-q5_0, ~520 МБ на small-q8_0 во время
инференса; 0 в простое).

Переключение на лету (без рестарта): `POST /device` пишет `STT_BACKEND`
напрямую (`cpu` → `faster-whisper`, `gpu` → `whispercpp` с проверкой наличия,
`auto` → автовыбор), `transcribe_file` смотрит его на каждый запрос. В popup —
селект «Устройство (GPU/CPU)», текущее значение — в `/health` (`device_mode`).
CPU-модель догружается лениво при первом запросе. Рестарт не нужен (в отличие
от смены STT-модели и TTS-движка).

Измерено на GTX 950M (CC 5.0) в WSL — частота откатов, 28 откатов на 498
успешных GPU-распознаваний: `small-q8_0` (264 МБ) — **0**, `medium-q5_0`
(539 МБ) — 2, `large-v3-q5_0` (1031 МБ) — 6, полный `medium` (1.5 ГБ) — 16.
Причина: модель грузится в VRAM **одним блоком**, и WSL+Maxwell отдаёт такой
блок не всегда, даже когда свободно 2+ ГБ. Проверено также `GGML_CUDA_NO_VMM=1`:
legacy-путь жрёт вдвое больше (3.2 ГБ) и умирает с кодом 10 — хуже, не включаем.

Чего нет (честные пробелы):
- Нет предварительной проверки VRAM: крупная модель падает с `GGML_ASSERT`, а не
  откатывается заранее (лечится предупреждением в popup и докторе).
- Нет автовыбора кванта под VRAM и молчаливой смены модели (не мешаем выбору
  пользователя) — только рестарт для возврата на GPU.
- `faster-whisper` всегда CPU.
- Рекомендованная связка: `medium-q5_0` основная (стабильно на GPU), `small-q8_0`
  для коротких команд (быстрее всех), `large-v3-q5_0` — «точный режим» с
  ожиданием редких откатов.

---

## 4. Плагин (`src/`)

Entrypoint `src/index.ts` — хук `command.execute.before` для `/voice` и алиаса
`/v`, только динамические `import()` (иначе `getLegacyPlugins` падает; топ-левел
экспортов кроме функций — нельзя). Шаблон команды гасится через `setParts()`.

| Модуль | Роль |
|---|---|
| `lib/config.ts` | `DEFAULTS`, `STT_LANGUAGES/DEVICES`, `PLUGIN_VERSION`, модель/API-ключ |
| `lib/state.ts` | Персистентность `backend/language/device` (`~/.config/opencode-voice/state.json`); приоритет: env > файл > дефолты |
| `lib/stt.ts` | `transcribe()` (local/api, GPU/CPU), `stripNonSpeech()`, `logRecognized()` |
| `lib/whisper.ts` | Пути whisper.cpp/моделей/CUDA (`OPENCODE_VOICE_HOME/_WHISPER_DIR`, `CUDA_HOME`), `WHISPER_MODEL/WHISPER_CPP_MODEL_SIZE` (GPU: medium, CPU: small) |
| `lib/recorder.ts` | PTT (`startPushToTalk/waitPushToTalkAuto/...`), `recoverMic`, пины `OPENCODE_VOICE_SOURCE` |
| `lib/beep.ts` | `beep()` (aplay/paplay/ffplay) |
| `lib/heal.ts` | `heal()` — `doctor.sh --fix`, затем `ensureSttServer`, затем проверка `/health`; кулдаун 90 с |
| `lib/server-launcher.ts` | `ensureSttServer()` (до 60 с ожидания `/health`), `startServerWatchdog()` (120 с); авто-`OPENCODE_VOICE_TTS=1` и `PULSE_SERVER`, если не заданы |
| `lib/text.ts` | `stripNonSpeech()` + `cleanForSpeech()` — канон, паритет с `tts.js` и Python |

Сабкоманды `/voice`: PTT без аргументов; `<файл.wav|mp3|m4a|ogg|flac>`; `backend
[local|api]`; `lang [ru|en|auto]`; `device [auto|gpu|cpu]`; `doctor [--fix]`
(выполняет `doctor.sh`, показывает хвост 14 строк); `heal|fix|restart`;
`help`. TUI: `.opencode/tui/voice.ts` (`<leader>v`); веб-кнопка —
`extension/content.js`.

---

## 5. Расширение

`manifest.json` v3 (`activeTab/scripting/storage`; host-права на локальные
адреса; content-скрипты `tts.js` → `content.js` на localhost/127.0.0.1).

### 5.1. `content.js` — кнопка и мост

- `STT_SERVER = <protocol>//<STT_HOST>:<STT_PORT>`; хост — `location.hostname`
  (`localhost` → `127.0.0.1`), запоминается в storage для popup; порт —
  `sttPort` из storage (дефолт 8765) + живая подписка `onChanged` (без F5).
- Гибридная запись (браузер → сервер), вставка в промпт, тосты, хоткеи
  (`hotkey`/`sendHotkey` из storage, без F5), бипы, пинг версии (`/beep?freq=0`).
- TTS-старту передаёт `serverUrl` **функцией** (актуальный URL на момент запроса),
  иначе инициализация обгоняла асинхронное чтение порта.
- `log()` gated флагом `ttsDebug` (ошибки — всегда через `console.error`).

### 5.2. `popup.js/popup.html` — настройки

Контролы: `uiLang`, `status`, `beeps`, `hotkey`, `sendHotkey`, `tts`,
`ttsEngine` (browser/server), `ttsMode`, `ttsLang`, `ttsVoice` (голоса ОС),
`ttsServerEngine` (piper/silero), `ttsServerVoice`, `ttsLocalOnly`,
`ttsStopKey`, `ttsMuteKey`, `ttsDebug`, `ttsRate` (0.5–2), `ttsStatus` (панель
диагностики), `token`, `sttPort`, `sttModel`, `sttDevice` (auto/gpu/cpu, без
рестарта), `sttRisk` (плашка предупреждения), кнопки
`beepTestBtn/ttsTestBtn/testBtn/healBtn/openBtn`, `versions`.

Механика, которую важно знать:
- URL собирается `rebuildServer(host, port)`; проверки запрещены до чтения
  storage + single-flight (иначе статус мигал красно-зелёным).
- При сетевом провале — тихий фолбэк на `127.0.0.1` с запоминанием (лечит
  протухший хост от LAN-вкладок).
- Селекты модели/движка/голосов наполняются с сервера (`/health`, `/voices`);
  списки = только установленное; неудачное переключение мгновенно откатывает UI.
- Настройки делятся по движку (браузерные прячутся при серверном и наоборот;
  скорость скрыта при Silero — он игнорирует `rate`).
- `sttRisk`: жёлтая плашка, если `model_risk` (модель крупнее ~1 ГБ → риск
  CPU-фолбэка на слабой VRAM); при `gpu_fallback_streak > 0` статус красный с
  пояснением «сервер вернёт GPU после рестарта».
- Кнопка heal: `POST /heal?restart=1` + ожидание до 150 с; мёртвому серверу —
  честная подсказка про `/voice heal` (браузер процесс поднять не может).
- Ошибки содержат URL (`…недоступен (http://…): Failed to fetch`).

### 5.3. Хранилище (`chrome.storage.local`)

`uiLang`, `token`, `sttHost`, `sttPort`, `beeps`, `hotkey`, `sendHotkey`,
`tts/ttsEngine/ttsMode/ttsLang/ttsVoice/ttsServerVoice/ttsLocalOnly/ttsRate/ttsDebug/ttsHotkey/ttsMuteHotkey`
(+ внутренние `ttsMaxSeconds/ttsBriefSentences` без UI).
Пишет только popup; читают content.js/`tts.js` (живые `onChanged`-подписки).

---

## 6. Как что переключается

| Что | Где | Как (код/env) |
|---|---|---|
| STT backend | `/voice backend`, state | `OPENCODE_VOICE_BACKEND=local\|api` (+`OPENAI_API_KEY`), env > файл |
| STT язык | `/voice lang`, state | `OPENCODE_VOICE_LANGUAGE=ru\|en\|auto` (`ru` быстрее на ~25–30%) |
| STT устройство | popup «Устройство (GPU/CPU)», `/voice device`, state | `POST /device` (без рестарта) или `OPENCODE_VOICE_DEVICE=auto\|gpu\|cpu` (при старте сервера) |
| STT модель | popup «Модель распознавания» | `POST /model` → рестарт; env `WHISPER_CPP_MODEL` (полный путь) / `WHISPER_MODEL` (размер) |
| Порт/хост сервера | popup «Порт сервера» | `OPENCODE_VOICE_PORT` (сервер/лаунчер/doctor), storage `sttPort` (расширение) |
| TTS вкл/движок | popup, сервер | `OPENCODE_VOICE_TTS=1`, `OPENCODE_VOICE_TTS_ENGINE=piper\|silero`; в popup — движок озвучки + движок сервера |
| TTS голос/темп/режим | popup | `ttsServerVoice` → `POST /speak {voice}`; `rate` (не для Silero); `mode=brief\|full` |
| Токен | popup ↔ сервер | `OPENCODE_VOICE_TOKEN` ↔ поле popup (`X-Voice-Token`) |
| Восстановление | popup/`/voice` | `POST /heal?restart=1`, `/voice heal`, `doctor.sh --fix` |
| Стоп озвучки | popup «Стоп озвучки» | `ttsHotkey` (дефолт `ctrl+c`), ловится только во время речи |
| Mute озвучки | popup «Выключить озвучку» | `ttsMuteHotkey` (дефолт `alt+m`), работает и в тишине; снимание досказывает заглушённый текст |
| Порог автолечения GPU | env | `OPENCODE_VOICE_FB_STREAK` (дефолт 2 отката подряд → рестарт; `0` = выключить), `OPENCODE_VOICE_FB_HEAL_PAUSE` (1.5 с) |

---

## 7. Скрипты

- **`doctor.sh [--fix]`** — диагностика кнопки/микрофона: процесс/порт/`/health`,
  bind-конфликт (подсказка про WinNAT), **размер активной STT-модели против VRAM**
  (⚠️ при >1 ГБ: на слабой карте лотереит, часть распознаваний уйдёт на CPU) и
  **счётчик откатов** `whisper.cpp→CPU` (общий + в последних 400 строках лога;
  ⚠️ если идут прямо сейчас), CORS-preflight `X-Voice-Source/Token`,
  зависшая запись, mic-проба (`arecord -D pulse`, 3 с + peak/RMS), свежесть логов.
  `--fix`: убить/поднять сервер (сначала ждём штатный watchdog ~30 с, затем прямой
  `nohup python3 stt_server.py --port`, ожидание ~150 с), сброс `/record/*`,
  `fix-mic.sh`.
- **`fix-mic.sh`** — пересоздание RDP-аудиоканала WSLg (рестарт weston+PulseAudio
  через `$WSL_EXE`; Wayland-окна закроются). Не помогло → `wsl --shutdown`.
- **`setup.sh`** — установка: CPU (дефолт) / `--gpu` (сборка whisper.cpp + CUDA,
  модель), `--tts` (Piper + голоса + Silero `v4_ru.pt`), `--all`, `--check`
  (dry-run), `--write-config` (патчит `~/.config/opencode/*.json` с бэкапом),
  `--yes`, `--model-size`. Пишет `$OPENCODE_VOICE_HOME/env.sh` (подключать вручную).
- **`sync-plugin.sh`** — `src/index.ts → .opencode/plugins/index.ts`
  (перепись `./lib/` → `../../src/lib/`); `--check` для CI.

---

## 8. Общие спеки и тесты

- `shared/stt-spec.json` — единый источник: non-speech маркеры, тишина
  (peak 700/rms 80), флаги `-mc 0 -sns`, модели GPU/CPU, TTS-дефолты. Читают TS и Python.
- `shared/strip-cases.json` (14), `shared/tts-cases.json` (20) — кросс-паритет
  `stripNonSpeech`/`cleanForSpeech` между TS, Python и `tts.js` (через `node:vm`).
- `test/` (Node, hermetic, fake-`$`/stub-рекордер/whisper): unit-текст/stt/whisper/
  state/heal + TTS (включая `speechBudget` и раскладко-независимый `comboMatches`)
  + E2E плагина и сервера по HTTP (скип без Flask).
- `stt-server/tests/test_server.py` (pytest, ~84): health/CORS/токен, transcribe/
  record, гарды 400/413/429/504, heal/model/engine/**device**, автолечение откатов
  (`test_fallback_streak_*`), TTS+Silero, spec-паритет.
- CI: `npm ci`, `typecheck`, `sync-plugin.sh --check`, `npm test`, `pytest`.

---

## 9. Логи, диагностика, известные ловушки

Логи: `/tmp/opencode/stt_server.log` (старт + транскрибации),
`voice-recognized.log` (`source=`), `voice-requests.log` (origin/UA),
`voice-tts.log` (кэш/ошибки), записи — `/dev/shm/opencode-voice/` (RAM).

1. **Порт съеден Windows** (`EADDRINUSE`, а `ss` пуст): `netsh interface ipv4 show
   excludedportrange` → админское `net stop/start winnat` или смена
   `OPENCODE_VOICE_PORT` (проверено: 19876 свободен).
2. **GPU-падения на Maxwell (GTX 950M)**: модель грузится в VRAM **одним блоком**,
   и WSL+Maxwell отдаёт такой блок не всегда (`GGML_ASSERT`, exit 134), даже когда
   свободно 2+ ГБ — сервер уходит на CPU (faster-whisper) и сидит там до рестарта.
   Измерено: `small-q8_0` 0 откатов, `medium-q5_0` 2, `large-v3-q5_0` 6, полный
   `medium` 16. Лечится квантованием и автолечением: серия откатов подряд (дефолт
   2) → сервер сам себя перезапускает и возвращается на GPU. Признак в логе:
   `GPU-откат #N подряд`; в `/health` — `gpu_fallback_streak`, в popup — красный
   статус; `GGML_CUDA_NO_VMM=1` делает хуже (3.2 ГБ и код 10), не включать.
3. **WSL2 без `/dev/snd`**: только PulseAudio (`PULSE_SERVER=unix:/mnt/wslg/PulseServer`);
   `/proc/asound` пуст по дизайну.
4. **Тишина/галлюцинации**: сначала уровни (peak/RMS) и доставка (`doctor.sh`),
   потом модель. Пустой WAV <2000B → `recoverMic`.
5. **401** — токен popup ≠ `OPENCODE_VOICE_TOKEN`; **409** — зависшая запись
   (`POST /record/stop` / `doctor --fix`); **Failed to fetch** — сервер не слушает
   или CORS без `X-Voice-Source`.
