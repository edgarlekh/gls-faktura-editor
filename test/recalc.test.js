// test/recalc.test.js
// Запуск: node test/recalc.test.js  (или npm test)
// Без фреймворков — свой мини-раннер на assert из стандартной библиотеки Node.

import assert from 'node:assert/strict';
import { createInvoice, createVehicle, zlToGr } from '../src/model.js';
import { recalc } from '../src/recalc.js';
import { formatPLN, parsePLN } from '../src/format.js';
import { buildSampleInvoice } from './fixtures/sample-invoice.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Механика движка (не завязана на реальные цифры фактуры — их подставим,
// когда придёт полная спецификация 5 машин).
// ---------------------------------------------------------------------------

test('line: value по умолчанию = qty*unitPrice', () => {
  const inv = createInvoice({
    vehicles: [
      createVehicle({
        id: '1203',
        ooh: [{ name: 'OOH test', qty: 3, unitPrice: 500 }],
      }),
    ],
  });
  recalc(inv);
  assert.equal(inv.vehicles[0].ooh[0].value, 1500);
  assert.equal(inv.vehicles[0].ooh[0].valueOverridden, false);
});

test('line: valueOverridden фиксирует value независимо от qty*unitPrice', () => {
  const inv = createInvoice({
    vehicles: [
      createVehicle({
        id: '1210',
        surcharges: [{ name: 'Dopłata ręczna', qty: 1, unitPrice: 1000, value: -250, valueOverridden: true }],
      }),
    ],
  });
  recalc(inv);
  const line = inv.vehicles[0].surcharges[0];
  assert.equal(line.value, -250, 'value должен остаться -250, а не qty*unitPrice=1000');
  // меняем qty/unitPrice после создания — override должен пережить пересчёт
  line.qty = 99;
  line.unitPrice = 12345;
  recalc(inv);
  assert.equal(line.value, -250);
});

test('createLine: явный value, отличный от qty*unitPrice, сам ставит valueOverridden=true', () => {
  const inv = createInvoice({
    vehicles: [
      createVehicle({ id: '1220', extra: [{ name: 'PGB', qty: 1, unitPrice: 100, value: 999 }] }),
    ],
  });
  const line = inv.vehicles[0].extra[0];
  assert.equal(line.valueOverridden, true);
  recalc(inv);
  assert.equal(line.value, 999);
});

test('delivery tier: value = qty*rate, razemQty/razemValue по машине', () => {
  const inv = createInvoice({
    vehicles: [createVehicle({ id: '1240', deliveryQtys: [100, 50, 20] })],
  });
  recalc(inv);
  const d = inv.vehicles[0].delivery;
  // дефолтные ставки 650/570/544 gr
  assert.equal(d.tiers[0].value, 100 * 650);
  assert.equal(d.tiers[1].value, 50 * 570);
  assert.equal(d.tiers[2].value, 20 * 544);
  assert.equal(d.razemQty, 100 + 50 + 20);
  assert.equal(d.razemValue, 100 * 650 + 50 * 570 + 20 * 544);
});

test('pickup: value = qty*rate (дефолт 1.23 zł)', () => {
  const inv = createInvoice({ vehicles: [createVehicle({ id: '1299', pickupQty: 40 })] });
  recalc(inv);
  assert.equal(inv.vehicles[0].pickup.rate, 123);
  assert.equal(inv.vehicles[0].pickup.value, 40 * 123);
});

test('group000010/000004: агрегация тиров и pickup по всем машинам', () => {
  const inv = createInvoice({
    vehicles: [
      createVehicle({ id: 'A', deliveryQtys: [10, 20, 30], pickupQty: 5 }),
      createVehicle({ id: 'B', deliveryQtys: [1, 2, 3], pickupQty: 7 }),
    ],
  });
  recalc(inv);
  const g10 = inv.summary.group000010;
  assert.deepEqual(g10.tiers.map((t) => t.qty), [11, 22, 33]);
  assert.equal(g10.razemQty, 66);
  assert.equal(g10.razemValue, 11 * 650 + 22 * 570 + 33 * 544);
  assert.equal(inv.summary.group000004.qty, 12);
  assert.equal(inv.summary.group000004.value, 12 * 123);
});

