// src/pdf/tokenize.js
// Гоняет extractPageCells() по всем страницам PDF-документа и склеивает их
// в один плоский поток токенов (ячеек) — по нему потом идёт parse-invoice.js.
// Работает с любым объектом, у которого есть .numPages и .getPage(n) —
// то есть с "document proxy" pdf.js, что в браузере (vendor/pdfjs), что в
// Node (pdfjs-dist/legacy/build) через тот же самый код.

import { extractPageCellsWithY } from './geometry.js';

const PAGE_FOOTER_RE = /^Strona\s+(\d+)\s+z\s+(\d+)$/;

/**
 * @param {{numPages:number, getPage:(n:number)=>Promise<any>}} pdfDocument
 * @returns {Promise<{tokens: string[], pages: {number:number, total:number}[], tokenPages: number[]}>}
 *   tokens — сплошной поток ячеек всех страниц (без "Strona X z Y" — они
 *   вынесены отдельно в pages, т.к. это футер, а не содержимое фактуры).
 *   tokenPages[i] — номер физической страницы PDF (с 1), на которой стоит
 *   tokens[i]: парсер записывает её в invoice.layout[*].page, чтобы вкладка
 *   сравнения могла показать «на какой странице этот блок в оригинале».
 *   tokenY[i] — y токена в pt ОТ ВЕРХНЕГО края страницы (layout[*].y —
 *   подсветка блоков на картинке оригинала во вкладке сравнения).
 */
export async function tokenizePdf(pdfDocument) {
  const tokens = [];
  const pages = [];
  const tokenPages = [];
  const tokenY = [];
  for (let p = 1; p <= pdfDocument.numPages; p += 1) {
    const page = await pdfDocument.getPage(p);
    const content = await page.getTextContent();
    // page.view = [x0, y0, x1, y1] в pt; ось y в PDF направлена вверх
    const pageTop = page.view ? page.view[3] : 841.89;
    const cells = extractPageCellsWithY(content.items);
    for (const cell of cells) {
      const footerMatch = cell.text.match(PAGE_FOOTER_RE);
      if (footerMatch) {
        pages.push({ number: Number(footerMatch[1]), total: Number(footerMatch[2]) });
      } else {
        tokens.push(cell.text);
        tokenPages.push(p);
        tokenY.push(Math.round((pageTop - cell.y) * 10) / 10);
      }
    }
  }
  return { tokens, pages, tokenPages, tokenY };
}
