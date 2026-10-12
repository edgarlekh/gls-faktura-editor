// src/compare.js
// Вкладка «Сравнение с оригиналом»: слева — наша фактура (текущая, со всеми
// правками) в том виде, в каком она УЙДЁТ НА ПЕЧАТЬ, справа — оригинал
// (снимок фактуры сразу после загрузки PDF, тот же порядок блоков, что в
// самом PDF). Обе стороны строятся ОДНИМ и тем же print-model.js, поэтому
// «одинаково здесь» = «одинаково на бумаге»: порядок блоков, под-таблицы,
// строки, суммы RAZEM и номер страницы (наш — из print-layout.js, оригинала —
// дословно из PDF).
//
// Подсветка: зелёное — совпадает; жёлтое — значение отличается (видны оба);
// красное — блок/строка есть только с одной стороны. Чистая часть
// (diffModels) не трогает DOM и покрыта тестами (test/compare.test.js).

import { formatPLN, formatInt } from './format.js';
import { buildPrintModel, USLUGI_TABLE_LABELS } from './print-model.js';
import { paginate } from './print-layout.js';
import { VIRTUAL_VEHICLE_ID } from './model.js';

// ---------------------------------------------------------------------------
// чистая часть

const TABLE_TITLES = {
  pickup: 'Odbiór',
  tiers: 'Doręczenie',
  ooh: 'OOH',
  surcharges: USLUGI_TABLE_LABELS.surcharges,
  bonusMalus: USLUGI_TABLE_LABELS.bonusMalus,
  extra: USLUGI_TABLE_LABELS.extra,
  wyn: 'Wynagrodzenie ogółem',
  fees: 'Opłaty',
};

const BLOCK_TITLES = {
  'overall-pickup': 'Łączny przegląd — Odbiór',
  'overall-delivery': 'Łączny przegląd — Doręczenie',
  pickup: 'Odbiór',
  delivery: 'Doręczenie',
  ooh: 'OOH',
  uslugi: 'Usługi pojazdów',
  wynagrodzenie: 'Wynagrodzenie ogółem',
  oplaty: 'Opłaty',
};

function rowEq(a, b) {
  return a.name === b.name && a.qty === b.qty && a.unitPrice === b.unitPrice && a.value === b.value && (a.vehicle || '') === (b.vehicle || '') && (a.opis || '') === (b.opis || '');
}

// Тиры/pickup/Wynagrodzenie — позиционные таблицы: строка i слева ↔ строка i
// справа (переименованный порог — «отличается», а не «нет/нет»). Остальные —
// по названию строки.
const POSITIONAL = new Set(['pickup', 'tiers', 'wyn']);

/** Строки двух таблиц: по позиции (тиры) или по совпадению названия, остаток — только с одной стороны. */
function diffRows(oursRows, origRows, kind) {
  const out = [];
  if (POSITIONAL.has(kind)) {
    const n = Math.max(oursRows.length, origRows.length);
    for (let i = 0; i < n; i += 1) {
      const r = oursRows[i];
      const o = origRows[i];
      if (r && o) out.push({ status: rowEq(r, o) ? 'same' : 'changed', ours: r, orig: o });
      else if (r) out.push({ status: 'only-ours', ours: r, orig: null });
      else out.push({ status: 'only-orig', ours: null, orig: o });
    }
    return out;
  }
  const usedOrig = new Set();
  oursRows.forEach((r) => {
    let j = -1;
    for (let k = 0; k < origRows.length; k += 1) {
      if (!usedOrig.has(k) && origRows[k].name === r.name && (origRows[k].vehicle || '') === (r.vehicle || '')) {
        j = k;
        break;
      }
    }
    if (j === -1) {
      out.push({ status: 'only-ours', ours: r, orig: null });
    } else {
      usedOrig.add(j);
      const o = origRows[j];
      out.push({ status: rowEq(r, o) ? 'same' : 'changed', ours: r, orig: o });
    }
  });
  // строки, которых у нас больше нет — на месте их позиции в оригинале
  origRows.forEach((o, k) => {
    if (usedOrig.has(k)) return;
    // вставляем после последней уже сопоставленной строки оригинала с меньшим индексом
    let at = out.length;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      const idx = out[i].orig ? origRows.indexOf(out[i].orig) : -1;
      if (idx !== -1 && idx < k) {
        at = i + 1;
        break;
      }
      if (i === 0) at = 0;
    }
    out.splice(at, 0, { status: 'only-orig', ours: null, orig: o });
  });
  return out;
}

