# План тестирования opencode-voice

## 1. Локальный бэкенд (faster-whisper) — требует модели

### 1.1 Загрузка модели faster-whisper
```bash
python3 -c "
from faster_whisper import WhisperModel
model = WhisperModel('base', device='cpu', compute_type='int8')
print('Модель base загружена')
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
# Запуск в WSL-хосте (без контейнера)
export PATH="$HOME/.local/bin:$PATH"
export OPENCODE_VOICE_BACKEND=local
opencode
# В TUI: /voice  (начать запись, затем нажать Enter/пробел для остановки)
```

**Ожидается:** запись сохраняется в `/tmp/voice-ptt-*.wav`, текст вставляется в prompt.

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

---

## 6. Тест с реальным голосом (через микрофон в WSL)

### Предусловия:
- Запуск в WSL2 без контейнера песочницы (`/mnt/c/temp/openvi/...`)
- `ffmpeg` доступен в PATH
- `python3` + `faster-whisper` установлен (`pip install faster-whisper` уже выполнено)
- Модель `base` загружена (`faster-whisper` скачивает автоматически при первом запуске)

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
- `skill({ name: "voice-stt" })` — справка по конфигурации
- `skill({ name: "voice-debug" })` — диагностика бэкендов

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
