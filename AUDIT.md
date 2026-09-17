# Аудит OpenCode Voice — путь до промышленной эксплуатации

**Дата:** 2026-09-17 · **База:** `v0.3.1` (рабочая ветка) · **Легенда:** ✅ сделано · 🚧 частично · ⬜ запланировано

Документ ведём по мере работ: отмечаем статус и коммит.

---

## P0 — блокеры

### 1. Безопасность STT-сервера
- ✅ Bind только `127.0.0.1` по умолчанию (`OPENCODE_VOICE_HOST` / `--host`). Проверено: `ss -ltn` → `127.0.0.1:8765`; доступ из Windows (PowerShell → `200`) сохранён. — `stt_server.py`, коммит `a46b6b8`
- ✅ CORS только для локальных origin (`127.0.0.1`, `localhost`, RFC1918, `chrome-extension://`); чужой origin заголовок не получает. — `stt_server.py`
- ✅ Опциональный токен `OPENCODE_VOICE_TOKEN` (заголовок `X-Voice-Token` / `Authorization: Bearer`; `/health` исключён). Сервер: `before_request`; расширение: поле токена в popup + заголовки во всех запросах. Пустой токен = поведение как раньше. Тесты: 401/200/health-exempt. — `stt_server.py`, `extension/*`
- ✅ Защита от перегрузки: `MAX_CONTENT_LENGTH` (`413`), лимит длительности (`400`), семафор на транскрибацию (`429`), таймаут с `504`, token-bucket rate-limit на `/transcribe`/`/record/*`/`/beep`, серверная проверка `Origin` для POST (`403`), периодическая чистка RAM-каталога. Env: `OPENCODE_VOICE_MAX_UPLOAD_MB` (25), `_MAX_AUDIO_SECONDS` (300), `_MAX_CONCURRENT` (1), `_TRANSCRIBE_TIMEOUT` (300), `_RATE_LIMIT` (60/мин), `_PURGE_INTERVAL` (600). Расширение: предпроверка размера и понятные ошибки (`413/429/504/403`). Тесты: +7 (итого 37). — `stt_server.py`, `extension/content.js`

### 2. Ленивый импорт `faster-whisper`
- ✅ `from faster_whisper import WhisperModel` убран с верхнего уровня: сервер стартует в режиме whisper.cpp/GPU без пакета; `load_model()` даёт понятную ошибку; откат GPU→CPU не скрывает исходную ошибку. Проверено эмуляцией отсутствия пакета. — `stt_server.py`, коммит `a46b6b8`

### 3. Воспроизводимая установка
- ✅ `stt-server/requirements.txt` (flask + faster-whisper) и `requirements-dev.txt` (flask/pytest/requests для CI) — версии запинены. `package-lock.json` добавлен в git (нужен для `npm ci` в CI).
- ✅ Проверка версий/зависимостей при старте сервера (`_runtime_checks`, `_cuda_driver_version`): Python, наличие whisper.cpp CLI/модели, CUDA-драйвер и версия, рекордер (arecord/ffmpeg/sox), доступность `PULSE_SERVER`. Понятные `WARNING`. `/health` отдаёт `python` и `auth`. — `stt_server.py`
- ✅ Установка одной командой `setup.sh`: проверки зависимостей, `pip install -r requirements.txt`, сборка whisper.cpp с CUDA и скачивание `ggml-*.bin` (`--gpu`), `sync-plugin.sh`, готовые строки для `opencode.json`/`tui.json` (`--write-config` с бэкапом), `doctor.sh` в конце; `--check` — только план. — `setup.sh`

