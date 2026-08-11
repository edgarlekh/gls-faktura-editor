// src/print.js
// Печатный шаблон Этапа 4 — отдельный модуль вывода. НЕ трогает редактор
// (src/app.js) и не модифицирует model.js/recalc.js: только читает готовую
// модель (fixtures/sample-invoice.js) через recalc() и рендерит её в разметку,
// визуально повторяющую образец 10082026.pdf (координаты, цвета, шрифты и
// сетка колонок — из PyMuPDF-разбора образца).
//
// ПАГИНАЦИЯ. Мы сами режем контент на страницы, а не полагаемся на то, как
// браузер порвёт длинный поток при печати — так надёжнее (заголовки/футеры,
// оставленные "в потоке" на волю браузера, на реальной печати могут уехать
// от своих таблиц). Каждая физическая страница — отдельный <div class="page">
// ФИКСИРОВАННОЙ высоты (= содержательная высота A4), с принудительным
// разрывом перед каждой следующей. Внутри — обычный flex-column; футер
// "Strona X z Y" — последний ребёнок с margin-top:auto, поэтому он всегда
// прибит к низу страницы, независимо от того, сколько на ней реального
// контента (полная/неполная страница — без разницы). См. createPaginator().
//
// Блоки бывают двух видов:
//  - атомарные (сводки/pickup/delivery/Wynagrodzenie/Opłaty) — никогда не
//    бьются: не влезает целиком — переносится целиком (placeAtomicBlock);
//  - с "бьющимися" таблицами (OOH; Usługi pojazdów = 3 таблицы под одной
//    шапкой) — таблица может разбиться по страницам, но шапка колонок
//    печатается заново на каждом фрагменте, а плашки блока никогда не
//    остаются в одиночестве без первой строки своей таблицы (placeSplitBlock).

import { recalc } from './recalc.js';
import { formatPLN, formatInt } from './format.js';
import { buildSampleInvoice } from './fixtures/sample-invoice.js';

const invoice = recalc(buildSampleInvoice());

// Косметические коды "Grupa pojazdów" из образца — SAP-номер контракта/группы,
// в нашей модели такого поля нет (это не бизнес-данные, а ярлык источника),
// поэтому держим их как константы разметки, а не трогаем model.js.
const GROUP_004 = '5000000215/000004';
const GROUP_010 = '5000000215/000010';
const TIER_LABELS = ['Poniżej 3500', '3500-4800', 'Ponad 4800'];

// "Numer pojazdu"/"Opis" для Opłaty — та же косметика источника, дословно из
// образца. Ключ — fee.name (код "Materiał"). NP_REINV_COLL обрезан в самом
// образце (не наша ошибка — проверено на растре страницы).
const FEES_INFO = {
  NP_ADD_SUBC: { vehicle: '', opis: 'Wynagrodzenie zgodnie z par.5 ust.10 um.' },
  NP_ELOADING: { vehicle: '', opis: 'Ładowanie pojazdu elektrycznego' },
  NP_PNLT_KU_BRO: { vehicle: '1240', opis: 'Brak real. odb. od Klienta/Szybka' },
  NP_REINV_COLL: { vehicle: '1203', opis: 'Refaktura- zwiększone koszty odbi' },
  NP_REINV_DEL: { vehicle: '', opis: 'Refaktura- zwiększone koszty doręczeń' },
  NP_RENTAL_SCAN: { vehicle: '', opis: 'Najem skanerów' },
};

// Ширины колонок (мм), сумма = 176мм = ширина содержательной области A4
// (210 − 25 левое − 9 правое), см. разбор образца.
const STD_WIDTHS_MM = [70, 20, 26, 30, 30]; // Nazwa | (RAZEM:) | Ilość | Cena | Wartość
const FEES_WIDTHS_MM = [30, 20, 60, 16, 25, 25]; // Materiał | Nr pojazdu | Opis | Ilość | Cena | Wartość
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
function colgroup(widthsMm) {
  const cg = el('colgroup');
  widthsMm.forEach((w) => cg.appendChild(el('col', { style: { width: `${w}mm` } })));
  return cg;
}

// ---------- шапка документа (только на первой странице) ----------

