// src/salary.js
// Этап 2.5: экран "Расчёт зарплат курьеров" — DOM-слой поверх чистой логики
// src/salary-calc.js. Отдельная вкладка (см. src/main.js), не трогает
// фактуру/PDF-вывод: только читает invoice (current/original), полученную из
// src/app.js через getInvoiceState().
//
// Состояние экрана:
//  - процент выплаты и имя курьера по id скрута — переживают перезагрузку
//    страницы (localStorage), т.к. это данные о курьере, а не о фактуре;
//  - объединение скрутов в курьера ("группы") — только на время сессии, не
//    сохраняется (по ТЗ: "разовое, только для текущего расчёта"), хранится
//    в module-level переменной и переживает только повторные render() внутри
//    одной загрузки страницы.

import { formatPLN } from './format.js';
import { buildCourierRows, compareCourierRows } from './salary-calc.js';

const LS_PERCENT_PREFIX = 'gls-salary-percent-';
const LS_NAME_PREFIX = 'gls-salary-name-';

// стартовые проценты для машин образца 10082026.pdf — используются только
// как дефолт, если в localStorage для этого id ещё ничего не сохранено
const DEFAULT_PERCENTS = { 1203: 50, 1210: 80, 1220: 80, 1240: 50, 1299: 50 };
const FALLBACK_PERCENT = 50;

// сессионное состояние: объединения скрутов и текущий выбор чекбоксов
let groups = []; // [{ id, memberIds: [vehicleId...], percentSourceId }]
let checkedIds = new Set();
let groupSeq = 0;

function getPercent(id) {
  const raw = localStorage.getItem(LS_PERCENT_PREFIX + id);
  if (raw !== null) {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return n;
  }
  return DEFAULT_PERCENTS[id] ?? FALLBACK_PERCENT;
}

function setPercent(id, percent) {
  localStorage.setItem(LS_PERCENT_PREFIX + id, String(percent));
}

function getName(id) {
  return localStorage.getItem(LS_NAME_PREFIX + id) || '';
}

function setName(id, name) {
  if (name) localStorage.setItem(LS_NAME_PREFIX + id, name);
  else localStorage.removeItem(LS_NAME_PREFIX + id);
}

function percentMapFor(vehicleIds) {
  return new Map(vehicleIds.map((id) => [id, getPercent(id)]));
}

function courierLabel(memberIds) {
  const names = memberIds.map((id) => getName(id)).filter(Boolean);
  const idsPart = `скрут${memberIds.length > 1 ? 'ы' : ''} ${memberIds.join('+')}`;
  return names.length ? `${names[0]} (${idsPart})` : idsPart;
}

// --- маленькие DOM-хелперы (свои, как в app.js/print.js — модуль не делится DOM-кодом) ---

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

function moneyClass(value) {
  return value < 0 ? 'sal-neg' : '';
}

const ROW_LABELS = {
  doreczenie: 'Doręczenie',
  odbior: 'Odbiór',
  uslugi: 'Usługi',
  bonusMalus: 'Bonus/Malus',
  dodatkowe: 'Dodatkowe pozycje',
  ooh: 'OOH',
};