function diffTables(oursTables, origTables) {
  const out = [];
  const usedOrig = new Set();
  oursTables.forEach((t) => {
    const j = origTables.findIndex((o, k) => !usedOrig.has(k) && o.kind === t.kind);
    if (j === -1) {
      out.push({ kind: t.kind, status: 'only-ours', ours: t, orig: null, rows: t.rows.map((r) => ({ status: 'only-ours', ours: r, orig: null })), razemSame: false });
      return;
    }
    usedOrig.add(j);
    const o = origTables[j];
    const rows = diffRows(t.rows, o.rows, t.kind);
    const razemSame = t.razemValue === o.razemValue && (t.razemQty ?? null) === (o.razemQty ?? null);
    const same = razemSame && rows.every((r) => r.status === 'same');
    out.push({ kind: t.kind, status: same ? 'same' : 'changed', ours: t, orig: o, rows, razemSame });
  });
  origTables.forEach((o, k) => {
    if (usedOrig.has(k)) return;
    out.push({ kind: o.kind, status: 'only-orig', ours: null, orig: o, rows: o.rows.map((r) => ({ status: 'only-orig', ours: null, orig: r })), razemSame: false });
  });
  return out;
}

/**
 * @param {object} oursModel — buildPrintModel(текущая фактура)
 * @param {Map<string,number>} oursPages — paginate(oursModel).blockPages
 * @param {object} origModel — buildPrintModel(оригинал)
 * @param {Map<string,number>} origPages — страницы оригинала: block.page из PDF, иначе paginate(origModel)
 */
export function diffModels(oursModel, oursPages, origModel, origPages) {
  const origByKey = new Map(origModel.blocks.map((b) => [b.key, b]));
  const merged = [];
  const matchedOrig = new Set();

  oursModel.blocks.forEach((b) => {
    const o = origByKey.get(b.key) || null;
    if (!o) {
      merged.push({ key: b.key, kind: b.kind, vehicle: b.vehicle, status: 'only-ours', ours: b, orig: null, tables: diffTables(b.tables, []), ourPage: oursPages.get(b.key) ?? null, origPage: null, pageSame: false });
      return;
    }
    matchedOrig.add(b.key);
    const tables = diffTables(b.tables, o.tables);
    const ourPage = oursPages.get(b.key) ?? null;
    const origPage = origPages.get(b.key) ?? null;
    const pageSame = ourPage !== null && origPage !== null && ourPage === origPage;
    const same = tables.every((t) => t.status === 'same');
    merged.push({ key: b.key, kind: b.kind, vehicle: b.vehicle, status: same ? 'same' : 'changed', ours: b, orig: o, tables, ourPage, origPage, pageSame });
  });

  // блоки, которые есть только в оригинале — на своё место (после предыдущего блока оригинала)
  origModel.blocks.forEach((o, k) => {
    if (matchedOrig.has(o.key)) return;
    let at = 0;
    for (let i = k - 1; i >= 0; i -= 1) {
      const idx = merged.findIndex((m) => m.key === origModel.blocks[i].key);
      if (idx !== -1) {
        at = idx + 1;
        break;
      }
    }
    merged.splice(at, 0, { key: o.key, kind: o.kind, vehicle: o.vehicle, status: 'only-orig', ours: null, orig: o, tables: diffTables([], o.tables), ourPage: null, origPage: origPages.get(o.key) ?? null, pageSame: false });
  });

  // порядок: совпадает ли последовательность общих блоков
  const oursKeys = oursModel.blocks.map((b) => b.key).filter((k) => origByKey.has(k));
  const origKeys = origModel.blocks.map((b) => b.key).filter((k) => oursModel.blocks.some((b) => b.key === k));
  const orderSame = oursKeys.length === origKeys.length && oursKeys.every((k, i) => k === origKeys[i]);

  const count = (st) => merged.filter((m) => m.status === st).length;
  const ourPageCount = Math.max(0, ...[...oursPages.values()]);
  const origPageCount = Math.max(0, ...[...origPages.values()]);
  const pagesSame = merged.every((m) => m.status !== 'same' || m.pageSame);
  return {
    blocks: merged,
    orderSame,
    summary: {
      total: merged.length,
      same: count('same'),
      changed: count('changed'),
      onlyOurs: count('only-ours'),
      onlyOrig: count('only-orig'),
      ourPages: ourPageCount,
      origPages: origPageCount,
      pagesSame,
      identical: orderSame && count('changed') === 0 && count('only-ours') === 0 && count('only-orig') === 0,
    },
  };
}

