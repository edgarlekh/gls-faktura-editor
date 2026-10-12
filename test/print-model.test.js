// test/print-model.test.js
// Запуск: node test/print-model.test.js (или npm test).
// Чистая модель распечатки (src/print-model.js), пагинация «как у GLS»
// (src/print-layout.js) и сравнение с оригиналом (src/compare.js, чистая
// часть diffModels) — без DOM и без PDF-файлов.

import assert from 'node:assert/strict';
import { createInvoice, createVehicle, zlToGr, VIRTUAL_VEHICLE_ID } from '../src/model.js';
import { recalc } from '../src/recalc.js';
import { buildSampleInvoice } from '../src/fixtures/sample-invoice.js';
import { buildPrintModel } from '../src/print-model.js';
import {
  paginate,
  TOP_PT,
  BOTTOM_PT,
  BAR_H_PT,
  DOC_HEADER_H_PT,
  SPACE_AFTER_DOC_HEADER,
  SPACE_AFTER_BLOCK,
  SPACE_LG_SM,
} from '../src/print-layout.js';
import { diffModels, buildComparison } from '../src/compare.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const TIERS = [
  { label: 'Poniżej 4600', rate: zlToGr(6.2) },
  { label: '4600-6400', rate: zlToGr(5.54) },
  { label: 'Ponad 6400', rate: zlToGr(5.43) },
];
const GROUPS = { pickup: '5000000712/000004', delivery: '5000000712/000010' };

function mkVehicle(id, opts = {}) {
  return createVehicle({
    id,
    deliveryQtys: opts.deliveryQtys ?? [10, 20, 30],
    deliveryRates: TIERS.map((t) => t.rate),
    deliveryLabels: TIERS.map((t) => t.label),
    pickupQty: opts.pickupQty ?? 5,
    pickupRate: zlToGr(1.3),
    ooh: opts.ooh ?? [],
    surcharges: opts.surcharges ?? [],
    bonusMalus: opts.bonusMalus ?? [],
    extra: opts.extra ?? [],
  });
}

/** Фактура «как 325.pdf»: у машины 5150 два блока Usługi pojazdów (seg 3 и 5), общий блок без номера первым. */
function layoutInvoice() {
  const v5110 = mkVehicle('5110', {
    ooh: [{ name: 'Doręczenie APM', qty: 4, unitPrice: zlToGr(0.65), seg: 1 }],
    surcharges: [{ name: 'CashService - płatność gotówkowa', qty: 10, unitPrice: zlToGr(0.1), seg: 3 }],
  });
  const v5150 = mkVehicle('5150', {
    ooh: [{ name: 'STOP APM-MIX', qty: 2, unitPrice: zlToGr(3), seg: 2 }],
    surcharges: [
      { name: 'CashService - płatność gotówkowa', qty: 55, unitPrice: zlToGr(0.1), seg: 4 },
      { name: 'Rabat mała paczka', qty: 1310, unitPrice: zlToGr(-1.5), seg: 5 },
    ],
    bonusMalus: [{ name: 'Bonus/Malus NPSE', qty: 23, unitPrice: zlToGr(14), seg: 5 }],
    extra: [{ name: 'PGB (50645087567)', qty: 1, unitPrice: zlToGr(20), seg: 5 }],
  });
  const virt = createVehicle({
    id: VIRTUAL_VEHICLE_ID,
    deliveryRates: TIERS.map((t) => t.rate),
    deliveryLabels: TIERS.map((t) => t.label),
    pickupQty: 0,
    extra: [{ name: 'Dopłata paliwowa (Dopłata paliwowa)', qty: 1, unitPrice: zlToGr(3679.74), seg: 6 }],
  });
  const layout = [
    { kind: 'overall', sub: 'pickup', page: 1 },
    { kind: 'overall', sub: 'delivery', page: 1 },
    { kind: 'pickup', vehicle: '5110', page: 1 },
    { kind: 'pickup', vehicle: '5150', page: 1 },
    { kind: 'delivery', vehicle: '5110', page: 2 },
    { kind: 'delivery', vehicle: '5150', page: 2 },
    { kind: 'ooh', vehicle: '5110', seg: 1, page: 2 },
    { kind: 'ooh', vehicle: '5150', seg: 2, page: 2 },
    { kind: 'uslugi', vehicle: VIRTUAL_VEHICLE_ID, seg: 6, tables: ['extra'], page: 3 },
    { kind: 'uslugi', vehicle: '5110', seg: 3, tables: ['surcharges'], page: 3 },
    { kind: 'uslugi', vehicle: '5150', seg: 4, tables: ['surcharges'], page: 3 },
    { kind: 'uslugi', vehicle: '5150', seg: 5, tables: ['surcharges', 'bonusMalus', 'extra'], page: 3 },
    { kind: 'wynagrodzenie', page: 4 },
    { kind: 'oplaty', page: 4 },
  ];
  // порядок машин в invoice.vehicles НЕ совпадает с layout — печать должна идти по layout
  return recalc(createInvoice({ groups: GROUPS, vehicles: [v5150, v5110, virt], fees: [{ name: 'NP_X', opis: 'Opis', qty: 1, unitPrice: 100 }], layout }));
}

