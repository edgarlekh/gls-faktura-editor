// src/print-render.js
// DOM-рендер страниц распечатки из print-model.js + print-layout.js. Общий
// для print.html (src/print.js) и вкладки «Сравнение» (src/compare.js —
// там наши страницы показываются рядом со страницами оригинального PDF).
// Никаких измерений DOM: каждый элемент раскладки — абсолютно
// позиционированный div с top/height в pt. На уровне модуля DOM не
// трогается (импортируется и в Node-тестах через compare.js).
//
// Горизонтальная геометрия (ширины колонок, координаты шапки, позиции
// подписей в плашках) — из PyMuPDF-разбора образца 10082026.pdf.

import { formatPLN, formatInt } from './format.js';
import { VIRTUAL_VEHICLE_ID } from './model.js';
import { buildPrintModel } from './print-model.js';
import { paginate, TOP_PT, PAGE_H_PT, FOOTER_Y_PT, TEXT_OFFSET } from './print-layout.js';

// Ширины колонок (мм), сумма = 176мм = ширина содержательной области A4
// (210 − 25 левое − 9 правое), см. разбор образца.
const STD_WIDTHS_MM = [70, 20, 26, 30, 30]; // Nazwa | (RAZEM:) | Ilość | Cena | Wartość
// Materiał 36мм: образец набран MyriadPro (уже Arial) — в Arial "NP_WORKING_STK_EVO"
// и заголовок "Numer pojazdu" не влезали в 32/20мм оригинала; Opis и Cena/Wartość
// чуть уже (сумма 176мм неизменна).
const FEES_WIDTHS_MM = [36, 22, 56, 16, 23, 23]; // Materiał | Nr pojazdu | Opis | Ilość | Cena | Wartość
const WYN_WIDTHS_MM = [85, 45, 46]; // label | Paczki (ilość) | Wynagrodzenie - razem

// Координаты шапки документа (pt), относительно левого/верхнего края
// содержательной области (т.е. уже за вычетом полей 25мм/10мм).
const HEADER = {
  logo: { left: 385.5, top: 0, width: 108.5, height: 36.9 },
  line1: { top: 1.9 },
  druk: { left: 201.2 },
  drukVal: { left: 279.4 },
  nazwa: { top: 19.2 },
  nrdost: { top: 53.3 },
  nrkontr: { top: 70.3 },
  valueCol: { left: 73.7 },
};

/** Высота .page (печатная область под полями @page 10mm/…/2.5mm), pt. */
export const PAGE_BOX_H_PT = PAGE_H_PT - TOP_PT - 8.5;

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
const pt = (v) => `${v}pt`;
const gridCols = (widthsMm) => widthsMm.map((w) => `${w}mm`).join(' ');

// ---------- шапка документа (только на первой странице) ----------

function buildDocHeader(h, assetsBase) {
  const header = el('div', { className: 'doc-header' });
  header.appendChild(
    el('img', {
      className: 'logo',
      src: `${assetsBase}assets/gls-logo.jpeg`,
      alt: 'GLS',
      style: { left: pt(HEADER.logo.left), top: pt(HEADER.logo.top), width: pt(HEADER.logo.width), height: pt(HEADER.logo.height) },
    })
  );
  // Только "Specyfikacja miesięczna" / "Data wydruku" — bold (MyriadPro-Bold в образце).
  header.appendChild(text('div', `Specyfikacja miesięczna ${h.period}`, { className: 'f f-bold', style: { left: '2.8pt', top: pt(HEADER.line1.top) } }));
  header.appendChild(text('div', 'Data wydruku', { className: 'f f-bold', style: { left: pt(HEADER.druk.left), top: pt(HEADER.line1.top) } }));
  header.appendChild(text('div', h.printDate, { className: 'f f-bold', style: { left: pt(HEADER.drukVal.left), top: pt(HEADER.line1.top) } }));
  const fields = [
    ['Nazwa dostawcy', h.supplierName, HEADER.nazwa.top],
    ['Nr dostawcy', h.supplierNo, HEADER.nrdost.top],
    ['Nr kontraktu', h.contractNo, HEADER.nrkontr.top],
  ];
  // Многострочное значение (Nazwa dostawcy в 325.pdf) — строки с шагом 17pt, Nr dostawcy не сдвигается.
  const HEADER_LINE_PITCH_PT = 17;
  fields.forEach(([label, value, top]) => {
    header.appendChild(text('div', label, { className: 'f', style: { left: '2.8pt', top: pt(top) } }));
    String(value ?? '')
      .split('\n')
      .forEach((line, i) => {
        header.appendChild(text('div', line, { className: 'f', style: { left: pt(HEADER.valueCol.left), top: pt(top + i * HEADER_LINE_PITCH_PT) } }));
      });
  });
  return header;
}

// ---------- плашки-заголовки ----------

function barNode(bar) {
  if (bar.type === 'lg') return text('div', bar.text, { className: 'bar-lg' });
  const node = el('div', { className: 'bar-sm' });
  if (bar.variant === 'group') {
    node.appendChild(text('span', 'Grupa pojazdów', { style: { left: '2.8pt' } }));
    node.appendChild(text('span', bar.code, { style: { left: '107.7pt' } }));
  } else if (bar.variant === 'vehicleGroup') {
    node.appendChild(text('span', 'Pojazd', { style: { left: '2.8pt' } }));
    node.appendChild(text('span', bar.id, { style: { left: '67.3pt' } }));
    node.appendChild(text('span', 'Grupa pojazdów', { style: { left: '130.4pt' } }));
    node.appendChild(text('span', bar.code, { style: { left: '235.2pt' } }));
  } else {
    // VIRTUAL_VEHICLE_ID → общий блок "Pojazd" БЕЗ номера, как в PDF
    node.appendChild(text('span', 'Pojazd', { style: { left: '2.8pt' } }));
    node.appendChild(text('span', bar.id === VIRTUAL_VEHICLE_ID ? '' : bar.id, { style: { left: '67.3pt' } }));
  }
  return node;
}

