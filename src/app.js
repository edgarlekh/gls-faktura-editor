// src/app.js
// UI Этапа 2: рендер фактуры в браузере + редактирование ячеек. Никакого
// фреймворка — обычный DOM. Стратегия перерисовки: любое изменение модели
// сразу идёт через recalc(invoice), после чего весь #app перестраивается
// заново (render()). Инвойс небольшой (5 машин), полный ререндер на каждое
// подтверждённое изменение — самый простой и надёжный вариант, без риска
// рассинхронизации сумм.
//
// Ячейки редактируются в 2 шага: клик по ячейке превращает её в <input>;
// подтверждение — Enter или потеря фокуса (blur). Так перерисовка не
// происходит на каждый нажатый символ и не сбивает курсор во время ввода.

import { createLine, DELIVERY_TIER_RATES, PICKUP_RATE } from './model.js';
import { recalc } from './recalc.js';
import { formatPLN, parsePLN, formatInt, parseIntPL } from './format.js';
import { buildSampleInvoice } from './fixtures/sample-invoice.js';
import { loadInvoiceFromPdfFile } from './pdf/load-browser.js';
import { reconcile } from './pdf/reconcile.js';
import { buildInvoiceContext } from './ai/context-builder.js';
import { askClaudeForOps, parseOpsResponse } from './ai/anthropic-client.js';
import { resolveOps, applyResolved } from './ai/ops.js';

const TIER_LABELS = ['Poniżej 3500', '3500-4800', 'Ponad 4800'];

// --- состояние приложения -------------------------------------------------

let invoice = buildSampleInvoice();
recalc(invoice);
// исходная сумма фактуры — для «дельты» самоконтроля; меняется вместе с
// источником данных (сбрасывается Reset-кнопкой на фикстуру, а после загрузки
// PDF — на только что распознанную сумму), но не самими правками пользователя
let ORIGINAL_RAZEM = invoice.summary.wynagrodzenie.razem;
// глубокий снимок invoice в тот же момент, что и ORIGINAL_RAZEM — нужен
// вкладке "Расчёт зарплат" (src/salary.js) для сравнения "до/после" по
// каждому курьеру, а не только по общей сумме
let originalInvoiceSnapshot = structuredClone(invoice);

// заполняется после успешной/неуспешной загрузки PDF: {fileName, warnings,
// reconciliation, feesInfo} — сверка recalc() с суммами, напечатанными в PDF
let parseReport = null;

// вызывается в конце каждого render() — так вкладка "Расчёт зарплат"
// (src/main.js/src/salary.js) узнаёт о правках, не будучи частью app.js
let onInvoiceChange = null;
export function setOnInvoiceChange(cb) {
  onInvoiceChange = cb;
}
/** {current, original} — оба уже прогнаны через recalc(). Только для чтения. */
export function getInvoiceState() {
  return { current: invoice, original: originalInvoiceSnapshot };
}

let rates = {
  tiers: invoice.vehicles[0].delivery.tiers.map((t) => t.rate),
  pickup: invoice.vehicles[0].pickup.rate,
};

// --- Этап 5: текстовые команды через Anthropic API --------------------------
// Ключ никогда не хранится в коде/репозитории — только localStorage браузера.
const LS_API_KEY = 'gls-anthropic-api-key';
function getApiKey() {
  return (localStorage.getItem(LS_API_KEY) || '').trim();
}
function setApiKey(key) {
  const trimmed = String(key).trim();
  if (trimmed) localStorage.setItem(LS_API_KEY, trimmed);
  else localStorage.removeItem(LS_API_KEY);
}

// --- синхронизация с предпросмотром печати (print.html) ---------------------
// print.html открывается отдельной страницей (свой module-граф, свой
// buildSampleInvoice()) — единственный мост между редактором и печатью это
// sessionStorage: перед каждым render() кладём туда текущий invoice целиком,
// print.js при загрузке читает его вместо фикстуры, если он есть.
const PRINT_STORAGE_KEY = 'gls-print-invoice';

let settingsOpen = false;
let commandDraft = '';
let aiLoading = false;
let aiError = null;
let aiPreview = null; // { commandText, resolved: [{op, ok, description, error, apply}] } | null

// --- маленькие DOM-хелперы -------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'className') node.className = v;
    else if (k === 'title') node.title = v;
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