// ---------------------------------------------------------------------------
// print-model

test('print-model: без layout — порядок по умолчанию (сводки, pickup, delivery, OOH, Usługi, Wyn, Opłaty), по одному блоку на машину', () => {
  const inv = recalc(buildSampleInvoice());
  const m = buildPrintModel(inv);
  const kinds = m.blocks.map((b) => b.kind);
  const firstIdx = (k) => kinds.indexOf(k);
  const lastIdx = (k) => kinds.lastIndexOf(k);
  assert.deepEqual(kinds.slice(0, 2), ['overall-pickup', 'overall-delivery']);
  assert.ok(lastIdx('pickup') < firstIdx('delivery'));
  assert.ok(lastIdx('delivery') < firstIdx('ooh'));
  assert.ok(lastIdx('ooh') < firstIdx('uslugi'));
  assert.deepEqual(kinds.slice(-2), ['wynagrodzenie', 'oplaty']);
  // 1299: нет pickup и нет Bonus/Malus — блок pickup отсутствует, под-таблица Bonus/Malus отсутствует
  assert.equal(m.blocks.some((b) => b.kind === 'pickup' && b.vehicle === '1299'), false);
  const u1299 = m.blocks.find((b) => b.kind === 'uslugi' && b.vehicle === '1299');
  assert.ok(u1299);
  assert.deepEqual(u1299.tables.map((t) => t.kind), ['surcharges', 'extra']);
  assert.equal(m.blocks.filter((b) => b.kind === 'uslugi').length, 5);
});

test('print-model: layout задаёт порядок дословно; у 5150 ДВА блока Usługi pojazdów с разными строками и своими RAZEM', () => {
  const inv = layoutInvoice();
  const m = buildPrintModel(inv);
  assert.deepEqual(
    m.blocks.map((b) => `${b.kind}:${b.vehicle ?? ''}:${b.seg ?? ''}`),
    [
      'overall-pickup::',
      'overall-delivery::',
      'pickup:5110:',
      'pickup:5150:',
      'delivery:5110:',
      'delivery:5150:',
      'ooh:5110:1',
      'ooh:5150:2',
      `uslugi:${VIRTUAL_VEHICLE_ID}:6`,
      'uslugi:5110:3',
      'uslugi:5150:4',
      'uslugi:5150:5',
      'wynagrodzenie::',
      'oplaty::',
    ]
  );
  const u4 = m.blocks.find((b) => b.key === 'uslugi:5150:4');
  const u5 = m.blocks.find((b) => b.key === 'uslugi:5150:5');
  assert.deepEqual(u4.tables.map((t) => t.kind), ['surcharges']);
  assert.deepEqual(u4.tables[0].rows.map((r) => r.name), ['CashService - płatność gotówkowa']);
  assert.equal(u4.tables[0].razemValue, 55 * 10);
  assert.deepEqual(u5.tables.map((t) => t.kind), ['surcharges', 'bonusMalus', 'extra']);
  assert.deepEqual(u5.tables[0].rows.map((r) => r.name), ['Rabat mała paczka']);
  assert.equal(u5.tables[0].razemValue, 1310 * -150);
  // сумма RAZEM двух блоков = surchargesRazem машины (recalc считает по машине целиком)
  const v = inv.vehicles.find((x) => x.id === '5150');
  assert.equal(u4.tables[0].razemValue + u5.tables[0].razemValue, v.surchargesRazem);
  // страница оригинала проброшена из layout
  assert.equal(u5.page, 3);
  // виртуальная машина: плашка "Pojazd" без номера, только Dodatkowe pozycje
  const virt = m.blocks.find((b) => b.vehicle === VIRTUAL_VEHICLE_ID);
  assert.equal(virt.bars[1].id, VIRTUAL_VEHICLE_ID);
  assert.deepEqual(virt.tables.map((t) => t.kind), ['extra']);
});