### 4. CI и автотесты
- ✅ GitHub Actions `.github/workflows/ci.yml`: `npm ci` → `tsc --noEmit` → `npm test` → `sync-plugin.sh --check` → `py_compile` → `pytest`.
- ✅ Герметичные pytest-тесты (`stt-server/tests/test_server.py`, **37 шт.**): `/health` (backend/python/auth), CORS (allow/deny + `X-Voice-Source`), токен (off/401/200/health-exempt), `/beep` (freq=0 и мусорный freq), `/transcribe` (успех/без файла/ошибка), `/record/*` через `OPENCODE_VOICE_FAKE_AUDIO`, `_runtime_checks`/`_cuda_driver_version`, порог тишины (`_wav_levels`/`_is_silent`), анти-галлюцинационные флаги, `_wav_duration`, тег `source=` в логе распознавания и экранирование текста. Микрофон и модель не нужны.
- ✅ Побочный фикс: `/health` теперь отдаёт эффективный `backend` и при запуске не через `main()`.
- ✅ Порог тишины + анти-галлюцинации: на тишине/шуме Whisper не запускается (`OPENCODE_VOICE_SILENCE_PEAK/_RMS`); whisper.cpp работает с `-mc 0 -sns`. Плагин и сервер. — коммит `90ca852`
- ✅ Общий набор кейсов для `stripNonSpeech` / `_strip_non_speech` (TS + Python): Python — в `test_server.py`, TS — `test/strip-nonspeech.test.mjs` (12 кейсов, `npm test`, шаг в CI). Логика TS вынесена в `src/lib/text.ts` без зависимостей.

### 5. Дублирование логики TS ↔ Python
- ✅ Общие значения вынесены в `shared/stt-spec.json` (список служебных маркеров и символы, пороги тишины, доп. флаги whisper.cpp `-mc 0 -sns`, размеры моделей GPU/CPU) — читают и TS (`src/lib/text.ts`, `src/lib/whisper.ts`), и Python (`stt_server.py`), со встроенным фолбэком. Кейсы `stripNonSpeech` — в `shared/strip-cases.json`, их проверяют оба набора тестов (у Python паритетных тестов раньше не было). Осталось (не критично): выбор бэкенда по-прежнему описан в двух местах — плагин (локальный whisper.cpp/faster-whisper/api) и сервер (`transcribe_file`), но scopes у них разные.

---

## P1 — важно

6. ✅ **Пустой запрос модели**: info-подкоманды `backend/lang/device/help` и сбой `/voice <file>` кладут в `parts` служебный текст (`svc(...)`) вместо `"\n"`; успех PTT/файла — распознанный текст; сбои PTT бросают исключение (без запроса). — `src/index.ts`
7. ⬜ **Персист состояния**: `state.backend/language/device` живёт в памяти, общий на все сессии, сбрасывается при рестарте. Писать в `~/.config/opencode-voice/config.json` (или читать из `opencode.json`). — `src/index.ts`, `src/lib/config.ts`
8. ✅ **Портируемость**: пути вынесены в `src/lib/whisper.ts` и зеркально в `stt_server.py`: база `OPENCODE_VOICE_HOME` (`~/.local/share/opencode-voice`), CLI/модель ищутся в `OPENCODE_VOICE_WHISPER_DIR` (`<home>/whisper`), CUDA-каталоги — glob `cuda-*` + `CUDA_HOME`/`CUDA_PATH` (версия toolkit не зашита). Тесты: TS (`test/whisper.test.mjs`) + Python (`test_server.py`).
9. ✅ **Адаптивный выбор модели**: `WHISPER_MODEL`/`WHISPER_CPP_MODEL_SIZE` переопределяют, иначе `medium` на GPU и `small` на CPU; на CPU whisper.cpp берёт `small`, если он есть. — `src/lib/{stt,whisper}.ts`, `stt_server.py`
10. ⬜ **Сериализация транскрибации**: Flask `threaded=True` + общий объект модели faster-whisper → возможные конфликты при параллельных запросах. Lock/очередь.
11. ✅ **Блокирующий хук / логи**: поведение `/voice` (хук блокируется на время записи; отказы логируются как ERROR, чтобы не уходил пустой запрос; авто-стоп по тишине) задокументировано в README EN/RU и AGENTS.md. — `README.md`, `README.ru.md`
12. 🚧 **npm-пакет**: добавлены `files`, `engines`, `repository`, `homepage`, `bugs`, `publishConfig`; имя переведено в скоуп `@di1r1/opencode-voice` (без скоупа имя занято), `package-lock` пересинхронизирован. Осталось: реальная публикация/версионирование. — `package.json`
13. 🚧 **Chrome Web Store**: добавлены иконки 16/32/48/128 (`extension/icons/`, в `manifest.icons` и `action.default_icon`), версия расширения 1.0.8; версия сервера и расширения видны в popup и в консоли. Осталось: сузить `content_scripts.matches` (`<all_urls>` → реджект) и политика приватности. — `extension/manifest.json`

