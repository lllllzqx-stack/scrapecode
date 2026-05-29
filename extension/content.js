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
  const pendingRoots = new Set();
  const bootstrapSilentUntil = Date.now() + 2500;
  let captureSettings = null;
  let captureSettingsLoadedAt = 0;
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

    scanVideos(root, options).catch(() => {});
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

  async function scanVideos(root, options = {}) {
    if (options.silent || !root) {
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

      videoCaptureStarted.add(video);
      captureVideoFrames(video, settings).catch((error) => {
        const container = findMessageContainer(video);
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

  start();
})();