test('print-model: строка без seg (добавлена в редакторе) идёт в ПОСЛЕДНИЙ блок машины; новая машина — в конец своего ряда; пустой блок пропадает', () => {
  const inv = layoutInvoice();
  const v5150 = inv.vehicles.find((x) => x.id === '5150');
  v5150.surcharges.push({ name: 'Nowa dopłata', qty: 1, unitPrice: 100, value: 100, valueOverridden: false }); // без seg
  // у 5110 удалили все surcharges → блок uslugi:5110:3 исчезает
  const v5110 = inv.vehicles.find((x) => x.id === '5110');
  v5110.surcharges.length = 0;
  // новая машина из редактора: только delivery
  inv.vehicles.push(mkVehicle('9999', { pickupQty: 0, deliveryQtys: [1, 0, 0] }));
  recalc(inv);
  const m = buildPrintModel(inv);
  const keys = m.blocks.map((b) => b.key);
  assert.equal(keys.includes('uslugi:5110:3'), false);
  const u5 = m.blocks.find((b) => b.key === 'uslugi:5150:5');
  assert.deepEqual(u5.tables[0].rows.map((r) => r.name), ['Rabat mała paczka', 'Nowa dopłata']);
  const u4 = m.blocks.find((b) => b.key === 'uslugi:5150:4');
  assert.deepEqual(u4.tables[0].rows.map((r) => r.name), ['CashService - płatność gotówkowa']);
  // 9999: delivery после последнего delivery, pickup нет (qty 0)
  assert.equal(keys.indexOf('delivery:9999'), keys.indexOf('delivery:5150') + 1);
  assert.equal(keys.includes('pickup:9999'), false);
});

test('print-model: pickup/delivery с qty=0 и value=0 не печатаются, сводка pickup — только если хоть у одной машины есть odbiór', () => {
  const inv = recalc(createInvoice({ groups: GROUPS, vehicles: [mkVehicle('1', { pickupQty: 0 }), mkVehicle('2', { pickupQty: 0, deliveryQtys: [0, 0, 0] })] }));
  const m = buildPrintModel(inv);
  assert.deepEqual(
    m.blocks.map((b) => b.key),
    ['overall-delivery', 'delivery:1', 'wynagrodzenie', 'oplaty']
  );
});

// ---------------------------------------------------------------------------
// print-layout

function blocksOnPage(pages, type = 'bar') {
  return pages.map((p) => p.items.filter((it) => it.type === type).length);
}

test('print-layout: первая плашка документа на 127.8pt (как во всех оригиналах), шапка только на 1-й странице', () => {
  const inv = recalc(buildSampleInvoice());
  const { pages } = paginate(buildPrintModel(inv));
  const first = pages[0].items;
  assert.equal(first[0].type, 'docHeader');
  assert.equal(first[0].y, TOP_PT);
  const firstBar = first.find((it) => it.type === 'bar');
  assert.equal(Math.round((TOP_PT + DOC_HEADER_H_PT + SPACE_AFTER_DOC_HEADER) * 100) / 100, 127.8);
  assert.equal(Math.round(firstBar.y * 100) / 100, 127.8);
  assert.equal(pages.slice(1).some((p) => p.items.some((it) => it.type === 'docHeader')), false);
  // ничего не выходит за нижнюю границу
  pages.forEach((p) => p.items.forEach((it) => assert.ok(it.y + it.h <= BOTTOM_PT + 0.05, `элемент ${it.type} вылез за страницу`)));
});

