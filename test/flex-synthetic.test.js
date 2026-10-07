// test/flex-synthetic.test.js
// Запуск: node test/flex-synthetic.test.js (или npm test).
//
// ТЕСТЫ НА ГИБКОСТЬ: приложение не должно зависеть ни от каких "констант"
// конкретной фактуры. Мы трижды ловили баги из-за хардкода (границы тиров
// 3500→4600, код группы 000010→000017, "Pojazd" без номера), поэтому здесь
// СИНТЕТИЧЕСКИЕ фактуры с заведомо другими данными: любые номера машин и
// их число (1…30+), 2 и 4 тира с другими границами и ставками, другие коды
// групп, машины без отдельных блоков, перенос таблиц между страницами с
// повторными шапками, блоки в другом порядке. Для парсера генерируется
// поток токенов в том же виде, в каком его отдаёт tokenize.js для
// реального PDF (порядок ячеек подсмотрен в трёх реальных образцах).
//
// Проверяются все слои без браузера: model → recalc → parse → reconcile →
// salary-calc → ai/ops + ai/context-builder. Печать (print.js) DOM-зависима
// и проверяется вживую (Playwright) — см. CLAUDE.md.

import assert from 'node:assert/strict';
import {
  createInvoice,
  createVehicle,
  zlToGr,
  getTierTemplate,
  getPickupTemplate,
  realVehicles,
  VIRTUAL_VEHICLE_ID,
  DEFAULT_GROUP_CODES,
} from '../src/model.js';
import { recalc } from '../src/recalc.js';
import { parseTokens } from '../src/pdf/parse-invoice.js';
import { reconcile } from '../src/pdf/reconcile.js';
import { formatPLN, formatInt } from '../src/format.js';
import { vehicleBase, buildCourierRows } from '../src/salary-calc.js';
import { resolveOp, applyResolved } from '../src/ai/ops.js';
import { buildInvoiceContext } from '../src/ai/context-builder.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Генератор потока токенов "как из PDF" по произвольной спецификации.
//
// spec = {
//   groups: { pickup, delivery },           // коды "Grupa pojazdów", любые
//   tiers: [{ label, rate }],               // тиры доставки, любое число
//   pickupLabel, pickupRate,
//   vehicles: [{ id, deliveryQtys?, pickupQty?, ooh?, surcharges?, bonusMalus?, extra? }],
//   virtual: { extra?: [...] },             // общий блок "Pojazd" без номера
//   fees: [{ name, vehicle?, opis, qty, unitPrice }],
//   options: { splitUslugi, repeatHeaderInOoh, splitOplaty, oohFirst }
// }
// Строки — {name, qty, unitPrice} (гроши), value = qty*unitPrice.

const HDR_STD = ['Paczki', 'Ilość', 'Cena jedn. (PLN)', 'Wartość (PLN)'];
const HDR_OOH = ['Nazwa usługi', 'Ilość', 'Cena jedn. (PLN)', 'Wartość (PLN)'];
const HDR_USL = ['Ilość', 'Cena jedn. (PLN)', 'Wartość (PLN)'];
const HDR_FEES = ['Materiał', 'Numer pojazdu', 'Opis', 'Ilość', 'Cena jedn.(PLN)', 'Wartość (PLN)'];

const money = (gr) => formatPLN(gr);
const int = (n) => formatInt(n);
const lineValue = (l) => l.qty * l.unitPrice;
const sumLines = (lines) => lines.reduce((s, l) => s + lineValue(l), 0);

