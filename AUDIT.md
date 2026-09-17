# Аудит OpenCode Voice — путь до промышленной эксплуатации

**Дата:** 2026-09-17 · **База:** коммит `ff4a1cc` · **Легенда:** ✅ сделано · 🚧 частично · ⬜ запланировано

Документ ведём по мере работ: отмечаем статус и коммит.

---

## P0 — блокеры

### 1. Безопасность STT-сервера
- ✅ Bind только `127.0.0.1` по умолчанию (`OPENCODE_VOICE_HOST` / `--host`). Проверено: `ss -ltn` → `127.0.0.1:8765`; доступ из Windows (PowerShell → `200`) сохранён. — `stt_server.py`, коммит `a46b6b8`
- ✅ CORS только для локальных origin (`127.0.0.1`, `localhost`, RFC1918, `chrome-extension://`); чужой origin заголовок не получает. — `stt_server.py`
- ✅ Опциональный токен `OPENCODE_VOICE_TOKEN` (заголовок `X-Voice-Token` / `Authorization: Bearer`; `/health` исключён). Сервер: `before_request`; расширение: поле токена в popup + заголовки во всех запросах. Пустой токен = поведение как раньше. Тесты: 401/200/health-exempt. — `stt_server.py`, `extension/*`
- ⬜ Лимит размера загрузки/таймауты и простейший rate-limit на `/transcribe`, `/beep`, `/record/*`.

### 2. Ленивый импорт `faster-whisper`
- ✅ `from faster_whisper import WhisperModel` убран с верхнего уровня: сервер стартует в режиме whisper.cpp/GPU без пакета; `load_model()` даёт понятную ошибку; откат GPU→CPU не скрывает исходную ошибку. Проверено эмуляцией отсутствия пакета. — `stt_server.py`, коммит `a46b6b8`

### 3. Воспроизводимая установка
- ✅ `stt-server/requirements.txt` (flask + faster-whisper) и `requirements-dev.txt` (flask/pytest/requests для CI) — версии запинены. `package-lock.json` добавлен в git (нужен для `npm ci` в CI).
- ✅ Проверка версий/зависимостей при старте сервера (`_runtime_checks`, `_cuda_driver_version`): Python, наличие whisper.cpp CLI/модели, CUDA-драйвер и версия, рекордер (arecord/ffmpeg/sox), доступность `PULSE_SERVER`. Понятные `WARNING`. `/health` отдаёт `python` и `auth`. — `stt_server.py`

### 4. CI и автотесты
- ✅ GitHub Actions `.github/workflows/ci.yml`: `npm ci` → `tsc --noEmit` → `sync-plugin.sh --check` → `py_compile` → `pytest`.
- ✅ Герметичные pytest-тесты (`stt-server/tests/test_server.py`, 21 шт.): `/health`, CORS (allow/deny), токен (off/401/200/health-exempt), `/beep` (freq=0 и мусорный freq), `/transcribe` (успех/без файла/ошибка), `/record/*` через `OPENCODE_VOICE_FAKE_AUDIO`, `_runtime_checks`/`_cuda_driver_version`. Микрофон и модель не нужны.
- ✅ Побочный фикс: `/health` теперь отдаёт эффективный `backend` и при запуске не через `main()`.
- ⬜ Общий набор кейсов для `stripNonSpeech` / `_strip_non_speech` (TS + Python).

### 5. Дублирование логики TS ↔ Python
- ⬜ Выбор бэкенда, дефолты моделей и `stripNonSpeech` реализованы дважды (`src/lib/stt.ts` и `stt-server/stt_server.py`) и уже рассинхронизировались. Решение: один источник истины (плагин ходит в сервер, либо общий формат/генерация).

---

## P1 — важно