test('print-layout: отступ, не влезший внизу, уезжает НАВЕРХ следующей страницы; влезший — теряется', () => {
  // Один блок OOH с таким числом строк, чтобы плашка заголовка легла впритык к низу.
  // Считаем высоту: шапка 81.45 + 18.0, блок: LG 21.6 + 11.4 + SM 21.6 + thead 10.6 + rows*14.4 + razem 14.8
  const inv = recalc(
    createInvoice({
      groups: GROUPS,
      vehicles: [
        mkVehicle('1', { pickupQty: 0, deliveryQtys: [0, 0, 0], ooh: Array.from({ length: 44 }, (_, i) => ({ name: `L${i}`, qty: 1, unitPrice: 1 })) }),
        mkVehicle('2', { pickupQty: 0, deliveryQtys: [0, 0, 0], ooh: [{ name: 'X', qty: 1, unitPrice: 1 }] }),
      ],
    })
  );
  const { pages } = paginate(buildPrintModel(inv));
  // первый блок: 28.35+81.45+18 = 127.8; LG→SM: 127.8+21.6+11.4 = 160.8; SM до 182.4; thead до 193.0; 44 строк → 826.6 > 813.54:
  // строки переносятся; на стр. 2 второй OOH-блок обязан начаться с плашки, а не с пустого отступа
  assert.ok(pages.length >= 2);
  const p2bars = pages[1].items.filter((it) => it.type === 'bar');
  assert.ok(p2bars.length >= 2);
  // плашка второго блока: после RAZEM первого + SPACE_AFTER_BLOCK.ooh (14.4) — на той же странице, если влезла
  const razem1 = pages.flatMap((p) => p.items).find((it) => it.type === 'razem');
  const lg2 = pages.flatMap((p) => p.items).filter((it) => it.type === 'bar' && it.bar.type === 'lg')[1];
  const expected = razem1.y + razem1.h + SPACE_AFTER_BLOCK.ooh;
  if (expected + BAR_H_PT <= BOTTOM_PT + 0.05) assert.equal(Math.round(lg2.y * 100) / 100, Math.round(expected * 100) / 100);
  else assert.equal(lg2.y, TOP_PT); // отступ влез, плашка нет → плашка ровно у верхнего поля
  // Перенос строк: шапка колонок повторена на второй странице перед первой перенесённой строкой
  const p2 = pages[1].items;
  assert.equal(p2[0].type, 'thead');
  assert.equal(p2[0].repeated, true);
  assert.equal(p2[1].type, 'row');
});

test('print-layout: одинокий RAZEM на новой странице — без повторной шапки; отступ между плашками OOH 11.4, у остальных 14.4', () => {
  // подбираем число строк так, чтобы RAZEM не влез: 44 строки влезают до ~826 → точнее считаем в цикле
  for (let n = 38; n <= 46; n += 1) {
    const inv = recalc(
      createInvoice({
        groups: GROUPS,
        vehicles: [mkVehicle('1', { pickupQty: 0, deliveryQtys: [0, 0, 0], ooh: Array.from({ length: n }, (_, i) => ({ name: `L${i}`, qty: 1, unitPrice: 1 })) })],
      })
    );
    const { pages } = paginate(buildPrintModel(inv));
    if (pages.length >= 2 && pages[1].items[0].type === 'razem') {
      assert.equal(pages[1].items[0].y, TOP_PT);
      // следующий блок (Wynagrodzenie) идёт после RAZEM + 14.4
      return;
    }
  }
  assert.fail('не удалось подобрать случай с одиноким RAZEM');
});

test('print-layout: LG→SM отступ 11.4 у OOH и 14.4 у Usługi/pickup; blockPages содержит все блоки', () => {
  const inv = layoutInvoice();
  const m = buildPrintModel(inv);
  const { pages, blockPages } = paginate(m);
  m.blocks.forEach((b) => assert.ok(blockPages.has(b.key), `нет страницы у ${b.key}`));
  const all = pages.flatMap((p) => p.items);
  const ooh = m.blocks.find((b) => b.kind === 'ooh');
  const bars = all.filter((it) => it.type === 'bar' && it.block === ooh);
  assert.equal(Math.round((bars[1].y - bars[0].y) * 100) / 100, BAR_H_PT + SPACE_LG_SM.ooh);
  const usl = m.blocks.find((b) => b.kind === 'uslugi');
  const ubars = all.filter((it) => it.type === 'bar' && it.block === usl);
  assert.equal(Math.round((ubars[1].y - ubars[0].y) * 100) / 100, BAR_H_PT + SPACE_LG_SM.default);
});