function buildTokens(spec) {
  const o = spec.options || {};
  const t = [];
  t.push('Specyfikacja miesięczna Marzec 2027', 'Data wydruku', '05.04.2027', 'Nazwa dostawcy', 'TEST SP. Z O.O.', 'Nr dostawcy', '1234567890', 'Nr kontraktu', '4600009999');

  const vehicles = spec.vehicles;
  const tiers = spec.tiers;
  const pickupLabel = spec.pickupLabel ?? 'Ponad 0';
  const pickupRate = spec.pickupRate ?? 123;

  const vPickupQty = (v) => v.pickupQty ?? 0;
  const vTierQty = (v, i) => (v.deliveryQtys ? v.deliveryQtys[i] ?? 0 : 0);
  const vDeliveryQty = (v) => tiers.reduce((s, _, i) => s + vTierQty(v, i), 0);
  const vDeliveryValue = (v) => tiers.reduce((s, tier, i) => s + vTierQty(v, i) * tier.rate, 0);

  const totalPickupQty = vehicles.reduce((s, v) => s + vPickupQty(v), 0);
  const totalPickupValue = totalPickupQty * pickupRate;
  const totalTierQty = tiers.map((_, i) => vehicles.reduce((s, v) => s + vTierQty(v, i), 0));
  const totalDeliveryQty = totalTierQty.reduce((s, q) => s + q, 0);
  const totalDeliveryValue = tiers.reduce((s, tier, i) => s + totalTierQty[i] * tier.rate, 0);

  const anyPickup = vehicles.some((v) => vPickupQty(v) > 0);
  const anyDelivery = vehicles.some((v) => vDeliveryQty(v) > 0);

  // --- общие сводки (GLS не печатает сводку с 0 paczek)
  if (anyPickup) {
    t.push('Łączny przegląd dla wszystkich grup pojazdów (za paczkę)', 'Grupa pojazdów', spec.groups.pickup, ...HDR_STD);
    t.push(pickupLabel, int(totalPickupQty), money(pickupRate), money(totalPickupValue));
    t.push('Odbiór, za paczkę', 'RAZEM:', int(totalPickupQty), money(totalPickupValue));
  }
  if (anyDelivery) {
    t.push('Łączny przegląd dla wszystkich grup pojazdów (za paczkę)', 'Grupa pojazdów', spec.groups.delivery, ...HDR_STD);
    tiers.forEach((tier, i) => t.push(tier.label, int(totalTierQty[i]), money(tier.rate), money(totalTierQty[i] * tier.rate)));
    t.push('Doręczenie, za paczkę', 'RAZEM:', int(totalDeliveryQty), money(totalDeliveryValue));
  }

  const pushOoh = (v) => {
    if (!v.ooh || !v.ooh.length) return;
    t.push('OOH', 'Pojazd', v.id, ...HDR_OOH);
    v.ooh.forEach((l, i) => {
      if (o.repeatHeaderInOoh && i === Math.floor(v.ooh.length / 2)) t.push(...HDR_OOH); // перенос страницы: шапка повторилась
      t.push(l.name, int(l.qty), money(l.unitPrice), money(lineValue(l)));
    });
    t.push('RAZEM:', money(sumLines(v.ooh)));
  };

  if (o.oohFirst) vehicles.forEach(pushOoh);

  // --- по машинам: pickup, затем delivery (как в образцах: все pickup, потом все delivery)
  vehicles.forEach((v) => {
    if (vPickupQty(v) === 0) return;
    t.push('Pojazdy z grupy pojazdów (za paczkę)', 'Pojazd', v.id, 'Grupa pojazdów', spec.groups.pickup, ...HDR_STD);
    t.push(pickupLabel, int(vPickupQty(v)), money(pickupRate), money(vPickupQty(v) * pickupRate));
    t.push('Odbiór, za paczkę', 'RAZEM:', int(vPickupQty(v)), money(vPickupQty(v) * pickupRate));
  });
  vehicles.forEach((v) => {
    if (vDeliveryQty(v) === 0) return;
    t.push('Pojazdy z grupy pojazdów (za paczkę)', 'Pojazd', v.id, 'Grupa pojazdów', spec.groups.delivery, ...HDR_STD);
    tiers.forEach((tier, i) => t.push(tier.label, int(vTierQty(v, i)), money(tier.rate), money(vTierQty(v, i) * tier.rate)));
    t.push('Doręczenie, za paczkę', 'RAZEM:', int(vDeliveryQty(v)), money(vDeliveryValue(v)));
  });

  if (!o.oohFirst) vehicles.forEach(pushOoh);

  // --- Usługi pojazdów: 0..3 под-таблицы, только непустые
  const SUB = [
    ['surcharges', 'Usługi (Dopłaty)'],
    ['bonusMalus', 'Bonus/Malus'],
    ['extra', 'Dodatkowe pozycje'],
  ];
  const pushUslugi = (id, v) => {
    const present = SUB.filter(([key]) => v[key] && v[key].length);
    if (!present.length) return;
    const pushSub = (key, footer, lines) => {
      t.push(...HDR_USL);
      lines.forEach((l) => t.push(l.name, int(l.qty), money(l.unitPrice), money(lineValue(l))));
      t.push(footer, 'RAZEM:', money(sumLines(lines)));
    };
    if (o.splitUslugi && v.surcharges && v.surcharges.length >= 2) {
      // первая под-таблица порвана на две страницы: якорь + "Pojazd" + id печатаются заново
      const half = Math.ceil(v.surcharges.length / 2);
      t.push('Usługi pojazdów', 'Pojazd');
      if (id !== null) t.push(id);
      pushSub('surcharges', 'Usługi (Dopłaty)', v.surcharges.slice(0, half));
      t.push('Usługi pojazdów', 'Pojazd');
      if (id !== null) t.push(id);
      pushSub('surcharges', 'Usługi (Dopłaty)', v.surcharges.slice(half));
      present.filter(([key]) => key !== 'surcharges').forEach(([key, footer]) => pushSub(key, footer, v[key]));
      return;
    }
    t.push('Usługi pojazdów', 'Pojazd');
    if (id !== null) t.push(id);
    present.forEach(([key, footer]) => pushSub(key, footer, v[key]));
  };
  if (spec.virtual) pushUslugi(null, spec.virtual);
  vehicles.forEach((v) => pushUslugi(v.id, v));

  // --- Wynagrodzenie ogółem
  const all = spec.virtual ? [...vehicles, spec.virtual] : vehicles;
  const sumKey = (key) => all.reduce((s, v) => s + sumLines(v[key] || []), 0);
  const uslugi = sumKey('surcharges');
  const bonus = sumKey('bonusMalus');
  const extra = sumKey('extra');
  const ooh = sumKey('ooh');
  const razem = totalDeliveryValue + totalPickupValue + uslugi + bonus + extra + ooh;
  t.push('Wynagrodzenie ogółem (PLN)', 'Paczki (ilość)', 'Wynagrodzenie - razem');
  t.push('Doręczenie (za paczkę)', int(totalDeliveryQty), money(totalDeliveryValue));
  t.push('Odbiór (za paczkę)', int(totalPickupQty), money(totalPickupValue));
  t.push('Usługi', money(uslugi), 'Bonus/Malus', money(bonus), 'Dodatkowe pozycje', money(extra), 'OOH', money(ooh));
  t.push('RAZEM:', money(razem));

  // --- Opłaty
  const fees = spec.fees || [];
  const pushFeeRows = (rows) => {
    rows.forEach((f) => {
      t.push(f.name);
      if (f.vehicle) t.push(f.vehicle);
      t.push(f.opis, int(f.qty), money(f.unitPrice), money(lineValue(f)));
    });
  };
  if (o.splitOplaty && fees.length >= 2) {
    const half = Math.ceil(fees.length / 2);
    t.push('Opłaty', ...HDR_FEES);
    pushFeeRows(fees.slice(0, half));
    t.push(...HDR_FEES); // перенос страницы: шапка повторилась внутри таблицы
    pushFeeRows(fees.slice(half));
    t.push('RAZEM:', money(sumLines(fees)));
  } else {
    t.push('Opłaty', ...HDR_FEES);
    pushFeeRows(fees);
    t.push('RAZEM:', money(sumLines(fees)));
  }

  return { tokens: t, expected: { razem, uslugi, bonus, extra, ooh, totalDeliveryQty, totalDeliveryValue, totalPickupQty, totalPickupValue, fees: sumLines(fees) } };
}

