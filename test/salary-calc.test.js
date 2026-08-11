// test/salary-calc.test.js
// Запуск: node test/salary-calc.test.js (или npm test)
// Контрольные суммы — по фикстуре из fixtures/sample-invoice.js (та же, что
// в test/recalc.test.js и test/pdf-parser.test.js).

import assert from 'node:assert/strict';
import { recalc } from '../src/recalc.js';
import { buildSampleInvoice } from '../src/fixtures/sample-invoice.js';
import { formatPLN } from '../src/format.js';
import { vehicleBase, buildCourierRows, compareCourierRows, payout } from '../src/salary-calc.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const invoice = recalc(buildSampleInvoice());
const byId = new Map(invoice.vehicles.map((v) => [v.id, v]));

test('ACCEPTANCE: база скрута 1203 = 15 937,76', () => {
  assert.equal(formatPLN(vehicleBase(byId.get('1203'))), '15 937,76');
});

test('ACCEPTANCE: выплата 1203 при 50% = 7 968,88', () => {
  assert.equal(formatPLN(payout(vehicleBase(byId.get('1203')), 50)), '7 968,88');
});

test('ACCEPTANCE: объединение 1240+1299 при 50% = 7 815,35', () => {
  const groups = [{ id: 'merged-1240-1299', memberIds: ['1240', '1299'], percentSourceId: '1240' }];
  const percentById = new Map([['1240', 50]]);
  const rows = buildCourierRows(invoice.vehicles, groups, percentById);
  const merged = rows.find((r) => r.groupId === 'merged-1240-1299');
  assert.ok(merged, 'должна быть строка объединённого курьера');
  assert.equal(merged.merged, true);
  assert.equal(formatPLN(merged.payout), '7 815,35');
});

test('ACCEPTANCE: сумма всех баз (без объединений) = RAZEM фактуры = 60 863,83', () => {
  const percentById = new Map();
  const rows = buildCourierRows(invoice.vehicles, [], percentById);
  const totalBase = rows.reduce((s, r) => s + r.base, 0);
  assert.equal(formatPLN(totalBase), '60 863,83');
  assert.equal(totalBase, invoice.summary.wynagrodzenie.razem);
});

test('сумма баз не меняется при объединении скрутов — просто перегруппировка', () => {
  const percentById = new Map();
  const flatTotal = buildCourierRows(invoice.vehicles, [], percentById).reduce((s, r) => s + r.base, 0);
  const groups = [{ id: 'g1', memberIds: ['1203', '1210', '1220'] }];
  const groupedTotal = buildCourierRows(invoice.vehicles, groups, percentById).reduce((s, r) => s + r.base, 0);
  assert.equal(groupedTotal, flatTotal);
});

test('можно объединить любое число скрутов (не только 2)', () => {
  const groups = [{ id: 'g-all', memberIds: ['1203', '1210', '1220', '1240', '1299'] }];
  const rows = buildCourierRows(invoice.vehicles, groups, new Map());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].base, invoice.summary.wynagrodzenie.razem);
});

test('percentSourceId по умолчанию — первый из объединённых, если не указан явно', () => {
  const groups = [{ id: 'g1', memberIds: ['1210', '1220'] }];
  const percentById = new Map([
    ['1210', 80],
    ['1220', 33],
  ]);
  const rows = buildCourierRows(invoice.vehicles, groups, percentById);
  assert.equal(rows[0].percentSourceId, '1210');
  assert.equal(rows[0].percent, 80);
});

test('compareCourierRows: без правок дельта = 0 для каждого курьера', () => {
  const percentById = new Map([['1203', 50]]);
  const before = buildCourierRows(invoice.vehicles, [], percentById);
  const after = buildCourierRows(invoice.vehicles, [], percentById);
  const compared = compareCourierRows(before, after);
  compared.forEach((row) => {
    assert.equal(row.deltaBase, 0, `deltaBase для ${row.groupId}`);
    assert.equal(row.deltaPayout, 0, `deltaPayout для ${row.groupId}`);
  });
});

test('compareCourierRows: правка qty у одного скрута меняет дельту только у него', () => {
  const percentById = new Map([
    ['1203', 50],
    ['1210', 50],
  ]);
  const before = buildCourierRows(invoice.vehicles, [], percentById);

  const editedInvoice = recalc(buildSampleInvoice());
  const v1203 = editedInvoice.vehicles.find((v) => v.id === '1203');
  v1203.delivery.tiers[0].qty += 100; // +100 szt. по тарифу 6,50 zł => +650,00 zł базы
  recalc(editedInvoice);
  const after = buildCourierRows(editedInvoice.vehicles, [], percentById);

  const compared = compareCourierRows(before, after);
  const row1203 = compared.find((r) => r.groupId === '1203');
  const row1210 = compared.find((r) => r.groupId === '1210');
  assert.equal(formatPLN(row1203.deltaBase), '650,00');
  assert.equal(row1210.deltaBase, 0);
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