function renderBreakdown(breakdown) {
  const table = el('table', { className: 'sal-breakdown' });
  const tbody = el('tbody');
  Object.entries(ROW_LABELS).forEach(([key, label]) => {
    const tr = el('tr');
    tr.appendChild(text('td', label));
    tr.appendChild(text('td', formatPLN(breakdown[key]), { className: moneyClass(breakdown[key]) }));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

function deltaText(delta) {
  const sign = delta > 0 ? '+' : '';
  return `${sign}${formatPLN(delta)}`;
}

/** Одна карточка курьера/скрута (compared-row: после + before + delta). */
function renderCourierCard(row, { onMerge, onSplit, onCheck, onPercentSourceChange, onPercentChange, onNameChange }) {
  const card = el('div', { className: `sal-card ${row.merged ? 'sal-merged' : ''}` });

  const headerRow = el('div', { className: 'sal-card-header' });
  if (row.merged) {
    const splitBtn = text('button', '✂ Разъединить', { className: 'sal-split-btn' });
    splitBtn.title = 'Вернуть обратно на отдельные скруты';
    splitBtn.addEventListener('click', () => onSplit(row.groupId));
    headerRow.appendChild(splitBtn);
  } else {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = checkedIds.has(row.memberIds[0]);
    cb.addEventListener('change', () => onCheck(row.memberIds[0], cb.checked));
    headerRow.appendChild(cb);
  }

  headerRow.appendChild(text('span', row.memberIds.join(' + '), { className: 'sal-ids' }));

  const nameInput = el('input', { className: 'sal-name-input' });
  nameInput.placeholder = 'имя курьера';
  nameInput.value = row.merged ? '' : getName(row.memberIds[0]);
  if (!row.merged) {
    nameInput.addEventListener('change', () => onNameChange(row.memberIds[0], nameInput.value.trim()));
    headerRow.appendChild(nameInput);
  }
  card.appendChild(headerRow);

  if (row.merged) {
    const namesLine = row.memberIds
      .map((id) => getName(id))
      .filter(Boolean)
      .join(', ');
    if (namesLine) card.appendChild(text('div', namesLine, { className: 'sal-merged-names' }));
  }

  card.appendChild(renderBreakdown(row.breakdown));

  const totalsRow = el('div', { className: 'sal-totals' });

  const baseLine = el('div', { className: 'sal-base-line' });
  baseLine.appendChild(text('span', 'База: ', { className: 'sal-label' }));
  baseLine.appendChild(text('span', formatPLN(row.base), { className: moneyClass(row.base) }));
  if (row.deltaBase !== 0) {
    baseLine.appendChild(
      text('span', ` (было ${formatPLN(row.before ? row.before.base : 0)}, Δ ${deltaText(row.deltaBase)})`, {
        className: 'sal-delta',
      })
    );
  }
  totalsRow.appendChild(baseLine);

  const percentLine = el('div', { className: 'sal-percent-line' });
  percentLine.appendChild(text('span', '× ', { className: 'sal-label' }));
  const percentInput = el('input', { className: 'sal-percent-input' });
  percentInput.type = 'number';
  percentInput.step = '0.5';
  percentInput.min = '0';
  percentInput.value = String(row.percent);
  percentInput.addEventListener('change', () => {
    const n = parseFloat(String(percentInput.value).replace(',', '.'));
    if (Number.isFinite(n) && n >= 0) onPercentChange(row.percentSourceId, n);
  });
  percentLine.appendChild(percentInput);
  percentLine.appendChild(text('span', ' %', { className: 'sal-label' }));

  if (row.merged) {
    const select = el('select', { className: 'sal-percent-source' });
    row.memberIds.forEach((id) => {
      const opt = text('option', `ставка ${id} (${getPercent(id)}%)`);
      opt.value = id;
      if (id === row.percentSourceId) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => onPercentSourceChange(row.groupId, select.value));
    percentLine.appendChild(select);
  }
  totalsRow.appendChild(percentLine);

  const payoutLine = el('div', { className: 'sal-payout-line' });
  payoutLine.appendChild(text('span', '= К выплате: ', { className: 'sal-label' }));
  payoutLine.appendChild(text('span', formatPLN(row.payout), { className: 'sal-payout' }));
  if (row.deltaPayout !== 0) {
    payoutLine.appendChild(
      text('span', ` (было ${formatPLN(row.before ? row.before.payout : 0)}, Δ ${deltaText(row.deltaPayout)})`, {
        className: 'sal-delta',
      })
    );
  }
  totalsRow.appendChild(payoutLine);

  card.appendChild(totalsRow);

  return card;
}

function buildSummaryText(compared, current, original) {
  const lines = [];
  lines.push(`Расчёт зарплат курьеров — ${current.header.period || 'фактура'}`);
  lines.push('');
  compared.forEach((row) => {
    const label = courierLabel(row.memberIds);
    const deltaPart = row.deltaPayout !== 0 ? `, было ${formatPLN(row.before ? row.before.payout : 0)}, Δ ${deltaText(row.deltaPayout)}` : '';
    lines.push(`${label}: база ${formatPLN(row.base)} zł, ${row.percent}% → к выплате ${formatPLN(row.payout)} zł${deltaPart}`);
  });
  lines.push('');
  const totalBase = compared.reduce((s, r) => s + r.base, 0);
  const totalPayout = compared.reduce((s, r) => s + r.payout, 0);
  lines.push(`Сумма баз: ${formatPLN(totalBase)} zł (RAZEM фактуры: ${formatPLN(current.summary.wynagrodzenie.razem)} zł)`);
  lines.push(`Сумма к выплате: ${formatPLN(totalPayout)} zł`);
  return lines.join('\n');
}

async function copyToClipboard(textValue) {
  try {
    await navigator.clipboard.writeText(textValue);
    return true;
  } catch {
    // запасной путь (например insecure-context/старый браузер)
    const ta = document.createElement('textarea');
    ta.value = textValue;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
}

/**
 * @param {HTMLElement} container
 * @param {{current: object, original: object}} state — invoice ДО и ПОСЛЕ
 *   правок (оба уже прогнаны через recalc(), см. src/app.js).
 */
export function renderSalaryTab(container, state) {
  const { current, original } = state;
  container.textContent = '';

  if (!current || !current.vehicles.length) {
    container.appendChild(text('p', 'Нет данных — сначала загрузите или откройте фактуру во вкладке «Редактор фактуры».', { className: 'sal-empty' }));
    return;
  }

  // групповое состояние может ссылаться на скруты, которых больше нет в
  // текущей фактуре (например после загрузки другого PDF) — подчищаем
  const currentIds = new Set(current.vehicles.map((v) => v.id));
  groups = groups.filter((g) => g.memberIds.every((id) => currentIds.has(id)));
  checkedIds = new Set([...checkedIds].filter((id) => currentIds.has(id)));

  const percentById = percentMapFor(current.vehicles.map((v) => v.id));
  const currentRows = buildCourierRows(current.vehicles, groups, percentById);
  const originalRows = buildCourierRows(original.vehicles, groups, percentById);
  const compared = compareCourierRows(originalRows, currentRows);

  // --- панель управления объединением ---
  const toolbar = el('div', { className: 'sal-toolbar' });
  const mergeBtn = text('button', '🔗 Объединить', { className: 'sal-merge-btn' });
  mergeBtn.disabled = checkedIds.size < 2;
  mergeBtn.addEventListener('click', () => {
    if (checkedIds.size < 2) return;
    groupSeq += 1;
    groups.push({ id: `merged-${groupSeq}`, memberIds: [...checkedIds], percentSourceId: [...checkedIds][0] });
    checkedIds = new Set();
    renderSalaryTab(container, state);
  });
  toolbar.appendChild(mergeBtn);
  toolbar.appendChild(
    text('span', checkedIds.size >= 2 ? `Выбрано скрутов: ${checkedIds.size}` : 'Отметьте ≥2 скрута чекбоксами, чтобы объединить их в одного курьера', {
      className: 'sal-toolbar-hint',
    })
  );

  const copyBtn = text('button', '📋 Скопировать сводку', { className: 'sal-copy-btn' });
  const copyStatus = text('span', '', { className: 'sal-copy-status' });
  copyBtn.addEventListener('click', async () => {
    const ok = await copyToClipboard(buildSummaryText(compared, current, original));
    copyStatus.textContent = ok ? '✓ скопировано' : '✗ не удалось скопировать';
    setTimeout(() => {
      copyStatus.textContent = '';
    }, 2500);
  });
  toolbar.appendChild(copyBtn);
  toolbar.appendChild(copyStatus);

  container.appendChild(toolbar);

  // --- карточки ---
  const grid = el('div', { className: 'sal-grid' });
  compared.forEach((row) => {
    grid.appendChild(
      renderCourierCard(row, {
        onSplit: (groupId) => {
          groups = groups.filter((g) => g.id !== groupId);
          renderSalaryTab(container, state);
        },
        onCheck: (id, checked) => {
          if (checked) checkedIds.add(id);
          else checkedIds.delete(id);
          renderSalaryTab(container, state);
        },
        onPercentSourceChange: (groupId, newSourceId) => {
          const g = groups.find((x) => x.id === groupId);
          if (g) g.percentSourceId = newSourceId;
          renderSalaryTab(container, state);
        },
        onPercentChange: (id, percent) => {
          setPercent(id, percent);
          renderSalaryTab(container, state);
        },
        onNameChange: (id, name) => {
          setName(id, name);
          renderSalaryTab(container, state);
        },
      })
    );
  });
  container.appendChild(grid);

  // --- контрольная строка ---
  const totalBase = compared.reduce((s, r) => s + r.base, 0);
  const razem = current.summary.wynagrodzenie.razem;
  const matches = totalBase === razem;
  const control = el('div', { className: `sal-control ${matches ? 'sal-control-ok' : 'sal-control-fail'}` });
  control.appendChild(
    text(
      'span',
      `Сумма всех баз: ${formatPLN(totalBase)} zł   •   RAZEM фактуры: ${formatPLN(razem)} zł   ${matches ? '✓ совпадает' : '✗ РАСХОЖДЕНИЕ'}`
    )
  );
  container.appendChild(control);
}
