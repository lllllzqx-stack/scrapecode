'use strict';

const DEFAULT_SETTINGS = {
  notificationEnabled: true,
  soundEnabled: true,
  webhookEnabled: true,
  webhookUrl: 'https://api.val.bot/api/webhooks/broadcast/content',
  webhookApiKey: '',
  webhookType: 'code_daily_hr',
  videoCaptureEnabled: true,
  videoFrameWebhookType: 'code_daily_hr_frames',
  videoFrameCount: 5,
  videoFrameStartMs: 500,
  videoFrameEndMs: 3500,
  videoFrameMaxHeight: 720,
  videoFrameQuality: 0.86,
  videoFrameMimeType: 'image/png',
  telegramBotEnabled: false,
  telegramBotToken: '',
  telegramChatId: '',
  telegramSendCode: true,
  telegramSendFrames: true,
  maxLiveCodesPerBurst: 1,
  liveCodeBurstMs: 2500,
  autoDisarmOnScan: true,
  scanReadyNotification: true,
  historyLimit: 500,
  processedLimit: 1500
};

const pendingLiveCodeEvents = new Map();
let pendingLiveCodeTimer = null;

chrome.runtime.onInstalled.addListener(async () => {
  const defaults = await loadDefaultSettings();
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) {
    await chrome.storage.local.set({ settings: defaults });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message, sender) {
  if (message?.type === 'TW_CODE_DETECTED') {
    return handleDetectedCode(message.payload, sender);
  }

  if (message?.type === 'TW_GET_STATE') {
    return getState();
  }

  if (message?.type === 'TW_GET_CAPTURE_SETTINGS') {
    return getCaptureSettings();
  }

  if (message?.type === 'TW_ARE_CODES_PROCESSED') {
    return areCodesProcessed(message.codes || []);
  }

  if (message?.type === 'TW_SCAN_STARTED') {
    return handleScanStarted(message.payload || {}, sender);
  }

  if (message?.type === 'TW_SCAN_READY') {
    return handleScanReady(message.payload || {}, sender);
  }

  if (message?.type === 'TW_SET_DELIVERY_ARMED') {
    return setDeliveryArmed(Boolean(message.armed));
  }

  if (message?.type === 'TW_VIDEO_FRAMES_CAPTURED') {
    return handleVideoFrames(message.payload, sender);
  }

  if (message?.type === 'TW_VIDEO_FRAME_CAPTURE_FAILED') {
    return handleVideoCaptureFailure(message.payload, sender);
  }

  if (message?.type === 'TW_UPDATE_SETTINGS') {
    return updateSettings(message.settings || {});
  }

  if (message?.type === 'TW_CLEAR_HISTORY') {
    await chrome.storage.local.set({
      history: [],
      videoHistory: [],
      processedCodes: [],
      processedFingerprints: [],
      processedVideoFingerprints: []
    });
    await updateBadge(0);
    return { ok: true };
  }

  if (message?.type === 'TW_TEST_ALERT') {
    return emitAlert({
      code: 'stakecomTest12345',
      rawLine: 'Code: stakecomTest12345',
      text: 'Manual test alert',
      messageId: 'manual-test',
      messageUrl: null,
      pageUrl: sender.tab?.url || null,
      fingerprint: `manual-test:${Date.now()}`,
      detectedAt: new Date().toISOString()
    }, await loadSettings());
  }

  return { ok: false, error: 'Unknown message type' };
}

async function handleDetectedCode(payload, sender) {
  const settings = await loadSettings();
  const now = new Date().toISOString();
  const event = {
    code: payload.code,
    rawLine: payload.rawLine || null,
    text: payload.text || '',
    messageId: payload.messageId || null,
    messageUrl: payload.messageUrl || null,
    pageUrl: payload.pageUrl || sender.tab?.url || null,
    tabId: sender.tab?.id || null,
    fingerprint: payload.fingerprint || `${payload.code}:${now}`,
    messageNumber: payload.messageNumber || null,
    timelineMs: payload.timelineMs || null,
    detectedAt: now
  };

  const state = await chrome.storage.local.get({
    history: [],
    processedCodes: [],
    processedFingerprints: []
  });

  const codeKey = event.code.toLowerCase();
  const processedCodes = new Set(state.processedCodes);
  const processedFingerprints = new Set(state.processedFingerprints);

  if (processedCodes.has(codeKey) || processedFingerprints.has(event.fingerprint)) {
    return { ok: true, duplicate: true };
  }

  processedCodes.add(codeKey);
  processedFingerprints.add(event.fingerprint);

  await chrome.storage.local.set({
    history: state.history,
    processedCodes: Array.from(processedCodes).slice(-settings.processedLimit),
    processedFingerprints: Array.from(processedFingerprints).slice(-settings.processedLimit),
    lastDetected: event
  });

  if (!payload.silent) {
    queueLiveCodeEvent(event, settings);
  }

  return { ok: true, duplicate: false, queued: !payload.silent, silent: Boolean(payload.silent) };
}

async function handleScanStarted(payload, sender) {
  const settings = await loadSettings();
  const state = {
    status: 'scanning',
    pageUrl: payload.pageUrl || sender.tab?.url || null,
    startedAt: new Date().toISOString()
  };
  const nextStorage = { monitorStatus: state };

  pendingLiveCodeEvents.clear();
  if (pendingLiveCodeTimer) {
    clearTimeout(pendingLiveCodeTimer);
    pendingLiveCodeTimer = null;
  }

  if (settings.autoDisarmOnScan) {
    nextStorage.deliveryArmed = false;
  }

  await chrome.storage.local.set(nextStorage);
  await updateBadge(0);
  return { ok: true, deliveryArmed: !settings.autoDisarmOnScan };
}

async function handleScanReady(payload, sender) {
  const settings = await loadSettings();
  const state = {
    status: 'ready',
    pageUrl: payload.pageUrl || sender.tab?.url || null,
    maxSeenMessageNumber: payload.maxSeenMessageNumber || null,
    maxSeenTimelineMs: payload.maxSeenTimelineMs || null,
    readyAt: new Date().toISOString()
  };

  await chrome.storage.local.set({
    monitorStatus: state,
    deliveryArmed: false
  });
  await updateBadge(0);

  if (settings.scanReadyNotification) {
    await chrome.notifications.create(`telegram-scan-ready-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon-128.svg',
      title: 'Telegram scan ready',
      message: 'Old codes are seeded. Arm endpoint for the next new code.',
      priority: 1
    }).catch(() => {});
  }

  return { ok: true, deliveryArmed: false };
}

async function setDeliveryArmed(armed) {
  await chrome.storage.local.set({
    deliveryArmed: armed,
    deliveryArmedAt: armed ? new Date().toISOString() : null
  });
  return { ok: true, deliveryArmed: armed };
}

function queueLiveCodeEvent(event, settings) {
  pendingLiveCodeEvents.set(event.fingerprint, event);
  if (pendingLiveCodeTimer) {
    return;
  }

  pendingLiveCodeTimer = setTimeout(() => {
    flushLiveCodeEvents().catch((error) => {
      chrome.storage.local.set({
        lastCodeBurstError: {
          ok: false,
          error: error.message,
          at: new Date().toISOString()
        }
      });
    });
  }, clampNumber(settings.liveCodeBurstMs, 500, 10_000));
}

async function flushLiveCodeEvents() {
  const events = Array.from(pendingLiveCodeEvents.values());
  pendingLiveCodeEvents.clear();
  pendingLiveCodeTimer = null;

  if (events.length === 0) {
    return;
  }

  const settings = await loadSettings();
  const { deliveryArmed } = await chrome.storage.local.get({
    deliveryArmed: false
  });
  const selectedEvents = events
    .sort(compareNewestEvents)
    .slice(0, clampNumber(settings.maxLiveCodesPerBurst, 1, 5));
  const state = await chrome.storage.local.get({
    history: []
  });
  const history = deliveryArmed
    ? [...selectedEvents, ...state.history].slice(0, settings.historyLimit)
    : state.history;

  await chrome.storage.local.set({
    history,
    lastCodeBurst: {
      received: events.length,
      sent: deliveryArmed ? selectedEvents.length : 0,
      dropped: Math.max(0, events.length - (deliveryArmed ? selectedEvents.length : 0)),
      deliveryArmed: Boolean(deliveryArmed),
      at: new Date().toISOString()
    }
  });
  await updateBadge(history.length);

  if (!deliveryArmed) {
    return;
  }

  for (const event of selectedEvents) {
    await emitAlert(event, settings);
  }
}

async function areCodesProcessed(codes) {
  const state = await chrome.storage.local.get({
    processedCodes: []
  });
  const processedCodes = new Set(state.processedCodes);
  const result = {};

  for (const code of codes) {
    const codeKey = String(code || '').toLowerCase();
    result[codeKey] = processedCodes.has(codeKey);
  }

  return { ok: true, processed: result };
}

async function handleVideoFrames(payload, sender) {
  const settings = await loadSettings();
  const { deliveryArmed } = await chrome.storage.local.get({
    deliveryArmed: false
  });
  const event = {
    messageId: payload?.messageId || null,
    messageUrl: payload?.messageUrl || null,
    pageUrl: payload?.pageUrl || sender.tab?.url || null,
    tabId: sender.tab?.id || null,
    videoSrc: payload?.videoSrc || null,
    fingerprint: payload?.fingerprint || `video:${Date.now()}`,
    frames: Array.isArray(payload?.frames) ? payload.frames : [],
    capturedAt: new Date().toISOString()
  };

  const state = await chrome.storage.local.get({
    videoHistory: [],
    processedVideoFingerprints: []
  });
  const processedVideoFingerprints = new Set(state.processedVideoFingerprints);

  if (processedVideoFingerprints.has(event.fingerprint)) {
    return { ok: true, duplicate: true };
  }

  processedVideoFingerprints.add(event.fingerprint);
  const videoHistory = [summarizeVideoEvent(event), ...state.videoHistory].slice(0, settings.historyLimit);
  await chrome.storage.local.set({
    videoHistory,
    processedVideoFingerprints: Array.from(processedVideoFingerprints).slice(-settings.processedLimit),
    lastVideoFrames: summarizeVideoEvent(event)
  });

  const results = {
    webhook: false,
    telegram: false
  };

  if (deliveryArmed && settings.webhookEnabled && settings.webhookUrl) {
    results.webhook = await sendFrameWebhook(settings.webhookUrl, event, settings);
  }

  if (deliveryArmed && hasTelegramConfig(settings) && settings.telegramSendFrames) {
    try {
      results.telegram = await sendTelegramFrames(event, settings);
    } catch (error) {
      results.telegram = { ok: false, error: error.message };
      await chrome.storage.local.set({
        lastTelegramFrameResult: {
          ok: false,
          error: error.message,
          at: new Date().toISOString()
        }
      });
    }
  }

  return { ok: true, duplicate: false, ...results };
}

async function handleVideoCaptureFailure(payload, sender) {
  const failure = {
    messageId: payload?.messageId || null,
    messageUrl: payload?.messageUrl || null,
    pageUrl: payload?.pageUrl || sender.tab?.url || null,
    fingerprint: payload?.fingerprint || null,
    error: payload?.error || 'Video capture failed',
    at: new Date().toISOString()
  };
  await chrome.storage.local.set({ lastVideoCaptureError: failure });
  return { ok: true };
}

async function emitAlert(event, settings) {
  const results = {
    ok: true,
    notification: false,
    sound: false,
    webhook: false,
    telegram: false
  };

  if (settings.notificationEnabled) {
    try {
      await chrome.notifications.create(`telegram-code-${hashString(event.fingerprint)}`, {
        type: 'basic',
        iconUrl: 'icons/icon-128.svg',
        title: 'Telegram code detected',
        message: event.code,
        priority: 2
      });
      results.notification = true;
    } catch (error) {
      results.notificationError = error.message;
    }
  }

  if (settings.soundEnabled) {
    try {
      await playSound();
      results.sound = true;
    } catch (error) {
      results.soundError = error.message;
    }
  }

  if (settings.webhookEnabled && settings.webhookUrl) {
    try {
      results.webhook = await sendWebhook(settings.webhookUrl, event, settings);
    } catch (error) {
      results.webhook = { ok: false, error: error.message };
    }
  }

  if (hasTelegramConfig(settings) && settings.telegramSendCode) {
    try {
      results.telegram = await sendTelegramMessage(event, settings);
    } catch (error) {
      results.telegram = { ok: false, error: error.message };
    }
  }

  return results;
}

async function sendWebhook(url, event, settings) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(settings.webhookApiKey
          ? { 'x-internal-api-key': settings.webhookApiKey }
          : {})
      },
      body: JSON.stringify({
        type: settings.webhookType || 'code_daily_hr',
        content: event.code
      }),
      signal: controller.signal
    });

    const result = {
      ok: response.ok,
      status: response.status,
      at: new Date().toISOString()
    };
    await chrome.storage.local.set({ lastWebhookResult: result });
    return result;
  } catch (error) {
    const result = {
      ok: false,
      error: error.message,
      at: new Date().toISOString()
    };
    await chrome.storage.local.set({ lastWebhookResult: result });
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendFrameWebhook(url, event, settings) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(settings.webhookApiKey
          ? { 'x-internal-api-key': settings.webhookApiKey }
          : {})
      },
      body: JSON.stringify({
        type: settings.videoFrameWebhookType || 'code_daily_hr_frames',
        content: {
          pageUrl: event.pageUrl,
          messageId: event.messageId,
          messageUrl: event.messageUrl,
          capturedAt: event.capturedAt,
          frames: event.frames
        }
      }),
      signal: controller.signal
    });

    const result = {
      ok: response.ok,
      status: response.status,
      at: new Date().toISOString()
    };
    await chrome.storage.local.set({ lastFrameWebhookResult: result });
    return result;
  } catch (error) {
    const result = {
      ok: false,
      error: error.message,
      at: new Date().toISOString()
    };
    await chrome.storage.local.set({ lastFrameWebhookResult: result });
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTelegramMessage(event, settings) {
  const response = await fetch(buildTelegramApiUrl(settings.telegramBotToken, 'sendMessage'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: settings.telegramChatId,
      text: `Code: ${event.code}`,
      disable_web_page_preview: true
    })
  });
  return saveTelegramResult('lastTelegramCodeResult', response);
}

async function sendTelegramFrames(event, settings) {
  const frames = event.frames.slice(0, 10);
  if (frames.length === 0) {
    return { ok: false, error: 'No frames to send' };
  }

  if (frames.length === 1) {
    return sendTelegramDocument(frames[0], event, settings);
  }

  const form = new FormData();
  form.append('chat_id', settings.telegramChatId);
  form.append('media', JSON.stringify(frames.map((frame, index) => ({
    type: 'document',
    media: `attach://frame_${index}`,
    caption: index === 0 ? buildFrameCaption(event) : undefined,
    disable_content_type_detection: true
  }))));

  frames.forEach((frame, index) => {
    form.append(`frame_${index}`, dataUrlToBlob(frame.dataUrl), buildFrameFilename(frame, index));
  });

  const response = await fetch(buildTelegramApiUrl(settings.telegramBotToken, 'sendMediaGroup'), {
    method: 'POST',
    body: form
  });
  return saveTelegramResult('lastTelegramFrameResult', response);
}

