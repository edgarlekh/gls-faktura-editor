# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Client-side editor for monthly GLS delivery invoices (Polish: "faktura"). Pure HTML/CSS/JS (ES modules), no framework, no build step, no backend — meant to be served statically (e.g. GitHub Pages). Comments and UI strings are in Russian/Polish (the domain is a Polish GLS courier invoice); match that language when editing existing files.

## Текущий статус (на 2026-08-11)

Этапы 1 (модель/пересчёт), 2 (редактор), 2.5 (расчёт зарплат курьеров) и 3
(парсер PDF) готовы. Этап 4
(`print.js`/`print.css` — точная копия эталонного PDF) почти готов: суммы,
дословные тексты, ширины колонок, серые плашки и рамки RAZEM сверены построчно
с образцом.

Слабое место Этапа 4 — разбивка на страницы: заголовки-плашки "Pojazd NNNN"
уезжали в конец страницы отдельно от своей таблицы, а футер "Strona X z Y" на
промежуточных страницах не всегда точно ложился на нужное место. Последняя
правка переписывает пагинацию: вместо ретроактивного измерения уже
отрисованного потока print.js теперь сам режет контент на `<div class="page">`
фиксированной высоты (`createPaginator` / `placeAtomicBlock` /
`placeSplitBlock`), футер — последний ребёнок страницы с `margin-top:auto`
(гарантированно прибит к низу), а плашка блока никогда не кладётся без первой
строки своей таблицы (glue-проверка перед размещением). Проверено через
headless Playwright-рендер (7 страниц, футер на каждой, без оторванных
заголовков) — **но не сверено глазами в реальном браузерном "Печать" (Ctrl+P →
Save as PDF)**; при следующей правке стоит попросить пользователя подтвердить
это на реальной печати, прежде чем считать пагинацию окончательно закрытой.
`print.js` по-прежнему рендерит только `buildSampleInvoice()` — загруженная
через Этап 3 PDF-фактура в него не прокидывается (см. `src/pdf/`).

Этап 3 (`src/pdf/*` — разбор PDF-фактуры через pdf.js прямо в браузере) готов
и сверен на образце `10082026.pdf`: все 45 строк построчной сверки
(recalc vs напечатанные в PDF RAZEM) сходятся, 0 warnings, header/5 машин/
Opłaty распознаны дословно, итог 60 863,83 / Opłaty 3 070,23 совпадают с
фикстурой. Ключевой урок разбора: GLS печатает под-таблицу (Bonus/Malus,
pickup и т.п.) только если в ней ≥1 строка — при 0 строках вся шапка+RAZEM
блока в PDF отсутствует целиком, поэтому парсер определяет тип под-таблицы не
по позиции (1-я/2-я/3-я), а по текстовой подписи прямо перед её `RAZEM:` (см.
`SUBTABLE_KIND_BY_FOOTER` в `parse-invoice.js`).

Этап 2.5 (`src/salary*.js` — расчёт зарплат курьеров, вкладка «Расчёт зарплат»
в `index.html`) готов и сверен: база скрута 1203 = 15 937,76, выплата при 50%
= 7 968,88, объединение 1240+1299 при 50% = 7 815,35, сумма всех баз = RAZEM
фактуры = 60 863,83 — все четыре числа из ТЗ воспроизведены и в юнит-тестах, и
вручную в headless-браузере (объединение/разъединение, смена %, копирование
сводки, переключение вкладок — без единой ошибки в консоли).

Дальше по плану: ничего не запланировано явно — уточнить у пользователя.

## Commands