function headerRow(labels) {
  const thead = el('thead');
  const tr = el('tr');
  labels.forEach((l) => tr.appendChild(text('th', l)));
  thead.appendChild(tr);
  return thead;
}

/**
 * Ячейка "клик → input". kind определяет форматирование/парсинг:
 * 'text' — как есть, 'int' — formatInt/parseIntPL, 'money' — formatPLN/parsePLN.
 * onCommit(parsedValue) вызывается только если распарсилось; иначе просто
 * возвращаемся в режим отображения без изменений.
 */
function editableCell(rawValue, { kind = 'text', onCommit, title, className } = {}) {
  const td = el('td', { className: ['editable', className].filter(Boolean).join(' ') });
  if (title) td.title = title;

  const display = () => {
    if (kind === 'money') return formatPLN(rawValue);
    if (kind === 'int') return formatInt(rawValue);
    return String(rawValue);
  };

  const showDisplay = () => {
    td.textContent = '';
    const span = text('span', display(), { className: 'cell-display' });
    td.appendChild(span);
  };

  const showInput = () => {
    td.textContent = '';
    const input = el('input', { className: 'cell-input' });
    input.value = display();
    td.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      let parsed;
      if (kind === 'money') parsed = parsePLN(input.value);
      else if (kind === 'int') parsed = parseIntPL(input.value);
      else parsed = input.value.trim();
      const valid = kind === 'text' ? true : Number.isFinite(parsed);
      if (valid) onCommit(parsed);
      else render(); // некорректный ввод — просто перерисовать как было
    };
    const cancel = () => {
      if (done) return;
      done = true;
      render();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
  };

  td.addEventListener('click', () => {
    if (td.querySelector('input')) return;
    showInput();
  });
  showDisplay();
  return td;
}

function readonlyCell(value, kind = 'money') {
  const txt = kind === 'money' ? formatPLN(value) : kind === 'int' ? formatInt(value) : String(value);
  return text('td', txt, { className: 'readonly' });
}

// --- строка ooh/surcharges/bonusMalus/extra/fees ---------------------------

function renderLineRow(line, { onDelete }) {
  const tr = el('tr', { className: line.valueOverridden ? 'overridden' : '' });

  tr.appendChild(
    editableCell(line.name, {
      kind: 'text',
      onCommit: (v) => {
        line.name = v;
        recalcAndRender();
      },
    })
  );
  tr.appendChild(
    editableCell(line.qty, {
      kind: 'int',
      onCommit: (v) => {
        line.qty = v;
        recalcAndRender();
      },
    })
  );
  tr.appendChild(
    editableCell(line.unitPrice, {
      kind: 'money',
      onCommit: (v) => {
        line.unitPrice = v;
        recalcAndRender();
      },
    })
  );
  tr.appendChild(
    editableCell(line.value, {
      kind: 'money',
      className: line.valueOverridden ? 'value-overridden' : '',
      title: line.valueOverridden ? 'Значение изменено вручную — отличается от Ilość × Cena' : undefined,
      onCommit: (v) => {
        line.value = v;
        line.valueOverridden = true;
        recalcAndRender();
      },
    })
  );

  const actions = el('td', { className: 'actions' });
  if (line.valueOverridden) {
    actions.appendChild(text('span', '✎', { className: 'badge-override', title: 'Значение изменено вручную' }));
    const resetBtn = text('button', '↺', { className: 'btn-reset', title: 'Восстановить: Wartość = Ilość × Cena' });
    resetBtn.addEventListener('click', () => {
      line.valueOverridden = false;
      recalcAndRender();
    });
    actions.appendChild(resetBtn);
  }
  const delBtn = text('button', '🗑', { className: 'btn-delete', title: 'Удалить строку' });
  delBtn.addEventListener('click', onDelete);
  actions.appendChild(delBtn);
  tr.appendChild(actions);

  return tr;
}

