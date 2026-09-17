// OpenCode Voice - Content Script
// Injects 🎤 button into OpenCode web UI

// STT сервер слушает 0.0.0.0:8765 → доступен по тому же хосту, что и веб-UI
// (важно при доступе через WSL2 IP, а не localhost).
const STT_PORT = 8765;
const MAX_UPLOAD_MB = 25;
const STT_SERVER = `${location.protocol}//${location.hostname}:${STT_PORT}`;
const LOG_PREFIX = '[OpenCode Voice]';

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function showToast(message, type = 'info', duration = 3000) {
  const existing = document.querySelector('.opencode-voice-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `opencode-voice-toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Store found input to avoid re-searching (which might find terminal)
let foundInput = null;

function findPromptInput() {
  // Get ALL contenteditable elements and pick the real prompt input.
  // Terminal input has data-component="terminal" and class "font-mono" - exclude it.
  const all = document.querySelectorAll('[contenteditable="true"]');

  for (const el of all) {
    const component = el.getAttribute('data-component') || '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    const cls = typeof el.className === 'string' ? el.className : '';

    // Explicitly skip terminal
    if (component === 'terminal') continue;
    if (/terminal/i.test(ariaLabel)) continue;
    if (/font-mono/.test(cls)) continue;

    // Prefer the real prompt input
    const isPrompt = component === 'prompt-input' ||
                     /Промпт|Prompt/i.test(ariaLabel) ||
                     /min-h-\[60px\]/.test(cls) ||
                     /whitespace-pre-wrap/.test(cls);

    if (!isPrompt) continue;

    // Skip hidden elements
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const isVisible = rect.width > 50 &&
                      rect.height > 20 &&
                      style.opacity !== '0' &&
                      style.visibility !== 'hidden' &&
                      style.display !== 'none' &&
                      !style.clipPath?.includes('inset');

    if (isVisible) {
      log('Found prompt input:', el);
      foundInput = el;
      return el;
    }
  }
  return null;
}

function findContainer(input) {
  // Prefer the prompt form
  const form = input.closest('form[data-component="prompt-input-v2"]') ||
               input.closest('form') ||
               input.closest('[data-component="prompt-input-v2"]');
  if (form) return form;

  let el = input.parentElement;
  for (let i = 0; i < 10 && el; i++) {
    const classes = typeof el.className === 'string' ? el.className : '';
    if (
      classes.includes('prompt') ||
      classes.includes('composer') ||
      el.tagName === 'FORM'
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return input.parentElement;
}

function insertText(text) {
  const input = foundInput || findPromptInput();
  if (!input) {
    showToast('Поле ввода не найдено', 'error');
    return false;
  }

  input.focus();

  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const value = input.value;
    input.value = value.slice(0, start) + text + value.slice(end);
    input.selectionStart = input.selectionEnd = start + text.length;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  if (input.isContentEditable) {
    // Place caret at the end so caret-based insertion works
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);

    // execCommand triggers proper input events the UI framework listens to
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch {
      ok = false;
    }

    if (!ok) {
      // Fallback: manual DOM insert + input event
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
    return true;
  }
  return false;
}

// Найти панель инструментов (где кнопка «Отправить») внутри формы
function findToolbar(input) {
  const form = input.closest('form') || input.closest('[data-component="prompt-input-v2"]') || input.parentElement;

  // Кнопка отправки — самый надёжный ориентир
  const submit =
    form.querySelector('button[type="submit"]') ||
    form.querySelector('button[aria-label*="Отправ"]') ||
    form.querySelector('button[aria-label*="Send"]') ||
    form.querySelector('button[title*="Отправ"]') ||
    form.querySelector('button[title*="Send"]');

  if (submit && submit.parentElement) {
    return { parent: submit.parentElement, before: submit };
  }

  // Иначе — последняя кнопка в форме
  const buttons = form.querySelectorAll('button');
  if (buttons.length) {
    const last = buttons[buttons.length - 1];
    return { parent: last.parentElement, before: last };
  }

  // Fallback: сама форма
  return { parent: form, before: null };
}

// --- Гибридная запись: микрофон браузера, при неудаче — сервер WSL ---

// Звуковая индикация (как в /voice): сигнал проигрывает STT-сервер в WSL
// (880 Гц — старт, 520 Гц — конец записи, 660 Гц — распознавание завершено).
// Отключается переключателем в popup расширения (chrome.storage.local.beeps).
let beepsEnabled = true;
try {
  chrome.storage.local.get({ beeps: true }, (v) => { beepsEnabled = v.beeps !== false; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.beeps) beepsEnabled = changes.beeps.newValue !== false;
  });
} catch {}

// Опциональный токен доступа (если на сервере задан OPENCODE_VOICE_TOKEN).
let voiceToken = '';
const tokenReady = new Promise((resolve) => {
  try {
    chrome.storage.local.get({ token: '' }, (v) => { voiceToken = v.token || ''; resolve(); });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.token) voiceToken = changes.token.newValue || '';
    });
  } catch { resolve(); }
});

