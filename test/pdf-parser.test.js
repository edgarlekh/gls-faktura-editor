// test/pdf-parser.test.js
// Запуск: node test/pdf-parser.test.js (или npm test).
//
// Гоняет парсер (src/pdf/*) на РЕАЛЬНЫХ образцах через pdf.js — в Node берём
// его из pdfjs-dist/legacy/build (devDependency, нужен только для этого
// теста; в браузере используется вендоренная копия в vendor/pdfjs/, см.
// src/pdf/load-browser.js — код разбора в обоих случаях один и тот же,
// tokenize.js/parse-invoice.js от pdf.js не зависят).
//
// Два образца — реальные деловые фактуры, оба в .gitignore (см. корень
// репо), поэтому на машинах без них (например CI) соответствующий блок
// теста аккуратно пропускается, а не падает: "нет образца" — это не "тест
// сломан". Если нет НИ ОДНОГО образца — весь файл пропускается целиком.
//
//   10082026.pdf — 5 машин, оригинальный образец Этапа 3/4.
//   325.pdf — 9 машин + виртуальная позиция без номера машины, другие
//     границы весовых тиров доставки, новые коды Opłaty — образец, на
//     котором нашлись и были исправлены реальные баги парсера: тиры
//     доставки были не динамические, "Pojazd" без номера падал, а
//     "Numer pojazdu" в Opłaty распознавался только для уже известных id
//     (ломалось на машине, которая нигде больше в фактуре не встречается).

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
const SAMPLE2_PATH = path.join(__dirname, '..', '325.pdf');

const sample1Exists = fs.existsSync(SAMPLE_PATH);
const sample2Exists = fs.existsSync(SAMPLE2_PATH);

