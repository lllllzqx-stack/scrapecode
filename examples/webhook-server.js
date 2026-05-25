'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const host = '127.0.0.1';
const port = Number.parseInt(process.env.PORT || '8787', 10);
const outputPath = path.join(process.cwd(), 'webhook-events.jsonl');

const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/code') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: 'Not found' }));
    return;
  }

  try {
    const body = await readBody(request);
    const payload = JSON.parse(body);
    await fs.appendFile(outputPath, `${JSON.stringify(payload)}\n`, 'utf8');

    console.log(`[${new Date().toISOString()}] ${payload.code}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  } catch (error) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: error.message }));
  }
});

server.listen(port, host, () => {
  console.log(`Webhook listening at http://${host}:${port}/code`);
});

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error('Body too large'));
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}