6. ✅ **Пустой запрос модели**: info-подкоманды `backend/lang/device/help` и сбой `/voice <file>` кладут в `parts` служебный текст (`svc(...)`) вместо `"\n"`; успех PTT/файла — распознанный текст; сбои PTT бросают исключение (без запроса). — `src/index.ts`
7. ⬜ **Персист состояния**: `state.backend/language/device` живёт в памяти, общий на все сессии, сбрасывается при рестарте. Писать в `~/.config/opencode-voice/config.json` (или читать из `opencode.json`). — `src/index.ts`, `src/lib/config.ts`
8. ⬜ **Портируемость**: захардкожены `~/cuda-12.6/lib64`, `~/.local/share/opencode-voice/whisper/*`. Авто-детекция + только env. — `src/lib/stt.ts:288`, `stt_server.py:100,286`, `_cuda_available`
9. ⬜ **Адаптивный выбор модели**: сейчас дефолт `medium` и на CPU (медленно). Автоподбор (CPU→small, GPU→medium) или явная настройка.
10. ⬜ **Сериализация транскрибации**: Flask `threaded=True` + общий объект модели faster-whisper → возможные конфликты при параллельных запросах. Lock/очередь.
11. ⬜ **Блокирующий хук / логи**: `/voice` блокирует хук на 30 с (таймера нет), нормальные отказы пишутся как ERROR в лог OpenCode. Задокументировать в README/FAQ.
12. ⬜ **npm-пакет**: нет `files`, `exports`, `repository`, `engines`, `prepublishOnly`; имя `opencode-voice` занято — использовать скоуп (`@di1r1/opencode-voice`). — `package.json`
13. ⬜ **Chrome Web Store**: нет иконок (`icons`), `content_scripts.matches` включает `<all_urls>` (широкое разрешение — реджект), возможно лишние `activeTab`/`scripting`, нет политики приватности. — `extension/manifest.json`

---

## P2 — гигиена

- ✅ Удалены: `TranscribeResult`, `STT_BACKENDS`, неиспользуемые поля `config` (`sampleRate`/`channels`/`bitsPerSample`/`pttKey`/`pulseServer`) и мёртвые env (`OPENCODE_VOICE_PTT_KEY`, `_BITS_PER_SAMPLE`, `_SAMPLE_RATE`, `_CHANNELS`), `stopPushToTalk`. — коммит `ff4a1cc`
- ✅ `TEST_PLAN.md` актуализирован (`/dev/shm`, фиксированные 30 с).
- ✅ `.opencode/web/voice.ts` переименован в **`.tsx`** (JSX требует `.tsx`) и включён в `tsc` (`jsx: preserve`, `jsxImportSource: @opentui/solid`); поправлены типы обработчиков. Файл **опционален** — в глобальном TUI-конфиге не подключён (см. README §4).
- ✅ `sync-plugin.sh`: добавлен режим `--check` (для CI/локально); сам синк сохранён, т.к. глобальный конфиг OpenCode грузит именно `.opencode/plugins/index.ts` (проверено в `~/.config/opencode/opencode.json`). Проверка: `bash sync-plugin.sh --check` → OK.
- ✅ `tui.json` приведён к нейтральному виду (убраны `theme`/`leader`/`attention`; остался список плагинов, путь web-плагина → `.tsx`).
- ✅ `runPythonFile` (`stt.ts`) пишет временный `.py` в RAM-каталог с фолбэком в `os.tmpdir()`; `note()` оставлен в `/tmp/opencode` — это лог, не аудио.
- ✅ `_record_cmd`: `-f cd` → `-f S16_LE`; проверено записью: `pcm_s16le, 16000 Hz, mono`.

---

## Проверки (актуально на `ff4a1cc` + правки P2)
- `tsc --noEmit` — OK (включая `.opencode/web/voice.tsx`)
- `python3 -m py_compile stt_server.py` — OK
- `bash sync-plugin.sh --check` — OK
- `python3 -m pytest` (21 тест, герметично) — OK
- Bind/CORS/доступ из Windows — OK (`ss` → `127.0.0.1:8765`; PowerShell → `200`)
- Ленивый импорт (эмуляция отсутствия `faster-whisper`) — OK
- Запись сервером — OK (`pcm_s16le, 16000 Hz, mono`), `/beep` пишет в лог
- Живой прогон из браузера (transcribe + beep) на новом bind/CORS — OK (лог `voice-requests.log`)