/** Страницы оригинала: дословно из PDF (block.page), а если их нет (фикстура) — наша же раскладка. */
export function origPageMap(origModel) {
  const fromPdf = new Map();
  origModel.blocks.forEach((b) => {
    if (b.page != null) fromPdf.set(b.key, b.page);
  });
  if (fromPdf.size === origModel.blocks.length) return { pages: fromPdf, fromPdf: true };
  return { pages: paginate(origModel).blockPages, fromPdf: false };
}

export function buildComparison(current, original) {
  const oursModel = buildPrintModel(current);
  const origModel = buildPrintModel(original);
  const oursPages = paginate(oursModel).blockPages;
  const orig = origPageMap(origModel);
  const diff = diffModels(oursModel, oursPages, origModel, orig.pages);
  return { ...diff, origPagesFromPdf: orig.fromPdf };
}

// ---------------------------------------------------------------------------
// DOM

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'className') node.className = v;
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

let onlyDiffs = false; // сессионное состояние переключателя «только различия»

function vehicleLabel(id) {
  if (id == null) return '';
  return id === VIRTUAL_VEHICLE_ID ? 'Pojazd (без номера)' : `Pojazd ${id}`;
}

function blockTitle(b) {
  const base = BLOCK_TITLES[b.kind] || b.kind;
  return b.vehicle != null ? `${base} — ${vehicleLabel(b.vehicle)}` : base;
}

const STATUS_TEXT = {
  same: 'совпадает',
  changed: 'отличается',
  'only-ours': 'только у нас',
  'only-orig': 'только в оригинале',
};

function moneyCell(v, cls) {
  return text('td', v == null ? '' : formatPLN(v), { className: cls || '' });
}
function intCell(v, cls) {
  return text('td', v == null ? '' : formatInt(v), { className: cls || '' });
}