/** Табличный блок ooh/surcharges/bonusMalus/extra/fees + RAZEM + "добавить строку". */
function renderLineBlock(title, lines, razemValue, { addLabel = 'Новая позиция' } = {}) {
  const section = el('div', { className: 'block' });
  section.appendChild(text('h4', title));

  const table = el('table');
  table.appendChild(headerRow(['Nazwa', 'Ilość', 'Cena', 'Wartość', '']));
  const tbody = el('tbody');
  lines.forEach((line, idx) => {
    tbody.appendChild(
      renderLineRow(line, {
        onDelete: () => {
          lines.splice(idx, 1);
          recalcAndRender();
        },
      })
    );
  });
  table.appendChild(tbody);
  section.appendChild(table);

  const footer = el('div', { className: 'block-footer' });
  footer.appendChild(text('span', `RAZEM: ${formatPLN(razemValue)}`, { className: 'razem' }));
  const addBtn = text('button', '+ добавить строку', { className: 'btn-add' });
  addBtn.addEventListener('click', () => {
    lines.push(createLine({ name: addLabel, qty: 0, unitPrice: 0 }));
    recalcAndRender();
  });
  footer.appendChild(addBtn);
  section.appendChild(footer);

  return section;
}

// --- блоки машины: delivery / pickup ---------------------------------------

