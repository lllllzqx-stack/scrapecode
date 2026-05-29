'use strict';

const DEFAULT_SETTINGS = {
  notificationEnabled: true,
  soundEnabled: true,
  webhookEnabled: true,
  webhookUrl: 'https://api.val.bot/api/webhooks/broadcast/content',
  webhookApiKey: '',
  webhookType: 'code_daily_hr',
  historyLimit: 500,
  processedLimit: 1500
};

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

  if (message?.type === 'TW_UPDATE_SETTINGS') {
    return updateSettings(message.settings || {});
  }

  if (message?.type === 'TW_CLEAR_HISTORY') {
    await chrome.storage.local.set({
      history: [],
      processedCodes: [],
      processedFingerprints: []
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

  const history = payload.silent
    ? state.history
    : [event, ...state.history].slice(0, settings.historyLimit);

  await chrome.storage.local.set({
    history,
    processedCodes: Array.from(processedCodes).slice(-settings.processedLimit),
    processedFingerprints: Array.from(processedFingerprints).slice(-settings.processedLimit),
    lastDetected: event
  });

  await updateBadge(history.length);

  if (!payload.silent) {
    await emitAlert(event, settings);
  }

  return { ok: true, duplicate: false, silent: Boolean(payload.silent) };
}

async function emitAlert(event, settings) {
  const results = {
    ok: true,
    notification: false,
    sound: false,
    webhook: false
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
    lastDetected: null,
    lastWebhookResult: null
  });

  return {
    ok: true,
    settings: { ...DEFAULT_SETTINGS, ...(state.settings || {}), ...defaults },
    history: state.history,
    lastDetected: state.lastDetected,
    lastWebhookResult: state.lastWebhookResult
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

function hashString(value) {
  let hash = 0x811c9dc5;
  const text = String(value || '');

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}
