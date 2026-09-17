// OpenCode Voice - Popup Script

const STT_SERVER = 'http://localhost:8765';
const statusEl = document.getElementById('status');
const testBtn = document.getElementById('testBtn');
const openBtn = document.getElementById('openBtn');
const beepsEl = document.getElementById('beeps');
const beepTestBtn = document.getElementById('beepTestBtn');

// Настройка «звуковые сигналы» (хранится в chrome.storage.local, читается content.js)
chrome.storage.local.get({ beeps: true }, (v) => {
  beepsEl.checked = v.beeps !== false;
});
beepsEl.addEventListener('change', () => {
  chrome.storage.local.set({ beeps: beepsEl.checked });
});

beepTestBtn.addEventListener('click', async () => {
  try {
    await fetch(`${STT_SERVER}/beep?freq=880`);
  } catch {
    statusEl.textContent = `❌ STT сервер недоступен`;
    statusEl.className = 'status error';
  }
});

async function checkServer() {
  try {
    const res = await fetch(`${STT_SERVER}/health`, { method: 'GET' });
    if (res.ok) {
      statusEl.textContent = '✅ STT сервер работает';
      statusEl.className = 'status ok';
      testBtn.disabled = false;
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
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

// Initial check
checkServer();
// Recheck every 10 seconds
setInterval(checkServer, 10000);