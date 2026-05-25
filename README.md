# Telegram Web Code Watcher

Chrome/Edge extension untuk mantengin Telegram Web yang sedang kamu buka, baca perubahan DOM dengan `MutationObserver`, lalu cari format:

```text
Code: stakecomD6nrMahwmZGN
```

Kalau match dan belum pernah diproses, extension akan:

- tampilkan Chrome notification
- bunyikan audio lewat offscreen document
- simpan history ke `chrome.storage.local`
- POST ke local webhook

## Install Extension

1. Buka `chrome://extensions` atau `edge://extensions`.
2. Aktifkan Developer mode.
3. Pilih Load unpacked.
4. Pilih folder `extension`.
5. Buka `https://web.telegram.org` dan masuk ke channel target.

## Local Webhook

Default webhook:

```text
http://127.0.0.1:8787/code
```

Jalankan contoh receiver:

```bash
npm run webhook
```

Payload yang dikirim:

```json
{
  "source": "telegram-web-code-watcher",
  "code": "stakecomD6nrMahwmZGN",
  "rawLine": "Code: stakecomD6nrMahwmZGN",
  "text": "...",
  "messageId": "...",
  "messageUrl": "...",
  "pageUrl": "https://web.telegram.org/...",
  "fingerprint": "...",
  "detectedAt": "2026-05-25T10:00:00.000Z"
}
```

## Cara Kerja

```text
Telegram Web terbuka
↓
DOM pesan berubah
↓
content.js menangkap node baru
↓
shared/parser.js cari Code: stakecom...
↓
background.js dedupe dan simpan
↓
notification + audio + local webhook
```

Popup extension bisa dipakai untuk toggle notification, audio, webhook, ubah URL webhook, scan tab aktif, test alert, dan clear history.