async function sendTelegramDocument(frame, event, settings) {
  const form = new FormData();
  form.append('chat_id', settings.telegramChatId);
  form.append('caption', buildFrameCaption(event));
  form.append('disable_content_type_detection', 'true');
  form.append('document', dataUrlToBlob(frame.dataUrl), buildFrameFilename(frame, 0));

  const response = await fetch(buildTelegramApiUrl(settings.telegramBotToken, 'sendDocument'), {
    method: 'POST',
    body: form
  });
  return saveTelegramResult('lastTelegramFrameResult', response);
}

async function saveTelegramResult(storageKey, response) {
  const result = {
    ok: response.ok,
    status: response.status,
    at: new Date().toISOString()
  };

  try {
    const body = await response.json();
    if (!response.ok && body?.description) {
      result.error = body.description;
    }
  } catch (error) {
    if (!response.ok) {
      result.error = response.statusText;
    }
  }

  await chrome.storage.local.set({ [storageKey]: result });
  return result;
}

function hasTelegramConfig(settings) {
  return Boolean(settings.telegramBotEnabled && settings.telegramBotToken && settings.telegramChatId);
}

function compareNewestEvents(left, right) {
  const leftMessageNumber = Number(left.messageNumber);
  const rightMessageNumber = Number(right.messageNumber);
  if (Number.isFinite(leftMessageNumber) && Number.isFinite(rightMessageNumber) && leftMessageNumber !== rightMessageNumber) {
    return rightMessageNumber - leftMessageNumber;
  }

  const leftTimelineMs = Number(left.timelineMs);
  const rightTimelineMs = Number(right.timelineMs);
  if (Number.isFinite(leftTimelineMs) && Number.isFinite(rightTimelineMs) && leftTimelineMs !== rightTimelineMs) {
    return rightTimelineMs - leftTimelineMs;
  }

  return Date.parse(right.detectedAt || 0) - Date.parse(left.detectedAt || 0);
}