function parseSpec(spec) {
  const { tokens, expected } = buildTokens(spec);
  const report = parseTokens(tokens);
  recalc(report.invoice);
  return { ...report, expected, tokens };
}

function assertClean(report, label) {
  assert.deepEqual(report.warnings, [], `${label}: предупреждения парсера:\n${JSON.stringify(report.warnings, null, 2)}`);
  const bad = reconcile(report.invoice, report.printed).filter((r) => !r.ok);
  assert.deepEqual(bad, [], `${label}: расхождения сверки:\n${JSON.stringify(bad, null, 2)}`);
}

// ---------------------------------------------------------------------------
// Спецификации

const TIERS4 = [
  { label: 'Poniżej 2000', rate: zlToGr(8.1) },
  { label: '2000-3000', rate: zlToGr(7.25) },
  { label: '3000-5000', rate: zlToGr(6.4) },
  { label: 'Ponad 5000', rate: zlToGr(5.95) },
];
const TIERS2 = [
  { label: 'Do 1000', rate: zlToGr(9.0) },
  { label: 'Powyżej 1000', rate: zlToGr(7.5) },
];
const GROUPS_X = { pickup: '5000000888/000031', delivery: '5000000888/000077' };

function specFourTiers() {
  return {
    groups: GROUPS_X,
    tiers: TIERS4,
    pickupLabel: 'Ponad 0',
    pickupRate: zlToGr(1.41),
    vehicles: [
      { id: '5110', deliveryQtys: [100, 200, 300, 400], pickupQty: 50, ooh: [{ name: 'Doręczenie APM', qty: 10, unitPrice: zlToGr(0.7) }], surcharges: [{ name: 'PGB (X_123)', qty: 2, unitPrice: zlToGr(-20) }, { name: 'Dopłata paliwowa', qty: 1, unitPrice: zlToGr(55.5) }], bonusMalus: [{ name: 'Eco Bonus', qty: 1, unitPrice: zlToGr(300) }], extra: [{ name: 'Extra doręczenia (A. B.)', qty: 3, unitPrice: zlToGr(10) }] },
      { id: '7', deliveryQtys: [1, 2, 3, 4], pickupQty: 0, surcharges: [{ name: 'PGB (Q_9)', qty: 1, unitPrice: zlToGr(-20) }] }, // без pickup, без OOH, без Bonus/Malus, без extra
      { id: 'A12', deliveryQtys: [0, 0, 0, 0], pickupQty: 12, ooh: [{ name: 'STOP APM-MIX', qty: 4, unitPrice: zlToGr(3) }] }, // без delivery вообще
      { id: '1230', deliveryQtys: [5, 5, 5, 5], pickupQty: 5, bonusMalus: [{ name: 'Malus jakość', qty: 1, unitPrice: zlToGr(-150) }] },
      { id: '99999', deliveryQtys: [7, 0, 0, 1], pickupQty: 1 },
    ],
    virtual: { extra: [{ name: 'Usługi dodatkowe (pomoc)', qty: 11, unitPrice: zlToGr(10) }, { name: 'Extra doręczenia (skoczek)', qty: 2, unitPrice: zlToGr(4.32) }] },
    fees: [
      { name: 'NP_NEW_CODE', vehicle: '', opis: 'Zupełnie nowa usługa', qty: 3, unitPrice: zlToGr(12.5) },
      { name: 'NP_PNLT_X', vehicle: '5110', opis: 'Kara za coś', qty: 1, unitPrice: zlToGr(200) },
      { name: 'NP_PNLT_X', vehicle: '1230', opis: 'Kara za coś', qty: 1, unitPrice: zlToGr(200) },
      { name: 'NP_PNLT_X', vehicle: '7', opis: 'Kara za coś', qty: 2, unitPrice: zlToGr(200) },
    ],
  };
}