test('Wynagrodzenie ogółem: 6 компонентов + RAZEM = их сумма; Opłaty отдельно', () => {
  const inv = createInvoice({
    vehicles: [
      createVehicle({
        id: 'X',
        deliveryQtys: [10, 0, 0], // 10*650 = 6500 gr
        pickupQty: 10, // 10*123 = 1230 gr
        ooh: [{ name: 'ooh', qty: 1, unitPrice: 1000 }], // 1000 gr
        surcharges: [{ name: 's', qty: 1, unitPrice: 500, value: -200, valueOverridden: true }], // -200 gr
        bonusMalus: [{ name: 'CQE', qty: 1, unitPrice: 300 }], // 300 gr
        extra: [{ name: 'PGB', qty: 1, unitPrice: 400 }], // 400 gr
      }),
    ],
    fees: [{ name: 'fee', qty: 2, unitPrice: 150 }], // 300 gr — вне RAZEM
  });
  recalc(inv);
  const w = inv.summary.wynagrodzenie;
  assert.equal(w.doreczenie, 6500);
  assert.equal(w.odbior, 1230);
  assert.equal(w.uslugi, -200);
  assert.equal(w.bonusMalus, 300);
  assert.equal(w.dodatkowePozycje, 400);
  assert.equal(w.ooh, 1000);
  assert.equal(w.razem, 6500 + 1230 - 200 + 300 + 400 + 1000);
  assert.equal(inv.summary.oplaty.razem, 300);
  // Opłaty НЕ входит в razem: razem не содержит +300 от fees
  assert.equal(w.razem, 9230);
});

test('format.js: formatPLN — пробел тысяч, запятая, 2 знака, знак минус', () => {
  assert.equal(formatPLN(5550496), '55 504,96');
  assert.equal(formatPLN(-582970), '-5 829,70');
  assert.equal(formatPLN(0), '0,00');
  assert.equal(formatPLN(123), '1,23');
  assert.equal(formatPLN(zlToGr(6086383 / 100)), '60 863,83');
});

test('format.js: parsePLN — обратная операция', () => {
  assert.equal(parsePLN('55 504,96'), 5550496);
  assert.equal(parsePLN('-5 829,70'), -582970);
});

// ---------------------------------------------------------------------------
// Acceptance-тест: реальная фактура на 5 машин (1203, 1210, 1220, 1240, 1299).
// ---------------------------------------------------------------------------

test('ACCEPTANCE: реальная фактура 5 машин — все контрольные суммы', () => {
  const inv = recalc(buildSampleInvoice());
  const w = inv.summary.wynagrodzenie;

  assert.equal(w.doreczenie, 5550496, `Doręczenie: ${formatPLN(w.doreczenie)}`);
  assert.equal(w.odbior, 212913, `Odbiór: ${formatPLN(w.odbior)}`);
  assert.equal(w.uslugi, -582970, `Usługi: ${formatPLN(w.uslugi)}`);
  assert.equal(w.bonusMalus, 194400, `Bonus/Malus: ${formatPLN(w.bonusMalus)}`);
  assert.equal(w.dodatkowePozycje, 239714, `Dodatkowe pozycje: ${formatPLN(w.dodatkowePozycje)}`);
  assert.equal(w.ooh, 471830, `OOH: ${formatPLN(w.ooh)}`);
  assert.equal(w.razem, 6086383, `RAZEM: ${formatPLN(w.razem)}`);
  assert.equal(inv.summary.oplaty.razem, 307023, `Opłaty: ${formatPLN(inv.summary.oplaty.razem)}`);

  const g10 = inv.summary.group000010;
  assert.deepEqual(g10.tiers.map((t) => t.qty), [3500, 1300, 4659]);
  assert.equal(inv.summary.group000004.qty, 1731);

  // те же числа, отформатированные — как их увидит пользователь
  assert.equal(formatPLN(w.doreczenie), '55 504,96');
  assert.equal(formatPLN(w.odbior), '2 129,13');
  assert.equal(formatPLN(w.uslugi), '-5 829,70');
  assert.equal(formatPLN(w.bonusMalus), '1 944,00');
  assert.equal(formatPLN(w.dodatkowePozycje), '2 397,14');
  assert.equal(formatPLN(w.ooh), '4 718,30');
  assert.equal(formatPLN(w.razem), '60 863,83');
  assert.equal(formatPLN(inv.summary.oplaty.razem), '3 070,23');
});

test('ACCEPTANCE: valueOverridden строки в Opłaty (NP_ELOADING, NP_REINV_DEL)', () => {
  const inv = recalc(buildSampleInvoice());
  const eloading = inv.fees.find((f) => f.name === 'NP_ELOADING');
  const reinvDel = inv.fees.find((f) => f.name === 'NP_REINV_DEL');

  assert.ok(eloading.valueOverridden, 'NP_ELOADING должен быть помечен valueOverridden');
  assert.equal(eloading.qty * eloading.unitPrice, 13100, 'qty*unitPrice = 131.00 zł (не используется)');
  assert.equal(eloading.value, 13076, 'фактический value = 130.76 zł');

  assert.ok(reinvDel.valueOverridden, 'NP_REINV_DEL должен быть помечен valueOverridden');
  assert.equal(reinvDel.qty * reinvDel.unitPrice, 179300, 'qty*unitPrice = 1793.00 zł (не используется)');
  assert.equal(reinvDel.value, 179299, 'фактический value = 1792.99 zł');
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
