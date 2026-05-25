(function attachParser(root) {
  'use strict';

  const DEFAULT_CODE_PATTERN = /(?:^|[\s-])Code\s*:\s*(stakecom[A-Za-z0-9_-]{4,})/gim;

  function extractCodesFromText(text, pattern = DEFAULT_CODE_PATTERN) {
    const normalized = normalizeText(text);
    const matches = [];
    const seen = new Set();
    let match;

    pattern.lastIndex = 0;
    while ((match = pattern.exec(normalized)) !== null) {
      const code = match[1].trim();
      const key = code.toLowerCase();

      if (!seen.has(key)) {
        seen.add(key);
        matches.push({
          code,
          rawLine: findLineForMatch(normalized, match.index)
        });
      }
    }

    return matches;
  }

  function findLineForMatch(text, index) {
    const before = text.lastIndexOf('\n', index);
    const after = text.indexOf('\n', index);
    const start = before === -1 ? 0 : before + 1;
    const end = after === -1 ? text.length : after;
    return text.slice(start, end).trim();
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }

  function hashString(value) {
    let hash = 0x811c9dc5;
    const text = String(value || '');

    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }

    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  const api = {
    DEFAULT_CODE_PATTERN,
    extractCodesFromText,
    hashString,
    normalizeText
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.TelegramCodeParser = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
