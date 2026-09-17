# Аудит OpenCode Voice — путь до промышленной эксплуатации

**Дата:** 2026-09-17 · **База:** коммит `ff4a1cc` · **Легенда:** ✅ сделано · 🚧 частично · ⬜ запланировано

Документ ведём по мере работ: отмечаем статус и коммит.

---

## P0 — блокеры

### 1. Безопасность STT-сервера
- ✅ Bind только `127.0.0.1` по умолчанию (`OPENCODE_VOICE_HOST` / `--host`). Проверено: `ss -ltn` → `127.0.0.1:8765`; доступ из Windows (PowerShell → `200`) сохранён. — `stt_server.py`, коммит `a46b6b8`
- ✅ CORS только для локальных origin (`127.0.0.1`, `localhost`, RFC1918, `chrome-extension://`); чужой origin заголовок не получает. — `stt_server.py`
- ⬜ Опциональный токен `OPENCODE_VOICE_TOKEN` (проверка заголовка на сервере; передача из плагина и расширения). Пустой токен = поведение как сейчас.
- ⬜ Лимит размера загрузки/таймауты и простейший rate-limit на `/transcribe`, `/beep`, `/record/*`.

### 2. Ленивый импорт `faster-whisper`
- ✅ `from faster_whisper import WhisperModel` убран с верхнего уровня: сервер стартует в режиме whisper.cpp/GPU без пакета; `load_model()` даёт понятную ошибку; откат GPU→CPU не скрывает исходную ошибку. Проверено эмуляцией отсутствия пакета. — `stt_server.py`, коммит `a46b6b8`

### 3. Воспроизводимая установка
- ⬜ `requirements.txt` (flask, faster-whisper, requests) с пинами версий; зафиксировать lock для npm (либо явно описаставить как dev-репозиторий).
- ⬜ Проверка минимальных версий Python/CUDA/драйвера при старте сервера (понятные сообщения).

### 4. CI и автотесты
- ⬜ GitHub Actions: `tsc --noEmit`, `python3 -m py_compile`, `pytest`.
- ⬜ `pytest` для сервера: `/health`, `/transcribe` (с `OPENCODE_VOICE_FAKE_AUDIO`), `/beep?freq=0`, граничные случаи `/record/stop` без start и двойной start. Сейчас есть только ручной `test_stt_server.py`, требующий запущенного сервера и микрофона.
- ⬜ Тест `stripNonSpeech`/`_strip_non_speech` общим набором кейсов (TS и Python).

### 5. Дублирование логики TS ↔ Python
- ⬜ Выбор бэкенда, дефолты моделей и `stripNonSpeech` реализованы дважды (`src/lib/stt.ts` и `stt-server/stt_server.py`) и уже рассинхронизировались. Решение: один источник истины (плагин ходит в сервер, либо общий формат/генерация).

---

## P1 — важно

6. ⬜ **Пустой запрос модели** на путях `/voice <file>` при ошибке и info-подкомандах `backend/lang/device/help`: остаётся `parts="\n"`. Привести к единому поведению (как в PTT — throw или иной механизм). — `src/index.ts`
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
- ✅ `voice-button.user.js` помечен DEPRECATED; README (EN/RU) раздел 5 предупреждает.
- ⬜ `.opencode/web/voice.ts` (JSX) не входит в `tsconfig.include` — не типизируется. Решить: включить в сборку (с `jsx`-настройками) или удалить дубль.
- ⬜ `sync-plugin.sh` + закоммиченный `.opencode/plugins/index.ts` — дубль `src/index.ts`. Перейти на загрузку `./src/index.ts` из `opencode.json`, синк удалить.
- ⬜ `tui.json` переопределяет `theme`/`leader`/`attention.sound` — навязчиво для публичного плагина; сделать нейтральным.
- ⬜ `note()` (`stt.ts`) и `runPythonFile` пишут в `/tmp` (диск) — перенести в RAM-каталог.
- ⬜ Мелочь: в `_record_cmd` используется `-f cd` (44.1 кГц стерео) с переопределением `-r/-c` — привести к `S16_LE`, как в плагине.

---

## Проверки (актуально на `ff4a1cc`)
- `tsc --noEmit` — OK
- `python3 -m py_compile stt_server.py` — OK
- Bind/CORS/доступ из Windows — OK
- Ленивый импорт (эмуляция отсутствия `faster-whisper`) — OK
- Живой прогон: кнопка 🎤 + `/voice` + бипы — OK (пользователь)