function buildTelegramApiUrl(token, method) {
  return `https://api.telegram.org/bot${String(token).trim()}/${method}`;
}

function buildFrameCaption(event) {
  const parts = ['Stake frame capture'];
  if (event.messageId) {
    parts.push(`message: ${event.messageId}`);
  }
  if (event.messageUrl) {
    parts.push(event.messageUrl);
  }
  return parts.join('\n');
}

function buildFrameFilename(frame, index) {
  const extension = frame.mimeType === 'image/png' ? 'png' : 'jpg';
  return `stake-frame-${String(index + 1).padStart(2, '0')}-${frame.timeMs}ms.${extension}`;
}

function dataUrlToBlob(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid frame data URL');
  }

  const mimeType = match[1];
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

async function playSound() {
  if (!chrome.offscreen) {
    return;
  }

  const hasDocument = await chrome.offscreen.hasDocument();
  if (!hasDocument) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play an alert sound when a Telegram code is detected.'
    });
  }

  await chrome.runtime.sendMessage({ type: 'TW_PLAY_SOUND' });
}

async function getState() {
  const defaults = await loadDefaultSettings();
  const state = await chrome.storage.local.get({
    settings: defaults,
    history: [],
    videoHistory: [],
    deliveryArmed: false,
    deliveryArmedAt: null,
    monitorStatus: null,
    lastDetected: null,
    lastWebhookResult: null,
    lastFrameWebhookResult: null,
    lastVideoCaptureError: null,
    lastTelegramCodeResult: null,
    lastTelegramFrameResult: null
  });

  return {
    ok: true,
    settings: { ...DEFAULT_SETTINGS, ...(state.settings || {}), ...defaults },
    history: state.history,
    videoHistory: state.videoHistory,
    deliveryArmed: Boolean(state.deliveryArmed),
    deliveryArmedAt: state.deliveryArmedAt,
    monitorStatus: state.monitorStatus,
    lastDetected: state.lastDetected,
    lastWebhookResult: state.lastWebhookResult,
    lastFrameWebhookResult: state.lastFrameWebhookResult,
    lastVideoCaptureError: state.lastVideoCaptureError,
    lastTelegramCodeResult: state.lastTelegramCodeResult,
    lastTelegramFrameResult: state.lastTelegramFrameResult
  };
}