function renderDeliveryBlock(vehicle) {
  const section = el('div', { className: 'block' });
  section.appendChild(text('h4', 'Doręczenie (grupa 000010)'));

  const table = el('table');
  table.appendChild(headerRow(['Próg', 'Ilość', 'Stawka', 'Wartość']));
  const tbody = el('tbody');
  vehicle.delivery.tiers.forEach((tier) => {
    const tr = el('tr');
    tr.appendChild(text('td', tier.label));
    tr.appendChild(
      editableCell(tier.qty, {
        kind: 'int',
        onCommit: (v) => {
          tier.qty = v;
          recalcAndRender();
        },
      })
    );
    tr.appendChild(readonlyCell(tier.rate, 'money'));
    tr.appendChild(readonlyCell(tier.value, 'money'));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  section.appendChild(table);

  section.appendChild(
    text(
      'div',
      `RAZEM: ${formatInt(vehicle.delivery.razemQty)} szt. / ${formatPLN(vehicle.delivery.razemValue)}`,
      { className: 'block-footer' }
    )
  );
  return section;
}

function renderPickupBlock(vehicle) {
  const section = el('div', { className: 'block' });
  section.appendChild(text('h4', 'Odbiór (grupa 000004)'));

  const table = el('table');
  table.appendChild(headerRow(['Nazwa', 'Ilość', 'Stawka', 'Wartość']));
  const tbody = el('tbody');
  const tr = el('tr');
  tr.appendChild(text('td', vehicle.pickup.label));
  tr.appendChild(
    editableCell(vehicle.pickup.qty, {
      kind: 'int',
      onCommit: (v) => {
        vehicle.pickup.qty = v;
        recalcAndRender();
      },
    })
  );
  tr.appendChild(readonlyCell(vehicle.pickup.rate, 'money'));
  tr.appendChild(readonlyCell(vehicle.pickup.value, 'money'));
  tbody.appendChild(tr);
  table.appendChild(tbody);
  section.appendChild(table);
  return section;
}

function renderVehicle(vehicle) {
  const wrap = el('section', { className: 'vehicle' });
  wrap.appendChild(text('h3', `Pojazd ${vehicle.id}`));
  const grid = el('div', { className: 'vehicle-grid' });
  grid.appendChild(renderDeliveryBlock(vehicle));
  grid.appendChild(renderPickupBlock(vehicle));
  grid.appendChild(renderLineBlock('OOH', vehicle.ooh, vehicle.oohRazem, { addLabel: 'Новая позиция OOH' }));
  grid.appendChild(
    renderLineBlock('Usługi (Dopłaty)', vehicle.surcharges, vehicle.surchargesRazem, { addLabel: 'Новая доплата' })
  );
  grid.appendChild(
    renderLineBlock('Bonus/Malus', vehicle.bonusMalus, vehicle.bonusMalusRazem, { addLabel: 'Новая позиция' })
  );
  grid.appendChild(
    renderLineBlock('Dodatkowe pozycje', vehicle.extra, vehicle.extraRazem, { addLabel: 'Новая позиция' })
  );
  wrap.appendChild(grid);
  return wrap;
}

// --- верхние сводки, панель ставок, итог -----------------------------------

function renderTopSummary(inv) {
  const section = el('section', { className: 'top-summary' });
  const g4 = inv.summary.group000004;
  const g10 = inv.summary.group000010;

  const card4 = el('div', { className: 'summary-card' });
  card4.appendChild(text('h3', 'Łączny przegląd — grupa 000004 (Odbiór)'));
  card4.appendChild(text('p', `Ilość: ${formatInt(g4.qty)} szt.   •   Wartość: ${formatPLN(g4.value)}`));

  const card10 = el('div', { className: 'summary-card' });
  card10.appendChild(text('h3', 'Łączny przegląd — grupa 000010 (Doręczenie)'));
  const table = el('table');
  table.appendChild(headerRow(['Próg', 'Ilość', 'Wartość']));
  const tbody = el('tbody');
  g10.tiers.forEach((t, i) => {
    const tr = el('tr');
    tr.appendChild(text('td', TIER_LABELS[i]));
    tr.appendChild(readonlyCell(t.qty, 'int'));
    tr.appendChild(readonlyCell(t.value, 'money'));
    tbody.appendChild(tr);
  });
  const trTotal = el('tr', { className: 'razem-row' });
  trTotal.appendChild(text('td', 'RAZEM'));
  trTotal.appendChild(readonlyCell(g10.razemQty, 'int'));
  trTotal.appendChild(readonlyCell(g10.razemValue, 'money'));
  tbody.appendChild(trTotal);
  table.appendChild(tbody);
  card10.appendChild(table);

  section.appendChild(card4);
  section.appendChild(card10);
  return section;
}

function renderRatesPanel() {
  const section = el('section', { className: 'rates-panel' });
  section.appendChild(text('h3', 'Ставки (для всех машин)'));
  const row = el('div', { className: 'rates-row' });

  rates.tiers.forEach((rate, i) => {
    const field = el('label', { className: 'rate-field' });
    field.appendChild(document.createTextNode(`${TIER_LABELS[i]}: `));
    const input = el('input', { className: 'rate-input' });
    input.value = formatPLN(rate);
    input.addEventListener('change', () => {
      const n = parsePLN(input.value);
      if (Number.isFinite(n)) {
        rates.tiers[i] = n;
        applyRates();
      } else render();
    });
    field.appendChild(input);
    row.appendChild(field);
  });

  const pickupField = el('label', { className: 'rate-field' });
  pickupField.appendChild(document.createTextNode('Odbiór (Ponad 0): '));
  const pickupInput = el('input', { className: 'rate-input' });
  pickupInput.value = formatPLN(rates.pickup);
  pickupInput.addEventListener('change', () => {
    const n = parsePLN(pickupInput.value);
    if (Number.isFinite(n)) {
      rates.pickup = n;
      applyRates();
    } else render();
  });
  pickupField.appendChild(pickupInput);
  row.appendChild(pickupField);

  section.appendChild(row);
  return section;
}

function renderTotals(inv) {
  const section = el('section', { className: 'totals-panel' });
  section.appendChild(text('h3', 'Wynagrodzenie ogółem'));

  const w = inv.summary.wynagrodzenie;
  const rows = [
    ['Doręczenie', w.doreczenie],
    ['Odbiór', w.odbior],
    ['Usługi', w.uslugi],
    ['Bonus/Malus', w.bonusMalus],
    ['Dodatkowe pozycje', w.dodatkowePozycje],
    ['OOH', w.ooh],
  ];
  const table = el('table');
  const tbody = el('tbody');
  rows.forEach(([label, val]) => {
    const tr = el('tr');
    tr.appendChild(text('td', label));
    tr.appendChild(readonlyCell(val, 'money'));
    tbody.appendChild(tr);
  });
  const trTotal = el('tr', { className: 'razem-row' });
  trTotal.appendChild(text('td', 'RAZEM'));
  trTotal.appendChild(readonlyCell(w.razem, 'money'));
  tbody.appendChild(trTotal);
  table.appendChild(tbody);
  section.appendChild(table);

  const delta = w.razem - ORIGINAL_RAZEM;
  const sign = delta > 0 ? '+' : '';
  const deltaClass = delta === 0 ? 'zero' : delta > 0 ? 'pos' : 'neg';
  section.appendChild(
    text('p', `Изменение относительно оригинала: ${sign}${formatPLN(delta)}`, { className: `delta ${deltaClass}` })
  );
  section.appendChild(text('p', `Opłaty RAZEM (не входит в сумму): ${formatPLN(inv.summary.oplaty.razem)}`, { className: 'oplaty-note' }));

  const resetBtn = text('button', '⟲ Сбросить к оригиналу', { className: 'btn-reset-all' });
  resetBtn.addEventListener('click', resetToOriginal);
  section.appendChild(resetBtn);

  // rel="opener" обязателен: с Chrome 88 target="_blank" по умолчанию ведёт
  // себя как rel="noopener" (window.opener===null в новой вкладке), а без
  // opener'а sessionStorage НЕ наследуется — печать открылась бы с фикстурой
  // вместо текущих правок. Проверено вживую (Playwright): без rel="opener"
  // window.opener===null и предпросмотр печати показывал старые данные.
  const printLink = text('a', '🖨 Просмотр печати (PDF)', { className: 'print-link', href: 'print.html', rel: 'opener' });
  printLink.target = '_blank';
  section.appendChild(printLink);

  return section;
}

// --- загрузка PDF (Этап 3) --------------------------------------------------

function renderLoadPanel() {
  const section = el('section', { className: 'load-panel' });

  const label = el('label', { className: 'load-btn' });
  label.textContent = '📄 Загрузить PDF-фактуру';
  const input = el('input', { type: 'file', accept: 'application/pdf,.pdf', className: 'file-input' });
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (file) handleFileSelected(file);
  });
  label.appendChild(input);
  section.appendChild(label);

  section.appendChild(
    text('span', 'Распознавание работает локально в браузере (pdf.js) — файл никуда не отправляется.', {
      className: 'load-hint',
    })
  );

  return section;
}

