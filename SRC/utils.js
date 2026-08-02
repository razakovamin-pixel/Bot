/**
 * Small dependency-free utilities shared across the project.
 */

/** Resolve after `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` up to `attempts` times, waiting `baseDelayMs * attemptNumber`
 * between tries (simple linear backoff). Rethrows the last error if every
 * attempt fails.
 */
export async function withRetry(fn, { attempts = 5, baseDelayMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await sleep(baseDelayMs * attempt);
      }
    }
  }
  throw lastError;
}

/**
 * Pull a JSON array out of a raw AI completion. Strips ``` / ```json code
 * fences if the model added them anyway, then parses the substring between
 * the first "[" and the last "]".
 */
export function extractJsonArray(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Empty AI response, cannot extract JSON array');
  }

  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON array found in AI response');
  }

  const slice = cleaned.slice(start, end + 1);
  return JSON.parse(slice);
}

/** Zero-pad a batch number to 3 digits: 3 -> "003". */
export function pad3(n) {
  return String(n).padStart(3, '0');
}
