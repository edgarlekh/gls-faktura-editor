// test/ui-scenarios.test.js
// Запуск: node test/ui-scenarios.test.js  (или npm test)
//
// Проверяет на уровне модели те же мутации, что выполняют элементы UI
// (панель "Ставки" и кнопка "удалить" строки), без DOM — это ровно то, что
// делают applyRates()/onDelete в src/app.js, только напрямую.

import assert from 'node:assert/strict';
import { recalc } from '../src/recalc.js';
import { formatPLN } from '../src/format.js';
import { buildSampleInvoice } from '../src/fixtures/sample-invoice.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('Сценарий "смена ставок": новые ставки применяются ко всем машинам сразу', () => {
  const inv = recalc(buildSampleInvoice());
  const before = inv.summary.wynagrodzenie;
  assert.equal(before.doreczenie, 5550496);
  assert.equal(before.odbior, 212913);

  // ровно то, что делает applyRates() в app.js
  const newTierRates = [700, 600, 500]; // 7.00 / 6.00 / 5.00 zł
  const newPickupRate = 150; // 1.50 zł
  inv.vehicles.forEach((v) => {
    v.delivery.tiers.forEach((t, i) => {
      t.rate = newTierRates[i];
    });
    v.pickup.rate = newPickupRate;
  });
  recalc(inv);

  const after = inv.summary.wynagrodzenie;
  // qty по тирам не меняются от смены ставки — берём их из group000010/000004
  const g10 = inv.summary.group000010;
  const g4 = inv.summary.group000004;
  assert.deepEqual(g10.tiers.map((t) => t.qty), [3500, 1300, 4659], 'qty по тирам не должны меняться от смены ставки');
  assert.equal(g4.qty, 1731, 'qty pickup не должен меняться от смены ставки');

  const expectedDoreczenie = 3500 * 700 + 1300 * 600 + 4659 * 500;
  const expectedOdbior = 1731 * 150;
  assert.equal(after.doreczenie, expectedDoreczenie);
  assert.equal(after.odbior, expectedOdbior);
  assert.equal(formatPLN(after.doreczenie), '55 595,00');
  assert.equal(formatPLN(after.odbior), '2 596,50');

  // остальные 4 компонента не зависят от ставок delivery/pickup — не должны измениться
  assert.equal(after.uslugi, before.uslugi);
  assert.equal(after.bonusMalus, before.bonusMalus);
  assert.equal(after.dodatkowePozycje, before.dodatkowePozycje);
  assert.equal(after.ooh, before.ooh);

  const expectedRazem = expectedDoreczenie + expectedOdbior + after.uslugi + after.bonusMalus + after.dodatkowePozycje + after.ooh;
  assert.equal(after.razem, expectedRazem);
  assert.equal(formatPLN(after.razem), '61 421,24');
});

test('Сценарий "удалить Eco Bonus у 1203": удаление строки пересчитывает Dodatkowe pozycje и RAZEM', () => {
  const inv = recalc(buildSampleInvoice());
  const before = inv.summary.wynagrodzenie;
  assert.equal(before.dodatkowePozycje, 239714);
  assert.equal(before.razem, 6086383);

  const v1203 = inv.vehicles.find((v) => v.id === '1203');
  const idx = v1203.extra.findIndex((l) => l.name.startsWith('Eco Bonus'));
  assert.notEqual(idx, -1, 'строка Eco Bonus должна существовать в фикстуре');
  const ecoBonusValue = v1203.extra[idx].value;
  assert.equal(ecoBonusValue, 138140, 'Eco Bonus = 1381.40 zł');

  // ровно то, что делает кнопка "удалить" (onDelete) в app.js
  v1203.extra.splice(idx, 1);
  recalc(inv);

  const after = inv.summary.wynagrodzenie;
  assert.equal(after.dodatkowePozycje, before.dodatkowePozycje - ecoBonusValue);
  assert.equal(after.dodatkowePozycje, 101574);
  assert.equal(formatPLN(after.dodatkowePozycje), '1 015,74');

  // остальные 5 компонентов не должны были измениться
  assert.equal(after.doreczenie, before.doreczenie);
  assert.equal(after.odbior, before.odbior);
  assert.equal(after.uslugi, before.uslugi);
  assert.equal(after.bonusMalus, before.bonusMalus);
  assert.equal(after.ooh, before.ooh);

  assert.equal(after.razem, before.razem - ecoBonusValue);
  assert.equal(after.razem, 5948243);
  assert.equal(formatPLN(after.razem), '59 482,43');
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