async function handleFileSelected(file) {
  aiPreview = null;
  aiError = null;
  try {
    const parsed = await loadInvoiceFromPdfFile(file);
    invoice = parsed.invoice;
    recalc(invoice);
    ORIGINAL_RAZEM = invoice.summary.wynagrodzenie.razem;
    originalInvoiceSnapshot = structuredClone(invoice);
    rates = {
      tiers: invoice.vehicles[0] ? invoice.vehicles[0].delivery.tiers.map((t) => t.rate) : DELIVERY_TIER_RATES.slice(),
      pickup: invoice.vehicles[0] ? invoice.vehicles[0].pickup.rate : PICKUP_RATE,
    };
    parseReport = {
      fileName: file.name,
      warnings: parsed.warnings,
      reconciliation: reconcile(invoice, parsed.printed),
      feesInfo: parsed.feesInfo,
    };
  } catch (err) {
    parseReport = {
      fileName: file.name,
      warnings: [{ section: 'document', message: `Не удалось загрузить PDF: ${err.message}` }],
      reconciliation: [],
      feesInfo: {},
    };
  }
  render();
}

function renderParseReport(report) {
  const section = el('section', { className: 'parse-report' });
  section.appendChild(text('h3', `Результат распознавания: ${report.fileName}`));

  if (report.warnings.length) {
    section.appendChild(
      text('p', `⚠ ${report.warnings.length} мест требуют ручной проверки:`, { className: 'warn-title' })
    );
    const ul = el('ul', { className: 'warn-list' });
    report.warnings.forEach((w) => ul.appendChild(text('li', `[${w.section}] ${w.message}`)));
    section.appendChild(ul);
  } else {
    section.appendChild(text('p', '✓ Парсер не выдал предупреждений.', { className: 'warn-ok' }));
  }

  if (report.reconciliation.length) {
    const table = el('table');
    table.appendChild(headerRow(['Сверка с PDF', 'Вычислено (recalc)', 'Напечатано в PDF', '']));
    const tbody = el('tbody');
    report.reconciliation.forEach((row) => {
      const tr = el('tr', { className: row.ok ? 'recon-ok' : 'recon-fail' });
      tr.appendChild(text('td', row.label));
      tr.appendChild(readonlyCell(row.computed, row.kind));
      tr.appendChild(row.printed === null ? text('td', '—', { className: 'readonly' }) : readonlyCell(row.printed, row.kind));
      tr.appendChild(text('td', row.ok ? '✓' : '✗', { className: row.ok ? 'ok-mark' : 'fail-mark' }));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    section.appendChild(table);

    const allOk = report.reconciliation.every((r) => r.ok);
    section.appendChild(
      text('p', allOk ? '✓ Все суммы совпадают с PDF.' : '✗ Есть расхождения — проверьте красные строки выше.', {
        className: allOk ? 'recon-summary-ok' : 'recon-summary-fail',
      })
    );
  }

  return section;
}

// --- настройки: API-ключ Anthropic (Этап 5) ---------------------------------

function renderSettingsPanel() {
  const wrap = el('div', { className: 'settings-wrap' });
  const gearBtn = text('button', '⚙', { className: 'settings-gear', title: 'Настройки: ключ API Anthropic' });
  gearBtn.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    render();
  });
  wrap.appendChild(gearBtn);

  if (settingsOpen) {
    const hasKey = !!getApiKey();
    const panel = el('div', { className: 'settings-panel' });
    panel.appendChild(text('h4', 'Ключ API Anthropic'));
    panel.appendChild(
      text(
        'p',
        'Ключ хранится только локально в браузере (localStorage) — никогда не попадает в репозиторий или на какой-либо сервер, кроме api.anthropic.com. Нужен для текстовых команд (AI) ниже.',
        { className: 'settings-hint' }
      )
    );
    const input = el('input', { type: 'password', className: 'settings-key-input' });
    input.placeholder = 'sk-ant-...';
    input.value = getApiKey();
    panel.appendChild(input);

    const row = el('div', { className: 'settings-row' });
    const saveBtn = text('button', 'Сохранить', { className: 'settings-save-btn' });
    saveBtn.addEventListener('click', () => {
      setApiKey(input.value);
      settingsOpen = false;
      render();
    });
    row.appendChild(saveBtn);
    if (hasKey) {
      const clearBtn = text('button', 'Удалить ключ', { className: 'settings-clear-btn' });
      clearBtn.addEventListener('click', () => {
        setApiKey('');
        render();
      });
      row.appendChild(clearBtn);
    }
    panel.appendChild(row);
    panel.appendChild(
      text('p', hasKey ? '✓ Ключ сохранён' : '✗ Ключ не задан', {
        className: hasKey ? 'settings-status-ok' : 'settings-status-missing',
      })
    );
    wrap.appendChild(panel);
  }

  return wrap;
}

