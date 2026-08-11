// src/pdf/load-browser.js
// Браузерный вход в парсер: читает загруженный пользователем File (PDF
// фактуры GLS) через вендоренный pdf.js (vendor/pdfjs/ — ESM-сборка + воркер,
// без CDN и без бандлера). Всё разбирается локально в браузере, файл никуда
// не отправляется. Общую логику (tokenize.js/parse-invoice.js) переиспользует
// и test/pdf-parser.test.js (там pdf.js берётся из pdfjs-dist в Node).

import * as pdfjsLib from '../../vendor/pdfjs/pdf.min.mjs';
import { tokenizePdf } from './tokenize.js';
import { parseTokens } from './parse-invoice.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

/**
 * @param {File} file
 * @returns {Promise<{invoice: object, printed: object, feesInfo: object, warnings: object[]}>}
 *   invoice — ЕЩЁ БЕЗ recalc(): вызывающий код (app.js) сам решает, когда
 *   пересчитывать, точно так же, как с buildSampleInvoice().
 */
export async function loadInvoiceFromPdfFile(file) {
  const buffer = await file.arrayBuffer();
  const pdfDocument = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const { tokens } = await tokenizePdf(pdfDocument);
  return parseTokens(tokens);
}