// ---------- строки таблиц (CSS grid, высота задаётся раскладкой) ----------

function cell(content, cls = '') {
  return text('div', content ?? '', { className: `c ${cls}`.trim() });
}
function rowNode(className, widthsMm, cells) {
  const node = el('div', { className: `trow ${className}`, style: { gridTemplateColumns: gridCols(widthsMm) } });
  cells.forEach((c) => node.appendChild(c));
  return node;
}

function theadNode(table) {
  if (table.kind === 'fees') {
    return rowNode('thead', FEES_WIDTHS_MM, [cell('Materiał', 'c-left'), cell('Numer pojazdu', 'c-left'), cell('Opis', 'c-left'), cell('Ilość'), cell(table.cenaHeader), cell('Wartość (PLN)')]);
  }
  if (table.kind === 'wyn') {
    return rowNode('thead thead-wyn', WYN_WIDTHS_MM, [cell('Wynagrodzenie ogółem (PLN)', 'c-left c-title'), cell('Paczki (ilość)'), cell('Wynagrodzenie - razem')]);
  }
  return rowNode('thead', STD_WIDTHS_MM, [cell(table.nameHeader, 'c-left c-span2'), cell('Ilość'), cell(table.cenaHeader), cell('Wartość (PLN)')]);
}

function dataRowNode(table, r) {
  if (table.kind === 'fees') {
    return rowNode('data', FEES_WIDTHS_MM, [cell(r.name, 'c-left c-materiał'), cell(r.vehicle || '', 'c-left'), cell(r.opis || '', 'c-left'), cell(formatInt(r.qty)), cell(formatPLN(r.unitPrice)), cell(formatPLN(r.value))]);
  }
  if (table.kind === 'wyn') {
    return rowNode('data data-wyn', WYN_WIDTHS_MM, [cell(r.name, 'c-left c-bold'), cell(r.qty != null ? formatInt(r.qty) : ''), cell(formatPLN(r.value))]);
  }
  return rowNode('data', STD_WIDTHS_MM, [cell(r.name, 'c-left c-span2'), cell(formatInt(r.qty)), cell(formatPLN(r.unitPrice)), cell(formatPLN(r.value))]);
}

function razemNode(table) {
  if (table.kind === 'fees') {
    return rowNode('razem', FEES_WIDTHS_MM, [cell('', 'c-left'), cell('', 'c-left'), cell('RAZEM:', 'c-left'), cell(''), cell(''), cell(formatPLN(table.razemValue))]);
  }
  if (table.kind === 'wyn') {
    return rowNode('razem', WYN_WIDTHS_MM, [cell('RAZEM:', 'c-left'), cell(''), cell(formatPLN(table.razemValue))]);
  }
  return rowNode('razem', STD_WIDTHS_MM, [cell(table.razemLabel || '', 'c-left'), cell('RAZEM:', 'c-left'), cell(table.razemQty != null ? formatInt(table.razemQty) : ''), cell(''), cell(formatPLN(table.razemValue))]);
}

function itemNode(item, header, assetsBase) {
  if (item.type === 'docHeader') return buildDocHeader(header, assetsBase);
  if (item.type === 'bar') return barNode(item.bar);
  const kind = item.table.kind;
  let node;
  let offset;
  if (item.type === 'thead') {
    node = theadNode(item.table);
    offset = TEXT_OFFSET.thead[kind] ?? TEXT_OFFSET.thead.default;
  } else if (item.type === 'row') {
    node = dataRowNode(item.table, item.row);
    offset = TEXT_OFFSET.row[kind] ?? TEXT_OFFSET.row.default;
  } else {
    node = razemNode(item.table);
    offset = TEXT_OFFSET.razem[kind] ?? TEXT_OFFSET.razem.default;
  }
  node.style.paddingTop = pt(offset);
  return node;
}

/**
 * Строит страницы распечатки.
 * @param {object} invoice — уже после recalc().
 * @param {{assetsBase?: string}} opts — префикс пути к assets/ (print.html лежит в корне → '').
 * @returns {{ pages: HTMLElement[], model: object, layout: {pages: object[], blockPages: Map<string, number>} }}
 *   Каждый элемент страницы несёт data-block = key блока (для подсветки во вкладке сравнения).
 */
export function buildPrintPages(invoice, { assetsBase = '' } = {}) {
  const model = buildPrintModel(invoice);
  const layout = paginate(model);
  const pages = layout.pages.map((pg, i) => {
    const page = el('div', { className: 'page', style: { height: pt(PAGE_BOX_H_PT) } });
    pg.items.forEach((item) => {
      const node = itemNode(item, model.header, assetsBase);
      node.style.top = pt(item.y - TOP_PT);
      node.style.height = pt(item.h);
      node.classList.add('abs');
      if (item.block) node.dataset.block = item.block.key;
      page.appendChild(node);
    });
    const footer = text('div', `Strona ${i + 1} z ${layout.pages.length}`, { className: 'page-footer' });
    footer.style.top = pt(FOOTER_Y_PT - TOP_PT);
    page.appendChild(footer);
    return page;
  });
  return { pages, model, layout };
}
