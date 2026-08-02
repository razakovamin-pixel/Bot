import { extractJsonArray, withRetry } from './utils.js';

const SYSTEM_PROMPT = `Ты — специалист по шиитской риджал-науке (‘ильм ар-риджаль) и профессиональный переводчик с арабского на русский.
Тебе дают несколько биографий передатчиков хадисов (рувват) из классической книги.
Для КАЖДОЙ биографии в том же порядке, в котором они даны, верни один объект со следующими полями:
- name_ar: имя передатчика на арабском, как в оригинале
- name_ru: имя передатчика, транслитерированное на русский
- bio_ru: связный перевод/пересказ биографии на русский язык
- reliability_ar: оценка надёжности передатчика (например الجرح والتعديل) на арабском, как в оригинале
- reliability_ru: перевод этой оценки надёжности на русский
- sources: массив строк — упомянутые в тексте источники/ссылки на других риджалистов, если есть (иначе пустой массив)

ОТВЕТЬ СТРОГО JSON-МАССИВОМ ОБЪЕКТОВ И НИЧЕМ ДРУГИМ.
Никакого markdown, никаких кодовых блоков, никаких пояснений до или после JSON.
Длина массива должна точно совпадать с числом переданных биографий, и порядок должен сохраняться.`;

function buildUserPrompt(entries) {
  const numbered = entries
    .map((text, i) => `--- Биография ${i + 1} ---\n${text}`)
    .join('\n\n');
  return `Переведи и структурируй следующие ${entries.length} биографи${entries.length === 1 ? 'ю' : 'й'} передатчиков:\n\n${numbered}`;
}

/**
 * Send one batch (array of raw entry texts) to the configured AI endpoint
 * and return the parsed array of translated objects. Retries up to 5 times
 * on network errors, non-2xx responses, or malformed/short JSON output.
 */
export async function translateBatch(env, entries) {
  if (!env.AI_API_KEY || !env.AI_BASE_URL || !env.AI_MODEL) {
    throw new Error('AI_API_KEY / AI_BASE_URL / AI_MODEL secrets are not configured');
  }

  return withRetry(async () => {
    const res = await fetch(`${env.AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.AI_MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(entries) },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`AI endpoint HTTP ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = await res.json();
    // Support both OpenAI-style (choices[0].message.content) and
    // Anthropic-style (content[0].text) response shapes transparently.
    const content =
      data?.choices?.[0]?.message?.content ??
      data?.content?.[0]?.text ??
      null;

    if (!content) {
      throw new Error('AI response contained no content');
    }

    const parsed = extractJsonArray(content);
    if (!Array.isArray(parsed)) {
      throw new Error('AI response JSON was not an array');
    }
    if (parsed.length !== entries.length) {
      throw new Error(`AI returned ${parsed.length} items, expected ${entries.length}`);
    }

    return parsed;
  }, { attempts: 5, baseDelayMs: 2000 });
}