---

## P2 — гигиена

- ✅ Удалены: `TranscribeResult`, `STT_BACKENDS`, неиспользуемые поля `config` (`sampleRate`/`channels`/`bitsPerSample`/`pttKey`/`pulseServer`) и мёртвые env (`OPENCODE_VOICE_PTT_KEY`, `_BITS_PER_SAMPLE`, `_SAMPLE_RATE`, `_CHANNELS`), `stopPushToTalk`. — коммит `ff4a1cc`
- ✅ `TEST_PLAN.md` актуализирован (ОЗУ `/dev/shm`, авто-стоп по тишине, doctor/кнопка, sync вместо ручного `cp/sed`).
- ✅ `.opencode/web/voice.ts` переименован в **`.tsx`** (JSX требует `.tsx`) и включён в `tsc` (`jsx: preserve`, `jsxImportSource: @opentui/solid`); поправлены типы обработчиков. Файл **опционален** — в глобальном TUI-конфиге не подключён (см. README §4).
- ✅ `sync-plugin.sh`: добавлен режим `--check` (для CI/локально); сам синк сохранён, т.к. глобальный конфиг OpenCode грузит именно `.opencode/plugins/index.ts` (проверено в `~/.config/opencode/opencode.json`). Проверка: `bash sync-plugin.sh --check` → OK.
- ✅ `tui.json` приведён к нейтральному виду (убраны `theme`/`leader`/`attention`; остался список плагинов, путь web-плагина → `.tsx`).
- ✅ `runPythonFile` (`stt.ts`) пишет временный `.py` в RAM-каталог с фолбэком в `os.tmpdir()`; `note()` оставлен в `/tmp/opencode` — это лог, не аудио.
- ✅ `_record_cmd`: `-f cd` → `-f S16_LE`; проверено записью: `pcm_s16le, 16000 Hz, mono`.
- ✅ Запись `/voice`: авто-стоп по тишине (~1.5 с) + жёсткий предел 60 с; остановка рекордера мягкая (SIGINT), WAV-заголовок всегда финализируется (раньше `SIGKILL` обрезал длинные записи). Проверено: `declared == actual`. — коммит `1f4a13f`
- ✅ Единый лог распознанного текста `/tmp/opencode/voice-recognized.log` с `source=command|button`, бэкендом/моделью/языком/длительностью; расширение шлёт `X-Voice-Source`, сервер принимает заголовок в CORS. — коммит `1f4a13f`
- ✅ `doctor.sh` (диагностика/ремонт пути кнопки) + `/voice doctor [--fix]`. — коммит `d951689`
- ✅ 7 скиллов `ovi-*` (overview/plugin/server/extension/models/debug/dev), валидированы; удалены устаревшие `voice-debug`/`voice-stt`. — коммит `8d66782`
- ✅ `.opencode/` вынесен из git (git-ignored, генерируется `sync-plugin.sh`; в CI добавлен `sync-plugin.sh` перед `--check`). — коммит `3ebde0b`
- ✅ Удалён неиспользуемый `voice-button.user.js` (Tampermonkey) и его упоминания. — коммит `9299810`

---

## Проверки (актуально на `v0.3.1`)
- `tsc --noEmit` — OK
- `python3 -m py_compile stt_server.py` — OK
- `bash sync-plugin.sh --check` — OK
- `python3 -m pytest` (**44 теста**, герметично) — OK
- `npm test` (**33 теста**: 14 кейсов `stripNonSpeech` из `shared/strip-cases.json` + целостность `shared/stt-spec.json` + 9 путей/моделей whisper.cpp + E2E: пайплайн плагина (рекордер→WAV→whisper-CLI→текст, стаб-бинари) и реальный сервер по HTTP со стаб-whisper-cli) — OK
- Bind/CORS/доступ из Windows — OK (`ss` → `127.0.0.1:8765`)
- Ленивый импорт (эмуляция отсутствия `faster-whisper`) — OK
- Запись сервером — OK (`pcm_s16le, 16000 Hz, mono`), `/beep` пишет в лог
- Живой прогон из браузера (transcribe + beep) и `/voice` (GPU whisper.cpp) — OK (`voice-requests.log`, `voice-recognized.log`)
- Авто-стоп по тишине и мягкая остановка WAV — OK (`declared == actual`)