if (!sample1Exists && !sample2Exists) {
  console.log(
    'SKIP test/pdf-parser.test.js — ни 10082026.pdf, ни 325.pdf нет локально (см. .gitignore в корне репо), это ожидаемо вне машины автора.'
  );
  process.exit(0);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

async function parsePdf(samplePath) {
  const data = new Uint8Array(fs.readFileSync(samplePath));
  const pdfDocument = await getDocument({ data, useWorkerFetch: false, isEvalSupported: false }).promise;
  const { tokens } = await tokenizePdf(pdfDocument);
  const report = parseTokens(tokens);
  recalc(report.invoice);
  return report;
}

// ============================================================
// 10082026.pdf — 5 машин
// ============================================================
if (sample1Exists) {
  let parsedInvoice;
  let parsedReport;

  test('[10082026.pdf] парсер разбирает образец без исключений и без нераспознанных токенов документа', async () => {
    parsedReport = await parsePdf(SAMPLE_PATH);
    parsedInvoice = parsedReport.invoice;
    const docWarnings = parsedReport.warnings.filter((w) => w.section === 'document');
    assert.deepEqual(docWarnings, [], `остались нераспознанные токены: ${JSON.stringify(docWarnings)}`);
  });

  test('[10082026.pdf] ACCEPTANCE: 5 машин, как в фикстуре (1203/1210/1220/1240/1299)', () => {
    const ids = parsedInvoice.vehicles.map((v) => v.id).sort();
    assert.deepEqual(ids, ['1203', '1210', '1220', '1240', '1299']);
  });

  test('[10082026.pdf] ACCEPTANCE: Wynagrodzenie ogółem RAZEM = 60 863,83', () => {
    assert.equal(formatPLN(parsedInvoice.summary.wynagrodzenie.razem), '60 863,83');
  });

  test('[10082026.pdf] ACCEPTANCE: Opłaty RAZEM = 3 070,23', () => {
    assert.equal(formatPLN(parsedInvoice.summary.oplaty.razem), '3 070,23');
  });

  test('[10082026.pdf] ACCEPTANCE: header фактуры разобран дословно', () => {
    assert.equal(parsedInvoice.header.period, 'Lipiec 2026');
    assert.equal(parsedInvoice.header.printDate, '10.08.2026');
    assert.equal(parsedInvoice.header.supplierName, 'MELBUS EDHAR LEKH');
    assert.equal(parsedInvoice.header.supplierNo, '6169907899');
    assert.equal(parsedInvoice.header.contractNo, '4600003440');
  });

  test('[10082026.pdf] ACCEPTANCE: valueOverridden строки в Opłaty подхвачены парсером (NP_ELOADING, NP_REINV_DEL)', () => {
    const eloading = parsedInvoice.fees.find((f) => f.name === 'NP_ELOADING');
    const reinvDel = parsedInvoice.fees.find((f) => f.name === 'NP_REINV_DEL');
    assert.ok(eloading.valueOverridden, 'NP_ELOADING должен быть помечен valueOverridden (qty*unitPrice=131.00 != 130.76)');
    assert.equal(eloading.value, 13076);
    assert.ok(reinvDel.valueOverridden, 'NP_REINV_DEL должен быть помечен valueOverridden (qty*unitPrice=1793.00 != 1792.99)');
    assert.equal(reinvDel.value, 179299);
  });

  test('[10082026.pdf] ОБЯЗАТЕЛЬНАЯ СВЕРКА: все суммы, посчитанные recalc(), совпадают с напечатанными в PDF', () => {
    const rows = reconcile(parsedInvoice, parsedReport.printed);
    assert.ok(rows.length > 20, `сверка должна дать много строк (по каждой машине и блоку), получили ${rows.length}`);
    const bad = rows.filter((r) => !r.ok);
    assert.deepEqual(bad, [], `есть расхождения со сверкой PDF:\n${JSON.stringify(bad, null, 2)}`);
  });

  test('[10082026.pdf] парсер не выдал предупреждений — образец полностью распознан', () => {
    assert.deepEqual(parsedReport.warnings, [], `есть предупреждения:\n${JSON.stringify(parsedReport.warnings, null, 2)}`);
  });
} else {
  console.log('SKIP блока 10082026.pdf — файла нет локально.');
}

// ============================================================
// 325.pdf — 9 машин + виртуальная позиция, другие тиры, новые коды Opłaty
// ============================================================
if (sample2Exists) {
  let parsedInvoice;
  let parsedReport;

  test('[325.pdf] парсер разбирает образец без исключений и без нераспознанных токенов документа', async () => {
    parsedReport = await parsePdf(SAMPLE2_PATH);
    parsedInvoice = parsedReport.invoice;
    const docWarnings = parsedReport.warnings.filter((w) => w.section === 'document');
    assert.deepEqual(docWarnings, [], `остались нераспознанные токены: ${JSON.stringify(docWarnings)}`);
  });

  test('[325.pdf] ACCEPTANCE: 9 реальных машин + 1 виртуальная (общие позиции без Pojazd)', () => {
    const ids = parsedInvoice.vehicles.map((v) => v.id);
    const real = ids.filter((id) => id !== '_общие');
    assert.equal(real.length, 9, `должно быть 9 реальных машин, получили ${real.length}: ${real.join(', ')}`);
    assert.deepEqual(
      real.sort(),
      ['5110', '5125', '5130', '5150', '5156', '5160', '5170', '5180', '5190']
    );
    assert.ok(ids.includes('_общие'), 'должна быть виртуальная машина для строк без номера Pojazd (например "Dopłata paliwowa")');
  });

  test('[325.pdf] ACCEPTANCE: Wynagrodzenie ogółem RAZEM = 62 584,71', () => {
    assert.equal(formatPLN(parsedInvoice.summary.wynagrodzenie.razem), '62 584,71');
  });

  test('[325.pdf] ACCEPTANCE: Opłaty RAZEM = 2 587,37', () => {
    assert.equal(formatPLN(parsedInvoice.summary.oplaty.razem), '2 587,37');
  });

  test('[325.pdf] названия тиров доставки читаются динамически из PDF, не хардкод', () => {
    const withDelivery = parsedInvoice.vehicles.find((v) => v.id !== '_общие' && v.delivery.razemQty > 0);
    const labels = withDelivery.delivery.tiers.map((t) => t.label);
    // в этом образце другие пороги, чем в 10082026.pdf (Poniżej 3500/3500-4800/Ponad 4800)
    assert.deepEqual(labels, ['Poniżej 4600', '4600-6400', 'Ponad 6400']);
  });

  test('[325.pdf] Opłaty с новыми кодами Materiał (NP_WORKING_*) распознаны, не только известные коды', () => {
    const codes = parsedInvoice.fees.map((f) => f.name);
    ['NP_WORKING_BLZKP', 'NP_WORKING_POL_M', 'NP_WORKING_STK_EVO', 'NP_WORKING_TSE_M'].forEach((code) => {
      assert.ok(codes.includes(code), `код "${code}" должен быть распознан среди строк Opłaty`);
    });
  });

  test('[325.pdf] ОБЯЗАТЕЛЬНАЯ СВЕРКА: все суммы, посчитанные recalc(), совпадают с напечатанными в PDF', () => {
    const rows = reconcile(parsedInvoice, parsedReport.printed);
    assert.ok(rows.length > 20, `сверка должна дать много строк, получили ${rows.length}`);
    const bad = rows.filter((r) => !r.ok);
    assert.deepEqual(bad, [], `есть расхождения со сверкой PDF:\n${JSON.stringify(bad, null, 2)}`);
  });

  test('[325.pdf] парсер не выдал предупреждений — образец полностью распознан', () => {
    assert.deepEqual(parsedReport.warnings, [], `есть предупреждения:\n${JSON.stringify(parsedReport.warnings, null, 2)}`);
  });
} else {
  console.log('SKIP блока 325.pdf — файла нет локально.');
}

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