function authHeaders() {
  const h = { 'X-Voice-Source': 'button' };
  if (voiceToken) h['X-Voice-Token'] = voiceToken;
  return h;
}

function beep(freq = 880) {
  if (!beepsEnabled) return;
  try {
    void tokenReady.then(() =>
      fetch(`${STT_SERVER}/beep?freq=${freq}`, { method: 'GET', headers: authHeaders() }).catch(() => {})
    );
  } catch {}
}

async function startCapture() {
  // 1. Микрофон браузера (работает, когда Windows/RDP отдаёт микрофон)
  if (navigator.mediaDevices?.getUserMedia && window.MediaRecorder) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
      const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.start(250);
      log('Запись: микрофон браузера');
      return { mode: 'browser', stream, recorder, chunks };
    } catch (e) {
      log('Микрофон браузера недоступен:', e.name, e.message);
    }
  }

  // 2. Запись на сервере (WSL PulseAudio)
  const startReq = async () => { await tokenReady; return fetch(`${STT_SERVER}/record/start`, { method: 'POST', headers: authHeaders() }); };
  const stopReq = async () => { await tokenReady; return fetch(`${STT_SERVER}/record/stop`, { method: 'POST', headers: authHeaders() }); };

  let res;
  try {
    res = await startReq();
  } catch (e) {
    throw new Error(`нет микрофона — браузер недоступен, STT-сервер не отвечает (${e.message})`);
  }

  // 409 = на сервере осталась «зависшая» запись с прошлого раза (клиент не вызвал
  // /record/stop). Сбрасываем её и пробуем стартовать заново.
  if (res.status === 409) {
    log('Сервер уже пишет — сбрасываю зависшую запись и пробую снова');
    try { await stopReq(); } catch {}
    try {
      res = await startReq();
    } catch (e) {
      throw new Error(`STT-сервер не отвечает (${e.message})`);
    }
  }

  if (res.status === 409) {
    const err = new Error('на сервере уже идёт запись');
    err.alreadyRecording = true;
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  log('Запись: сервер WSL');
  return { mode: 'server' };
}

function stopBrowserCapture(session) {
  return new Promise((resolve) => {
    session.recorder.onstop = () => {
      session.stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(session.chunks, { type: session.recorder.mimeType || 'audio/webm' }));
    };
    session.recorder.stop();
  });
}

// Понятные сообщения на защитные ответы сервера (лимиты/таймауты).
function friendlyError(status, fallback) {
  if (status === 413) return `Запись слишком большая (лимит ${MAX_UPLOAD_MB} МБ)`;
  if (status === 429) return 'Сервер занят — попробуй ещё раз через пару секунд';
  if (status === 504) return 'Распознавание заняло слишком долго';
  if (status === 403) return 'Запрос отклонён (origin) — перезагрузи расширение';
  return fallback;
}