```
npm test          # runs all four test files, node's built-in assert, no test framework
node test/recalc.test.js
node test/ui-scenarios.test.js
node test/pdf-parser.test.js   # разбирает 10082026.pdf через pdfjs-dist (devDependency);
                                # если файла нет локально (он в .gitignore) — тест просто печатает
                                # SKIP и завершается успешно, а не падает
node test/salary-calc.test.js
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
- **`src/main.js`** — the page entry point loaded by `index.html` (Stage 2.5); owns tab-switching between `#editor-view` (`src/app.js`'s `#app`) and `#salary-view` (`src/salary.js`'s `#salary`). `app.js` still fully owns and self-renders `#app` exactly as in Stage 2 — it's unaware `main.js`/`salary.js` exist. The only coupling is one-directional and explicit: `app.js` exports `setOnInvoiceChange(cb)` (called at the end of every `render()`) and `getInvoiceState()` (returns `{current, original}`, both already `recalc()`'d — `original` is a `structuredClone()` snapshot taken at the same three points `ORIGINAL_RAZEM` resets: initial load, `resetToOriginal()`, successful PDF load). `main.js` wires `getInvoiceState` → `renderSalaryTab`.
- **`src/salary-calc.js`** + **`src/salary.js`** — Stage 2.5, "Расчёт зарплат курьеров" (courier payout calculator), a read-only view over the already-`recalc()`'d invoice; never mutates `invoice`/`model.js`/`recalc.js`. `salary-calc.js` is pure (no DOM/localStorage, mirrors the `recalc.js`/`format.js` separation): `vehicleBase(vehicle)` sums the same six components `recalc.js` sums into `wynagrodzenie.razem` (`doreczenie`+`odbior`+`uslugi`+`bonusMalus`+`dodatkowe`+`ooh`), so `Σ vehicleBase(v) === invoice.summary.wynagrodzenie.razem` always holds — that identity is the UI's red/green control-sum row. `buildCourierRows(vehicles, groups, percentById)` turns vehicles into courier rows, honoring `groups` (`{id, memberIds, percentSourceId}`) for merged "one courier drove under two skruty" cases; `compareCourierRows(before, after)` matches by `groupId` to compute before/after deltas. `salary.js` is the DOM layer: percent-per-vehicle and courier name are persisted to `localStorage` (`gls-salary-percent-<id>` / `gls-salary-name-<id>`, with `DEFAULT_PERCENTS` seeding the demo fixture's 1203/1210/1220/1240/1299 only as an initial default); vehicle-merge `groups` are **session-only, module-level state, deliberately not persisted** (re-merging is a manual per-run action). Re-renders the whole `#salary` container on every change, same full-rebuild philosophy as `app.js`.
- **`src/print.js`** + **`src/print.css`** — a separate, independent print/PDF output module (Stage 4) that reads the same `recalc(buildSampleInvoice())` model and renders it to visually match the reference sample `10082026.pdf` (layout coordinates/widths were reverse-engineered from that PDF via PyMuPDF — see comments with pt/mm measurements in `print.js`). It deliberately does **not** share UI code or DOM helpers with `src/app.js` (has its own `el()`/`text()`) and never touches `model.js`/`recalc.js` beyond calling `recalc()`. Vehicle-group SAP codes (`GROUP_004`, `GROUP_010`) are cosmetic labels from the sample document, kept as constants in `print.js` rather than added to the data model since they aren't business data.
- **`src/pdf/`** — Stage 3, the PDF import parser. Pipeline: `geometry.js` (pure — clusters raw pdf.js `getTextContent()` text fragments into reading-order cells by y/x-gap; needed because pdf.js splits words at Polish diacritics) → `tokenize.js` (walks all pages of a pdf.js document proxy through `geometry.js` into one flat cell stream, pulling out `"Strona X z Y"` footers) → `parse-invoice.js` (pure — a resilient anchor-driven scanner over that flat token stream that builds an `invoice` via `model.js` factories, plus a `printed` object mirroring every `RAZEM:` actually printed in the PDF, plus `warnings`; every block is try/caught and recovers by fast-forwarding to the next known anchor rather than throwing) → `reconcile.js` (pure — diffs `recalc(invoice)` against `printed`, grosze-exact, one row per block/vehicle). `load-browser.js` is the only browser-specific file: it points pdf.js (vendored in `vendor/pdfjs/`, not npm/CDN) at the uploaded `File` and calls the pipeline above. Node-side testing instead gets pdf.js from `pdfjs-dist` (devDependency) via `pdfjs-dist/legacy/build/pdf.mjs` — same `geometry.js`/`tokenize.js`/`parse-invoice.js` either way, since none of them import pdf.js directly. **Never assume a fixed number/order of sub-tables**: GLS omits a whole sub-table (header + rows + `RAZEM:`) when it would have 0 rows (see e.g. vehicle 1299 having no pickup or Bonus/Malus block at all in the sample) — `parse-invoice.js` identifies which sub-table it's looking at by the text label immediately before its `RAZEM:` (`SUBTABLE_KIND_BY_FOOTER`), not by position. `src/app.js`'s "📄 Wczytaj fakturę PDF" button wires this in, replacing `invoice` and rendering the reconciliation table (`.parse-report`); `print.js` is untouched and still only ever renders `buildSampleInvoice()`.

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
