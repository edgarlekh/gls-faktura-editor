// test/ai-ops.test.js
// Запуск: node test/ai-ops.test.js (или npm test)
// Чистая логика src/ai/ops.js и src/ai/context-builder.js — без сети,
// без Anthropic API. ИИ здесь вообще не участвует: подаём уже готовые
// JSON-операции (как будто их вернула модель) и проверяем resolve/apply.

import assert from 'node:assert/strict';
import { recalc } from '../src/recalc.js';
import { buildSampleInvoice } from '../src/fixtures/sample-invoice.js';
import { formatPLN } from '../src/format.js';
import { resolveOp, resolveOps, applyResolved } from '../src/ai/ops.js';
import { buildInvoiceContext } from '../src/ai/context-builder.js';
import { parseOpsResponse } from '../src/ai/anthropic-client.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function freshInvoice() {
  return recalc(buildSampleInvoice());
}

test('setRates: валидна, применяет ставки ко всем машинам', () => {
  const inv = freshInvoice();
  const r = resolveOp(inv, { op: 'setRates', rates: [6.0, 5.3, 5.2] });
  assert.equal(r.ok, true);
  applyResolved([r]);
  recalc(inv);
  inv.vehicles.forEach((v) => {
    assert.deepEqual(
      v.delivery.tiers.map((t) => t.rate),
      [600, 530, 520]
    );
    const expectedValue = v.delivery.tiers.reduce((s, t) => s + t.qty * t.rate, 0);
    assert.equal(v.delivery.razemValue, expectedValue);
  });
});

test('setRates: невалидный массив -> ok:false, ничего не меняется', () => {
  const inv = freshInvoice();
  const before = inv.vehicles[0].delivery.tiers.map((t) => t.rate);
  const r = resolveOp(inv, { op: 'setRates', rates: [6.0, 5.3] });
  assert.equal(r.ok, false);
  assert.deepEqual(
    inv.vehicles[0].delivery.tiers.map((t) => t.rate),
    before
  );
});

test('deleteLine: единственное совпадение — удаляет строку', () => {
  const inv = freshInvoice();
  const before = inv.vehicles.find((v) => v.id === '1203').extra.length;
  const r = resolveOp(inv, { op: 'deleteLine', vehicle: '1203', block: 'extra', match: 'Eco Bonus' });
  assert.equal(r.ok, true);
  applyResolved([r]);
  recalc(inv);
  const v1203 = inv.vehicles.find((v) => v.id === '1203');
  assert.equal(v1203.extra.length, before - 1);
  assert.ok(!v1203.extra.some((l) => l.name.includes('Eco Bonus')));
  const expected = v1203.extra.reduce((s, l) => s + l.value, 0);
  assert.equal(v1203.extraRazem, expected);
});