function buildDocHeader(h) {
  const header = el('div', { className: 'doc-header' });
  const img = el('img', {
    className: 'logo',
    src: 'assets/gls-logo.jpeg',
    alt: 'GLS',
    style: {
      left: `${HEADER.logo.left}pt`,
      top: `${HEADER.logo.top}pt`,
      width: `${HEADER.logo.width}pt`,
      height: `${HEADER.logo.height}pt`,
    },
  });
  header.appendChild(img);

  // Только "Specyfikacja miesięczna" / "Data wydruku" — bold (MyriadPro-Bold в образце);
  // "Nazwa dostawcy" / "Nr dostawcy" / "Nr kontraktu" (label и value) — обычным начертанием.
  const line1 = el('div', { className: 'f f-bold', style: { left: '2.8pt', top: `${HEADER.line1.top}pt` } });
  line1.textContent = `Specyfikacja miesięczna ${h.period}`;
  header.appendChild(line1);

  const druk = el('div', { className: 'f f-bold', style: { left: `${HEADER.druk.left}pt`, top: `${HEADER.line1.top}pt` } });
  druk.textContent = 'Data wydruku';
  header.appendChild(druk);
  const drukVal = el('div', { className: 'f f-bold', style: { left: `${HEADER.drukVal.left}pt`, top: `${HEADER.line1.top}pt` } });
  drukVal.textContent = h.printDate;
  header.appendChild(drukVal);

  const fields = [
    ['Nazwa dostawcy', h.supplierName, HEADER.nazwa.top],
    ['Nr dostawcy', h.supplierNo, HEADER.nrdost.top],
    ['Nr kontraktu', h.contractNo, HEADER.nrkontr.top],
  ];
  fields.forEach(([label, value, top]) => {
    header.appendChild(el('div', { className: 'f', style: { left: '2.8pt', top: `${top}pt` } }, [document.createTextNode(label)]));
    const val = el('div', { className: 'f', style: { left: `${HEADER.valueCol.left}pt`, top: `${top}pt` } });
    val.textContent = value;
    header.appendChild(val);
  });

  return header;
}

// ---------- плашки-заголовки ----------

function barLg(text_) {
  return text('div', text_, { className: 'bar-lg' });
}

/** subBar: варианты, повторяющие "Grupa pojazdów NNN", "Pojazd NNN Grupa pojazdów NNN", "Pojazd NNN" */
function subBarGroup(code) {
  const bar = el('div', { className: 'bar-sm' });
  bar.appendChild(text('span', 'Grupa pojazdów', { style: { left: '2.8pt' } }));
  bar.appendChild(text('span', code, { style: { left: '107.7pt' } }));
  return bar;
}
function subBarVehicleGroup(id, code) {
  const bar = el('div', { className: 'bar-sm' });
  bar.appendChild(text('span', 'Pojazd', { style: { left: '2.8pt' } }));
  bar.appendChild(text('span', id, { style: { left: '67.3pt' } }));
  bar.appendChild(text('span', 'Grupa pojazdów', { style: { left: '130.4pt' } }));
  bar.appendChild(text('span', code, { style: { left: '235.2pt' } }));
  return bar;
}
function subBarVehicle(id) {
  const bar = el('div', { className: 'bar-sm' });
  bar.appendChild(text('span', 'Pojazd', { style: { left: '2.8pt' } }));
  bar.appendChild(text('span', id, { style: { left: '67.3pt' } }));
  return bar;
}

// ---------- стандартная таблица (Nazwa/Ilość/Cena/Wartość) -----------------
// Поддерживает частичный рендер по строкам (rowsSlice/includeHeader/
// includeRazem) — на этом основана "бьющаяся" таблица: при переносе на новую
// страницу шапка колонок печатается заново (includeHeader=true у каждого
// фрагмента), RAZEM — только у последнего.

