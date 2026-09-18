// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
// OpenCode Voice - Popup Script

// Хост сервера: по умолчанию 127.0.0.1, но content.js запоминает хост страницы
// (актуально при доступе к OpenCode по LAN/IP) — читаем его ниже.
let STT_SERVER = 'http://127.0.0.1:8765';
// Пока идёт восстановление, не показываем красные ошибки на транзиентных сбоях.
let healing = false;
const statusEl = document.getElementById('status');
const testBtn = document.getElementById('testBtn');
const openBtn = document.getElementById('openBtn');
const beepsEl = document.getElementById('beeps');
const beepTestBtn = document.getElementById('beepTestBtn');
const tokenEl = document.getElementById('token');

// Токен доступа (если на сервере задан OPENCODE_VOICE_TOKEN) и хост сервера.
chrome.storage.local.get({ token: '', sttHost: '' }, (v) => {
  tokenEl.value = v.token || '';
  const host = String(v.sttHost || '').replace(/^https?:\/\//, '').replace(/:\d+$/, '');
  if (host) STT_SERVER = `http://${host}:8765`;
  checkServer();
});
tokenEl.addEventListener('change', () => {
  chrome.storage.local.set({ token: tokenEl.value.trim() });
  checkServer();
  fillServerVoices();
});

function authHeaders() {
  const token = tokenEl.value.trim();
  return token ? { 'X-Voice-Token': token } : {};
}

// Настройка «звуковые сигналы» (хранится в chrome.storage.local, читается content.js)
chrome.storage.local.get({ beeps: true }, (v) => {
  beepsEl.checked = v.beeps !== false;
});
beepsEl.addEventListener('change', () => {
  chrome.storage.local.set({ beeps: beepsEl.checked });
});

// Комбинация push-to-talk (читается content.js через chrome.storage.onChanged)
const hotkeyEl = document.getElementById('hotkey');
chrome.storage.local.get({ hotkey: 'alt+z' }, (v) => {
  hotkeyEl.value = v.hotkey || 'alt+z';
});
hotkeyEl.addEventListener('change', () => {
  chrome.storage.local.set({ hotkey: hotkeyEl.value });
});

// Alt+X: запись + немедленная отправка (второй хоткей).
const sendHotkeyEl = document.getElementById('sendHotkey');
chrome.storage.local.get({ sendHotkey: true }, (v) => {
  sendHotkeyEl.checked = v.sendHotkey !== false;
});
sendHotkeyEl.addEventListener('change', () => {
  chrome.storage.local.set({ sendHotkey: sendHotkeyEl.checked });
});

// Озвучка ответов ассистента (ключи читают content.js/tts.js).
const ttsEl = document.getElementById('tts');
const ttsEngineEl = document.getElementById('ttsEngine');
const ttsModeEl = document.getElementById('ttsMode');
const ttsLangEl = document.getElementById('ttsLang');
const ttsLocalOnlyEl = document.getElementById('ttsLocalOnly');
const ttsRateEl = document.getElementById('ttsRate');
const ttsRateVal = document.getElementById('ttsRateVal');
const ttsDebugEl = document.getElementById('ttsDebug');
const ttsVoiceEl = document.getElementById('ttsVoice');

// Список голосов системы (грузится асинхронно — voiceschanged).
function fillVoices(selected) {
  const cur = selected !== undefined ? selected : ttsVoiceEl.value;
  const voices = (typeof speechSynthesis !== 'undefined' && speechSynthesis.getVoices()) || [];
  ttsVoiceEl.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Авто (по языку)';
  ttsVoiceEl.appendChild(auto);
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = `${v.name} — ${v.lang}${v.localService === false ? ' (сеть)' : ''}${v.default ? ' ★' : ''}`;
    ttsVoiceEl.appendChild(o);
  }
  ttsVoiceEl.value = cur || '';
}
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.addEventListener('voiceschanged', () => fillVoices());
}

