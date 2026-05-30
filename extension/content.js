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
  const videoCaptureStarted = new WeakSet();
  const videoFingerprints = new Set();
  const pendingScans = new Map();
  const startupStartedAt = Date.now();
  const STARTUP_MIN_MS = 8000;
  const STARTUP_IDLE_MS = 3000;
  const STARTUP_MAX_MS = 30000;
  const processedCodeCache = new Set();
  let liveMode = false;
  let activatingLiveMode = false;
  let startupTimer = null;
  let maxSeenMessageNumber = 0;
  let maxSeenTimelineMs = 0;
  let captureSettings = null;
  let captureSettingsLoadedAt = 0;
  let flushTimer = null;

  function start() {
    if (!parser || !document.body) {
      window.setTimeout(start, 250);
      return;
    }

    sendRuntimeMessage({
      type: 'TW_SCAN_STARTED',
      payload: {
        pageUrl: location.href
      }
    });
    queueScan(document.body, { silent: true });
    scheduleLiveMode();

    const observer = new MutationObserver((mutations) => {
      if (!liveMode) {
        scheduleLiveMode();
      }

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            queueScan(node, { silent: !liveMode });
          }
        } else if (mutation.type === 'characterData') {
          queueScan(mutation.target.parentElement, { silent: !liveMode });
        } else if (mutation.type === 'attributes') {
          queueScan(mutation.target, { silent: !liveMode });
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
        scanRoot(document.body, { force: true, silent: true });
        sendResponse({ ok: true });
      }
      return false;
    });
  }

  function queueScan(root, options = {}) {
    if (!root) {
      return;
    }

    const previous = pendingScans.get(root) || {};
    pendingScans.set(root, {
      force: Boolean(previous.force || options.force),
      silent: Boolean(previous.silent || options.silent)
    });

    if (flushTimer) {
      return;
    }

    flushTimer = window.setTimeout(() => {
      const scans = Array.from(pendingScans.entries());
      pendingScans.clear();
      flushTimer = null;

      for (const [root, scanOptions] of scans) {
        scanRoot(root, scanOptions);
      }
    }, 150);
  }

  function scheduleLiveMode() {
    if (liveMode) {
      return;
    }

    window.clearTimeout(startupTimer);
    const elapsedMs = Date.now() - startupStartedAt;
    if (elapsedMs >= STARTUP_MAX_MS) {
      activateLiveMode();
      return;
    }

    const waitMs = Math.min(
      Math.max(STARTUP_IDLE_MS, STARTUP_MIN_MS - elapsedMs),
      STARTUP_MAX_MS - elapsedMs
    );
    startupTimer = window.setTimeout(activateLiveMode, waitMs);
  }

  function activateLiveMode() {
    if (liveMode || activatingLiveMode) {
      return;
    }

    activatingLiveMode = true;
    Promise.all([
      scanTextElements(document.body, { force: true, silent: true }),
      scanVideos(document.body, { silent: true })
    ]).finally(() => {
      liveMode = true;
      activatingLiveMode = false;
      sendRuntimeMessage({
        type: 'TW_SCAN_READY',
        payload: {
          pageUrl: location.href,
          maxSeenMessageNumber,
          maxSeenTimelineMs
        }
      });
    });
  }

  function scanRoot(root, options = {}) {
    scanTextElements(root, options).catch(() => {});

    scanVideos(root, options).catch(() => {});
  }

  async function scanTextElements(root, options = {}) {
    for (const element of collectCandidateElements(root)) {
      await scanElement(element, options);
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

  async function scanElement(element, options = {}) {
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
    const messageNumber = getMessageNumber(messageId, messageUrl);
    const timelineMs = getMessageTimelineMs(element);
    const shouldForceSilent = Boolean(
      options.silent
      || !liveMode
      || isOldMessageNumber(messageNumber)
      || isOldTimeline(timelineMs, messageNumber)
    );
    const processedStatus = await getProcessedStatus(matches.map((match) => match.code));

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
      rememberMessageNumber(messageNumber);
      rememberTimeline(timelineMs);
      if (processedStatus[codeKey]) {
        continue;
      }

      rememberProcessedCode(match.code);
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
          messageNumber,
          timelineMs,
          silent: shouldForceSilent
        }
      });
    }
  }

  async function scanVideos(root, options = {}) {
    if (options.silent || !root) {
      seedVideoMessageNumbers(root);
      return;
    }

    const settings = await getCaptureSettings();
    if (!settings.videoCaptureEnabled) {
      return;
    }

    for (const video of collectVideos(root)) {
      if (videoCaptureStarted.has(video)) {
        continue;
      }

      const container = findMessageContainer(video);
      const messageNumber = getMessageNumber(findMessageId(container), findMessageUrl(container));
      const timelineMs = getMessageTimelineMs(container);
      if (isOldMessageNumber(messageNumber) || isOldTimeline(timelineMs, messageNumber)) {
        videoCaptureStarted.add(video);
        continue;
      }

      rememberMessageNumber(messageNumber);
      rememberTimeline(timelineMs);
      videoCaptureStarted.add(video);
      captureVideoFrames(video, settings).catch((error) => {
        chrome.runtime.sendMessage({
          type: 'TW_VIDEO_FRAME_CAPTURE_FAILED',
          payload: {
            messageId: findMessageId(container),
            messageUrl: findMessageUrl(container),
            pageUrl: location.href,
            fingerprint: buildVideoFingerprint(video, container),
            error: error.message
          }
        });
      });
    }
  }

  function collectVideos(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      return [];
    }

    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) {
      return [];
    }

    const videos = new Set();
    if (root.nodeType === Node.ELEMENT_NODE && root.matches('video')) {
      videos.add(root);
    }

    for (const video of root.querySelectorAll?.('video') || []) {
      videos.add(video);
    }

    return Array.from(videos);
  }

  function seedVideoMessageNumbers(root) {
    for (const video of collectVideos(root)) {
      const container = findMessageContainer(video);
      rememberMessageNumber(getMessageNumber(findMessageId(container), findMessageUrl(container)));
      rememberTimeline(getMessageTimelineMs(container));
    }
  }

  async function captureVideoFrames(video, settings) {
    await waitForVideoReady(video, 12_000);

    const container = findMessageContainer(video);
    const fingerprint = buildVideoFingerprint(video, container);
    if (videoFingerprints.has(fingerprint)) {
      return;
    }
    videoFingerprints.add(fingerprint);

    const timesMs = buildFrameTimes(video.duration, settings);
    const originalTime = video.currentTime || 0;
    const wasPaused = video.paused;
    const frames = [];

    video.pause();
    for (const timeMs of timesMs) {
      await seekVideo(video, timeMs / 1000);
      frames.push(captureFrame(video, timeMs, settings));
    }

    await seekVideo(video, Math.min(originalTime, getSafeDuration(video)));
    if (!wasPaused) {
      await video.play().catch(() => {});
    }

    chrome.runtime.sendMessage({
      type: 'TW_VIDEO_FRAMES_CAPTURED',
      payload: {
        messageId: findMessageId(container),
        messageUrl: findMessageUrl(container),
        pageUrl: location.href,
        videoSrc: video.currentSrc || video.src || null,
        fingerprint,
        frames
      }
    });
  }

  function buildFrameTimes(durationSeconds, settings) {
    const count = clampNumber(settings.videoFrameCount, 1, 8);
    const durationMs = Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.floor(durationSeconds * 1000)
      : Math.max(settings.videoFrameEndMs, settings.videoFrameStartMs + 1000);
    const startMs = Math.min(clampNumber(settings.videoFrameStartMs, 0, durationMs), durationMs);
    const requestedEndMs = Math.max(settings.videoFrameEndMs, startMs);
    const endMs = Math.max(startMs, Math.min(requestedEndMs, durationMs));

    if (count === 1 || startMs === endMs) {
      return [startMs];
    }

    const step = (endMs - startMs) / (count - 1);
    return Array.from({ length: count }, (_item, index) => Math.round(startMs + (step * index)));
  }

  function captureFrame(video, timeMs, settings) {
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) {
      throw new Error('Video dimensions are not available');
    }

    const maxHeight = clampNumber(settings.videoFrameMaxHeight, 180, 1080);
    const scale = Math.min(1, maxHeight / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = width;
    canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    const mimeType = settings.videoFrameMimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const dataUrl = mimeType === 'image/jpeg'
      ? canvas.toDataURL(mimeType, clampFloat(settings.videoFrameQuality, 0.35, 0.95))
      : canvas.toDataURL(mimeType);

    return {
      timeMs,
      width,
      height,
      mimeType,
      dataUrl
    };
  }

  function buildVideoFingerprint(video, container) {
    const source = video.currentSrc || video.src || '';
    const messageId = findMessageId(container) || findMessageUrl(container) || '';
    return [
      'video',
      messageId || parser.hashString(source || location.href),
      parser.hashString(source || String(video.duration || Date.now()))
    ].join(':');
  }

  async function getCaptureSettings() {
    if (captureSettings && Date.now() - captureSettingsLoadedAt < 30_000) {
      return captureSettings;
    }

    const response = await sendRuntimeMessage({ type: 'TW_GET_CAPTURE_SETTINGS' });
    captureSettings = response?.settings || { videoCaptureEnabled: false };
    captureSettingsLoadedAt = Date.now();
    return captureSettings;
  }

  async function getProcessedStatus(codes) {
    const uniqueCodes = Array.from(new Set(codes.map((code) => String(code || '').toLowerCase())));
    const uncachedCodes = uniqueCodes.filter((code) => !processedCodeCache.has(code));
    const result = Object.fromEntries(uniqueCodes.map((code) => [code, processedCodeCache.has(code)]));

    if (uncachedCodes.length === 0) {
      return result;
    }

    const response = await sendRuntimeMessage({
      type: 'TW_ARE_CODES_PROCESSED',
      codes: uncachedCodes
    });

    for (const [code, processed] of Object.entries(response?.processed || {})) {
      if (processed) {
        processedCodeCache.add(code);
        result[code] = true;
      }
    }

    return result;
  }

  function rememberProcessedCode(code) {
    const codeKey = String(code || '').toLowerCase();
    if (codeKey) {
      processedCodeCache.add(codeKey);
    }
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response);
      });
    });
  }

  function waitForVideoReady(video, timeoutMs) {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth && video.videoHeight) {
      return Promise.resolve();
    }

    video.preload = 'auto';
    video.load();

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for video metadata'));
      }, timeoutMs);

      const onReady = () => {
        if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth && video.videoHeight) {
          cleanup();
          resolve();
        }
      };
      const onError = () => {
        cleanup();
        reject(new Error('Video failed to load'));
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', onReady);
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('loadedmetadata', onReady);
      video.addEventListener('loadeddata', onReady);
      video.addEventListener('error', onError);
      onReady();
    });
  }

  function seekVideo(video, timeSeconds) {
    const safeTime = Math.min(Math.max(timeSeconds, 0), getSafeDuration(video));
    if (Math.abs((video.currentTime || 0) - safeTime) < 0.05) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Timed out while seeking video'));
      }, 5000);
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('Video seek failed'));
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);
      video.currentTime = safeTime;
    });
  }

  function getSafeDuration(video) {
    return Number.isFinite(video.duration) && video.duration > 0
      ? Math.max(0, video.duration - 0.05)
      : Math.max(0, video.currentTime || 0);
  }

  function clampNumber(value, min, max) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) {
      return min;
    }
    return Math.min(Math.max(number, min), max);
  }

  function clampFloat(value, min, max) {
    const number = Number.parseFloat(value);
    if (!Number.isFinite(number)) {
      return min;
    }
    return Math.min(Math.max(number, min), max);
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

  function getMessageTimelineMs(element) {
    const container = findMessageContainer(element);
    const candidates = [
      container,
      ...Array.from(container.querySelectorAll?.(
        'time, [datetime], [data-timestamp], [data-time], [data-date], [title], [aria-label], [class*="time"], [class*="Time"], [class*="date"], [class*="Date"]'
      ) || [])
    ].slice(0, 40);

    for (const candidate of candidates) {
      const values = [
        candidate.getAttribute?.('datetime'),
        candidate.getAttribute?.('data-timestamp'),
        candidate.getAttribute?.('data-time'),
        candidate.getAttribute?.('data-date'),
        candidate.getAttribute?.('title'),
        candidate.getAttribute?.('aria-label'),
        candidate.tagName?.toLowerCase() === 'time' ? candidate.textContent : null
      ];

      for (const value of values) {
        const timelineMs = parseTimelineValue(value);
        if (Number.isFinite(timelineMs)) {
          return timelineMs;
        }
      }
    }

    return null;
  }

  function parseTimelineValue(value) {
    const text = String(value || '').trim();
    if (!text) {
      return null;
    }

    if (/^\d{13}$/.test(text)) {
      return normalizeTimelineMs(Number.parseInt(text, 10));
    }

    if (/^\d{10}$/.test(text)) {
      return normalizeTimelineMs(Number.parseInt(text, 10) * 1000);
    }

    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      return normalizeTimelineMs(parsed);
    }

    const timeMatch = text.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\b/i);
    if (!timeMatch) {
      return null;
    }

    let hour = Number.parseInt(timeMatch[1], 10);
    const minute = Number.parseInt(timeMatch[2], 10);
    const second = Number.parseInt(timeMatch[3] || '0', 10);
    const meridiem = timeMatch[4]?.toUpperCase();

    if (meridiem === 'PM' && hour < 12) {
      hour += 12;
    } else if (meridiem === 'AM' && hour === 12) {
      hour = 0;
    }

    if (hour > 23 || minute > 59 || second > 59) {
      return null;
    }

    const today = new Date();
    today.setHours(hour, minute, second, 0);
    return normalizeTimelineMs(today.getTime());
  }

  function normalizeTimelineMs(value) {
    const earliest = Date.UTC(2020, 0, 1);
    const latest = Date.now() + 86_400_000;
    return Number.isFinite(value) && value >= earliest && value <= latest ? value : null;
  }

  function getMessageNumber(...values) {
    for (const value of values) {
      const text = String(value || '');
      const matches = text.match(/\d+/g);
      if (!matches) {
        continue;
      }

      const number = Number.parseInt(matches[matches.length - 1], 10);
      if (Number.isFinite(number)) {
        return number;
      }
    }

    return null;
  }

  function isOldMessageNumber(messageNumber) {
    return Number.isFinite(messageNumber)
      && maxSeenMessageNumber > 0
      && messageNumber <= maxSeenMessageNumber;
  }

  function rememberMessageNumber(messageNumber) {
    if (Number.isFinite(messageNumber)) {
      maxSeenMessageNumber = Math.max(maxSeenMessageNumber, messageNumber);
    }
  }

  function isOldTimeline(timelineMs, messageNumber) {
    if (!Number.isFinite(timelineMs) || maxSeenTimelineMs <= 0) {
      return false;
    }

    if (Number.isFinite(messageNumber) && !isOldMessageNumber(messageNumber)) {
      return false;
    }

    return timelineMs <= maxSeenTimelineMs;
  }

  function rememberTimeline(timelineMs) {
    if (Number.isFinite(timelineMs)) {
      maxSeenTimelineMs = Math.max(maxSeenTimelineMs, timelineMs);
    }
  }

  start();
})();
