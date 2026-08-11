// test/salary-copy.test.js
// Запуск: node test/salary-copy.test.js (или npm test)
// Проверяет формат текста "📋 Скопировать сводку" (src/salary.js
// buildSummaryText) — точное посимвольное совпадение с макетом из ТЗ, на
// реальных числах фикстуры (Скрут 1203 в макете — это ровно наши реальные
// база/выплата 15 937,76 / 7 968,88 при 50%, не выдуманные).
//
// salary.js — DOM-модуль (localStorage для имён/процентов курьеров); в Node
// его нет по умолчанию — минимальный in-memory полифилл только на время
// теста. document не нужен: buildSummaryText никогда не трогает DOM.
globalThis.localStorage = {
  _map: new Map(),
  getItem(k) {
    return this._map.has(k) ? this._map.get(k) : null;
  },
  setItem(k, v) {
    this._map.set(k, String(v));
  },
  removeItem(k) {
    this._map.delete(k);
  },
};

import assert from 'node:assert/strict';
import { recalc } from '../src/recalc.js';
import { buildSampleInvoice } from '../src/fixtures/sample-invoice.js';
import { buildCourierRows } from '../src/salary-calc.js';
import { formatPLN } from '../src/format.js';
import { buildSummaryText } from '../src/salary.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const invoice = recalc(buildSampleInvoice());
// те же дефолты, что DEFAULT_PERCENTS в salary.js для образца 10082026.pdf
const DEFAULT_PERCENTS = new Map([
  ['1203', 50],
  ['1210', 80],
  ['1220', 80],
  ['1240', 50],
  ['1299', 50],
]);

test('ACCEPTANCE: блок курьера "Скрут 1203" совпадает с макетом из ТЗ посимвольно', () => {
  const rows = buildCourierRows(invoice.vehicles, [], DEFAULT_PERCENTS);
  const text = buildSummaryText(rows, invoice);
  const expectedBlock = [
    '═══════════════════════',
    'Скрут 1203',
    '───────────────────────',
    'Доставка:      13 347,20',
    'Отборы:           678,96',
    'ООН:            1 322,50',
    'Услуги:        −1 389,30',
    'Бонус/Малус:      437,00',
    'Доп. позиции:   1 541,40',
    '───────────────────────',
    'База:          15 937,76',
    '× 50% → К выплате: 7 968,88 zł',
    '═══════════════════════',
  ].join('\n');
  assert.ok(text.includes(expectedBlock), `блок 1203 не совпадает с макетом:\n${text}`);
});

test('заголовок сводки берёт период из header фактуры', () => {
  const rows = buildCourierRows(invoice.vehicles, [], DEFAULT_PERCENTS);
  const text = buildSummaryText(rows, invoice);
  assert.equal(invoice.header.period, 'Lipiec 2026');
  assert.ok(text.startsWith(`Расчёт зарплат курьеров — ${invoice.header.period}`));
});

test('объединённые скруты: заголовок "Курьер (id1+id2)", процент — по percentSourceId', () => {
  const groups = [{ id: 'g1', memberIds: ['1240', '1299'], percentSourceId: '1240' }];
  const rows = buildCourierRows(invoice.vehicles, groups, DEFAULT_PERCENTS);
  const merged = rows.find((r) => r.merged);
  const text = buildSummaryText(rows, invoice);

  assert.ok(text.includes('Курьер (1240+1299)'), 'заголовок объединённого курьера');
  assert.ok(text.includes(`× ${merged.percent}% → К выплате: ${formatPLN(merged.payout)} zł`));
  // контрольное число из ТЗ Этапа 2.5: объединение 1240+1299 при 50% = 7 815,35
  assert.equal(formatPLN(merged.payout), '7 815,35');
});

test('футер: ИТОГО к выплате и Сумма баз = RAZEM фактуры ✓ (без объединений — все 5 машин)', () => {
  const rows = buildCourierRows(invoice.vehicles, [], DEFAULT_PERCENTS);
  const text = buildSummaryText(rows, invoice);
  const totalBase = rows.reduce((s, r) => s + r.base, 0);
  const totalPayout = rows.reduce((s, r) => s + r.payout, 0);

  assert.equal(totalBase, invoice.summary.wynagrodzenie.razem, 'сумма баз всегда равна RAZEM фактуры');
  assert.ok(text.includes(`ИТОГО к выплате: ${formatPLN(totalPayout)} zł`));
  assert.ok(text.includes(`Сумма баз: ${formatPLN(totalBase)} zł = RAZEM фактуры ✓`));
});

test('строки 6 позиций и "База:" выровнены — ровно 24 символа на строку', () => {
  const rows = buildCourierRows(invoice.vehicles, [], DEFAULT_PERCENTS);
  const text = buildSummaryText(rows, invoice);
  const rowLines = text
    .split('\n')
    .filter((l) => /^(Доставка|Отборы|ООН|Услуги|Бонус\/Малус|Доп\. позиции|База):/.test(l));
  assert.ok(rowLines.length >= 5 * 7, 'должно быть 7 строк (6 позиций + База) на каждую из 5 машин');
  rowLines.forEach((l) => assert.equal([...l].length, 24, `строка "${l}" должна быть ровно 24 символа шириной`));
});

test('отрицательные Usługi показаны с типографским минусом (−), а не ASCII "-"', () => {
  const rows = buildCourierRows(invoice.vehicles, [], DEFAULT_PERCENTS);
  const text = buildSummaryText(rows, invoice);
  const uslugiLine = text.split('\n').find((l) => l.startsWith('Услуги:') && l.includes('1 389,30'));
  assert.ok(uslugiLine, 'должна быть строка Услуги для 1203');
  assert.ok(uslugiLine.includes('−'), 'должен быть типографский минус U+2212');
  assert.ok(!uslugiLine.includes('-'), 'не должно быть ASCII-дефиса');
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
