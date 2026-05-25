(() => {
  'use strict';

  const parser = globalThis.TelegramCodeParser;
  const candidateSelector = [
    '[data-message-id]',
    '[data-mid]',
    '.message',
    '.Message',
    '.bubble',
    '.text-content',
    '.message-content',
    '[class*="message"]',
    '[class*="Message"]'
  ].join(',');

  const runtimeSeen = new Set();
  const nodeHashes = new WeakMap();
  const pendingRoots = new Set();
  const bootstrapSilentUntil = Date.now() + 2500;
  let flushTimer = null;

  function start() {
    if (!parser || !document.body) {
      window.setTimeout(start, 250);
      return;
    }

    queueScan(document.body);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            queueScan(node);
          }
        } else if (mutation.type === 'characterData') {
          queueScan(mutation.target.parentElement);
        } else if (mutation.type === 'attributes') {
          queueScan(mutation.target);
        }
      }
    });

    observer.observe(document.body, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'TW_CODE_WATCHER_SCAN_NOW') {
        scanRoot(document.body, { force: true, silent: false });
        sendResponse({ ok: true });
      }
      return false;
    });
  }

  function queueScan(root) {
    if (!root) {
      return;
    }

    pendingRoots.add(root);
    if (flushTimer) {
      return;
    }

    flushTimer = window.setTimeout(() => {
      const roots = Array.from(pendingRoots);
      pendingRoots.clear();
      flushTimer = null;

      for (const root of roots) {
        scanRoot(root, { silent: Date.now() < bootstrapSilentUntil });
      }
    }, 150);
  }

  function scanRoot(root, options = {}) {
    for (const element of collectCandidateElements(root)) {
      scanElement(element, options);
    }
  }

  function collectCandidateElements(root) {
    if (!root) {
      return [];
    }

    const elements = new Set();

    if (root.nodeType === Node.TEXT_NODE) {
      if (root.parentElement) {
        elements.add(root.parentElement);
      }
      return Array.from(elements);
    }

    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) {
      return [];
    }

    if (root.nodeType === Node.ELEMENT_NODE) {
      const element = root;
      if (element.matches(candidateSelector)) {
        elements.add(element);
      }
      if (element.textContent && /Code\s*:/i.test(element.textContent)) {
        elements.add(findMessageContainer(element));
      }
    }

    const queryRoot = root.nodeType === Node.DOCUMENT_NODE ? root : root;
    for (const element of queryRoot.querySelectorAll?.(candidateSelector) || []) {
      if (element.textContent && /Code\s*:/i.test(element.textContent)) {
        elements.add(findMessageContainer(element));
      }
    }

    return Array.from(elements).filter(Boolean);
  }

  function scanElement(element, options = {}) {
    if (!element?.textContent || !/Code\s*:/i.test(element.textContent)) {
      return;
    }

    const text = parser.normalizeText(element.innerText || element.textContent);
    const textHash = parser.hashString(text);
    if (!options.force && nodeHashes.get(element) === textHash) {
      return;
    }
    nodeHashes.set(element, textHash);

    const matches = parser.extractCodesFromText(text);
    if (matches.length === 0) {
      return;
    }

    const messageId = findMessageId(element);
    const messageUrl = findMessageUrl(element);

    for (const match of matches) {
      const codeKey = match.code.toLowerCase();
      const fingerprint = [
        codeKey,
        messageId || messageUrl || textHash
      ].join(':');

      if (runtimeSeen.has(fingerprint)) {
        continue;
      }

      runtimeSeen.add(fingerprint);
      chrome.runtime.sendMessage({
        type: 'TW_CODE_DETECTED',
        payload: {
          code: match.code,
          rawLine: match.rawLine,
          text: text.slice(0, 4000),
          messageId,
          messageUrl,
          pageUrl: location.href,
          fingerprint,
          silent: Boolean(options.silent)
        }
      });
    }
  }

  function findMessageContainer(element) {
    return element.closest?.('[data-message-id], [data-mid], .message, .Message, .bubble, [class*="message"], [class*="Message"]') || element;
  }

  function findMessageId(element) {
    const container = findMessageContainer(element);
    const attrs = ['data-message-id', 'data-mid', 'data-message', 'data-id'];

    for (const attr of attrs) {
      const value = container.getAttribute?.(attr);
      if (value) {
        return value;
      }
    }

    const link = container.querySelector?.('a[href*="t.me/"], a[href*="web.telegram.org/"]');
    return link?.getAttribute('href') || null;
  }

  function findMessageUrl(element) {
    const container = findMessageContainer(element);
    const link = container.querySelector?.('a[href*="t.me/"], a[href*="web.telegram.org/"]');
    return link?.href || null;
  }

  start();
})();