// --- команды текстом через AI (Этап 5) --------------------------------------
// Модель (claude-haiku-4-5) только переводит текст в JSON-операции (см.
// src/ai/ops.js) — ничего не считает и не применяется без подтверждения:
// сначала показываем распознанный список действий, применение — отдельным
// кликом через уже готовый recalc().

async function runCommand() {
  const cmd = commandDraft.trim();
  const apiKey = getApiKey();
  if (!cmd || !apiKey) return;

  aiLoading = true;
  aiError = null;
  aiPreview = null;
  render();

  try {
    const context = buildInvoiceContext(invoice);
    const raw = await askClaudeForOps(apiKey, context, cmd);
    const ops = parseOpsResponse(raw);
    const resolved = resolveOps(invoice, ops);
    aiPreview = { commandText: cmd, resolved };
    if (!ops.length) {
      aiError = 'Модель не распознала ни одной операции в этой команде.';
    }
  } catch (err) {
    aiError = err.message;
  } finally {
    aiLoading = false;
    render();
  }
}

function renderCommandPanel() {
  const section = el('section', { className: 'cmd-panel' });
  section.appendChild(text('h3', '💬 Текстовая команда (AI)'));

  const hasKey = !!getApiKey();
  const row = el('div', { className: 'cmd-row' });
  const input = el('input', { className: 'cmd-input' });
  input.type = 'text';
  input.value = commandDraft;
  input.placeholder = hasKey ? 'например: удали Eco Bonus у 1203 / ставки 6.00 5.30 5.20' : 'введите API-ключ в настройках';
  input.disabled = !hasKey || aiLoading;
  input.addEventListener('input', () => {
    commandDraft = input.value;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runCommand();
    }
  });
  row.appendChild(input);

  // disabled только от hasKey/aiLoading (известны на момент render()), не от
  // текста в поле — тот меняется без render() (см. editableCell), так что
  // проверку "пусто ли поле" делает сам runCommand() при клике
  const runBtn = text('button', aiLoading ? '⏳ Выполняю…' : '▶ Выполнить', { className: 'cmd-run-btn' });
  runBtn.disabled = !hasKey || aiLoading;
  runBtn.addEventListener('click', runCommand);
  row.appendChild(runBtn);
  section.appendChild(row);

  if (aiError) {
    section.appendChild(text('p', `✗ ${aiError}`, { className: 'cmd-error' }));
  }

  if (aiPreview) {
    section.appendChild(
      text('p', `Распознанные действия для: «${aiPreview.commandText}»`, { className: 'cmd-preview-title' })
    );
    const ul = el('ul', { className: 'cmd-list' });
    aiPreview.resolved.forEach((r) => {
      ul.appendChild(text('li', r.description, { className: r.ok ? 'cmd-ok' : 'cmd-fail' }));
    });
    section.appendChild(ul);

    const actions = el('div', { className: 'cmd-actions' });
    const okCount = aiPreview.resolved.filter((r) => r.ok).length;
    const applyBtn = text('button', `✓ Применить (${okCount})`, { className: 'cmd-apply-btn' });
    applyBtn.disabled = okCount === 0;
    applyBtn.addEventListener('click', () => {
      applyResolved(aiPreview.resolved);
      recalc(invoice);
      aiPreview = null;
      aiError = null;
      commandDraft = '';
      render();
    });
    const cancelBtn = text('button', '✗ Отмена', { className: 'cmd-cancel-btn' });
    cancelBtn.addEventListener('click', () => {
      aiPreview = null;
      render();
    });
    actions.appendChild(applyBtn);
    actions.appendChild(cancelBtn);
    section.appendChild(actions);
  }

  return section;
}