function specTwoTiersOneVehicle() {
  return {
    groups: { pickup: '1111111111/000001', delivery: '1111111111/000002' },
    tiers: TIERS2,
    pickupLabel: 'Ponad 0',
    pickupRate: zlToGr(2.0),
    vehicles: [{ id: '42', deliveryQtys: [800, 250], pickupQty: 0 }], // одна машина, без pickup, без OOH/Usługi
    fees: [],
  };
}

function specManyVehicles(n) {
  const vehicles = [];
  for (let i = 0; i < n; i += 1) {
    vehicles.push({
      id: String(6000 + i * 7),
      deliveryQtys: [i + 1, (i * 3) % 50, i * 2],
      pickupQty: i % 4 === 0 ? 0 : i + 10,
      ooh: i % 3 === 0 ? [{ name: `Odbiór APM`, qty: i + 1, unitPrice: zlToGr(0.65) }] : [],
      surcharges: i % 2 === 0 ? [{ name: `PGB (S_${1000 + i})`, qty: 1, unitPrice: zlToGr(-20) }] : [],
      bonusMalus: i % 5 === 0 ? [{ name: 'Eco Bonus', qty: 1, unitPrice: zlToGr(100) }] : [],
      extra: [],
    });
  }
  return {
    groups: { pickup: '5000000215/000004', delivery: '5000000215/000123' },
    tiers: [
      { label: 'Poniżej 4600', rate: zlToGr(6.2) },
      { label: '4600-6400', rate: zlToGr(5.54) },
      { label: 'Ponad 6400', rate: zlToGr(5.43) },
    ],
    pickupRate: zlToGr(1.3),
    vehicles,
    fees: [{ name: 'NP_ADD_SUBC', vehicle: '', opis: 'Wynagrodzenie zgodnie z par.5 ust.10 um.', qty: 15000, unitPrice: zlToGr(0.02) }],
  };
}

