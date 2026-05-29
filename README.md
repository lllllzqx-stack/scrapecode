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

## Config Lokal

Setting bisa diubah dari popup extension atau dari file lokal `extension/config.json`. File itu masuk `.gitignore`, jadi aman buat isi API key sendiri. Nilai di `config.json` akan jadi override; string kosong tidak dihitung sebagai override.

Contoh:

```json
{
  "webhookEnabled": true,
  "webhookUrl": "https://api.val.bot/api/webhooks/broadcast/content",
  "webhookApiKey": "ISI_SENDIRI",
  "webhookType": "code_daily_hr",
  "notificationEnabled": true,
  "soundEnabled": true
}
```

Kalau ubah `extension/config.json`, reload extension dari `chrome://extensions` / `edge://extensions`.

## Local Webhook Test

Jalankan contoh receiver lokal kalau mau tes tanpa ValBot:

```bash
npm run webhook
```

Payload ValBot yang dikirim:

```json
{
  "type": "code_daily_hr",
  "content": "stakecomD6nrMahwmZGN"
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
