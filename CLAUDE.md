# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Client-side editor for monthly GLS delivery invoices (Polish: "faktura"). Pure HTML/CSS/JS (ES modules), no framework, no build step, no backend — meant to be served statically (e.g. GitHub Pages). Comments and UI strings are in Russian/Polish (the domain is a Polish GLS courier invoice); match that language when editing existing files.

## Текущий статус (на 2026-08-11)

Этапы 1 (модель/пересчёт) и 2 (редактор) готовы и закоммичены. Этап 4
(`print.js`/`print.css` — точная копия эталонного PDF) почти готов: суммы,
дословные тексты, ширины колонок, серые плашки и рамки RAZEM сверены построчно
с образцом.

Слабое место — разбивка на страницы: заголовки-плашки "Pojazd NNNN" уезжали в
конец страницы отдельно от своей таблицы, а футер "Strona X z Y" на
промежуточных страницах не всегда точно ложился на нужное место. Последняя
правка (коммит "Этап 4: точная копия PDF...") переписывает пагинацию: вместо
ретроактивного измерения уже отрисованного потока print.js теперь сам режет
контент на `<div class="page">` фиксированной высоты (`createPaginator` /
`placeAtomicBlock` / `placeSplitBlock`), футер — последний ребёнок страницы с
`margin-top:auto` (гарантированно прибит к низу), а плашка блока никогда не
кладётся без первой строки своей таблицы (glue-проверка перед размещением).
Проверено через headless Playwright-рендер (7 страниц, футер на каждой, без
оторванных заголовков) — **но не сверено глазами в реальном браузерном
"Печать" (Ctrl+P → Save as PDF)**; при следующей правке стоит попросить
пользователя подтвердить это на реальной печати, прежде чем считать пагинацию
окончательно закрытой.

Дальше по плану: парсер PDF (извлечение реальных фактур из PDF-файлов) и
расчёт зарплат курьеров.

## Commands

```
npm test          # runs both test files, node's built-in assert, no test framework
node test/recalc.test.js
node test/ui-scenarios.test.js
```

There is no build/lint step and no bundler — `index.html` and `print.html` load `src/*.js` directly as ES modules (`type="module"`). To view the app, open `index.html` (or `print.html`) via a local static server (opening `file://` directly may break module imports in some browsers).

Each test file is its own tiny hand-rolled runner (array of `{name, fn}`, run in a loop, `process.exit(1)` on failure) — there's no test framework like Jest/Vitest. To run a "single test," temporarily comment out the other `test(...)` calls in the relevant file, or add a `.only`-style filter yourself; there's no built-in flag for it.

## Architecture

**Data flow is one-directional and hub-based:** UI mutation → `recalc(invoice)` → full re-render. There is no partial state update or diffing.

- **`src/model.js`** — factory functions for the invoice shape (`createInvoice`, `createVehicle`, `createLine`, `createTier`, `createPickup`). All money fields (`unitPrice`, `rate`, `value`, `razem*`) are stored as **integer grosze** (1 zł = 100 gr), never floats — this is the load-bearing invariant of the whole codebase, so summing across the tree never accumulates rounding error. Only `format.js` converts grosze ↔ display strings.
- **`src/recalc.js`** — the sole place that derives totals. `recalc(invoice)` mutates the invoice bottom-up (line → vehicle → invoice.summary) and can be safely re-run after any qty/unitPrice/override edit. Key mechanic: a line's `value` is normally `qty * unitPrice`, but setting `valueOverridden = true` freezes `value` at whatever was typed, independent of qty×unitPrice (used for manual corrections that don't fit the formula — see the DQE/NPSE and Eco Bonus cases in `test/recalc.test.js`).
- **`src/format.js`** — the sole place that converts grosze ↔ Polish-formatted strings (`formatPLN`/`parsePLN` for money with space thousands-separator and comma decimals, `formatInt`/`parseIntPL` for plain quantities).
- **`src/fixtures/sample-invoice.js`** — a real 5-vehicle invoice (ids 1203/1210/1220/1240/1299) built from `model.js` factories, shared as the seed data by both the acceptance test (`test/recalc.test.js`) and the UI's initial/reset state (`src/app.js`). If you change this fixture, re-check the hardcoded expected sums in the tests.
- **`src/app.js`** — the editor UI (Stage 2). No framework: plain DOM built via small `el()`/`text()` helpers. Rendering strategy is **full re-render on every commit**: any edit calls `recalcAndRender()`, which reruns `recalc()` then rebuilds `#app` from scratch. This is intentional (invoice is small — 5 vehicles) to avoid any risk of the DOM getting out of sync with computed sums; don't introduce partial/incremental DOM patching without a reason. Editable cells follow a click-to-`<input>` pattern (`editableCell()`): click swaps a `<td>`'s display span for an input; commit happens on Enter/blur, cancel on Escape — this avoids re-rendering (and losing cursor position) on every keystroke.
- **`src/print.js`** + **`src/print.css`** — a separate, independent print/PDF output module (Stage 4) that reads the same `recalc(buildSampleInvoice())` model and renders it to visually match the reference sample `10082026.pdf` (layout coordinates/widths were reverse-engineered from that PDF via PyMuPDF — see comments with pt/mm measurements in `print.js`). It deliberately does **not** share UI code or DOM helpers with `src/app.js` (has its own `el()`/`text()`) and never touches `model.js`/`recalc.js` beyond calling `recalc()`. Vehicle-group SAP codes (`GROUP_004`, `GROUP_010`) are cosmetic labels from the sample document, kept as constants in `print.js` rather than added to the data model since they aren't business data.

### Invoice shape (informal)

```
invoice = { header, vehicles: [vehicle...], fees: [line...], summary }
vehicle = { id, delivery: { tiers: [tier x3], razemQty, razemValue },
            pickup: tier-shaped, ooh: [line...], surcharges: [line...],
            bonusMalus: [line...], extra: [line...],
            oohRazem, surchargesRazem, bonusMalusRazem, extraRazem }  // razem* set by recalc()
tier  = { label, qty, rate, value }               // value = qty*rate, no override
line  = { name, qty, unitPrice, value, valueOverridden }
```

`invoice.summary` (entirely computed by `recalc()`, never hand-edited) holds `group000010` (delivery tiers totals across all vehicles), `group000004` (pickup totals), `wynagrodzenie` (the six components + `razem` grand total), and `oplaty` (fees total — explicitly **excluded** from the grand `razem`).

### Working with money

Always construct/compare amounts in grosze (integers). Use `zlToGr(x)` (in `model.js`) when writing test/fixture data from a złoty figure for readability — never do float złoty arithmetic directly on model fields.
