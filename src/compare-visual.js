// src/compare-visual.js
// Визуальная часть вкладки «Сравнение с оригиналом»: постранично, слева —
// наша распечатка (те же страницы, что в print.html, через print-render.js),
// справа — страницы ЗАГРУЖЕННОГО PDF, нарисованные pdf.js. Обе стороны в
// одном масштабе A4, страница N слева напротив страницы N справа — глазами
// видно, совпадает ли структура и внешний вид.
//
// Подсветка (из diffModels, см. compare.js): у нас — рамка вокруг элементов
// блока по data-block (жёлтая — блок отличается, красная — блока нет в
// оригинале); на картинке оригинала — рамка по координатам якоря блока из
// PDF (layout[*].y, см. parse-invoice.js): жёлтая — отличается, красная —
// у нас этого блока нет. Высота рамки — до следующего блока на той же
// странице оригинала.
//
// Браузерный модуль (pdf.js из vendor/) — compare.js подгружает его
// динамически, в Node-тесты он не попадает.

import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { buildPrintPages } from './print-render.js';
import { PAGE_W_PT, PAGE_H_PT, TOP_PT, BOTTOM_PT, CONTENT_LEFT_PT } from './print-layout.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'className') node.className = v;
    else if (k === 'style') Object.assign(node.style, v);
    else node.setAttribute(k, v);
  });
  children.forEach((c) => node.appendChild(c));
  return node;
}
function text(tag, content, props = {}) {
  const node = el(tag, props);
  node.textContent = content;
  return node;
}

const PT_TO_PX = 96 / 72;

/** Рамка A4 в px при масштабе scale, внутри — наша .page на своём месте (поля 25мм/10мм). */
function a4Frame(pageNode, scale) {
  const w = PAGE_W_PT * PT_TO_PX * scale;
  const h = PAGE_H_PT * PT_TO_PX * scale;
  const outer = el('div', { className: 'cmp-a4', style: { width: `${w}px`, height: `${h}px` } });
  const inner = el('div', {
    className: 'cmp-a4-inner',
    style: { width: `${PAGE_W_PT * PT_TO_PX}px`, height: `${PAGE_H_PT * PT_TO_PX}px`, transform: `scale(${scale})` },
  });
  if (pageNode) {
    pageNode.style.position = 'absolute';
    pageNode.style.left = `${CONTENT_LEFT_PT}pt`;
    pageNode.style.top = `${TOP_PT}pt`;
    inner.appendChild(pageNode);
  }
  outer.appendChild(inner);
  return outer;
}

/** Высота блока оригинала на странице: до следующего блока на той же странице, иначе до низа содержимого. */
function origBlockBottom(block, origBlocks) {
  const sameLater = origBlocks.filter((b) => b.page === block.page && b.y != null && b.y > block.y).map((b) => b.y);
  return sameLater.length ? Math.min(...sameLater) : BOTTOM_PT;
}

/**
 * @param {HTMLElement} container
 * @param {{current:object, pdfData:ArrayBuffer|null, cmp:object, origBlocks:object[]}} args
 *   cmp — результат buildComparison(); origBlocks — buildPrintModel(original).blocks (с page/y из PDF)
 */
