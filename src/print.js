// src/print.js
// Печатный шаблон (Этап 4) — отдельная страница print.html. НЕ трогает редактор
// (src/app.js) и не модифицирует model.js/recalc.js: читает invoice, прогоняет
// recalc() и рисует документ, визуально повторяющий оригинал GLS.
//
// Что здесь, а что нет:
//  - ЧТО печатать и В КАКОМ ПОРЯДКЕ — src/print-model.js (чистая модель:
//    блоки/таблицы/строки, порядок дословно из PDF через invoice.layout);
//  - ГДЕ на каких страницах — src/print-layout.js (чистая пагинация «как у
//    GLS», координаты в pt, снятые с оригиналов);
//  - здесь — только DOM: каждый элемент раскладки ставится АБСОЛЮТНО по своим
//    координатам (top/height в pt). Браузер ничего не измеряет и ничего не
//    переносит сам, поэтому раскладка на экране, в page.pdf() и в реальной
//    печати Ctrl+P одна и та же, а состав страниц совпадает с оригиналом
//    (проверено на четырёх фактурах: 7/8/11/11 страниц, одинаковая
//    последовательность плашек и RAZEM на каждой странице).
//
// Горизонтальная геометрия (ширины колонок, координаты шапки документа,
// позиции подписей в плашках) — из PyMuPDF-разбора образца 10082026.pdf,
// см. комментарии у констант.

import { recalc } from './recalc.js';
import { formatPLN, formatInt } from './format.js';
import { buildSampleInvoice } from './fixtures/sample-invoice.js';
import { VIRTUAL_VEHICLE_ID } from './model.js';
import { buildPrintModel } from './print-model.js';
import { paginate, TOP_PT, PAGE_H_PT, FOOTER_Y_PT, TEXT_OFFSET } from './print-layout.js';

// src/app.js кладёт текущий (отредактированный) invoice сюда перед каждым
// своим render() — тот же ключ, см. app.js/PRINT_STORAGE_KEY. Это единственный
// мост между редактором и печатью (отдельные страницы, отдельные module-графы).
// Если ключа нет (печать открыта напрямую, без редактора) — фикстура, как раньше.
const PRINT_STORAGE_KEY = 'gls-print-invoice';

function loadInvoice() {
  try {
    const raw = sessionStorage.getItem(PRINT_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // испорченные данные в sessionStorage — молча откатываемся на фикстуру
  }
  return buildSampleInvoice();
}

const invoice = recalc(loadInvoice());

// Ширины колонок (мм), сумма = 176мм = ширина содержательной области A4
// (210 − 25 левое − 9 правое), см. разбор образца.
const STD_WIDTHS_MM = [70, 20, 26, 30, 30]; // Nazwa | (RAZEM:) | Ilość | Cena | Wartość
// Materiał 36мм: образец набран MyriadPro (уже Arial) — в Arial "NP_WORKING_STK_EVO"
// и заголовок "Numer pojazdu" не влезали в 32/20мм оригинала; Opis и Cena/Wartość
// чуть уже (сумма 176мм неизменна).
const FEES_WIDTHS_MM = [36, 22, 56, 16, 23, 23]; // Materiał | Nr pojazdu | Opis | Ilość | Cena | Wartość
const WYN_WIDTHS_MM = [85, 45, 46]; // label | Paczki (ilość) | Wynagrodzenie - razem

// Координаты шапки документа (pt), относительно левого/верхнего края
// содержательной области (т.е. уже за вычетом полей 25мм/10мм) — взяты
// из PyMuPDF-разбора страницы 1 образца.
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

// ---------- маленькие DOM-хелперы ----------

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

function buildDocHeader(h) {
  const header = el('div', { className: 'doc-header' });
  const img = el('img', {
    className: 'logo',
    src: 'assets/gls-logo.jpeg',
    alt: 'GLS',
    style: {
      left: pt(HEADER.logo.left),
      top: pt(HEADER.logo.top),
      width: pt(HEADER.logo.width),
      height: pt(HEADER.logo.height),
    },
  });
  header.appendChild(img);

  // Только "Specyfikacja miesięczna" / "Data wydruku" — bold (MyriadPro-Bold в образце);
  // "Nazwa dostawcy" / "Nr dostawcy" / "Nr kontraktu" (label и value) — обычным начертанием.
  header.appendChild(text('div', `Specyfikacja miesięczna ${h.period}`, { className: 'f f-bold', style: { left: '2.8pt', top: pt(HEADER.line1.top) } }));
  header.appendChild(text('div', 'Data wydruku', { className: 'f f-bold', style: { left: pt(HEADER.druk.left), top: pt(HEADER.line1.top) } }));
  header.appendChild(text('div', h.printDate, { className: 'f f-bold', style: { left: pt(HEADER.drukVal.left), top: pt(HEADER.line1.top) } }));

  const fields = [
    ['Nazwa dostawcy', h.supplierName, HEADER.nazwa.top],
    ['Nr dostawcy', h.supplierNo, HEADER.nrdost.top],
    ['Nr kontraktu', h.contractNo, HEADER.nrkontr.top],
  ];
  // Многострочное значение (Nazwa dostawcy в 325.pdf переносится на вторую
  // строку) — каждая строка отдельным абсолютным div с шагом 17pt (по
  // образцу: 47.5pt → 64.5pt); Nr dostawcy при этом НЕ сдвигается.
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
    // id === VIRTUAL_VEHICLE_ID → общий блок "Pojazd" БЕЗ номера, как в PDF
    // (см. 092026.pdf стр. 4, 325.pdf стр. 6): подпись "Pojazd" есть, номера нет.
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
    return rowNode('thead', FEES_WIDTHS_MM, [
      cell('Materiał', 'c-left'),
      cell('Numer pojazdu', 'c-left'),
      cell('Opis', 'c-left'),
      cell('Ilość'),
      cell(table.cenaHeader),
      cell('Wartość (PLN)'),
    ]);
  }
  if (table.kind === 'wyn') {
    return rowNode('thead thead-wyn', WYN_WIDTHS_MM, [
      cell('Wynagrodzenie ogółem (PLN)', 'c-left c-title'),
      cell('Paczki (ilość)'),
      cell('Wynagrodzenie - razem'),
    ]);
  }
  return rowNode('thead', STD_WIDTHS_MM, [cell(table.nameHeader, 'c-left c-span2'), cell('Ilość'), cell(table.cenaHeader), cell('Wartość (PLN)')]);
}