// Голоса серверного движка (Piper): каталог отдаёт GET /voices.
// Отдельный ключ ttsServerVoice — выбор браузерного голоса не задевает.
const ttsServerVoiceEl = document.getElementById('ttsServerVoice');
async function fillServerVoices(selected) {
  const cur = selected !== undefined ? selected : ttsServerVoiceEl.value;
  const setOpts = (items, disabled) => {
    ttsServerVoiceEl.innerHTML = '';
    for (const it of items) {
      const o = document.createElement('option');
      o.value = it.value;
      o.textContent = it.label;
      if (it.disabled) o.disabled = true;
      ttsServerVoiceEl.appendChild(o);
    }
    ttsServerVoiceEl.disabled = !!disabled;
    ttsServerVoiceEl.value = cur || '';
  };
  try {
    const res = await fetch(`${STT_SERVER}/voices`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    const items = [{ value: '', label: `По умолчанию (${info.default || 'на сервере'})` }];
    for (const name of info.voices || []) items.push({ value: name, label: name });
    setOpts(items, false);
  } catch {
    setOpts([{ value: '', label: 'Сервер недоступен (проверьте /health)' }], true);
  }
}

chrome.storage.local.get(
  { tts: false, ttsEngine: 'browser', ttsMode: 'brief', ttsLang: 'auto', ttsVoice: '', ttsServerVoice: '', ttsLocalOnly: true, ttsRate: 1.0, ttsDebug: false },
  (v) => {
    ttsEl.checked = v.tts === true;
    ttsEngineEl.value = v.ttsEngine || 'browser';
    ttsModeEl.value = v.ttsMode || 'brief';
    ttsLangEl.value = v.ttsLang || 'auto';
    ttsLocalOnlyEl.checked = v.ttsLocalOnly !== false;
    ttsRateEl.value = String(v.ttsRate || 1.0);
    ttsRateVal.textContent = Number(ttsRateEl.value).toFixed(1);
    ttsDebugEl.checked = v.ttsDebug === true;
    ttsVoiceEl.value = v.ttsVoice || '';
    fillVoices(v.ttsVoice || '');
    fillServerVoices(v.ttsServerVoice || '');
  }
);
ttsEl.addEventListener('change', () => chrome.storage.local.set({ tts: ttsEl.checked }));
ttsEngineEl.addEventListener('change', () => chrome.storage.local.set({ ttsEngine: ttsEngineEl.value }));
ttsModeEl.addEventListener('change', () => chrome.storage.local.set({ ttsMode: ttsModeEl.value }));
ttsLangEl.addEventListener('change', () => chrome.storage.local.set({ ttsLang: ttsLangEl.value }));
ttsLocalOnlyEl.addEventListener('change', () => chrome.storage.local.set({ ttsLocalOnly: ttsLocalOnlyEl.checked }));
ttsRateEl.addEventListener('input', () => {
  ttsRateVal.textContent = Number(ttsRateEl.value).toFixed(1);
  chrome.storage.local.set({ ttsRate: Number(ttsRateEl.value) });
});
ttsDebugEl.addEventListener('change', () => chrome.storage.local.set({ ttsDebug: ttsDebugEl.checked }));
ttsVoiceEl.addEventListener('change', () => chrome.storage.local.set({ ttsVoice: ttsVoiceEl.value }));
ttsServerVoiceEl.addEventListener('change', () => chrome.storage.local.set({ ttsServerVoice: ttsServerVoiceEl.value }));

// Тест озвучки: просим content-скрипт активной вкладки произнести фразу —
// так отделяем проблему синтеза от проблемы событий/DOM.
const ttsTestBtn = document.getElementById('ttsTestBtn');
ttsTestBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('нет активной вкладки');
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'ocv-tts-test' });
    if (res && res.ok) {
      statusEl.textContent = '🔊 Тест отправлен — должна звучать фраза';
      statusEl.className = 'status ok';
    } else {
      statusEl.textContent = '⚠️ Content-скрипт не ответил';
      statusEl.className = 'status error';
    }
    setTimeout(refreshTtsStatus, 300);
  } catch (err) {
    statusEl.textContent = '⚠️ Откройте страницу OpenCode и обновите её (F5)';
    statusEl.className = 'status error';
  }
});

// Статус TTS с активной вкладки — быстрый способ диагностики без DevTools.
async function refreshTtsStatus() {
  const el = document.getElementById('ttsStatus');
  if (!el) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) { el.textContent = 'нет активной вкладки'; return; }
    const s = await chrome.tabs.sendMessage(tab.id, { type: 'ocv-tts-status' });
    if (!s || !s.ok) { el.textContent = 'content-скрипт не отвечает (обновите страницу F5)'; return; }
    el.textContent =
      `gate:${s.gateOk} sse:${s.sourceState} events:${s.events} fin:${s.finalized} rows:${s.rows} voices:${s.voices}\n` +
      `last:${s.lastType || '-'} sid:${(s.lastSid || '').slice(-8)}\n` +
      (s.lastSkip ? `skip:${s.lastSkip}\n` : '') +
      ((s.logTail && s.logTail.length) ? s.logTail.slice(-5).join('\n') : '');
  } catch (e) {
    el.textContent = 'статус недоступен (обновите страницу F5)';
  }
}
refreshTtsStatus();

