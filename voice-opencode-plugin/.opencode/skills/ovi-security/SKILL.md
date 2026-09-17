---
name: ovi-security
description: Использовать при вопросах безопасности и приватности OpenCode Voice — токен доступа, CORS-allowlist, bind на 127.0.0.1, что остаётся в записях и логах, ретеншен/ОЗУ, гигиена секретов в публичном репозитории, права расширения. Ключевые слова: токен, X-Voice-Token, CORS, host, 0.0.0.0, приватность, секреты, публичный репо, retention, KEEP_AUDIO.
---

# Безопасность и приватность

Проект публичный, а сервер умеет писать с микрофона и отдавать расшифровки — поэтому границы доступа и утечки через логи/записи важны не меньше функциональности.

## 1. Что где защищает (источник истины)

| Механизм | Где | Поведение |
|---|---|---|
| Bind только localhost | `stt_server.py` (`OPENCODE_VOICE_HOST`, `--host`) | по умолчанию `127.0.0.1`; наружу — только осознанно |
| CORS-allowlist | `stt_server.py` (`_ALLOWED_ORIGIN`, `_cors`) | `localhost`/`127.0.0.1`/RFC1918 + `chrome-extension://[a-p]{32}`; не `*` |
| Токен доступа | `_auth_token`, `_check_token`; расширение (popup) | `OPENCODE_VOICE_TOKEN`; все эндпоинты кроме `/health` и preflight требуют `X-Voice-Token` (или `Authorization: Bearer`) |
| Записи в ОЗУ + ретеншен | `recorder.ts`, `stt_server.py` | `/dev/shm/opencode-voice`, удаление через `OPENCODE_VOICE_RETAIN_SECONDS` (300 с); `OPENCODE_VOICE_KEEP_AUDIO` отключает |
| Логи с текстом | `/tmp/opencode/voice-recognized.log` | каждый распознанный текст + `source=`; чистить перед отправкой наружу |
| Права расширения | `extension/manifest.json` | только `127.0.0.1` и RFC1918; `<all_urls>` избегать |

## 2. Правила проекта

1. **Никаких секретов в репозитории.** В глобальном `~/.config/opencode/opencode.json` лежит Google API-ключ — никогда не копировать его в репо, навыки, логи и коммиты.
2. **Не логировать чувствительное.** Логи и записи содержат речь; перед публикацией (issue, PR, чат) вырезать текст и пути.
3. **Не выставлять сервер наружу без токена.** `OPENCODE_VOICE_HOST=0.0.0.0` без `OPENCODE_VOICE_TOKEN` = любой в сети пишет с микрофона и читает расшифровки.
4. **Расширение — минимум прав.** Новые разрешения/хосты обосновывать; токен хранится в `chrome.storage.local`, не в коде.
5. **Файлы больше не нужны — удалять.** Записи и `*.webm` в `/dev/shm` и `/tmp/opencode` одноразовые.

## 3. Проверки

```bash
# слушает только localhost?
ss -ltn | grep 8765

# preflight: разрешён ли наш заголовок
curl -s -X OPTIONS http://127.0.0.1:8765/beep \
  -H 'Origin: chrome-extension://abcdefghijklmnopabcdefghijklmnop' \
  -H 'Access-Control-Request-Headers: x-voice-token,x-voice-source' -D - -o /dev/null | grep -i allow-headers

# токен реально требуется?
OPENCODE_VOICE_TOKEN=secret python3 stt-server/stt_server.py --port 8765 &
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/record/status     # 401
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Voice-Token: secret' \
     http://127.0.0.1:8765/record/status                                          # 200

# нет ли секретов в трекаемых файлах
git grep -nIE 'api[_-]?key|secret|password|sk-[a-z0-9]{10}|BEGIN [A-Z ]*PRIVATE KEY' -- . ':!package-lock.json'
```

## 4. Частые ошибки

- Проверять CORS «в браузере» и забывать, что preflight кэшируется: после правки allow-headers **перезапустите сервер** (иначе кнопка `Failed to fetch`, см. `ovi-debug`).
- Считать, что `vibeguard`/маскировка защищает git — она маскирует только вывод инструментов.
- Оставлять `OPENCODE_VOICE_KEEP_AUDIO` включённым в бою (записи накапливаются).
- Копировать реальные логи с речью в issue/PR.

## 5. Чек-лист

- [ ] `ss -ltn` → `127.0.0.1:8765` (если не нужен LAN)
- [ ] токен задан, если сервер доступен не только с localhost
- [ ] preflight разрешает `X-Voice-Token`/`X-Voice-Source`
- [ ] ретеншен записей включён (`OPENCODE_VOICE_KEEP_AUDIO` не задан)
- [ ] в коммитах/доках/навыках нет секретов и реальных путей/логов с речью
