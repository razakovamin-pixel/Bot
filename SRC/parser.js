/**
 * Streaming structural analysis of a rijal book.
 *
 * The book text lives in R2. We stream it once, line by line, to find where
 * each transmitter biography starts. We never hold the whole book as a
 * single JS string — only the current chunk/line and the (much smaller)
 * list of boundary offsets stay in memory.
 *
 * Boundary offsets are tracked in BYTES (UTF-8 encoded), because R2 range
 * reads are byte-based. Every offset we record sits exactly on a line
 * start, so later range reads never split a multi-byte character.
 */

// Numbered-entry heading, e.g. "1 - فلان" / "١- فلان" / "23) فلان" / "45. فلان"
const NUMBERED_ENTRY_RE = /^\s*(?:\d+|[\u0660-\u0669]+)\s*[-–—.\)]\s*\S/;

/**
 * Stream `r2Key` from R2, detect entry boundaries, and persist the boundary
 * list to `${r2Key}.boundaries.json` in R2. Returns the number of entries
 * found.
 */
export async function analyzeBook(env, r2Key) {
  const obj = await env.BOOK_STORAGE.get(r2Key);
  if (!obj) {
    throw new Error(`Book not found in R2 storage: ${r2Key}`);
  }

  const numberedStarts = [];
  const blankLineStarts = []; // fallback boundary candidates
  let sawBlankLine = true; // treat start-of-file as "after a blank line"

  const reader = obj.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const encoder = new TextEncoder();

  let carry = '';
  let byteOffset = 0;

  const handleLine = (line) => {
    const isBlank = line.trim().length === 0;
    if (!isBlank) {
      if (NUMBERED_ENTRY_RE.test(line)) {
        numberedStarts.push(byteOffset);
      }
      if (sawBlankLine) {
        blankLineStarts.push(byteOffset);
      }
    }
    sawBlankLine = isBlank;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const chunkText = decoder.decode(value, { stream: true });
    const combined = carry + chunkText;
    const lastNewline = combined.lastIndexOf('\n');

    let processable, remainder;
    if (lastNewline === -1) {
      processable = '';
      remainder = combined;
    } else {
      processable = combined.slice(0, lastNewline + 1);
      remainder = combined.slice(lastNewline + 1);
    }

    if (processable.length > 0) {
      const lines = processable.split('\n');
      // split('\n') on a string ending in '\n' yields a trailing '' — drop it.
      if (lines[lines.length - 1] === '') lines.pop();
      for (const line of lines) {
        handleLine(line);
        byteOffset += encoder.encode(line + '\n').length;
      }
    }

    carry = remainder;
  }

  // Flush whatever is left (last line with no trailing newline).
  const tail = carry + decoder.decode();
  if (tail.length > 0) {
    handleLine(tail);
  }

  const totalBytes = obj.size;

  // Prefer numbered biography headings; fall back to blank-line-separated
  // paragraphs if the book doesn't use a numbered format we recognise.
  const starts = numberedStarts.length >= 2 ? numberedStarts : blankLineStarts;

  const boundaries = starts.map((start, i) => ({
    start,
    end: i + 1 < starts.length ? starts[i + 1] : totalBytes,
  }));

  await env.BOOK_STORAGE.put(`${r2Key}.boundaries.json`, JSON.stringify(boundaries));

  return boundaries.length;
}

/** Load the previously computed boundary list for a book. */
export async function loadBoundaries(env, r2Key) {
  const obj = await env.BOOK_STORAGE.get(`${r2Key}.boundaries.json`);
  if (!obj) {
    throw new Error(`Boundaries not found for ${r2Key} — did analyzeBook run?`);
  }
  return obj.json();
}

/** Read the raw text of a single entry via an R2 byte-range GET. */
export async function readEntryText(env, r2Key, entry) {
  const obj = await env.BOOK_STORAGE.get(r2Key, {
    range: { offset: entry.start, length: entry.end - entry.start },
  });
  if (!obj) {
    throw new Error(`Failed to read entry range [${entry.start}, ${entry.end}) from ${r2Key}`);
  }
  const buf = await obj.arrayBuffer();
  return new TextDecoder('utf-8').decode(buf).trim();
}
