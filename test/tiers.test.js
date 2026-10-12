// test/tiers.test.js
// Запуск: node test/tiers.test.js (или npm test).
// Пороги тиров (src/tiers.js): разбор чисел из названий и перераспределение
// количеств по накопительной модели при смене порогов.

import assert from 'node:assert/strict';
import { createInvoice, createVehicle, zlToGr } from '../src/model.js';
import { recalc } from '../src/recalc.js';
import { parseThresholds, redistributeTiers, applyTierLabels } from '../src/tiers.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const LABELS = ['Poniżej 4600', '4600-6400', 'Ponad 6400'];
const RATES = [zlToGr(6.2), zlToGr(5.54), zlToGr(5.43)];

// Разбивка по машинам как в LPL 09/2026 (тир 3 округлён): сводка 4 600 / 1 800 / 10 365 = 16 765
function lplVehicles() {
  const mk = (id, qtys) => createVehicle({ id, deliveryQtys: qtys, deliveryRates: RATES, deliveryLabels: LABELS, pickupQty: 0 });
  return [
    mk('5110', [0, 0, 126]),
    mk('5125', [0, 0, 999]),
    mk('5130', [0, 82, 44]),
    mk('5135', [201, 76, 722]),
    mk('5145', [743, 307, 1405]),
    mk('5150', [941, 378, 1612]),
    mk('5160', [977, 306, 1450]),
    mk('5170', [882, 299, 1542]),
    mk('5180', [843, 352, 1581]),
    mk('5190', [13, 0, 884]),
  ];
}
const sumTier = (vs, i) => vs.reduce((s, v) => s + v.delivery.tiers[i].qty, 0);
const vTotal = (v) => v.delivery.tiers.reduce((s, t) => s + t.qty, 0);

test('parseThresholds: «Poniżej 4600 / 4600-6400 / Ponad 6400» → [4600, 6400]; 4 тира; с пробелами-разделителями; мусор → null', () => {
  assert.deepEqual(parseThresholds(LABELS), [4600, 6400]);
  assert.deepEqual(parseThresholds(['Poniżej 3500', '3500-4800', 'Ponad 4800']), [3500, 4800]);
  assert.deepEqual(parseThresholds(['Do 2000', '2000-3000', '3000-5000', 'Powyżej 5000']), [2000, 3000, 5000]);
  assert.deepEqual(parseThresholds(['Poniżej 4 600', '4 600-6 400', 'Ponad 6 400']), [4600, 6400]);
  assert.equal(parseThresholds(['Poniżej 7000', '4600-6400', 'Ponad 6400']), null); // не по возрастанию
  assert.equal(parseThresholds(['Mało', 'Średnio', 'Dużo']), null);
  assert.equal(parseThresholds(['Ponad 0']), null);
});

test('redistributeTiers: сводка = новым порогам ровно, суммы по машинам не меняются, целые и ≥ 0', () => {
  const vs = lplVehicles();
  const before = vs.map(vTotal);
  assert.deepEqual([sumTier(vs, 0), sumTier(vs, 1), sumTier(vs, 2)], [4600, 1800, 10365]);
  const { tierTotals, total } = redistributeTiers(vs, [3500, 4800]);
  assert.equal(total, 16765);
  assert.deepEqual(tierTotals, [3500, 1300, 11965]);
  assert.deepEqual(vs.map(vTotal), before);
  vs.forEach((v) => v.delivery.tiers.forEach((t) => assert.ok(Number.isInteger(t.qty) && t.qty >= 0)));
  // машина без paczek в тире 1 (5130: 0/82/44) — при снижении порога тир 1 остаётся 0 (её paczki шли позже)
  const v5130 = vs.find((v) => v.id === '5130');
  assert.equal(v5130.delivery.tiers[0].qty, 0);
  // машина с 743 в тире 1 из первых 4600 → при пороге 3500 пропорционально ≈ 565
  const v5145 = vs.find((v) => v.id === '5145');
  assert.ok(Math.abs(v5145.delivery.tiers[0].qty - Math.round((743 * 3500) / 4600)) <= 1);
});

test('redistributeTiers: повышение порогов (6000/9000) — тир 1 растёт за счёт тира 2 и 3, суммы точные', () => {
  const vs = lplVehicles();
  const { tierTotals } = redistributeTiers(vs, [6000, 9000]);
  assert.deepEqual(tierTotals, [6000, 3000, 7765]);
  assert.deepEqual(vs.map(vTotal), lplVehicles().map(vTotal));
});

test('redistributeTiers: те же пороги → ничего не меняется; пороги выше общего числа paczek → всё в тир 1', () => {
  const vs = lplVehicles();
  const snapshot = vs.map((v) => v.delivery.tiers.map((t) => t.qty));
  redistributeTiers(vs, [4600, 6400]);
  assert.deepEqual(vs.map((v) => v.delivery.tiers.map((t) => t.qty)), snapshot);
  const vs2 = lplVehicles();
  const { tierTotals } = redistributeTiers(vs2, [20000, 30000]);
  assert.deepEqual(tierTotals, [16765, 0, 0]);
  vs2.forEach((v) => assert.equal(v.delivery.tiers[0].qty, vTotal(v)));
});

test('redistributeTiers: 4 тира и неправильное число порогов → исключение', () => {
  const mk = (id, qtys) => createVehicle({ id, deliveryQtys: qtys, deliveryRates: [1, 2, 3, 4], deliveryLabels: ['a', 'b', 'c', 'd'], pickupQty: 0 });
  const vs = [mk('1', [100, 200, 300, 400]), mk('2', [50, 50, 50, 50])];
  const { tierTotals } = redistributeTiers(vs, [100, 400, 700]);
  assert.deepEqual(tierTotals, [100, 300, 300, 500]);
  assert.throws(() => redistributeTiers(vs, [100, 400]));
});

test('applyTierLabels: меняет названия у всех машин и перераспределяет, если пороги изменились; после recalc сводка по новым порогам', () => {
  const inv = recalc(createInvoice({ vehicles: lplVehicles() }));
  const r = applyTierLabels(inv.vehicles, ['Poniżej 3500', '3500-4800', 'Ponad 4800']);
  assert.equal(r.redistributed, true);
  assert.deepEqual(r.thresholds, [3500, 4800]);
  recalc(inv);
  assert.deepEqual(inv.summary.deliveryGroup.tiers.map((t) => t.qty), [3500, 1300, 11965]);
  assert.equal(inv.summary.deliveryGroup.razemQty, 16765);
  assert.equal(inv.summary.deliveryGroup.razemValue, 3500 * RATES[0] + 1300 * RATES[1] + 11965 * RATES[2]);
  inv.vehicles.forEach((v) => assert.deepEqual(v.delivery.tiers.map((t) => t.label), ['Poniżej 3500', '3500-4800', 'Ponad 4800']));
  // только текст без чисел — названия меняются, количества нет
  const before = inv.vehicles.map((v) => v.delivery.tiers.map((t) => t.qty));
  const r2 = applyTierLabels(inv.vehicles, ['Lekkie', 'Średnie', 'Ciężkie']);
  assert.equal(r2.redistributed, false);
  assert.ok(r2.reason);
  assert.deepEqual(inv.vehicles.map((v) => v.delivery.tiers.map((t) => t.qty)), before);
});

let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ok  ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${t.name}\n${err.stack || err}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
