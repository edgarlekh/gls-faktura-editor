// test/pdf-parser.test.js
// Запуск: node test/pdf-parser.test.js (или npm test).
//
// Гоняет парсер (src/pdf/*) на РЕАЛЬНОМ образце 10082026.pdf через pdf.js —
// в Node берём его из pdfjs-dist/legacy/build (devDependency, нужен только
// для этого теста; в браузере используется вендоренная копия в vendor/pdfjs/,
// см. src/pdf/load-browser.js — код разбора в обоих случаях один и тот же,
// tokenize.js/parse-invoice.js от pdf.js не зависят).
//
// Файл образца — реальная деловая фактура, в .gitignore (см. корень репо),
// поэтому на машинах без него (например CI) тест аккуратно пропускается,
// а не падает: "нет образца" — это не "тест сломан".

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { tokenizePdf } from '../src/pdf/tokenize.js';
import { parseTokens } from '../src/pdf/parse-invoice.js';
import { reconcile } from '../src/pdf/reconcile.js';
import { recalc } from '../src/recalc.js';
import { formatPLN } from '../src/format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = path.join(__dirname, '..', '10082026.pdf');

if (!fs.existsSync(SAMPLE_PATH)) {
  console.log('SKIP test/pdf-parser.test.js — 10082026.pdf нет локально (см. .gitignore в корне репо), это ожидаемо вне машины автора.');
  process.exit(0);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

let parsedInvoice;
let parsedReport;

test('парсер разбирает образец без исключений и без нераспознанных токенов документа', async () => {
  const data = new Uint8Array(fs.readFileSync(SAMPLE_PATH));
  const pdfDocument = await getDocument({ data, useWorkerFetch: false, isEvalSupported: false }).promise;
  const { tokens } = await tokenizePdf(pdfDocument);
  parsedReport = parseTokens(tokens);
  parsedInvoice = parsedReport.invoice;
  recalc(parsedInvoice);

  const docWarnings = parsedReport.warnings.filter((w) => w.section === 'document');
  assert.deepEqual(docWarnings, [], `остались нераспознанные токены: ${JSON.stringify(docWarnings)}`);
});

test('ACCEPTANCE: 5 машин, как в фикстуре (1203/1210/1220/1240/1299)', () => {
  const ids = parsedInvoice.vehicles.map((v) => v.id).sort();
  assert.deepEqual(ids, ['1203', '1210', '1220', '1240', '1299']);
});

test('ACCEPTANCE: Wynagrodzenie ogółem RAZEM = 60 863,83', () => {
  assert.equal(formatPLN(parsedInvoice.summary.wynagrodzenie.razem), '60 863,83');
});

test('ACCEPTANCE: Opłaty RAZEM = 3 070,23', () => {
  assert.equal(formatPLN(parsedInvoice.summary.oplaty.razem), '3 070,23');
});

test('ACCEPTANCE: header фактуры разобран дословно', () => {
  assert.equal(parsedInvoice.header.period, 'Lipiec 2026');
  assert.equal(parsedInvoice.header.printDate, '10.08.2026');
  assert.equal(parsedInvoice.header.supplierName, 'MELBUS EDHAR LEKH');
  assert.equal(parsedInvoice.header.supplierNo, '6169907899');
  assert.equal(parsedInvoice.header.contractNo, '4600003440');
});

test('ACCEPTANCE: valueOverridden строки в Opłaty подхвачены парсером (NP_ELOADING, NP_REINV_DEL)', () => {
  const eloading = parsedInvoice.fees.find((f) => f.name === 'NP_ELOADING');
  const reinvDel = parsedInvoice.fees.find((f) => f.name === 'NP_REINV_DEL');
  assert.ok(eloading.valueOverridden, 'NP_ELOADING должен быть помечен valueOverridden (qty*unitPrice=131.00 != 130.76)');
  assert.equal(eloading.value, 13076);
  assert.ok(reinvDel.valueOverridden, 'NP_REINV_DEL должен быть помечен valueOverridden (qty*unitPrice=1793.00 != 1792.99)');
  assert.equal(reinvDel.value, 179299);
});

test('ОБЯЗАТЕЛЬНАЯ СВЕРКА: все суммы, посчитанные recalc(), совпадают с напечатанными в PDF', () => {
  const rows = reconcile(parsedInvoice, parsedReport.printed);
  assert.ok(rows.length > 20, `сверка должна дать много строк (по каждой машине и блоку), получили ${rows.length}`);
  const bad = rows.filter((r) => !r.ok);
  assert.deepEqual(bad, [], `есть расхождения со сверкой PDF:\n${JSON.stringify(bad, null, 2)}`);
});

test('парсер не выдал предупреждений — образец полностью распознан', () => {
  assert.deepEqual(parsedReport.warnings, [], `есть предупреждения:\n${JSON.stringify(parsedReport.warnings, null, 2)}`);
});

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