// ---------------------------------------------------------------------------
// model + recalc

test('model: createVehicle с 4 тирами и с 2 тирами — число тиров из данных, не 3', () => {
  const v4 = createVehicle({ id: 'X', deliveryQtys: [1, 2, 3, 4], deliveryRates: TIERS4.map((t) => t.rate), deliveryLabels: TIERS4.map((t) => t.label) });
  assert.equal(v4.delivery.tiers.length, 4);
  assert.deepEqual(v4.delivery.tiers.map((t) => t.label), TIERS4.map((t) => t.label));
  const v2 = createVehicle({ id: 'Y', deliveryQtys: [10, 20], deliveryRates: TIERS2.map((t) => t.rate), deliveryLabels: TIERS2.map((t) => t.label) });
  assert.equal(v2.delivery.tiers.length, 2);
});

test('recalc: сводка deliveryGroup имеет столько тиров, сколько у машин (4), суммы по индексам', () => {
  const mk = (id, qtys) => createVehicle({ id, deliveryQtys: qtys, deliveryRates: TIERS4.map((t) => t.rate), deliveryLabels: TIERS4.map((t) => t.label), pickupQty: 3, pickupRate: 150, pickupLabel: 'Ponad 0' });
  const inv = recalc(createInvoice({ groups: GROUPS_X, vehicles: [mk('a', [1, 2, 3, 4]), mk('b', [10, 20, 30, 40])] }));
  assert.equal(inv.summary.deliveryGroup.tiers.length, 4);
  assert.deepEqual(inv.summary.deliveryGroup.tiers.map((t) => t.qty), [11, 22, 33, 44]);
  assert.equal(inv.summary.deliveryGroup.razemQty, 110);
  assert.equal(inv.summary.deliveryGroup.razemValue, 11 * TIERS4[0].rate + 22 * TIERS4[1].rate + 33 * TIERS4[2].rate + 44 * TIERS4[3].rate);
  assert.equal(inv.summary.pickupGroup.qty, 6);
  assert.equal(inv.summary.pickupGroup.value, 6 * 150);
  assert.deepEqual(inv.groups, GROUPS_X);
});

test('recalc: фактура без единой машины — пустая сводка, без исключений', () => {
  const inv = recalc(createInvoice({ vehicles: [], fees: [{ name: 'X', qty: 1, unitPrice: 5 }] }));
  assert.equal(inv.summary.deliveryGroup.tiers.length, 0);
  assert.equal(inv.summary.wynagrodzenie.razem, 0);
  assert.equal(inv.summary.oplaty.razem, 5);
  assert.deepEqual(inv.groups, DEFAULT_GROUP_CODES);
});