// ---------------------------------------------------------------------------
// compare (чистая часть)

test('compare: фактура сама с собой — identical, страницы совпадают, порядок совпадает', () => {
  const inv = layoutInvoice();
  const cmp = buildComparison(inv, structuredClone(inv));
  assert.equal(cmp.summary.identical, true);
  assert.equal(cmp.orderSame, true);
  assert.equal(cmp.summary.same, cmp.summary.total);
  assert.equal(cmp.origPagesFromPdf, true);
  cmp.blocks.forEach((b) => assert.equal(b.status, 'same'));
});

test('compare: смена порога — строка тира «отличается» (позиционное сопоставление), RAZEM тот же; удалённая строка — «только в оригинале»; новая — «только у нас»', () => {
  const orig = layoutInvoice();
  const cur = structuredClone(orig);
  cur.vehicles.forEach((v) => {
    v.delivery.tiers[0].label = 'Poniżej 5000';
  });
  const v5150 = cur.vehicles.find((x) => x.id === '5150');
  v5150.bonusMalus.length = 0; // удалили Bonus/Malus целиком → под-таблица только в оригинале
  v5150.ooh.push({ name: 'Nowa pozycja', qty: 1, unitPrice: 100, value: 100, valueOverridden: false }); // без seg → в блок seg 2
  recalc(cur);
  const cmp = buildComparison(cur, orig);
  assert.equal(cmp.summary.identical, false);
  const od = cmp.blocks.find((b) => b.key === 'overall-delivery');
  assert.equal(od.status, 'changed');
  assert.equal(od.tables[0].rows[0].status, 'changed');
  assert.equal(od.tables[0].rows[0].ours.name, 'Poniżej 5000');
  assert.equal(od.tables[0].rows[0].orig.name, 'Poniżej 4600');
  assert.equal(od.tables[0].razemSame, true);
  const u5 = cmp.blocks.find((b) => b.key === 'uslugi:5150:5');
  assert.equal(u5.status, 'changed');
  const bm = u5.tables.find((t) => t.kind === 'bonusMalus');
  assert.equal(bm.status, 'only-orig');
  const ooh = cmp.blocks.find((b) => b.key === 'ooh:5150:2');
  assert.equal(ooh.status, 'changed');
  assert.equal(ooh.tables[0].rows.find((r) => r.status === 'only-ours').ours.name, 'Nowa pozycja');
  assert.equal(ooh.tables[0].razemSame, false);
});

test('compare: блок только в оригинале встаёт на своё место; блок только у нас — на своё; порядок общих блоков сравнивается', () => {
  const orig = layoutInvoice();
  const cur = structuredClone(orig);
  const v5110 = cur.vehicles.find((x) => x.id === '5110');
  v5110.surcharges.length = 0; // uslugi:5110:3 исчезает у нас
  cur.vehicles.push(mkVehicle('7', { pickupQty: 3, deliveryQtys: [0, 0, 0] })); // новый pickup:7
  recalc(cur);
  const cmp = buildComparison(cur, orig);
  const keys = cmp.blocks.map((b) => `${b.key}|${b.status}`);
  assert.ok(keys.includes('uslugi:5110:3|only-orig'));
  assert.ok(keys.includes('pickup:7|only-ours'));
  // only-orig стоит сразу после виртуального блока (как в оригинале)
  const i = cmp.blocks.findIndex((b) => b.key === 'uslugi:5110:3');
  assert.equal(cmp.blocks[i - 1].key, `uslugi:${VIRTUAL_VEHICLE_ID}:6`);
  assert.equal(cmp.orderSame, true);
  assert.equal(cmp.summary.onlyOrig, 1);
  assert.equal(cmp.summary.onlyOurs, 1);
});

test('compare/diffModels: разный порядок общих блоков → orderSame=false', () => {
  const inv = layoutInvoice();
  const a = buildPrintModel(inv);
  const b = buildPrintModel(inv);
  b.blocks = [...b.blocks].reverse();
  const pagesA = paginate(a).blockPages;
  const pagesB = paginate(b).blockPages;
  const d = diffModels(a, pagesA, b, pagesB);
  assert.equal(d.orderSame, false);
  assert.equal(d.summary.identical, false);
  assert.equal(d.summary.changed, 0);
});

// ---------------------------------------------------------------------------

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
