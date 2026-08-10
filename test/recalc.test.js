// test/recalc.test.js
// Запуск: node test/recalc.test.js  (или npm test)
// Без фреймворков — свой мини-раннер на assert из стандартной библиотеки Node.

import assert from 'node:assert/strict';
import { createInvoice, createVehicle, zlToGr } from '../src/model.js';
import { recalc } from '../src/recalc.js';
import { formatPLN, parsePLN } from '../src/format.js';

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
// TODO (следующий шаг Этапа 1): захардкодить реальную фактуру на 5 машин
// (1203, 1210, 1220, 1240, 1299) с фактическими qty/unitPrice/value по каждой
// строке ooh/surcharges/bonusMalus/extra/fees и проверить, что recalc() даёт
// ровно:
//   Doręczenie 55 504,96 / Odbiór 2 129,13 / Usługi -5 829,70 /
//   Bonus-Malus 1 944,00 / Dodatkowe pozycje 2 397,14 / OOH 4 718,30 /
//   RAZEM 60 863,83 / Opłaty RAZEM 3 070,23 /
//   group000010 qty per tier [3500, 1300, 4659] / group000004 qty 1731.
// Нужны реальные построчные цифры по каждой машине — жду их отдельным
// сообщением, синтетические числа сюда специально не вставлял, чтобы тест
// проверял настоящую фактуру, а не подогнанную под итоги фикцию.
// ---------------------------------------------------------------------------

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