beepTestBtn.addEventListener('click', async () => {
  try {
    await fetch(`${STT_SERVER}/beep?freq=880`, { headers: authHeaders() });
  } catch {
    statusEl.textContent = `❌ STT сервер недоступен`;
    statusEl.className = 'status error';
  }
});

async function checkServer() {
  try {
    const res = await fetch(`${STT_SERVER}/health`, { method: 'GET', headers: authHeaders() });
    if (res.ok) {
      let info = {};
      try { info = await res.json(); } catch {}
      statusEl.textContent = `✅ STT сервер v${info.version || '?'} · ${info.backend || '?'}`;
      statusEl.className = 'status ok';
      const vEl = document.getElementById('versions');
      if (vEl) {
        const extV = chrome.runtime.getManifest().version;
        vEl.textContent = `Расширение v${extV} · сервер v${info.version || '?'} (${info.backend || '?'}/${info.device || '?'})`;
      }
      testBtn.disabled = false;
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    if (healing) {
      statusEl.textContent = '⏳ Жду сервер…';
      statusEl.className = 'status';
      return;
    }
    statusEl.textContent = `❌ STT сервер недоступен: ${err.message}`;
    statusEl.className = 'status error';
    testBtn.disabled = true;
  }
}

testBtn.addEventListener('click', async () => {
  testBtn.textContent = 'Тестирование...';
  testBtn.disabled = true;

  try {
    // Create a tiny test audio (silence)
    const ctx = new AudioContext({ sampleRate: 16000 });
    const buffer = ctx.createBuffer(1, 16000, 16000); // 1 second silence
    const wav = bufferToWav(buffer);
    const blob = new Blob([wav], { type: 'audio/wav' });

    const formData = new FormData();
    formData.append('audio', blob, 'test.wav');

    const res = await fetch(`${STT_SERVER}/transcribe`, {
      method: 'POST',
      body: formData,
      headers: authHeaders(),
    });

    const result = await res.json();
    statusEl.textContent = `✅ Тест OK: "${result.text || '(пусто)'}"`;
    statusEl.className = 'status ok';
  } catch (err) {
    statusEl.textContent = `❌ Ошибка теста: ${err.message}`;
    statusEl.className = 'status error';
  } finally {
    testBtn.textContent = 'Тест STT сервера';
    testBtn.disabled = false;
  }
});

openBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
});

// Восстановление: /heal сбрасывает зависшую запись и перезапускает процесс
// (плагин-вотчдог поднимает сервер заново), затем ждём /health.
const healBtn = document.getElementById('healBtn');

async function waitForServer(timeoutMs) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch(`${STT_SERVER}/health`, { headers: authHeaders() });
      if (res.ok) {
        const info = await res.json().catch(() => ({}));
        statusEl.textContent = `✅ Сервер перезапущен · v${info.version || '?'} · ${info.backend || '?'}`;
        statusEl.className = 'status ok';
        testBtn.disabled = false;
        return true;
      }
    } catch {}
    statusEl.textContent = `⏳ Жду сервер… ${Math.round((Date.now() - started) / 1000)} с`;
    statusEl.className = 'status';
  }
  statusEl.textContent = '❌ Сервер не поднялся за отведённое время — запустите doctor.sh --fix (или ./setup.sh)';
  statusEl.className = 'status error';
  return false;
}

healBtn.addEventListener('click', async () => {
  healBtn.disabled = true;
  healBtn.textContent = '🔧 Восстанавливаю…';
  statusEl.textContent = '🔧 Перезапускаю STT-сервер…';
  statusEl.className = 'status';
  healing = true;
  try {
    await fetch(`${STT_SERVER}/heal?restart=1`, { method: 'POST', headers: authHeaders() });
  } catch {
    // сервер мог не успеть ответить — всё равно ждём восстановления
  }
  await waitForServer(60000);
  healing = false;
  healBtn.disabled = false;
  healBtn.textContent = '🔧 Восстановить сервер';
});

function bufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = buffer.length * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write samples
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, sample * 0x7FFF, true);
      offset += 2;
    }
  }

  return arrayBuffer;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// Recheck every 10 seconds (первая проверка — после загрузки настроек, см. выше)
setInterval(checkServer, 10000);