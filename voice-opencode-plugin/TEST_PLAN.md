# План тестирования opencode-voice

## 1. Локальный бэкенд (faster-whisper) — требует модели

### 1.1 Загрузка модели faster-whisper
```bash
python3 -c "
from faster_whisper import WhisperModel
model = WhisperModel('medium', device='cpu', compute_type='int8')
print('Модель medium загружена')
"
```

### 1.2 Тест распознавания WAV
```bash
export OPENCODE_VOICE_BACKEND=local
export OPENCODE_VOICE_LANGUAGE=ru
opencode
# В TUI: /voice /tmp/voice_test.wav
```

**Ожидается:** текст распознан (даже если это пустой/мусорный текст для синусоиды), toast "Готово" или ошибка с понятным текстом.

---

## 2. Push-to-talk (микрофон) — требует ALSA-устройства

### 2.1 Проверка ALSA в WSL
```bash
# Внутри WSL (без контейнера песочницы)
ls /dev/snd/
arecord -l  # список устройств
ls -l /dev/snd/
```

### 2.2 Если ALSA доступна — тест записи
```bash
# Запуск в WSL-хосте (без контейнера песочницы)
export PATH="$HOME/.local/bin:$PATH"
export OPENCODE_VOICE_BACKEND=local
export PULSE_SERVER=unix:/mnt/wslg/PulseServer
opencode
# В TUI: /voice  — запись идёт фиксированные 30 секунд, затем распознавание
```

**Ожидается:** запись сохраняется в `/dev/shm/opencode-voice/voice-ptt-*.wav` (RAM, tmpfs), текст вставляется в prompt. Файл удаляется автоматически через `OPENCODE_VOICE_RETAIN_SECONDS` (по умолчанию 300 с).

---

## 3. Разные форматы аудио

Создать тестовые файлы и проверить:
```bash
# MP3 (если ffmpeg установлен — уже установлен)
ffmpeg -f lavfi -i "sine=frequency=440:duration=3" -ac 1 -ar 16000 /tmp/test.mp3 -y

# OGG
ffmpeg -f lavfi -i "sine=frequency=440:duration=3" -ac 1 -ar 16000 /tmp/test.ogg -y

# FLAC
ffmpeg -f lavfi -i "sine=frequency=440:duration=3" -ac 1 -ar 16000 /tmp/test.flac -y
```

Проверка плагином:
```bash
/voice /tmp/test.mp3
/voice /tmp/test.ogg
/voice /tmp/test.flac
```

---

## 4. Переключение бэкендов в реальном времени

```bash
/voice backend         # показать текущий
/voice backend local    # переключить на local
/voice backend api      # переключить на api
```

**Проверка:** каждый вызов показывает toast с текущим/новым бэкендом и возвращает валидный ответ (без `UnknownError`).

---

## 5. Переключение языка в реальном времени

```bash
/voice lang             # показать текущий (ru)
/voice lang en          # переключить на en
/voice lang auto        # переключить на auto
/voice lang ru          # вернуться на ru
```

## 5.1. Переключение устройства (GPU/CPU)

```bash
/voice device           # показать текущее (auto)
/voice device cpu       # CPU: faster-whisper
/voice device gpu       # GPU: whisper.cpp + CUDA
/voice device auto      # авто: GPU, иначе CPU
```

**Ожидается:** toast с новым устройством; при `cpu` в `/tmp/opencode/voice-stt.log` пишется `faster-whisper`, при `gpu` — `whispercpp`.
Без GPU (нет `libcuda`) `auto` и `gpu` не должны падать — срабатывает откат на CPU
(`OPENCODE_VOICE_DEVICE=cpu` принудительно включает CPU).

---

## 6. Тест с реальным голосом (через микрофон в WSL)

### Предусловия:
- Запуск в WSL2 без контейнера песочницы (`/mnt/c/temp/openvi/...`)
- `ffmpeg` доступен в PATH
- `python3` + `faster-whisper` установлен (`pip install faster-whisper` уже выполнено)
- Модель `medium` загружена (`faster-whisper` скачивает автоматически при первом запуске)

### Шаги:
1. `export OPENCODE_VOICE_BACKEND=local`
2. `export OPENCODE_VOICE_LANGUAGE=ru`
3. `cd /mnt/c/temp/openvi/voice-opencode-plugin`
4. `opencode`
5. В TUI: `/voice` (начать запись → говорить → нажать Enter для остановки)
6. Ожидать: toast "Готово", текст распознанный в поле ввода

---

## 7. Тест с облачным API (через HTTP)

### Предусловия:
- `OPENAI_API_KEY` установлен в среде или `opencode.json`

### Шаги:
```bash
export OPENCODE_VOICE_BACKEND=api
export OPENCODE_VOICE_LANGUAGE=ru
opencode
# /voice /tmp/voice_test.wav (файл с речью или синусоидой)
```

Ожидается: текст распознанный, toast "Готово", валидный ответ через `/session/{id}/command`.

---

## 8. Тест скилов и агентов

### Скилы (доступны через инструмент `skill` в сессии):
- `skill({ name: "ovi-models" })` — модели/GPU/тюнинг; `ovi-overview` — обзор продукта
- `skill({ name: "ovi-debug" })` — диагностика/ремонт (doctor.sh, Failed to fetch, тишина)

### Агенты (доступны через `@` в TUI):
- `@voice-builder` — агент для разработки плагина
- `@voice-stt` — агент для настройки бэкендов

---

## 9. Проверка после изменений

После любой правки `src/index.ts` или `.opencode/plugins/index.ts`:
```bash
cp src/index.ts .opencode/plugins/index.ts
sed -i 's|from "./lib/config"|from "../../src/lib/config"|g; ...' .opencode/plugins/index.ts
# Перезапустить TUI и проверить:
# - [ ] /voice backend -> toast
# - [ ] /voice lang -> toast
# - Нет "failed to load plugin" в логах
# - Нет "UnknownError" при вызове через HTTP
```
