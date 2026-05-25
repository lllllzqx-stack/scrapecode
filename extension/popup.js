'use strict';

const elements = {
  notificationEnabled: document.querySelector('#notificationEnabled'),
  soundEnabled: document.querySelector('#soundEnabled'),
  webhookEnabled: document.querySelector('#webhookEnabled'),
  webhookUrl: document.querySelector('#webhookUrl'),
  count: document.querySelector('#count'),
  status: document.querySelector('#status'),
  history: document.querySelector('#history'),
  save: document.querySelector('#save'),
  scan: document.querySelector('#scan'),
  test: document.querySelector('#test'),
  clear: document.querySelector('#clear')
};

document.addEventListener('DOMContentLoaded', refresh);
elements.save.addEventListener('click', saveSettings);
elements.scan.addEventListener('click', scanActiveTab);
elements.test.addEventListener('click', testAlert);
elements.clear.addEventListener('click', clearHistory);

async function refresh() {
  const response = await sendMessage({ type: 'TW_GET_STATE' });
  if (!response?.ok) {
    setStatus(response?.error || 'Cannot read state');
    return;
  }

  const { settings, history, lastWebhookResult } = response;
  elements.notificationEnabled.checked = Boolean(settings.notificationEnabled);
  elements.soundEnabled.checked = Boolean(settings.soundEnabled);
  elements.webhookEnabled.checked = Boolean(settings.webhookEnabled);
  elements.webhookUrl.value = settings.webhookUrl || '';
  elements.count.textContent = String(history.length);
  renderHistory(history);

  if (lastWebhookResult?.ok === false) {
    setStatus(`Webhook failed: ${lastWebhookResult.error || lastWebhookResult.status}`);
  } else {
    setStatus('Ready');
  }
}

async function saveSettings() {
  const response = await sendMessage({
    type: 'TW_UPDATE_SETTINGS',
    settings: {
      notificationEnabled: elements.notificationEnabled.checked,
      soundEnabled: elements.soundEnabled.checked,
      webhookEnabled: elements.webhookEnabled.checked,
      webhookUrl: elements.webhookUrl.value.trim()
    }
  });

  setStatus(response?.ok ? 'Saved' : response?.error || 'Save failed');
  await refresh();
}

async function scanActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus('No active tab');
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TW_CODE_WATCHER_SCAN_NOW' });
    setStatus('Scan sent');
  } catch (error) {
    setStatus('Open Telegram Web tab first');
  }
}

async function testAlert() {
  const response = await sendMessage({ type: 'TW_TEST_ALERT' });
  setStatus(response?.ok ? 'Test sent' : response?.error || 'Test failed');
}

async function clearHistory() {
  const response = await sendMessage({ type: 'TW_CLEAR_HISTORY' });
  setStatus(response?.ok ? 'Cleared' : response?.error || 'Clear failed');
  await refresh();
}

function renderHistory(history) {
  elements.history.textContent = '';

  for (const item of history.slice(0, 20)) {
    const li = document.createElement('li');
    const code = document.createElement('span');
    const meta = document.createElement('span');

    code.className = 'code';
    code.textContent = item.code;
    meta.className = 'meta';
    meta.textContent = new Date(item.detectedAt).toLocaleString();

    li.append(code, meta);
    elements.history.append(li);
  }
}

function setStatus(message) {
  elements.status.textContent = message;
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}