async function getCaptureSettings() {
  const settings = await loadSettings();
  return {
    ok: true,
    settings: {
      videoCaptureEnabled: Boolean(settings.videoCaptureEnabled),
      videoFrameCount: clampNumber(settings.videoFrameCount, 1, 8),
      videoFrameStartMs: clampNumber(settings.videoFrameStartMs, 0, 60_000),
      videoFrameEndMs: clampNumber(settings.videoFrameEndMs, 0, 60_000),
      videoFrameMaxHeight: clampNumber(settings.videoFrameMaxHeight, 180, 1080),
      videoFrameQuality: clampFloat(settings.videoFrameQuality, 0.35, 0.95),
      videoFrameMimeType: normalizeFrameMimeType(settings.videoFrameMimeType)
    }
  };
}

async function updateSettings(nextSettings) {
  const defaults = await loadDefaultSettings();
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(await loadSettings()),
    ...defaults,
    ...nextSettings
  };

  settings.historyLimit = clampNumber(settings.historyLimit, 10, 2000);
  settings.processedLimit = clampNumber(settings.processedLimit, 100, 5000);
  settings.maxLiveCodesPerBurst = clampNumber(settings.maxLiveCodesPerBurst, 1, 5);
  settings.liveCodeBurstMs = clampNumber(settings.liveCodeBurstMs, 500, 10_000);

  await chrome.storage.local.set({ settings });
  return { ok: true, settings };
}

