// OpenCode Voice - Background Service Worker
// Handles extension lifecycle and communication

chrome.runtime.onInstalled.addListener(() => {
  console.log('[OpenCode Voice] Extension installed');
});

// Keep service worker alive
chrome.runtime.onStartup.addListener(() => {
  console.log('[OpenCode Voice] Service worker started');
});

// Handle messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ status: 'ok' });
  }
  return true;
});

console.log('[OpenCode Voice] Background script loaded');