/** Одна таблица одной стороны (ours|orig) с подсветкой по статусу строк. */
function renderSideTable(t, side) {
  const tbl = t[side];
  const wrap = el('div', { className: `cmp-table cmp-${t.status}` });
  const title = text('div', TABLE_TITLES[t.kind] || t.kind, { className: 'cmp-table-title' });
  if (!tbl) {
    title.classList.add('cmp-missing');
    title.textContent += side === 'ours' ? ' — у нас нет' : ' — в оригинале нет';
    wrap.appendChild(title);
    return wrap;
  }
  wrap.appendChild(title);
  const table = el('table');
  const thead = el('thead');
  const htr = el('tr');
  const isFees = t.kind === 'fees';
  const isWyn = t.kind === 'wyn';
  (isFees ? ['Materiał', 'Nr pojazdu', 'Opis', 'Ilość', 'Cena', 'Wartość'] : isWyn ? ['', 'Ilość', 'Wartość'] : ['Nazwa', 'Ilość', 'Cena', 'Wartość']).forEach((h) => htr.appendChild(text('th', h)));
  thead.appendChild(htr);
  table.appendChild(thead);
  const tbody = el('tbody');
  t.rows.forEach((r) => {
    const row = r[side];
    const other = side === 'ours' ? r.orig : r.ours;
    const tr = el('tr', { className: `cmp-row-${r.status}` });
    if (!row) {
      // строки нет с этой стороны — пустая строка-заглушка той же высоты
      tr.appendChild(text('td', side === 'ours' ? '— нет у нас —' : '— нет в оригинале —', { className: 'cmp-gap', colspan: String(isFees ? 6 : isWyn ? 3 : 4) }));
      tbody.appendChild(tr);
      return;
    }
    const diffCls = (field) => (r.status === 'changed' && other && other[field] !== row[field] ? 'cmp-cell-diff' : '');
    tr.appendChild(text('td', row.name, { className: diffCls('name') }));
    if (isFees) {
      tr.appendChild(text('td', row.vehicle || '', { className: diffCls('vehicle') }));
      tr.appendChild(text('td', row.opis || '', { className: diffCls('opis') }));
    }
    tr.appendChild(intCell(row.qty, diffCls('qty')));
    if (!isWyn) tr.appendChild(moneyCell(row.unitPrice, diffCls('unitPrice')));
    tr.appendChild(moneyCell(row.value, diffCls('value')));
    tbody.appendChild(tr);
  });
  const rtr = el('tr', { className: `razem-row ${t.razemSame ? '' : 'cmp-razem-diff'}` });
  rtr.appendChild(text('td', `${tbl.razemLabel || ''} RAZEM:`.trim(), { colspan: String(isFees ? 4 : isWyn ? 1 : 2) }));
  if (!isWyn) rtr.appendChild(text('td', tbl.razemQty != null ? formatInt(tbl.razemQty) : ''));
  else rtr.appendChild(text('td', ''));
  rtr.appendChild(moneyCell(tbl.razemValue));
  tbody.appendChild(rtr);
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderBlockPair(b, origPagesFromPdf) {
  const pair = el('div', { className: `cmp-pair cmp-${b.status}` });

  const head = el('div', { className: 'cmp-pair-head' });
  head.appendChild(text('span', blockTitle(b.ours || b.orig), { className: 'cmp-pair-title' }));
  head.appendChild(text('span', STATUS_TEXT[b.status], { className: `cmp-badge cmp-badge-${b.status}` }));
  const pageInfo = el('span', { className: `cmp-pages ${b.ourPage != null && b.origPage != null && !b.pageSame ? 'cmp-pages-diff' : ''}` });
  const ourP = b.ourPage != null ? `стр. ${b.ourPage}` : '—';
  const origP = b.origPage != null ? `стр. ${b.origPage}` : '—';
  pageInfo.textContent = `страница: у нас ${ourP} · в оригинале ${origP}${origPagesFromPdf ? '' : ' (расчётная)'}`;
  head.appendChild(pageInfo);
  pair.appendChild(head);

  const cols = el('div', { className: 'cmp-cols' });
  const left = el('div', { className: 'cmp-col cmp-col-ours' });
  const right = el('div', { className: 'cmp-col cmp-col-orig' });
  b.tables.forEach((t) => {
    left.appendChild(renderSideTable(t, 'ours'));
    right.appendChild(renderSideTable(t, 'orig'));
  });
  if (!b.ours) left.appendChild(text('div', 'Этого блока у нас нет — на печать не пойдёт.', { className: 'cmp-missing-block' }));
  if (!b.orig) right.appendChild(text('div', 'В оригинале такого блока нет.', { className: 'cmp-missing-block' }));
  cols.appendChild(left);
  cols.appendChild(right);
  pair.appendChild(cols);
  return pair;
}

/**
 * @param {HTMLElement} container — #compare
 * @param {{current:object, original:object, printed:object|null, fileName:string|null}} state — getInvoiceState()
 */
export function renderCompareTab(container, state) {
  container.textContent = '';
  const { current, original, fileName } = state;
  const cmp = buildComparison(current, original);
  const s = cmp.summary;

  const header = el('div', { className: 'cmp-header' });
  header.appendChild(text('h2', 'Сравнение с оригиналом'));
  header.appendChild(
    text(
      'p',
      fileName
        ? `Слева — наша фактура (как уйдёт на печать), справа — оригинал ${fileName} (порядок блоков и страницы — дословно из PDF).`
        : 'PDF не загружен: справа — исходная демо-фактура, слева — она же с вашими правками. Загрузите PDF на вкладке «Редактор фактуры», чтобы сравнивать с настоящим оригиналом.',
      { className: 'cmp-hint' }
    )
  );
  container.appendChild(header);

  const sum = el('div', { className: `cmp-summary ${s.identical ? 'cmp-summary-ok' : 'cmp-summary-diff'}` });
  sum.appendChild(
    text('div', s.identical ? '✓ Структура и все суммы идентичны оригиналу.' : '✗ Есть отличия от оригинала — см. подсвеченные блоки ниже.', { className: 'cmp-summary-title' })
  );
  const facts = el('ul', { className: 'cmp-facts' });
  facts.appendChild(text('li', `Блоков: ${s.total} — совпадают ${s.same}, отличаются ${s.changed}, только у нас ${s.onlyOurs}, только в оригинале ${s.onlyOrig}.`));
  facts.appendChild(text('li', `Порядок блоков: ${cmp.orderSame ? 'как в оригинале' : 'ОТЛИЧАЕТСЯ от оригинала'}.`));
  facts.appendChild(
    text('li', `Страниц: у нас ${s.ourPages}, в оригинале ${s.origPages}${cmp.origPagesFromPdf ? '' : ' (расчётно)'}; разбиение по страницам ${s.pagesSame ? 'совпадает' : 'отличается'}.`)
  );
  const razemOurs = current.summary.wynagrodzenie.razem;
  const razemOrig = original.summary.wynagrodzenie.razem;
  facts.appendChild(text('li', `RAZEM (Wynagrodzenie ogółem): у нас ${formatPLN(razemOurs)}, в оригинале ${formatPLN(razemOrig)}${razemOurs === razemOrig ? ' — совпадает' : ` — разница ${formatPLN(razemOurs - razemOrig)}`}.`));
  sum.appendChild(facts);
  container.appendChild(sum);

  const tools = el('div', { className: 'cmp-tools' });
  const legend = el('div', { className: 'cmp-legend' });
  [
    ['same', 'совпадает'],
    ['changed', 'отличается'],
    ['only-ours', 'только у нас'],
    ['only-orig', 'только в оригинале'],
  ].forEach(([st, label]) => legend.appendChild(text('span', label, { className: `cmp-badge cmp-badge-${st}` })));
  tools.appendChild(legend);
  const toggle = el('label', { className: 'cmp-toggle' });
  const cb = el('input', { type: 'checkbox' });
  cb.checked = onlyDiffs;
  cb.addEventListener('change', () => {
    onlyDiffs = cb.checked;
    renderCompareTab(container, state);
  });
  toggle.appendChild(cb);
  toggle.appendChild(document.createTextNode(' показывать только различия'));
  tools.appendChild(toggle);
  container.appendChild(tools);

  // --- постраничное визуальное сравнение (наши страницы ↔ страницы PDF)
  const vis = el('section', { className: 'cmp-visual' });
  vis.appendChild(text('h3', 'Постранично: наша распечатка ↔ оригинал', { className: 'cmp-section-title' }));
  vis.appendChild(
    text('p', 'Слева — страницы нашей распечатки (ровно то, что уйдёт на печать), справа — страницы загруженного PDF. Жёлтая рамка — блок отличается, красная — блока нет на другой стороне.', {
      className: 'cmp-hint',
    })
  );
  const visBody = el('div', { className: 'cmp-visual-body' });
  visBody.appendChild(text('p', 'Рисую страницы…', { className: 'cmp-hint' }));
  vis.appendChild(visBody);
  container.appendChild(vis);
  const origBlocks = buildPrintModel(original).blocks;
  import('./compare-visual.js')
    .then((mod) => mod.renderVisualPages(visBody, { current, pdfData: state.pdfData || null, cmp, origBlocks }))
    .catch((err) => {
      visBody.textContent = '';
      visBody.appendChild(text('p', `Не удалось нарисовать страницы: ${err.message}`, { className: 'cmp-missing-block' }));
    });

  container.appendChild(text('h3', 'Подробно по блокам', { className: 'cmp-section-title' }));
  const colsHead = el('div', { className: 'cmp-cols cmp-cols-head' });
  colsHead.appendChild(text('div', 'НАША ФАКТУРА (печать)', { className: 'cmp-col-title' }));
  colsHead.appendChild(text('div', 'ОРИГИНАЛ (PDF)', { className: 'cmp-col-title' }));
  container.appendChild(colsHead);

  const list = el('div', { className: 'cmp-list' });
  const visible = cmp.blocks.filter((b) => !onlyDiffs || b.status !== 'same' || !b.pageSame);
  if (!visible.length) list.appendChild(text('p', 'Различий нет.', { className: 'cmp-hint' }));
  visible.forEach((b) => list.appendChild(renderBlockPair(b, cmp.origPagesFromPdf)));
  container.appendChild(list);
}