async function transcribeBlob(blob) {
  if (blob.size > MAX_UPLOAD_MB * 1024 * 1024) {
    throw new Error(`Запись слишком большая (лимит ${MAX_UPLOAD_MB} МБ)`);
  }
  const fd = new FormData();
  fd.append('audio', blob, 'recording.webm');
  await tokenReady;
  const res = await fetch(`${STT_SERVER}/transcribe`, { method: 'POST', body: fd, headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendlyError(res.status, data.error || `HTTP ${res.status}`));
  return (data.text || '').trim();
}

async function stopServerCapture() {
  await tokenReady;
  const res = await fetch(`${STT_SERVER}/record/stop`, { method: 'POST', headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendlyError(res.status, data.error || `HTTP ${res.status}`));
  return (data.text || '').trim();
}

// --- Состояние записи (живёт вне кнопки — переживает перерендер UI) ---
let captureSession = null;  // {mode, stream, recorder, chunks}
let stopSignal = null;      // resolve() для остановки
let uiPhase = 'idle';       // idle | recording | processing

// При уходе со страницы не оставляем серверную запись висеть (иначе следующий
// /record/start получит 409 «already recording»).
window.addEventListener('pagehide', () => {
  if (uiPhase === 'recording' && captureSession?.mode === 'server') {
    try { fetch(`${STT_SERVER}/record/stop`, { method: 'POST', keepalive: true, headers: authHeaders() }); } catch {}
  }
});

function applyButtonState(btn) {
  if (!btn) return;
  btn.classList.remove('recording', 'processing');
  if (uiPhase === 'recording') {
    btn.classList.add('recording');
    btn.textContent = '⏺';
    btn.title = 'Идёт запись — нажми, чтобы остановить';
  } else if (uiPhase === 'processing') {
    btn.classList.add('processing');
    btn.textContent = '🧠';
    btn.title = 'Распознаю речь...';
  } else {
    btn.textContent = '🎤';
    btn.title = 'Voice: записать и распознать (браузер / WSL)';
  }
}

function syncButton() {
  applyButtonState(document.querySelector('#opencode-voice-btn'));
}

// Стабильный обработчик: клик либо начинает, либо останавливает
function onVoiceClick(btn) {
  if (uiPhase === 'recording') {
    if (stopSignal) stopSignal();
    return;
  }
  if (uiPhase === 'processing') return; // игнорируем клики во время распознавания
  runRecordingFlow(btn);
}

async function runRecordingFlow(btn) {
  uiPhase = 'recording';
  applyButtonState(btn);

  // Старт захвата
  try {
    captureSession = await startCapture();
  } catch (err) {
    // 409 от сервера = на сервере уже идёт запись (зависла) — переключаемся в режим стопа
    if (err.alreadyRecording) {
      log('Сервер уже пишет — переключаюсь в режим остановки');
      captureSession = { mode: 'server' };
    } else {
      log('Error:', err);
      showToast(`❌ Не удалось начать запись: ${err.message}`, 'error', 6000);
      uiPhase = 'idle';
      applyButtonState(btn);
      return;
    }
  }

  beep(880);
  const isBrowser = captureSession.mode === 'browser';
  showToast(isBrowser ? '🎙 Запись (микрофон браузера)...' : '🎙 Запись (WSL)...', 'info', 5000);

  // Таймер
  const start = Date.now();
  const timer = setInterval(() => {
    const sec = Math.floor((Date.now() - start) / 1000);
    const b = document.querySelector('#opencode-voice-btn');
    if (b) b.title = `Идёт запись: ${sec} сек — нажми, чтобы остановить`;
    if (sec > 0 && sec % 5 === 0) showToast(`🎙 Запись: ${sec} сек`, 'info', 1200);
  }, 1000);

  // Ждём второй клик
  await new Promise((resolve) => { stopSignal = resolve; });
  stopSignal = null;
  clearInterval(timer);
  beep(520);

  // Фаза распознавания
  uiPhase = 'processing';
  syncButton();
  showToast('🧠 Распознаю речь...', 'warning', 10000);

  try {
    const text = isBrowser
      ? await transcribeBlob(await stopBrowserCapture(captureSession))
      : await stopServerCapture();

    if (text) {
      beep(660);
      if (insertText(text)) showToast(`✅ Готово: "${text.slice(0, 60)}"`, 'success');
    } else {
      showToast('Речь не распознана', 'warning');
    }
  } catch (err) {
    log('Error:', err);
    showToast(`❌ Ошибка: ${err.message}`, 'error', 6000);
  } finally {
    captureSession = null;
    uiPhase = 'idle';
    syncButton();
  }
}

function addVoiceButton() {
  if (document.querySelector('#opencode-voice-btn')) return true;

  const input = foundInput || findPromptInput();
  if (!input) {
    log('Prompt input not found yet');
    return false;
  }

  const btn = document.createElement('button');
  btn.id = 'opencode-voice-btn';
  btn.type = 'button';
  btn.innerHTML = '🎤';
  btn.title = 'Voice: записать и распознать (браузер / WSL)';
  btn.onclick = () => onVoiceClick(btn);

  // Try to place next to the Send button
  try {
    const { parent, before } = findToolbar(input);
    log('Toolbar:', parent, 'before:', before);
    if (before && before.parentElement === parent) {
      parent.insertBefore(btn, before);
    } else {
      parent.appendChild(btn);
    }
  } catch (err) {
    log('Toolbar placement failed, fell back to form:', err);
    const container = findContainer(input);
    container.appendChild(btn);
  }

  applyButtonState(btn); // восстановить состояние после перерендера
  log('Voice button added!', 'phase:', uiPhase);
  return true;
}

// Re-add button if it was removed (e.g. prompt re-rendered)
let scheduled = false;
function scheduleAdd() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    // Only re-add if the prompt input is still in the DOM but button missing
    if (foundInput && document.contains(foundInput) && !document.querySelector('#opencode-voice-btn')) {
      addVoiceButton();
    } else if (!foundInput || !document.contains(foundInput)) {
      foundInput = null;
      addVoiceButton();
    }
  }, 300);
}

const observer = new MutationObserver(scheduleAdd);
observer.observe(document.body, { childList: true, subtree: true });

// Try to add button immediately
addVoiceButton();

log('Content script loaded, waiting for UI...');

// Диагностика: подтверждаем, что загружена именно эта версия (видно в консоли
// страницы и в логе STT-сервера как beep freq=0).
void tokenReady.then(() => {
  try {
    console.log('[OpenCode Voice] content.js v1.0.9 loaded');
    fetch(`${STT_SERVER}/beep?freq=0`, { method: 'GET', headers: authHeaders() }).catch(() => {});
    fetch(`${STT_SERVER}/health`, { method: 'GET', headers: authHeaders() })
      .then((r) => r.json())
      .then((h) => console.log(`[OpenCode Voice] server v${h.version || '?'} · ${h.backend || '?'}/${h.device || '?'} · auth=${h.auth}`))
      .catch(() => {});
  } catch {}
});