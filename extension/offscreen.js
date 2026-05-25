'use strict';

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'TW_PLAY_SOUND') {
    playBeep();
  }
});

async function playBeep() {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) {
    return;
  }

  const audioContext = new AudioContextClass();
  const gain = audioContext.createGain();
  gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.18, audioContext.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.45);
  gain.connect(audioContext.destination);

  for (const [offset, frequency] of [[0, 880], [0.16, 1175]]) {
    const oscillator = audioContext.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime + offset);
    oscillator.connect(gain);
    oscillator.start(audioContext.currentTime + offset);
    oscillator.stop(audioContext.currentTime + offset + 0.14);
  }

  window.setTimeout(() => audioContext.close(), 700);
}