function renderHeaderBar(inv) {
  const h = inv.header;
  const bar = el('header', { className: 'invoice-header' });
  bar.appendChild(text('h1', 'Фактура GLS — редактор (Этап 2)'));
  bar.appendChild(
    text(
      'p',
      `Okres: ${h.period}   •   Data wydruku: ${h.printDate}   •   ${h.supplierName} (${h.supplierNo})   •   Umowa: ${h.contractNo}`,
      { className: 'invoice-meta' }
    )
  );
  return bar;
}

// --- главный рендер и мутации состояния ------------------------------------

function render() {
  const app = document.getElementById('app');
  app.textContent = '';
  app.appendChild(renderSettingsPanel());
  app.appendChild(renderHeaderBar(invoice));
  app.appendChild(renderLoadPanel());
  if (parseReport) app.appendChild(renderParseReport(parseReport));
  app.appendChild(renderCommandPanel());
  app.appendChild(renderRatesPanel());
  app.appendChild(renderTopSummary(invoice));

  const vehiclesWrap = el('div', { className: 'vehicles' });
  invoice.vehicles.forEach((v) => vehiclesWrap.appendChild(renderVehicle(v)));
  app.appendChild(vehiclesWrap);

  app.appendChild(
    renderLineBlock('Opłaty (не входит в сумму Wynagrodzenia)', invoice.fees, invoice.summary.oplaty.razem, {
      addLabel: 'Новая оплата',
    })
  );

  app.appendChild(renderTotals(invoice));

  try {
    sessionStorage.setItem(PRINT_STORAGE_KEY, JSON.stringify(invoice));
  } catch {
    // sessionStorage недоступен (приватный режим и т.п.) — предпросмотр
    // печати в этом случае просто откроет фикстуру, не критично
  }

  if (onInvoiceChange) onInvoiceChange();
}

function recalcAndRender() {
  recalc(invoice);
  render();
}

function applyRates() {
  invoice.vehicles.forEach((v) => {
    v.delivery.tiers.forEach((t, i) => {
      t.rate = rates.tiers[i];
    });
    v.pickup.rate = rates.pickup;
  });
  recalcAndRender();
}

function resetToOriginal() {
  invoice = buildSampleInvoice();
  recalc(invoice);
  ORIGINAL_RAZEM = invoice.summary.wynagrodzenie.razem;
  originalInvoiceSnapshot = structuredClone(invoice);
  parseReport = null;
  aiPreview = null;
  aiError = null;
  rates = {
    tiers: invoice.vehicles[0].delivery.tiers.map((t) => t.rate),
    pickup: invoice.vehicles[0].pickup.rate,
  };
  render();
}

render();
