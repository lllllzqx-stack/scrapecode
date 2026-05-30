'use strict';

const elements = {
  deliveryArmed: document.querySelector('#deliveryArmed'),
  notificationEnabled: document.querySelector('#notificationEnabled'),
  soundEnabled: document.querySelector('#soundEnabled'),
  webhookEnabled: document.querySelector('#webhookEnabled'),
  webhookUrl: document.querySelector('#webhookUrl'),
  webhookApiKey: document.querySelector('#webhookApiKey'),
  webhookType: document.querySelector('#webhookType'),
  count: document.querySelector('#count'),
  status: document.querySelector('#status'),
  history: document.querySelector('#history'),
  save: document.querySelector('#save'),
  arm: document.querySelector('#arm'),
  scan: document.querySelector('#scan'),
  test: document.querySelector('#test'),
  clear: document.querySelector('#clear')
};

document.addEventListener('DOMContentLoaded', refresh);
elements.save.addEventListener('click', saveSettings);
elements.arm.addEventListener('click', toggleArm);
elements.scan.addEventListener('click', scanActiveTab);
elements.test.addEventListener('click', testAlert);
elements.clear.addEventListener('click', clearHistory);

async function refresh() {
  const response = await sendMessage({ type: 'TW_GET_STATE' });
  if (!response?.ok) {
    setStatus(response?.error || 'Cannot read state');
    return;
  }

  const { settings, history, lastWebhookResult, deliveryArmed, monitorStatus } = response;
  elements.deliveryArmed.checked = Boolean(deliveryArmed);
  elements.notificationEnabled.checked = Boolean(settings.notificationEnabled);
  elements.soundEnabled.checked = Boolean(settings.soundEnabled);
  elements.webhookEnabled.checked = Boolean(settings.webhookEnabled);
  elements.webhookUrl.value = settings.webhookUrl || '';
  elements.webhookApiKey.value = settings.webhookApiKey || '';
  elements.webhookType.value = settings.webhookType || '';
  elements.count.textContent = String(history.length);
  elements.arm.textContent = deliveryArmed ? 'Disarm' : 'Arm';
  renderHistory(history);

  if (lastWebhookResult?.ok === false) {
    setStatus(`Webhook failed: ${lastWebhookResult.error || lastWebhookResult.status}`);
  } else if (monitorStatus?.status === 'scanning') {
    setStatus('Scanning old codes...');
  } else if (monitorStatus?.status === 'ready' && !deliveryArmed) {
    setStatus('Scan ready. Arm endpoint.');
  } else if (deliveryArmed) {
    setStatus('Armed for next code');
  } else {
    setStatus('Ready');
  }
}

async function toggleArm() {
  const response = await sendMessage({
    type: 'TW_SET_DELIVERY_ARMED',
    armed: !elements.deliveryArmed.checked
  });

  setStatus(response?.ok ? (response.deliveryArmed ? 'Endpoint armed' : 'Endpoint disarmed') : response?.error || 'Arm failed');
  await refresh();
}

async function saveSettings() {
  const response = await sendMessage({
    type: 'TW_UPDATE_SETTINGS',
    settings: {
      notificationEnabled: elements.notificationEnabled.checked,
      soundEnabled: elements.soundEnabled.checked,
      webhookEnabled: elements.webhookEnabled.checked,
      webhookUrl: elements.webhookUrl.value.trim(),
      webhookApiKey: elements.webhookApiKey.value,
      webhookType: elements.webhookType.value.trim()
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