async function loadSettings() {
  const defaults = await loadDefaultSettings();
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}), ...defaults };
}

async function loadDefaultSettings() {
  const fileSettings = await loadConfigFile();
  return { ...DEFAULT_SETTINGS, ...fileSettings };
}

async function loadConfigFile() {
  try {
    const response = await fetch(chrome.runtime.getURL('config.json'), { cache: 'no-store' });
    if (!response.ok) {
      return {};
    }

    const config = await response.json();
    return sanitizeConfig(config);
  } catch (error) {
    return {};
  }
}

function sanitizeConfig(config) {
  const allowedKeys = [
    'notificationEnabled',
    'soundEnabled',
    'webhookEnabled',
    'webhookUrl',
    'webhookApiKey',
    'webhookType',
    'videoCaptureEnabled',
    'videoFrameWebhookType',
    'videoFrameCount',
    'videoFrameStartMs',
    'videoFrameEndMs',
    'videoFrameMaxHeight',
    'videoFrameQuality',
    'videoFrameMimeType',
    'telegramBotEnabled',
    'telegramBotToken',
    'telegramChatId',
    'telegramSendCode',
    'telegramSendFrames',
    'maxLiveCodesPerBurst',
    'liveCodeBurstMs',
    'autoDisarmOnScan',
    'scanReadyNotification',
    'historyLimit',
    'processedLimit'
  ];

  return Object.fromEntries(
    Object.entries(config || {}).filter(([key, value]) => {
      if (!allowedKeys.includes(key)) {
        return false;
      }

      return typeof value !== 'string' || value.trim() !== '';
    })
  );
}

async function updateBadge(count) {
  const text = count > 0 ? String(Math.min(count, 999)) : '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
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

function normalizeFrameMimeType(value) {
  return value === 'image/jpeg' ? 'image/jpeg' : 'image/png';
}

function summarizeVideoEvent(event) {
  return {
    messageId: event.messageId,
    messageUrl: event.messageUrl,
    pageUrl: event.pageUrl,
    fingerprint: event.fingerprint,
    frameCount: event.frames.length,
    capturedAt: event.capturedAt
  };
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
