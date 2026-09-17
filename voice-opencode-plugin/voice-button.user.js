// ==UserScript==
// @name         OpenCode Voice Button (DEPRECATED)
// @namespace    http://tampermonkey.net/
// @version      0.2
// @description  DEPRECATED: используйте Chrome-расширение (extension/) — оно поддерживает RAM-запись, бипы и настройки
// @author       You
// @match        http://127.0.0.1:*/*
// @match        http://localhost:*/*
// @match        http://172.*.*.*:*/*
// @match        http://192.168.*.*:*/*
// @grant        none
// ==/UserScript==

// ВНИМАНИЕ: устарело. Расширение (extension/) полностью заменяет этот скрипт и
// использует тот же id кнопки (#opencode-voice-btn) — не включайте оба одновременно.
// Оставлено для совместимости; не обновляется.

(function() {
    'use strict';

    const LOG_PREFIX = '[VoiceButton]';

    function log(...args) {
        console.log(LOG_PREFIX, ...args);
    }

    function findPromptArea() {
        // Список селекторов для поиска поля ввода
        const selectors = [
            // Основные селекторы
            'textarea[placeholder*="Ask"]',
            'textarea[placeholder*="Message"]',
            'textarea[placeholder*="ask"]',
            'textarea[placeholder*="message"]',
            'textarea[placeholder*="Type"]',
            'textarea[placeholder*="type"]',
            // Contenteditable
            '[contenteditable="true"][data-testid="prompt"]',
            '[contenteditable="true"][data-slot*="prompt"]',
            '[contenteditable="true"][class*="prompt"]',
            // Data attributes
            '[data-slot="session_prompt"] textarea',
            '[data-slot="home_prompt"] textarea',
            '[data-testid="prompt-input"]',
            '[data-testid="chat-input"]',
            // Классы
            '.prompt-input',
            '.chat-input',
            '[class*="prompt"] textarea',
            '[class*="input"] textarea',
            '[class*="composer"] textarea',
            // Общие
            'textarea',
        ];

        for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                // Проверяем, что это видимое поле ввода
                const rect = el.getBoundingClientRect();
                if (rect.width > 50 && rect.height > 20) {
                    log('Found prompt area with selector:', sel, el);
                    return el;
                }
            }
        }

        // Fallback: найти все textarea и взять самый большой
        const allTextareas = document.querySelectorAll('textarea');
        let best = null;
        let bestArea = 0;
        allTextareas.forEach(ta => {
            const rect = ta.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (area > bestArea) {
                bestArea = area;
                best = ta;
            }
        });
        if (best) log('Fallback: largest textarea', best);
        return best;
    }

    function findContainer(promptArea) {
        // Подняться вверх до подходящего контейнера
        let el = promptArea.parentElement;
        for (let i = 0; i < 10 && el; i++) {
            const classes = el.className || '';
            const slot = el.getAttribute('data-slot') || '';
            if (
                classes.includes('prompt') ||
                classes.includes('input') ||
                classes.includes('composer') ||
                classes.includes('footer') ||
                slot.includes('prompt') ||
                el.tagName === 'FORM'
            ) {
                return el;
            }
            el = el.parentElement;
        }
        return promptArea.parentElement;
    }

    function addVoiceButton() {
        if (document.querySelector('#opencode-voice-btn')) {
            return true;
        }

        const promptArea = findPromptArea();
        if (!promptArea) {
            log('Prompt area not found');
            return false;
        }

        const container = findContainer(promptArea);
        log('Container:', container);

        const btn = document.createElement('button');
        btn.id = 'opencode-voice-btn';
        btn.innerHTML = '🎤';
        btn.title = 'Voice: записать и распознать (Ctrl+Shift+V)';
        btn.style.cssText = `
            background: var(--v2-background-element, #fff);
            border: 1px solid var(--v2-border-default, #ddd);
            cursor: pointer;
            padding: 6px 10px;
            font-size: 18px;
            line-height: 1;
            opacity: 0.8;
            transition: opacity 0.2s, transform 0.1s, background 0.2s;
            border-radius: 6px;
            margin-left: 8px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 36px;
            height: 36px;
        `;
        btn.onmouseenter = () => { btn.style.opacity = '1'; btn.style.background = 'var(--v2-background-element-hover, #f0f0f0)'; };
        btn.onmouseleave = () => { btn.style.opacity = '0.8'; btn.style.background = 'var(--v2-background-element, #fff)'; };
        btn.onmousedown = () => btn.style.transform = 'scale(0.95)';
        btn.onmouseup = () => btn.style.transform = 'scale(1)';

        btn.onclick = async () => {
            btn.disabled = true;
            btn.innerHTML = '⏺';
            btn.style.opacity = '1';
            btn.style.background = 'var(--v2-accent, #007bff)';
            btn.style.color = 'white';
            btn.style.borderColor = 'var(--v2-accent, #007bff)';

            try {
                log('Fetching sessions...');
                const sessionsResp = await fetch('/api/session');
                const sessions = await sessionsResp.json();
                log('Sessions:', sessions);

                const session = sessions[0] || sessions.find(s => s.status === 'active') || sessions[sessions.length - 1];
                const sessionId = session?.id || session?.sessionID;

                if (!sessionId) {
                    alert('Нет активной сессии');
                    return;
                }

                log('Calling voice command for session:', sessionId);
                const resp = await fetch(`/api/session/${sessionId}/command`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: 'voice', arguments: '' })
                });

                const result = await resp.json();
                log('Voice result:', result);
            } catch (e) {
                log('Voice error:', e);
                alert('Ошибка: ' + e.message);
            } finally {
                btn.disabled = false;
                btn.innerHTML = '🎤';
                btn.style.opacity = '0.8';
                btn.style.background = '';
                btn.style.color = '';
                btn.style.borderColor = '';
            }
        };

        // Вставить кнопку
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display: inline-flex; align-items: center;';
        wrapper.appendChild(btn);

        // Попробовать вставить после promptArea
        if (promptArea.nextSibling) {
            container.insertBefore(wrapper, promptArea.nextSibling);
        } else {
            container.appendChild(wrapper);
        }

        log('Button added!');
        return true;
    }

    let added = addVoiceButton();

    const observer = new MutationObserver(() => {
        if (!document.querySelector('#opencode-voice-btn')) {
            added = addVoiceButton();
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setInterval(() => {
        if (!document.querySelector('#opencode-voice-btn')) {
            added = addVoiceButton();
        }
    }, 2000);

    log('Script loaded, waiting for UI...');
})();