function dataTableFragment({ nameHeader, rowsSlice, includeHeader = true, razemLabel, razemQty = null, razemValue, includeRazem = true }) {
  const table = el('table', { className: 'tbl' });
  table.appendChild(colgroup(STD_WIDTHS_MM));

  if (includeHeader) {
    const thead = el('thead');
    const htr = el('tr');
    htr.appendChild(text('th', nameHeader, { className: 'c-left', colspan: '2' }));
    htr.appendChild(text('th', 'Ilość'));
    htr.appendChild(text('th', 'Cena jedn. (PLN)'));
    htr.appendChild(text('th', 'Wartość (PLN)'));
    thead.appendChild(htr);
    table.appendChild(thead);
  }

  const tbody = el('tbody');
  rowsSlice.forEach((r) => {
    const tr = el('tr');
    tr.appendChild(text('td', r.name, { className: 'c-left', colspan: '2' }));
    tr.appendChild(text('td', formatInt(r.qty)));
    tr.appendChild(text('td', formatPLN(r.unitPrice)));
    tr.appendChild(text('td', formatPLN(r.value)));
    tbody.appendChild(tr);
  });

  if (includeRazem) {
    const rtr = el('tr', { className: 'razem-row' });
    rtr.appendChild(text('td', razemLabel || '', { className: 'c-left' }));
    rtr.appendChild(text('td', 'RAZEM:', { className: 'c-left' }));
    rtr.appendChild(text('td', razemQty != null ? formatInt(razemQty) : ''));
    rtr.appendChild(text('td', ''));
    rtr.appendChild(text('td', formatPLN(razemValue)));
    tbody.appendChild(rtr);
  }

  table.appendChild(tbody);
  return table;
}

// ---------- Opłaty: 6-колоночная таблица (атомарная, целиком) --------------