test('getTierTemplate/getPickupTemplate: шаблон из первой РЕАЛЬНОЙ машины, виртуальная пропускается', () => {
  const virt = createVehicle({ id: VIRTUAL_VEHICLE_ID, deliveryRates: [1], deliveryLabels: ['virt'], extra: [{ name: 'Общее', qty: 1, unitPrice: 100 }] });
  const real = createVehicle({ id: '5110', deliveryQtys: [1, 1], deliveryRates: TIERS2.map((t) => t.rate), deliveryLabels: TIERS2.map((t) => t.label), pickupRate: 777, pickupLabel: 'Ponad 0' });
  const inv = recalc(createInvoice({ vehicles: [virt, real] }));
  assert.deepEqual(getTierTemplate(inv).labels, TIERS2.map((t) => t.label));
  assert.deepEqual(getTierTemplate(inv).rates, TIERS2.map((t) => t.rate));
  assert.equal(getPickupTemplate(inv).rate, 777);
  assert.deepEqual(realVehicles(inv).map((v) => v.id), ['5110']);
});

// ---------------------------------------------------------------------------
// parser

test('parser: 4 тира, другие границы/ставки, код группы .../000077, машины 5110/7/A12/1230/99999 — без предупреждений, сверка сходится', () => {
  const r = parseSpec(specFourTiers());
  assertClean(r, '4 тира');
  const inv = r.invoice;
  assert.deepEqual(inv.groups, GROUPS_X);
  assert.deepEqual(realVehicles(inv).map((v) => v.id).sort(), ['1230', '5110', '7', '99999', 'A12'].sort());
  const v = inv.vehicles.find((x) => x.id === '5110');
  assert.equal(v.delivery.tiers.length, 4);
  assert.deepEqual(v.delivery.tiers.map((t) => t.label), TIERS4.map((t) => t.label));
  assert.deepEqual(v.delivery.tiers.map((t) => t.rate), TIERS4.map((t) => t.rate));
  assert.deepEqual(v.delivery.tiers.map((t) => t.qty), [100, 200, 300, 400]);
  assert.equal(v.pickup.rate, zlToGr(1.41));
  assert.equal(inv.summary.deliveryGroup.tiers.length, 4);
  assert.equal(inv.summary.wynagrodzenie.razem, r.expected.razem);
  assert.equal(inv.summary.oplaty.razem, r.expected.fees);
});

test('parser: машина без pickup/OOH/Bonus/extra ("7") и машина без delivery ("A12") — блоки отсутствуют, дефолт из этой же фактуры', () => {
  const r = parseSpec(specFourTiers());
  const inv = r.invoice;
  const v7 = inv.vehicles.find((x) => x.id === '7');
  assert.equal(v7.pickup.qty, 0);
  assert.equal(v7.pickup.rate, zlToGr(1.41), 'ставка pickup для машины без блока — из общей сводки этой фактуры, не константа');
  assert.deepEqual(v7.ooh, []);
  assert.deepEqual(v7.bonusMalus, []);
  assert.deepEqual(v7.extra, []);
  assert.equal(v7.surcharges.length, 1);
  const a12 = inv.vehicles.find((x) => x.id === 'A12');
  assert.equal(a12.delivery.tiers.length, 4, 'машина без блока delivery получает 4 тира-шаблона этой фактуры, не 3');
  assert.deepEqual(a12.delivery.tiers.map((t) => t.label), TIERS4.map((t) => t.label));
  assert.deepEqual(a12.delivery.tiers.map((t) => t.rate), TIERS4.map((t) => t.rate));
  assert.equal(a12.delivery.razemQty, 0);
  assert.equal(a12.pickup.qty, 12);
});

