// src/pdf/tokenize.js
// Гоняет extractPageCells() по всем страницам PDF-документа и склеивает их
// в один плоский поток токенов (ячеек) — по нему потом идёт parse-invoice.js.
// Работает с любым объектом, у которого есть .numPages и .getPage(n) —
// то есть с "document proxy" pdf.js, что в браузере (vendor/pdfjs), что в
// Node (pdfjs-dist/legacy/build) через тот же самый код.

import { extractPageCells } from './geometry.js';

const PAGE_FOOTER_RE = /^Strona\s+(\d+)\s+z\s+(\d+)$/;

/**
 * @param {{numPages:number, getPage:(n:number)=>Promise<any>}} pdfDocument
 * @returns {Promise<{tokens: string[], pages: {number:number, total:number}[]}>}
 *   tokens — сплошной поток ячеек всех страниц (без "Strona X z Y" — они
 *   вынесены отдельно в pages, т.к. это футер, а не содержимое фактуры).
 */
export async function tokenizePdf(pdfDocument) {
  const tokens = [];
  const pages = [];
  for (let p = 1; p <= pdfDocument.numPages; p += 1) {
    const page = await pdfDocument.getPage(p);
    const content = await page.getTextContent();
    const cells = extractPageCells(content.items);
    for (const cell of cells) {
      const footerMatch = cell.match(PAGE_FOOTER_RE);
      if (footerMatch) {
        pages.push({ number: Number(footerMatch[1]), total: Number(footerMatch[2]) });
      } else {
        tokens.push(cell);
      }
    }
  }
  return { tokens, pages };
}