function feesTable(fees, razemValue) {
  const table = el('table', { className: 'tbl-fees' });
  table.appendChild(colgroup(FEES_WIDTHS_MM));

  const thead = el('thead');
  const htr = el('tr');
  ['Materiał', 'Numer pojazdu', 'Opis', 'Ilość', 'Cena jedn. (PLN)', 'Wartość (PLN)'].forEach((h, i) => {
    htr.appendChild(text('th', h, { className: i < 3 ? 'c-left' : '' }));
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = el('tbody');
  fees.forEach((f) => {
    const info = FEES_INFO[f.name] || { vehicle: '', opis: '' };
    const tr = el('tr');
    tr.appendChild(text('td', f.name, { className: 'c-left' }));
    tr.appendChild(text('td', info.vehicle, { className: 'c-left' }));
    tr.appendChild(text('td', info.opis, { className: 'c-left' }));
    tr.appendChild(text('td', formatInt(f.qty)));
    tr.appendChild(text('td', formatPLN(f.unitPrice)));
    tr.appendChild(text('td', formatPLN(f.value)));
    tbody.appendChild(tr);
  });

  const rtr = el('tr', { className: 'razem-row' });
  rtr.appendChild(text('td', '', { className: 'c-left' }));
  rtr.appendChild(text('td', '', { className: 'c-left' }));
  rtr.appendChild(text('td', 'RAZEM:', { className: 'c-left' }));
  rtr.appendChild(text('td', ''));
  rtr.appendChild(text('td', ''));
  rtr.appendChild(text('td', formatPLN(razemValue)));
  tbody.appendChild(rtr);

  table.appendChild(tbody);
  return table;
}

// ---------- Wynagrodzenie ogółem: шапка-плашка (свой thead) + 6 строк + RAZEM

function wynagrodzenieTable(summary) {
  const w = summary.wynagrodzenie;
  const rows = [
    ['Doręczenie (za paczkę)', summary.group000010.razemQty, w.doreczenie],
    ['Odbiór (za paczkę)', summary.group000004.qty, w.odbior],
    ['Usługi', null, w.uslugi],
    ['Bonus/Malus', null, w.bonusMalus],
    ['Dodatkowe pozycje', null, w.dodatkowePozycje],
    ['OOH', null, w.ooh],
  ];

  const table = el('table', { className: 'tbl-wyn' });
  table.appendChild(colgroup(WYN_WIDTHS_MM));

  const thead = el('thead');
  const htr = el('tr');
  htr.appendChild(text('th', 'Wynagrodzenie ogółem (PLN)'));
  htr.appendChild(text('th', 'Paczki (ilość)'));
  htr.appendChild(text('th', 'Wynagrodzenie - razem'));
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = el('tbody');
  rows.forEach(([label, qty, val]) => {
    const tr = el('tr');
    tr.appendChild(text('td', label, { className: 'c-left' }));
    tr.appendChild(text('td', qty != null ? formatInt(qty) : ''));
    tr.appendChild(text('td', formatPLN(val)));
    tbody.appendChild(tr);
  });

  const rtr = el('tr', { className: 'razem-row' });
  rtr.appendChild(text('td', 'RAZEM:', { className: 'c-left' }));
  rtr.appendChild(text('td', ''));
  rtr.appendChild(text('td', formatPLN(w.razem)));
  tbody.appendChild(rtr);

  table.appendChild(tbody);
  return table;
}

// Блок с пустыми/нулевыми данными в образце не печатается вообще (напр. у
// 1299 нет ни pickup (000004), ни Bonus/Malus) — а не рисуется с нулями.
function isEmptyRows(rows) {
  return !rows || rows.length === 0;
}

// =====================================================================
// Пагинация: страницы фиксированной высоты + сборка блоков.
// =====================================================================

const MM_TO_PX = 96 / 25.4;
const PT_TO_PX = 96 / 72;
const PAGE_CONTENT_H_MM = 279; // 297 − 10(верх) − 8(низ) — должно совпадать с @page в print.css
const PAGE_CONTENT_H_PX = PAGE_CONTENT_H_MM * MM_TO_PX;
const GAP_PT = 14; // отступ перед новым блоком/встроенной таблицей — но НЕ в начале страницы (см. разбор образца)
const GAP_PX = GAP_PT * PT_TO_PX;
const DOC_HEADER_H_PX = 90 * PT_TO_PX; // .doc-header { height: 90pt } в print.css

/** Измеряет реальные (отрендеренные) высоты "строительных" элементов —
 *  плашек и строк таблиц — через скрытый зонд-контейнер той же ширины, что
 *  и страница. Высота строки таблицы не зависит от содержимого (везде
 *  white-space:nowrap + text-overflow:ellipsis — одна строка текста) и не
 *  зависит от colspan/числа реальных ячеек (высота задаётся padding+line-
 *  height класса, не структурой строки) — поэтому достаточно измерить по
 *  одной универсальной строке каждого вида на класс таблицы.
 *
 *  ВАЖНО: зонд обязан быть потомком #sheet, а не document.body — иначе он не
 *  наследует font-size:8pt/line-height:1.15, заданные на #sheet, и измеряет
 *  высоты по чуть другой (браузерной дефолтной) метрике шрифта. Разница
 *  меньше 1px на элемент, но накапливается за ~20 элементов на странице до
 *  заметного переполнения (см. разбор в чате) — оттуда и берётся #sheet. */
function measure() {
  const sheet = document.getElementById('sheet');
  const probe = el('div', {
    style: { position: 'absolute', visibility: 'hidden', left: '-99999px', top: '0', width: '176mm' },
  });
  sheet.appendChild(probe);

  function rowHeights(className, widthsMm) {
    const table = el('table', { className });
    table.appendChild(colgroup(widthsMm));
    const thead = el('thead');
    const htr = el('tr');
    widthsMm.forEach(() => htr.appendChild(text('th', 'X')));
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el('tbody');
    const dtr = el('tr');
    widthsMm.forEach(() => dtr.appendChild(text('td', 'X')));
    tbody.appendChild(dtr);
    const rtr = el('tr', { className: 'razem-row' });
    widthsMm.forEach(() => rtr.appendChild(text('td', 'X')));
    tbody.appendChild(rtr);
    table.appendChild(tbody);
    probe.appendChild(table);
    const heights = {
      head: htr.getBoundingClientRect().height,
      data: dtr.getBoundingClientRect().height,
      razem: rtr.getBoundingClientRect().height,
    };
    probe.removeChild(table);
    return heights;
  }

  function nodeHeight(node) {
    probe.appendChild(node);
    const h = node.getBoundingClientRect().height;
    probe.removeChild(node);
    return h;
  }

  const m = {
    barLg: nodeHeight(barLg('X')),
    barSm: nodeHeight(subBarVehicle('0000')),
    footer: nodeHeight(text('div', 'X', { className: 'page-footer' })),
    tbl: rowHeights('tbl', STD_WIDTHS_MM),
    tblFees: rowHeights('tbl-fees', FEES_WIDTHS_MM),
    tblWyn: rowHeights('tbl-wyn', WYN_WIDTHS_MM),
  };

  sheet.removeChild(probe);
  return m;
}

/** Раскладчик по страницам фиксированной высоты (см. .page в print.css).
 *  place(node, height, gapIfNotFirst) кладёт узел на текущую страницу; если
 *  это НЕ первый элемент на странице — добавляет отступ gapIfNotFirst через
 *  margin-top прямо на узле (в начале страницы отступа нет — она начинается
 *  вплотную сверху). Футер вставляется в каждую страницу сразу при её
 *  создании как последний ребёнок (margin-top:auto в CSS прижимает его к
 *  низу) — все дальнейшие place() вставляются ПЕРЕД ним через insertBefore,
 *  так что он гарантированно остаётся последним. */
function createPaginator(sheet, footerReservePx) {
  const pages = [];
  let page;
  let footerEl;
  let remaining;
  let isFirstOnPage;

  function newPage() {
    page = el('div', { className: 'page' });
    footerEl = text('div', '', { className: 'page-footer' });
    page.appendChild(footerEl);
    sheet.appendChild(page);
    pages.push(footerEl);
    remaining = PAGE_CONTENT_H_PX - footerReservePx;
    isFirstOnPage = true;
  }
  newPage();

  function place(node, height, gapIfNotFirst = 0) {
    const gap = !isFirstOnPage && gapIfNotFirst ? gapIfNotFirst : 0;
    if (gap) node.style.marginTop = `${gap}px`;
    page.insertBefore(node, footerEl);
    remaining -= height + gap;
    isFirstOnPage = false;
  }

  /** Гарантирует, что unit (+ отступ, если useGap и мы не в начале страницы)
   *  поместится в остаток текущей страницы — иначе начинает новую. */
  function ensure(coreHeight, useGap) {
    const gap = useGap && !isFirstOnPage ? GAP_PX : 0;
    if (coreHeight + gap > remaining) newPage();
  }

  function finish() {
    pages.forEach((footer, i) => {
      footer.textContent = `Strona ${i + 1} z ${pages.length}`;
    });
  }

  return {
    place,
    ensure,
    newPage,
    finish,
    get remaining() { return remaining; },
    get isFirstOnPage() { return isFirstOnPage; },
  };
}

/** Атомарный блок ("плашки" + одна цельная таблица) — никогда не бьётся:
 *  не влезает целиком в остаток страницы → переносится целиком на новую.
 *  Используется для сводок/pickup/delivery/Wynagrodzenie/Opłaty. */
function placeAtomicBlock(pg, bars, tableNode, tableH) {
  const barsH = bars.reduce((s, b) => s + b.h, 0);
  pg.ensure(barsH + tableH, true);
  bars.forEach((b, i) => pg.place(b.node, b.h, i === 0 ? GAP_PX : 0));
  pg.place(tableNode, tableH, bars.length === 0 ? GAP_PX : 0);
}

/** Длинная таблица, которая МОЖЕТ разбиваться по страницам (OOH, Usługi
 *  (Dopłaty), Bonus/Malus, Dodatkowe pozycje). На каждом фрагменте шапка
 *  колонок печатается заново; RAZEM — только у последнего фрагмента и
 *  всегда приклеен к последней строке (не остаётся один на новой странице).
 *  leadingGap — отступ перед ПЕРВЫМ фрагментом этой конкретной таблицы (0 —
 *  если сразу после плашек своего блока; GAP_PX — если это следующая
 *  встроенная таблица внутри того же блока, как в Usługi pojazdów). */
function placeSplittableTable(pg, buildFragment, rows, rowH, headH, razemH, leadingGap) {
  let idx = 0;
  let first = true;
  while (idx < rows.length) {
    const gap = first && !pg.isFirstOnPage ? leadingGap : 0;
    let avail = pg.remaining - headH - gap;
    let count = 0;
    while (idx + count < rows.length) {
      const isLast = idx + count === rows.length - 1;
      const need = rowH + (isLast ? razemH : 0);
      if (need > avail) break;
      avail -= rowH;
      count += 1;
    }
    if (count === 0) {
      // даже шапка + 1 строка не влезают в остаток — начинаем новую страницу
      // (на свежей странице места всегда достаточно, зацикливания не будет)
      pg.newPage();
      first = true;
      continue;
    }
    const chunkRows = rows.slice(idx, idx + count);
    const includeRazem = idx + count === rows.length;
    const chunkH = headH + count * rowH + (includeRazem ? razemH : 0);
    pg.place(buildFragment(chunkRows, includeRazem), chunkH, first ? leadingGap : 0);
    idx += count;
    first = false;
  }
}

/** Блок с плашками + одной или несколькими "бьющимися" таблицами. Плашки
 *  гарантированно не остаются в одиночестве без начала своей таблицы: если
 *  "плашки + шапка колонок + первая строка первой непустой таблицы" не
 *  влезают в остаток страницы — этот узел целиком переносится на следующую. */
function placeSplitBlock(pg, bars, tables) {
  const firstTable = tables.find((t) => t.rows.length > 0);
  if (!firstTable) return; // все таблицы блока пусты — блок целиком пропускаем

  const barsH = bars.reduce((s, b) => s + b.h, 0);
  const singleRow = firstTable.rows.length === 1;
  const glueUnit = barsH + firstTable.headH + firstTable.rowH + (singleRow ? firstTable.razemH : 0);
  pg.ensure(glueUnit, true);
  bars.forEach((b, i) => pg.place(b.node, b.h, i === 0 ? GAP_PX : 0));

  let placedAny = false;
  tables.forEach((t) => {
    if (t.rows.length === 0) return;
    placeSplittableTable(pg, t.buildFragment, t.rows, t.rowH, t.headH, t.razemH, placedAny ? GAP_PX : 0);
    placedAny = true;
  });
}

// ---------- сборка документа: порядок блоков — как в образце ----------
// сначала общие сводки (000004, 000010), потом по каждой машине pickup,
// потом delivery, потом OOH, потом Usługi pojazdów (3 бьющиеся таблицы под
// одной шапкой), затем Wynagrodzenie ogółem, затем Opłaty последним блоком.

function buildDocument(m) {
  const sheet = document.getElementById('sheet');
  sheet.textContent = '';
  const pg = createPaginator(sheet, m.footer);

  pg.place(buildDocHeader(invoice.header), DOC_HEADER_H_PX, 0);

  const g4 = invoice.summary.group000004;
  const g10 = invoice.summary.group000010;
  const pickupRate = invoice.vehicles[0].pickup.rate;
  const tierRates = invoice.vehicles[0].delivery.tiers.map((t) => t.rate);

  placeAtomicBlock(
    pg,
    [
      { node: barLg('Łączny przegląd dla wszystkich grup pojazdów (za paczkę)'), h: m.barLg },
      { node: subBarGroup(GROUP_004), h: m.barSm },
    ],
    dataTableFragment({
      nameHeader: 'Paczki',
      rowsSlice: [{ name: 'Ponad 0', qty: g4.qty, unitPrice: pickupRate, value: g4.value }],
      razemLabel: 'Odbiór, za paczkę',
      razemQty: g4.qty,
      razemValue: g4.value,
    }),
    m.tbl.head + m.tbl.data + m.tbl.razem
  );

  placeAtomicBlock(
    pg,
    [
      { node: barLg('Łączny przegląd dla wszystkich grup pojazdów (za paczkę)'), h: m.barLg },
      { node: subBarGroup(GROUP_010), h: m.barSm },
    ],
    dataTableFragment({
      nameHeader: 'Paczki',
      rowsSlice: TIER_LABELS.map((label, i) => ({ name: label, qty: g10.tiers[i].qty, unitPrice: tierRates[i], value: g10.tiers[i].value })),
      razemLabel: 'Doręczenie, za paczkę',
      razemQty: g10.razemQty,
      razemValue: g10.razemValue,
    }),
    m.tbl.head + 3 * m.tbl.data + m.tbl.razem
  );

  invoice.vehicles.forEach((v) => {
    if (v.pickup.qty === 0 && v.pickup.value === 0) return; // напр. 1299 — нет odbioru
    placeAtomicBlock(
      pg,
      [
        { node: barLg('Pojazdy z grupy pojazdów (za paczkę)'), h: m.barLg },
        { node: subBarVehicleGroup(v.id, GROUP_004), h: m.barSm },
      ],
      dataTableFragment({
        nameHeader: 'Paczki',
        rowsSlice: [{ name: v.pickup.label, qty: v.pickup.qty, unitPrice: v.pickup.rate, value: v.pickup.value }],
        razemLabel: 'Odbiór, za paczkę',
        razemQty: v.pickup.qty,
        razemValue: v.pickup.value,
      }),
      m.tbl.head + m.tbl.data + m.tbl.razem
    );
  });

  invoice.vehicles.forEach((v) => {
    placeAtomicBlock(
      pg,
      [
        { node: barLg('Pojazdy z grupy pojazdów (za paczkę)'), h: m.barLg },
        { node: subBarVehicleGroup(v.id, GROUP_010), h: m.barSm },
      ],
      dataTableFragment({
        nameHeader: 'Paczki',
        rowsSlice: v.delivery.tiers.map((t) => ({ name: t.label, qty: t.qty, unitPrice: t.rate, value: t.value })),
        razemLabel: 'Doręczenie, za paczkę',
        razemQty: v.delivery.razemQty,
        razemValue: v.delivery.razemValue,
      }),
      m.tbl.head + 3 * m.tbl.data + m.tbl.razem
    );
  });

  invoice.vehicles.forEach((v) => {
    if (isEmptyRows(v.ooh)) return;
    placeSplitBlock(pg, [{ node: barLg('OOH'), h: m.barLg }, { node: subBarVehicle(v.id), h: m.barSm }], [
      {
        rows: v.ooh,
        rowH: m.tbl.data,
        headH: m.tbl.head,
        razemH: m.tbl.razem,
        buildFragment: (rowsSlice, includeRazem) =>
          dataTableFragment({ nameHeader: 'Nazwa usługi', rowsSlice, razemLabel: '', razemValue: v.oohRazem, includeRazem }),
      },
    ]);
  });

  invoice.vehicles.forEach((v) => {
    // В Usługi pojazdów строка колонок без подписи "Nazwa usługi" (первая
    // колонка без заголовка) — в отличие от OOH, как в образце.
    const tables = [
      { rows: v.surcharges, razemLabel: 'Usługi (Dopłaty)', razemValue: v.surchargesRazem },
      { rows: v.bonusMalus, razemLabel: 'Bonus/Malus', razemValue: v.bonusMalusRazem },
      { rows: v.extra, razemLabel: 'Dodatkowe pozycje', razemValue: v.extraRazem },
    ].map((t) => ({
      rows: t.rows,
      rowH: m.tbl.data,
      headH: m.tbl.head,
      razemH: m.tbl.razem,
      buildFragment: (rowsSlice, includeRazem) =>
        dataTableFragment({ nameHeader: '', rowsSlice, razemLabel: t.razemLabel, razemValue: t.razemValue, includeRazem }),
    }));
    if (tables.every((t) => t.rows.length === 0)) return; // все три блока пустые — весь юнит пропускаем
    placeSplitBlock(pg, [{ node: barLg('Usługi pojazdów'), h: m.barLg }, { node: subBarVehicle(v.id), h: m.barSm }], tables);
  });

  placeAtomicBlock(pg, [], wynagrodzenieTable(invoice.summary), m.tblWyn.head + 6 * m.tblWyn.data + m.tblWyn.razem);

  placeAtomicBlock(
    pg,
    [{ node: barLg('Opłaty'), h: m.barLg }],
    feesTable(invoice.fees, invoice.summary.oplaty.razem),
    m.tblFees.head + invoice.fees.length * m.tblFees.data + m.tblFees.razem
  );

  pg.finish();
}

// ---------- запуск ----------

async function init() {
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch { /* ignore */ }
  }
  const m = measure();
  buildDocument(m);
}

window.addEventListener('load', init);

const btn = document.getElementById('btnPrint');
if (btn) btn.addEventListener('click', () => window.print());
