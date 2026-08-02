import { BookProcessor } from './durableObject.js';
import { sendMessage } from './telegram.js';
import { START_TEXT, HELP_TEXT, formatStatus } from './commands.js';

export { BookProcessor };

function getProcessorStub(env, chatId) {
  const id = env.BOOK_PROCESSOR.idFromName(String(chatId));
  return env.BOOK_PROCESSOR.get(id);
}

async function handleUpdate(update, env) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;
  const stub = getProcessorStub(env, chatId);

  if (message.document) {
    const doc = message.document;
    const looksLikeText =
      (doc.mime_type && doc.mime_type.startsWith('text/')) ||
      (doc.file_name && doc.file_name.toLowerCase().endsWith('.txt'));

    if (!looksLikeText) {
      await sendMessage(env, chatId, '⚠️ Пришлите файл книги в формате .txt');
      return;
    }

    const current = await stub.status();
    if (current.status === 'analyzing' || current.status === 'processing') {
      await sendMessage(env, chatId, '⏳ Уже обрабатываю предыдущую книгу. Используйте /status или /cancel.');
      return;
    }

    await stub.startNewBook({
      chatId,
      fileId: doc.file_id,
      fileName: doc.file_name,
    });
    return;
  }

  const text = (message.text || '').trim();
  if (!text.startsWith('/')) {
    await sendMessage(env, chatId, 'Отправьте .txt-файл книги, чтобы начать обработку. /help — справка.');
    return;
  }

  const command = text.split(/[\s@]/)[0];

  switch (command) {
    case '/start':
      await sendMessage(env, chatId, START_TEXT);
      break;
    case '/help':
      await sendMessage(env, chatId, HELP_TEXT);
      break;
    case '/status': {
      const s = await stub.status();
      await sendMessage(env, chatId, formatStatus(s));
      break;
    }
    case '/cancel': {
      await stub.cancel();
      await sendMessage(env, chatId, '🛑 Обработка отменена.');
      break;
    }
    default:
      await sendMessage(env, chatId, 'Неизвестная команда. /help — список команд.');
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('Shia Rijal Bot is running.', { status: 200 });
    }

    if (request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }

    let update;
    try {
      update = await request.json();
    } catch (_) {
      return new Response('Bad request', { status: 400 });
    }

    // Ack Telegram immediately; keep working via ctx.waitUntil so a large
    // book's processing kickoff never risks a webhook timeout.
    ctx.waitUntil(
      handleUpdate(update, env).catch((err) => {
        console.error('handleUpdate failed:', err);
      })
    );

    return new Response('ok', { status: 200 });
  },
};