test('parser: общий блок "Pojazd" без номера → виртуальная машина, его сумма в Dodatkowe pozycje', () => {
  const r = parseSpec(specFourTiers());
  const virt = r.invoice.vehicles.find((x) => x.id === VIRTUAL_VEHICLE_ID);
  assert.ok(virt, 'должна быть виртуальная машина');
  assert.equal(virt.extra.length, 2);
  assert.equal(virt.extraRazem, 11 * zlToGr(10) + 2 * zlToGr(4.32));
  assert.equal(r.invoice.summary.wynagrodzenie.dodatkowePozycje, r.expected.extra);
});

test('parser: Opłaty — один код трижды для разных машин, vehicle/opis на строке, новые коды', () => {
  const r = parseSpec(specFourTiers());
  const rows = r.invoice.fees.filter((f) => f.name === 'NP_PNLT_X');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((x) => x.vehicle).sort(), ['1230', '5110', '7']);
  assert.ok(r.invoice.fees.some((f) => f.name === 'NP_NEW_CODE' && f.opis === 'Zupełnie nowa usługa'));
});

test('parser: 2 тира, одна машина, без pickup, без OOH/Usługi, без Opłaty-строк', () => {
  const r = parseSpec(specTwoTiersOneVehicle());
  assertClean(r, '2 тира');
  const inv = r.invoice;
  assert.equal(inv.vehicles.length, 1);
  assert.equal(inv.vehicles[0].id, '42');
  assert.equal(inv.vehicles[0].delivery.tiers.length, 2);
  assert.deepEqual(inv.vehicles[0].delivery.tiers.map((t) => t.label), ['Do 1000', 'Powyżej 1000']);
  assert.equal(inv.summary.deliveryGroup.tiers.length, 2);
  assert.equal(inv.summary.pickupGroup.qty, 0);
  assert.equal(inv.groups.delivery, '1111111111/000002');
  assert.equal(inv.groups.pickup, DEFAULT_GROUP_CODES.pickup, 'pickup-блока в PDF нет — код группы остаётся дефолтным');
  assert.equal(inv.summary.wynagrodzenie.razem, r.expected.razem);
  assert.equal(inv.fees.length, 0);
});

test('parser: 30 машин с произвольными номерами — все найдены, суммы сходятся', () => {
  const r = parseSpec(specManyVehicles(30));
  assertClean(r, '30 машин');
  assert.equal(r.invoice.vehicles.length, 30);
  // порядок машин = порядок первого появления в PDF (6000 без pickup появляется позже 6007)
  const ids = r.invoice.vehicles.map((v) => v.id);
  assert.ok(ids.includes('6000') && ids.includes(String(6000 + 29 * 7)));
  assert.equal(new Set(ids).size, 30);
  assert.equal(r.invoice.summary.wynagrodzenie.razem, r.expected.razem);
  assert.equal(r.invoice.groups.delivery, '5000000215/000123');
});

test('parser: перенос таблиц между страницами — Usługi порваны с повторной шапкой "Pojazd"+id, шапка колонок повторена в OOH и в Opłaty — склеено', () => {
  const spec = specFourTiers();
  spec.vehicles[0].ooh = [
    { name: 'Doręczenie APM', qty: 10, unitPrice: zlToGr(0.7) },
    { name: 'Odbiór APM', qty: 3, unitPrice: zlToGr(0.7) },
    { name: 'STOP APM-MIX', qty: 2, unitPrice: zlToGr(3) },
  ];
  spec.options = { splitUslugi: true, repeatHeaderInOoh: true, splitOplaty: true };
  const r = parseSpec(spec);
  assertClean(r, 'перенос');
  const v = r.invoice.vehicles.find((x) => x.id === '5110');
  assert.equal(v.surcharges.length, 2, 'строки Usługi (Dopłaty) из двух кусков склеены');
  assert.equal(v.ooh.length, 3, 'повторная шапка колонок внутри OOH не стала строкой');
  assert.equal(r.invoice.fees.length, 4, 'повторная шапка колонок внутри Opłaty не стала строкой');
  assert.equal(r.invoice.summary.wynagrodzenie.razem, r.expected.razem);
});