function dataRowNode(table, r) {
  if (table.kind === 'fees') {
    return rowNode('data', FEES_WIDTHS_MM, [
      cell(r.name, 'c-left c-materiał'),
      cell(r.vehicle || '', 'c-left'),
      cell(r.opis || '', 'c-left'),
      cell(formatInt(r.qty)),
      cell(formatPLN(r.unitPrice)),
      cell(formatPLN(r.value)),
    ]);
  }
  if (table.kind === 'wyn') {
    return rowNode('data data-wyn', WYN_WIDTHS_MM, [cell(r.name, 'c-left c-bold'), cell(r.qty != null ? formatInt(r.qty) : ''), cell(formatPLN(r.value))]);
  }
  return rowNode('data', STD_WIDTHS_MM, [cell(r.name, 'c-left c-span2'), cell(formatInt(r.qty)), cell(formatPLN(r.unitPrice)), cell(formatPLN(r.value))]);
}

// Только верхняя (тёмно-синяя) и нижняя грань на всю ширину строки + левая/
// правая на контуре — как в образце; внутренних разделителей колонок нет.
function razemNode(table) {
  if (table.kind === 'fees') {
    return rowNode('razem', FEES_WIDTHS_MM, [cell('', 'c-left'), cell('', 'c-left'), cell('RAZEM:', 'c-left'), cell(''), cell(''), cell(formatPLN(table.razemValue))]);
  }
  if (table.kind === 'wyn') {
    return rowNode('razem', WYN_WIDTHS_MM, [cell('RAZEM:', 'c-left'), cell(''), cell(formatPLN(table.razemValue))]);
  }
  return rowNode('razem', STD_WIDTHS_MM, [
    cell(table.razemLabel || '', 'c-left'),
    cell('RAZEM:', 'c-left'),
    cell(table.razemQty != null ? formatInt(table.razemQty) : ''),
    cell(''),
    cell(formatPLN(table.razemValue)),
  ]);
}

function itemNode(item) {
  if (item.type === 'docHeader') return buildDocHeader(invoice.header);
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

// ---------- сборка документа: страницы фиксированной высоты, элементы абсолютно ----------

function buildDocument() {
  const sheet = document.getElementById('sheet');
  sheet.textContent = '';
  const model = buildPrintModel(invoice);
  const { pages } = paginate(model);

  pages.forEach((pg, i) => {
    const page = el('div', { className: 'page' });
    pg.items.forEach((item) => {
      const node = itemNode(item);
      node.style.top = pt(item.y - TOP_PT);
      node.style.height = pt(item.h);
      node.classList.add('abs');
      page.appendChild(node);
    });
    const footer = text('div', `Strona ${i + 1} z ${pages.length}`, { className: 'page-footer' });
    footer.style.top = pt(FOOTER_Y_PT - TOP_PT);
    page.appendChild(footer);
    sheet.appendChild(page);
  });
  // высота .page = печатная область под полями @page (см. print.css): 841.89 − 28.35 − 8.5
  document.documentElement.style.setProperty('--page-h', pt(PAGE_H_PT - TOP_PT - 8.5));
}

// ---------- запуск ----------

// На узком экране (телефон) предпросмотр масштабируем ЦЕЛИКОМ через
// transform; на печать не влияет (@media print в print.css сбрасывает).
function fitSheetToViewport() {
  const sheet = document.getElementById('sheet');
  const wrap = document.getElementById('sheet-wrap');
  if (!sheet || !wrap) return;
  sheet.style.transform = '';
  const sheetW = sheet.offsetWidth;
  const avail = document.documentElement.clientWidth - 16;
  const scale = sheetW > avail ? avail / sheetW : 1;
  if (scale < 1) {
    sheet.style.transform = `scale(${scale})`;
    sheet.style.transformOrigin = 'top left';
    sheet.style.marginLeft = '8px';
    wrap.style.height = `${sheet.offsetHeight * scale}px`;
  } else {
    sheet.style.marginLeft = '';
    wrap.style.height = '';
  }
}

async function init() {
  if (document.fonts && document.fonts.ready) {
    try {
      await document.fonts.ready;
    } catch {
      /* ignore */
    }
  }
  buildDocument();
  fitSheetToViewport();
}

window.addEventListener('load', init);
window.addEventListener('resize', fitSheetToViewport);

const btn = document.getElementById('btnPrint');
if (btn) btn.addEventListener('click', () => window.print());
