# Telegram Web Code Watcher

Chrome/Edge extension untuk mantengin Telegram Web yang sedang kamu buka, baca perubahan DOM dengan `MutationObserver`, lalu cari format:

```text
Code: stakecomD6nrMahwmZGN
```

Kalau match dan belum pernah diproses, extension akan:

- tampilkan Chrome notification
- bunyikan audio lewat offscreen document
- simpan history ke `chrome.storage.local`
- POST ke webhook ValBot
- capture 5 frame JPEG dari video baru dan kirim ke webhook

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
  "videoCaptureEnabled": true,
  "videoFrameWebhookType": "code_daily_hr_frames",
  "videoFrameCount": 5,
  "videoFrameStartMs": 500,
  "videoFrameEndMs": 3500,
  "videoFrameMaxHeight": 720,
  "videoFrameQuality": 0.86,
  "videoFrameMimeType": "image/png",
  "telegramBotEnabled": true,
  "telegramBotToken": "ISI_BOT_TOKEN",
  "telegramChatId": "ISI_CHAT_ID",
  "telegramSendCode": true,
  "telegramSendFrames": true,
  "notificationEnabled": true,
  "soundEnabled": true
}
```

Kalau ubah `extension/config.json`, reload extension dari `chrome://extensions` / `edge://extensions`.

Telegram Bot API tidak bisa kirim ke nomor HP langsung. Isi `telegramChatId` dengan chat id user/group/channel tujuan. Cara paling gampang: chat bot kamu dulu, lalu buka `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates` untuk lihat `message.chat.id`.

## Payload

Payload code:

```json
{
  "type": "code_daily_hr",
  "content": "stakecomD6nrMahwmZGN"
}
```

Payload frame video:

```json
{
  "type": "code_daily_hr_frames",
  "content": {
    "pageUrl": "https://web.telegram.org/...",
    "messageId": "...",
    "messageUrl": "...",
    "capturedAt": "2026-05-29T10:00:00.000Z",
    "frames": [
      {
        "timeMs": 500,
        "width": 1280,
        "height": 720,
        "mimeType": "image/png",
        "dataUrl": "data:image/png;base64,..."
      }
    ]
  }
}
```

Frame diambil dari video Telegram Web yang baru muncul, bukan dari Telegram API langsung. Extension akan mencoba preload video, seek ke rentang ms di config, lalu resize frame supaya tinggi maksimal 720p. Default `videoFrameMimeType` adalah `image/png` supaya frame lossless; ganti ke `image/jpeg` kalau mau payload lebih kecil.

Kalau `telegramBotEnabled` aktif, code dikirim via `sendMessage`, sedangkan frame dikirim via `sendDocument` / `sendMediaGroup` sebagai document. Mode document menjaga file frame tidak diperlakukan sebagai foto Telegram yang biasanya dikompres.

## Local Webhook Test

Jalankan contoh receiver lokal kalau mau tes tanpa ValBot:

```bash
npm run webhook
```

## Cara Kerja

```text
Telegram Web terbuka
|
DOM pesan/video berubah
|
content.js menangkap node baru
|
shared/parser.js cari Code: stakecom...
|
background.js dedupe dan simpan
|
notification + audio + webhook ValBot
```

Popup extension bisa dipakai untuk toggle notification, audio, webhook, ubah URL webhook, scan tab aktif, test alert, dan clear history.
