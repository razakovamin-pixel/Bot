import { withRetry } from './utils.js';

function apiUrl(env, method) {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

function fileUrl(env, filePath) {
  return `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
}

/** Send a plain text message to a chat, retrying on transient failures. */
export async function sendMessage(env, chatId, text, extra = {}) {
  return withRetry(async () => {
    const res = await fetch(apiUrl(env, 'sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...extra,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`sendMessage failed: ${res.status} ${body}`);
    }
    return res.json();
  }, { attempts: 5, baseDelayMs: 800 });
}

/**
 * Send `textContent` as a downloadable document named `filename`
 * (used to deliver part_XXX.json files). Retries on failure.
 */
export async function sendDocumentFromText(env, chatId, filename, textContent, caption) {
  return withRetry(async () => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    const blob = new Blob([textContent], { type: 'application/json' });
    form.append('document', blob, filename);

    const res = await fetch(apiUrl(env, 'sendDocument'), {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`sendDocument failed: ${res.status} ${body}`);
    }
    return res.json();
  }, { attempts: 5, baseDelayMs: 1500 });
}

/** Resolve a Telegram file_id to its file_path. */
export async function getFilePath(env, fileId) {
  const res = await fetch(apiUrl(env, 'getFile') + `?file_id=${encodeURIComponent(fileId)}`);
  if (!res.ok) {
    throw new Error(`getFile failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`getFile returned not-ok: ${JSON.stringify(data)}`);
  }
  return data.result.file_path;
}

/**
 * Fetch the raw file response for a resolved file_path. The caller streams
 * `response.body` straight into R2 — the file is never buffered whole in
 * Worker memory.
 */
export async function fetchFileStream(env, filePath) {
  const res = await fetch(fileUrl(env, filePath));
  if (!res.ok || !res.body) {
    throw new Error(`Downloading Telegram file failed: ${res.status}`);
  }
  return res;
}