export async function renderVisualPages(container, { current, pdfData, cmp, origBlocks }) {
  container.textContent = '';
  const narrow = container.clientWidth < 640; // телефон: колонки в столбик (см. style.css)
  const colW = narrow ? Math.max(200, container.clientWidth - 8) : Math.max(240, Math.floor((container.clientWidth - 16) / 2));
  const scale = colW / (PAGE_W_PT * PT_TO_PX);

  // --- статусы блоков для подсветки
  const statusByKey = new Map(cmp.blocks.map((b) => [b.key, b]));

  // --- наши страницы
  const ours = buildPrintPages(current, { assetsBase: '' });
  ours.pages.forEach((page) => {
    page.querySelectorAll('[data-block]').forEach((node) => {
      const st = statusByKey.get(node.dataset.block);
      if (!st) return;
      if (st.status === 'changed') node.classList.add('cmp-hl-changed');
      else if (st.status === 'only-ours') node.classList.add('cmp-hl-only');
    });
  });

  // --- страницы оригинала (pdf.js)
  let pdf = null;
  let pdfError = null;
  if (pdfData) {
    try {
      pdf = await pdfjsLib.getDocument({ data: new Uint8Array(pdfData.slice(0)) }).promise;
    } catch (err) {
      pdfError = err.message;
    }
  }
  const origCount = pdf ? pdf.numPages : 0;
  const n = Math.max(ours.pages.length, origCount);

  const head = el('div', { className: 'cmp-vis-head' });
  head.appendChild(text('span', `Наша распечатка: ${ours.pages.length} стр.`, { className: 'cmp-col-title' }));
  head.appendChild(text('span', pdf ? `Оригинал (PDF): ${origCount} стр.` : pdfError ? `Оригинал: не удалось открыть PDF (${pdfError})` : 'Оригинал: PDF не загружен', { className: 'cmp-col-title' }));
  container.appendChild(head);

  for (let i = 0; i < n; i += 1) {
    const pageNo = i + 1;
    const row = el('div', { className: 'cmp-vis-row' });

    // слева
    const left = el('div', { className: 'cmp-vis-col' });
    left.appendChild(text('div', `Страница ${pageNo} — у нас`, { className: 'cmp-vis-label' }));
    if (ours.pages[i]) left.appendChild(a4Frame(ours.pages[i], scale));
    else left.appendChild(el('div', { className: 'cmp-a4 cmp-a4-empty', style: { width: `${colW}px`, height: `${PAGE_H_PT * PT_TO_PX * scale}px` } }, [text('div', 'у нас такой страницы нет', { className: 'cmp-missing-block' })]));
    row.appendChild(left);

    // справа
    const right = el('div', { className: 'cmp-vis-col' });
    right.appendChild(text('div', `Страница ${pageNo} — оригинал`, { className: 'cmp-vis-label' }));
    if (pdf && pageNo <= origCount) {
      const page = await pdf.getPage(pageNo);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (colW / page.view[2]) * dpr });
      const canvas = el('canvas', { className: 'cmp-canvas' });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${colW}px`;
      canvas.style.height = `${colW * (page.view[3] / page.view[2])}px`;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const frame = el('div', { className: 'cmp-a4 cmp-a4-orig', style: { width: `${colW}px`, height: canvas.style.height } });
      frame.appendChild(canvas);
      // подсветка блоков оригинала по координатам из PDF
      const pxPerPt = colW / page.view[2];
      origBlocks
        .filter((b) => b.page === pageNo && b.y != null)
        .forEach((b) => {
          const st = statusByKey.get(b.key);
          if (!st || st.status === 'same') return;
          const top = b.y * pxPerPt;
          const bottom = origBlockBottom(b, origBlocks) * pxPerPt;
          const box = el('div', {
            className: `cmp-orig-box ${st.status === 'only-orig' ? 'cmp-orig-box-only' : 'cmp-orig-box-changed'}`,
            style: { top: `${top - 3 * pxPerPt}px`, height: `${Math.max(12, bottom - top - 8 * pxPerPt)}px`, left: `${CONTENT_LEFT_PT * pxPerPt - 3}px`, right: `${9 * (72 / 25.4) * pxPerPt - 3}px` },
          });
          box.title = st.status === 'only-orig' ? 'Этого блока у нас нет' : 'Блок отличается';
          frame.appendChild(box);
        });
      right.appendChild(frame);
    } else {
      right.appendChild(el('div', { className: 'cmp-a4 cmp-a4-empty', style: { width: `${colW}px`, height: `${PAGE_H_PT * PT_TO_PX * scale}px` } }, [text('div', pdf ? 'в оригинале такой страницы нет' : 'PDF не загружен', { className: 'cmp-missing-block' })]));
    }
    row.appendChild(right);
    container.appendChild(row);
  }
}