test('deleteLine: несколько совпадений без all -> ok:false (неоднозначно)', () => {
  const inv = freshInvoice();
  const r = resolveOp(inv, { op: 'deleteLine', vehicle: '1203', block: 'extra', match: 'PGB' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ambiguous');
});

test('deleteLine: all:true удаляет все совпадения', () => {
  const inv = freshInvoice();
  const v1220 = inv.vehicles.find((v) => v.id === '1220');
  const pgbCountBefore = v1220.extra.filter((l) => l.name.includes('PGB')).length;
  assert.ok(pgbCountBefore > 1, 'в фикстуре у 1220 должно быть несколько PGB');
  const r = resolveOp(inv, { op: 'deleteLine', vehicle: '1220', block: 'extra', match: 'PGB', all: true });
  assert.equal(r.ok, true);
  applyResolved([r]);
  recalc(inv);
  assert.equal(v1220.extra.filter((l) => l.name.includes('PGB')).length, 0);
});

test('deleteLine: машина не найдена', () => {
  const inv = freshInvoice();
  const r = resolveOp(inv, { op: 'deleteLine', vehicle: '9999', block: 'extra', match: 'PGB' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no-vehicle');
});

test('deleteLine: block="fees" не требует vehicle', () => {
  const inv = freshInvoice();
  const before = inv.fees.length;
  const r = resolveOp(inv, { op: 'deleteLine', block: 'fees', match: 'NP_RENTAL_SCAN' });
  assert.equal(r.ok, true);
  applyResolved([r]);
  recalc(inv);
  assert.equal(inv.fees.length, before - 1);
});

test('setField: меняет unitPrice, value пересчитывается через recalc (не overridden)', () => {
  const inv = freshInvoice();
  const r = resolveOp(inv, { op: 'setField', vehicle: '1210', block: 'bonusMalus', match: 'DQE', field: 'unitPrice', value: 15.0 });
  assert.equal(r.ok, true);
  applyResolved([r]);
  recalc(inv);
  const line = inv.vehicles.find((v) => v.id === '1210').bonusMalus.find((l) => l.name.includes('DQE'));
  assert.equal(line.unitPrice, 1500);
  assert.equal(line.value, line.qty * 1500);
  assert.equal(line.valueOverridden, false);
});

test('setField: меняет value напрямую -> ставит valueOverridden', () => {
  const inv = freshInvoice();
  const r = resolveOp(inv, { op: 'setField', vehicle: '1203', block: 'extra', match: 'Eco Bonus', field: 'value', value: 999.99 });
  assert.equal(r.ok, true);
  applyResolved([r]);
  recalc(inv);
  const line = inv.vehicles.find((v) => v.id === '1203').extra.find((l) => l.name.includes('Eco Bonus'));
  assert.equal(line.value, 99999);
  assert.equal(line.valueOverridden, true);
});

test('setField: неизвестное поле -> ok:false', () => {
  const inv = freshInvoice();
  const r = resolveOp(inv, { op: 'setField', vehicle: '1210', block: 'bonusMalus', match: 'DQE', field: 'foo', value: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad-field');
});

test('строка не найдена -> ok:false', () => {
  const inv = freshInvoice();
  const r = resolveOp(inv, { op: 'deleteLine', vehicle: '1203', block: 'extra', match: 'НетТакойСтроки' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not-found');
});

test('неизвестная операция -> ok:false, не падает', () => {
  const inv = freshInvoice();
  const r = resolveOp(inv, { op: 'frobnicate' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unknown-op');
});

test('мусор вместо операции -> ok:false, не падает', () => {
  const inv = freshInvoice();
  assert.equal(resolveOp(inv, null).ok, false);
  assert.equal(resolveOp(inv, 'oops').ok, false);
  assert.equal(resolveOp(inv, {}).ok, false);
});

test('resolveOps/applyResolved: применяет только валидные из смешанного списка', () => {
  const inv = freshInvoice();
  const razemBefore = inv.summary.wynagrodzenie.razem;
  const ops = [
    { op: 'deleteLine', vehicle: '1203', block: 'extra', match: 'Eco Bonus' }, // ok
    { op: 'deleteLine', vehicle: '9999', block: 'extra', match: 'x' }, // ошибка — машина не найдена
    { op: 'setField', vehicle: '1210', block: 'bonusMalus', match: 'DQE', field: 'unitPrice', value: 15.0 }, // ok
  ];
  const resolved = resolveOps(inv, ops);
  assert.equal(resolved.filter((r) => r.ok).length, 2);
  assert.equal(resolved.filter((r) => !r.ok).length, 1);
  applyResolved(resolved);
  recalc(inv);
  assert.notEqual(inv.summary.wynagrodzenie.razem, razemBefore);
});

test('resolveOps: не массив -> []', () => {
  const inv = freshInvoice();
  assert.deepEqual(resolveOps(inv, 'not-an-array'), []);
  assert.deepEqual(resolveOps(inv, null), []);
});

test('buildInvoiceContext: содержит все id машин и не падает на пустой фактуре', () => {
  const inv = freshInvoice();
  const ctx = buildInvoiceContext(inv);
  inv.vehicles.forEach((v) => assert.ok(ctx.includes(`Машина ${v.id}:`), `нет машины ${v.id} в контексте`));
  assert.ok(ctx.includes('DQE'));
  assert.ok(ctx.includes('Opłaty'));

  const empty = recalc({ header: {}, vehicles: [], fees: [], summary: null });
  assert.equal(buildInvoiceContext(empty), '');
});

test('parseOpsResponse: чистый JSON-массив', () => {
  const ops = parseOpsResponse('[{"op":"setRates","rates":[6,5.3,5.2]}]');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'setRates');
});

test('parseOpsResponse: снимает markdown-обёртку ```json ... ```, если модель её всё же добавила', () => {
  const ops = parseOpsResponse('```json\n[{"op":"deleteLine","block":"fees","match":"x"}]\n```');
  assert.equal(ops.length, 1);
});

test('parseOpsResponse: пустой массив — валиден (команда не распознана)', () => {
  assert.deepEqual(parseOpsResponse('[]'), []);
});

test('parseOpsResponse: не массив -> кидает исключение', () => {
  assert.throws(() => parseOpsResponse('{"op":"setRates"}'));
});

test('parseOpsResponse: невалидный JSON -> кидает исключение', () => {
  assert.throws(() => parseOpsResponse('это не JSON вообще'));
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
