import { DurableObject } from 'cloudflare:workers';
import { analyzeBook, loadBoundaries, readEntryText } from './parser.js';
import { translateBatch } from './ai.js';
import { sendMessage, sendDocumentFromText, getFilePath, fetchFileStream } from './telegram.js';
import { pad3 } from './utils.js';

const BATCH_SIZE = 40;
const STATE_KEY = 'state';
const ERROR_RETRY_DELAY_MS = 30_000;
const NEXT_BATCH_DELAY_MS = 500;

const IDLE_STATE = { status: 'idle' };

/**
 * One Durable Object instance per Telegram chat (id derived from chatId).
 * All processing state lives in this.storage, and progress advances only
 * one alarm-tick at a time — this is what makes the pipeline resumable:
 * if the Worker crashes or redeploys mid-batch, the alarm fires again on
 * the same object and picks up exactly where currentBatch left off.
 */
export class BookProcessor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = ctx;
    this.env = env;
  }

  async getState() {
    return (await this.state.storage.get(STATE_KEY)) ?? IDLE_STATE;
  }

  async setState(patch) {
    const current = await this.getState();
    const next = { ...current, ...patch };
    await this.state.storage.put(STATE_KEY, next);
    return next;
  }

  /** RPC method: called by the router for /status. */
  async status() {
    return this.getState();
  }

  /** RPC method: called by the router for /cancel. */
  async cancel() {
    await this.setState({ status: 'cancelled' });
    await this.state.storage.deleteAlarm();
    return { ok: true };
  }

  /**
   * RPC method: kick off processing of a freshly uploaded book. Called
   * directly by the router with the parsed Telegram payload.
   */
  async startNewBook({ chatId, fileId, fileName }) {
    await this.setState({
      status: 'analyzing',
      chatId,
      r2Key: null,
      totalEntries: 0,
      totalBatches: 0,
      currentBatch: 0,
      batchSize: BATCH_SIZE,
      lastError: null,
    });

    await sendMessage(this.env, chatId, '📥 Книга получена\n🔎 Анализирую...');

    const filePath = await getFilePath(this.env, fileId);
    const fileResponse = await fetchFileStream(this.env, filePath);

    const r2Key = `books/${chatId}/${Date.now()}-${(fileName || 'book').replace(/[^\w.\-]+/g, '_')}`;
    // Stream the Telegram file body directly into R2 — never buffered
    // whole in Worker memory.
    await this.env.BOOK_STORAGE.put(r2Key, fileResponse.body, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    });

    const totalEntries = await analyzeBook(this.env, r2Key);
    if (totalEntries === 0) {
      await this.setState({ status: 'error', lastError: 'Не удалось найти ни одной биографии в файле' });
      await sendMessage(this.env, chatId, '⚠️ Не удалось определить границы биографий в этом файле. Проверьте формат книги.');
      return;
    }

    const totalBatches = Math.ceil(totalEntries / BATCH_SIZE);

    await this.setState({
      status: 'processing',
      r2Key,
      totalEntries,
      totalBatches,
      currentBatch: 0,
    });

    await sendMessage(
      this.env,
      chatId,
      `Найдено:\n${totalEntries} передатчиков\n\nБудет создано:\n${totalBatches} JSON файлов`
    );

    await this.state.storage.setAlarm(Date.now());
  }

  /**
   * Processes exactly one batch, then either schedules the next tick or
   * finishes. On any failure the batch is NOT marked complete, so the next
   * alarm (scheduled after a delay) retries the very same batch — this is
   * the resume-after-failure guarantee.
   */
  async alarm() {
    const s = await this.getState();
    if (s.status !== 'processing') return;

    try {
      const boundaries = await loadBoundaries(this.env, s.r2Key);
      const startIdx = s.currentBatch * BATCH_SIZE;

      if (startIdx >= boundaries.length) {
        await this.setState({ status: 'done' });
        await sendMessage(this.env, s.chatId, `🎉 Обработка завершена: ${s.totalBatches} файлов отправлено.`);
        return;
      }

      const endIdx = Math.min(startIdx + BATCH_SIZE, boundaries.length);
      const batchEntries = boundaries.slice(startIdx, endIdx);

      const texts = [];
      for (const entry of batchEntries) {
        texts.push(await readEntryText(this.env, s.r2Key, entry));
      }

      const translated = await translateBatch(this.env, texts);

      const partNum = s.currentBatch + 1;
      const filename = `part_${pad3(partNum)}.json`;
      const jsonString = JSON.stringify(translated, null, 2);

      await sendDocumentFromText(this.env, s.chatId, filename, jsonString);

      await sendMessage(this.env, s.chatId, `✅ Обработан пакет ${partNum} из ${s.totalBatches}`);
      await sendMessage(this.env, s.chatId, `📄 ${filename} отправлен`);

      const nextBatch = s.currentBatch + 1;
      await this.setState({ currentBatch: nextBatch, lastError: null });

      if (nextBatch >= s.totalBatches) {
        await this.setState({ status: 'done' });
        await sendMessage(this.env, s.chatId, `🎉 Обработка завершена: ${s.totalBatches} файлов отправлено.`);
      } else {
        await this.state.storage.setAlarm(Date.now() + NEXT_BATCH_DELAY_MS);
      }
    } catch (err) {
      const message = err?.message ?? String(err);
      await this.setState({ lastError: message });
      try {
        await sendMessage(
          this.env,
          s.chatId,
          `⚠️ Ошибка при обработке пакета ${s.currentBatch + 1}: ${message}\nПовторю попытку автоматически.`
        );
      } catch (_) {
        // Telegram itself may be unreachable; the alarm retry below still
        // ensures we don't lose progress.
      }
      await this.state.storage.setAlarm(Date.now() + ERROR_RETRY_DELAY_MS);
    }
  }
}
