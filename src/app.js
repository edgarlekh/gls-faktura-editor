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

import { createLine } from './model.js';
import { recalc } from './recalc.js';
import { formatPLN, parsePLN, formatInt, parseIntPL } from './format.js';
import { buildSampleInvoice } from './fixtures/sample-invoice.js';

const TIER_LABELS = ['Poniżej 3500', '3500-4800', 'Ponad 4800'];

// --- состояние приложения -------------------------------------------------

let invoice = buildSampleInvoice();
recalc(invoice);
// исходная сумма фактуры — для «дельты» самоконтроля; никогда не меняется,
// даже если пользователь правит данные (сбрасывается только Reset-кнопкой,
// которая перезагружает фикстуру и делает delta=0 автоматически)
const ORIGINAL_RAZEM = invoice.summary.wynagrodzenie.razem;

let rates = {
  tiers: invoice.vehicles[0].delivery.tiers.map((t) => t.rate),
  pickup: invoice.vehicles[0].pickup.rate,
};

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
      title: line.valueOverridden ? 'Wartość nadpisana ręcznie — inna niż Ilość × Cena' : undefined,
      onCommit: (v) => {
        line.value = v;
        line.valueOverridden = true;
        recalcAndRender();
      },
    })
  );

  const actions = el('td', { className: 'actions' });
  if (line.valueOverridden) {
    actions.appendChild(text('span', '✎', { className: 'badge-override', title: 'Wartość nadpisana ręcznie' }));
    const resetBtn = text('button', '↺', { className: 'btn-reset', title: 'Przywróć: Wartość = Ilość × Cena' });
    resetBtn.addEventListener('click', () => {
      line.valueOverridden = false;
      recalcAndRender();
    });
    actions.appendChild(resetBtn);
  }
  const delBtn = text('button', '🗑', { className: 'btn-delete', title: 'Usuń wiersz' });
  delBtn.addEventListener('click', onDelete);
  actions.appendChild(delBtn);
  tr.appendChild(actions);

  return tr;
}

/** Табличный блок ooh/surcharges/bonusMalus/extra/fees + RAZEM + "dodaj wiersz". */
function renderLineBlock(title, lines, razemValue, { addLabel = 'Nowa pozycja' } = {}) {
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
  const addBtn = text('button', '+ dodaj wiersz', { className: 'btn-add' });
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
  grid.appendChild(renderLineBlock('OOH', vehicle.ooh, vehicle.oohRazem, { addLabel: 'Nowa pozycja OOH' }));
  grid.appendChild(
    renderLineBlock('Usługi (Dopłaty)', vehicle.surcharges, vehicle.surchargesRazem, { addLabel: 'Nowa dopłata' })
  );
  grid.appendChild(
    renderLineBlock('Bonus/Malus', vehicle.bonusMalus, vehicle.bonusMalusRazem, { addLabel: 'Nowa pozycja' })
  );
  grid.appendChild(
    renderLineBlock('Dodatkowe pozycje', vehicle.extra, vehicle.extraRazem, { addLabel: 'Nowa pozycja' })
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
  section.appendChild(text('h3', 'Stawki (dotyczą wszystkich pojazdów)'));
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
    text('p', `Zmiana względem oryginału: ${sign}${formatPLN(delta)}`, { className: `delta ${deltaClass}` })
  );
  section.appendChild(text('p', `Opłaty RAZEM (poza sumą): ${formatPLN(inv.summary.oplaty.razem)}`, { className: 'oplaty-note' }));

  const resetBtn = text('button', '⟲ Zresetuj do oryginału', { className: 'btn-reset-all' });
  resetBtn.addEventListener('click', resetToOriginal);
  section.appendChild(resetBtn);

  return section;
}

function renderHeaderBar(inv) {
  const h = inv.header;
  const bar = el('header', { className: 'invoice-header' });
  bar.appendChild(text('h1', 'Faktura GLS — edytor (Etap 2)'));
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
  app.appendChild(renderHeaderBar(invoice));
  app.appendChild(renderRatesPanel());
  app.appendChild(renderTopSummary(invoice));

  const vehiclesWrap = el('div', { className: 'vehicles' });
  invoice.vehicles.forEach((v) => vehiclesWrap.appendChild(renderVehicle(v)));
  app.appendChild(vehiclesWrap);

  app.appendChild(
    renderLineBlock('Opłaty (poza sumą Wynagrodzenia)', invoice.fees, invoice.summary.oplaty.razem, {
      addLabel: 'Nowa opłata',
    })
  );

  app.appendChild(renderTotals(invoice));
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
  rates = {
    tiers: invoice.vehicles[0].delivery.tiers.map((t) => t.rate),
    pickup: invoice.vehicles[0].pickup.rate,
  };
  render();
}

render();
