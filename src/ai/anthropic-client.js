// src/ai/anthropic-client.js
// Этап 5: прямой вызов Anthropic API из браузера (claude-haiku-4-5) —
// заголовок anthropic-dangerous-direct-browser-access обязателен для CORS
// без бэкенда-прокси. Ключ пользователь вводит сам в настройках (localStorage,
// в репозиторий не попадает — см. src/ai/settings.js). Модель НЕ считает
// суммы — только переводит текст в JSON-операции (см. src/ai/ops.js) и
// сверяет их с компактным контекстом фактуры (см. src/ai/context-builder.js).

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = `You are a JSON-only API. Respond ONLY with a valid JSON array of operations. No text, no explanation, no markdown, no code blocks. Your entire response must start with [ and end with ]. If you cannot parse the command into operations, return [].

Ты переводишь текстовую команду пользователя (на русском или польском языке) в JSON-массив операций редактирования фактуры GLS.

Доступные операции (ровно такие поля, без лишних):
- {"op":"setRates","rates":[a,b,c]} — три ставки доставки в złotych (число, не строка) по тарифам "Poniżej 3500" / "3500-4800" / "Ponad 4800", применяются сразу ко всем машинам.
- {"op":"deleteLine","vehicle":"NNNN","block":"ooh|surcharges|bonusMalus|extra|fees","match":"подстрока названия строки","all":true} — удалить строку(и), у которых name содержит match (регистр неважен). "vehicle" не нужен, если block="fees". "all":true — если нужно удалить ВСЕ совпадения (например, все PGB); если явно не указано число или "все" — не добавляй "all".
- {"op":"setField","vehicle":"NNNN","block":"ooh|surcharges|bonusMalus|extra|fees","match":"подстрока названия строки","field":"qty|unitPrice|value","value":число} — изменить одно поле строки. unitPrice и value — в złotych (не гроши). "vehicle" не нужен для block="fees".

Блоки: ooh=OOH, surcharges=Usługi (Dopłaty), bonusMalus=Bonus/Malus, extra=Dodatkowe pozycje, fees=Opłaty (без привязки к машине).

Ниже — компактный список машин и текущих строк фактуры (id машины, блок, название, qty, cena, wartość). Используй его, чтобы понять, к какой именно строке относится команда (match — это часть названия из этого списка, бери её дословно из списка, а не придумывай). Ты НЕ считаешь суммы и НЕ проверяешь корректность — только переводишь намерение пользователя в операции; проверка и применение — отдельный шаг.`;

/**
 * @param {string} apiKey
 * @param {string} contextText — компактный контекст фактуры (buildInvoiceContext)
 * @param {string} userCommand — свободный текст пользователя
 * @returns {Promise<string>} сырой текст ответа модели (ожидается JSON-массив)
 */
export async function askClaudeForOps(apiKey, contextText, userCommand) {
  const userMessage = `Текущая фактура:\n${contextText}\n\nКоманда пользователя: ${userCommand}`;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message || JSON.stringify(body);
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new Error(`Anthropic API ${res.status}: ${detail.slice(0, 400)}`);
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    throw new Error('Модель отказалась выполнить команду (refusal) — переформулируйте запрос.');
  }
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  return textBlock ? textBlock.text : '';
}

/**
 * Модель иногда всё же оборачивает ответ в ```json ... ``` несмотря на
 * системный промпт — на всякий случай снимаем обёртку перед JSON.parse.
 * @returns {Array} массив операций (может быть пустым)
 */
export function parseOpsResponse(rawText) {
  const cleaned = String(rawText)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error('ответ модели — не JSON-массив');
  return parsed;
}