test('parser: блоки в другом порядке (OOH до блоков pickup/delivery) — диспетчер по якорю, без предупреждений', () => {
  const spec = specFourTiers();
  spec.options = { oohFirst: true };
  const r = parseSpec(spec);
  assertClean(r, 'другой порядок');
  assert.equal(r.invoice.summary.wynagrodzenie.razem, r.expected.razem);
});

test('parser: нестандартная подпись pickup (не "Ponad 0") и тип блока по подписи "Odbiór, za paczkę"', () => {
  const spec = specTwoTiersOneVehicle();
  spec.pickupLabel = 'Wszystkie';
  spec.vehicles[0].pickupQty = 17;
  const r = parseSpec(spec);
  assertClean(r, 'подпись pickup');
  assert.equal(r.invoice.vehicles[0].pickup.label, 'Wszystkie');
  assert.equal(r.invoice.vehicles[0].pickup.qty, 17);
  assert.equal(r.invoice.summary.pickupGroup.qty, 17);
});

// ---------------------------------------------------------------------------
// reconcile labels / salary / ai

test('reconcile: подписи сводок несут код группы из фактуры, а не 000004/000010', () => {
  const r = parseSpec(specFourTiers());
  const rows = reconcile(r.invoice, r.printed);
  assert.ok(rows.some((x) => x.label.includes('5000000888/000077')), 'delivery-код из PDF');
  assert.ok(rows.some((x) => x.label.includes('5000000888/000031')), 'pickup-код из PDF');
  assert.ok(!rows.some((x) => x.label.includes('000010') || x.label.includes('000004')));
});

test('salary-calc: Σ vehicleBase == RAZEM на 30 произвольных машинах и на 4 тирах с виртуальной', () => {
  for (const spec of [specManyVehicles(30), specFourTiers()]) {
    const r = parseSpec(spec);
    const sum = r.invoice.vehicles.reduce((s, v) => s + vehicleBase(v), 0);
    assert.equal(sum, r.invoice.summary.wynagrodzenie.razem);
    const rows = buildCourierRows(r.invoice.vehicles, [{ id: 'g', memberIds: [r.invoice.vehicles[0].id, r.invoice.vehicles[1].id] }], new Map());
    assert.equal(rows.length, r.invoice.vehicles.length - 1);
    assert.equal(rows.reduce((s, x) => s + x.base, 0), r.invoice.summary.wynagrodzenie.razem);
  }
});

test('ai/ops setRates: число ставок = числу тиров фактуры (4 ок, 3 — отказ) и применяется ко всем машинам', () => {
  const r = parseSpec(specFourTiers());
  const bad = resolveOp(r.invoice, { op: 'setRates', rates: [6, 5.3, 5.2] });
  assert.equal(bad.ok, false);
  assert.match(bad.description, /4 чисел/);
  const good = resolveOp(r.invoice, { op: 'setRates', rates: [9, 8, 7, 6] });
  assert.equal(good.ok, true);
  applyResolved([good]);
  recalc(r.invoice);
  r.invoice.vehicles.forEach((v) => assert.deepEqual(v.delivery.tiers.map((t) => t.rate), [900, 800, 700, 600]));
  const two = parseSpec(specTwoTiersOneVehicle());
  assert.equal(resolveOp(two.invoice, { op: 'setRates', rates: [9, 8] }).ok, true);
  assert.equal(resolveOp(two.invoice, { op: 'setRates', rates: [9, 8, 7] }).ok, false);
});

test('ai/context-builder: контекст перечисляет реальные тиры фактуры (4 названия), без "Poniżej 3500"', () => {
  const r = parseSpec(specFourTiers());
  const ctx = buildInvoiceContext(r.invoice);
  assert.ok(ctx.includes('Тиры доставки (4 шт.'), ctx.split('\n')[0]);
  TIERS4.forEach((t) => assert.ok(ctx.includes(t.label), `нет тира ${t.label}`));
  assert.ok(!ctx.includes('Poniżej 3500'));
  assert.ok(ctx.includes('Машина A12:'));
});

// ---------------------------------------------------------------------------

let failed = 0;
for (const { name, fn } of tests) {
  try {
    // eslint-disable-next-line no-await-in-loop
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
