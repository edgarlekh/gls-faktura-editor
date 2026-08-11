# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Client-side editor for monthly GLS delivery invoices (Polish: "faktura"). Pure HTML/CSS/JS (ES modules), no framework, no build step, no backend — meant to be served statically (e.g. GitHub Pages). Comments are in Russian. **UI-language split (as of the UI-translation pass):** all app-chrome text — button labels, panel/tab titles, placeholders, tooltips, status and error messages — is Russian; invoice-domain vocabulary that mirrors the literal GLS document (block names like `Doręczenie`/`Odbiór`/`OOH`/`Usługi (Dopłaty)`/`Bonus/Malus`/`Dodatkowe pozycje`/`Opłaty`/`RAZEM`/`Wynagrodzenie ogółem`, column headers `Nazwa`/`Ilość`/`Cena`/`Wartość`/`Stawka`/`Próg`, tier labels `Poniżej 3500` etc., and invoice header field labels `Okres`/`Data wydruku`/`Umowa`) stays Polish — never translate that half, it's meant to visually match the official document. When adding new UI, follow this split rather than defaulting to Polish.

## Текущий статус (на 2026-08-12, конец сессии)

Готово и сверено: Этап 1 (модель/пересчёт), Этап 2 (редактор), Этап 2.5
(расчёт зарплат курьеров), Этап 3 (парсер PDF), Этап 5 (AI-команды), Этап 7
(GitHub Pages), UI-перевод на русский. Подробности каждого модуля — в разделе
Architecture ниже; там же зафиксированы нетривиальные находки по формату
GLS PDF (динамические тиры, "Pojazd" без номера, перенос таблиц между
страницами и т.п.), чтобы будущие правки их не сломали.

Последняя правка (2026-08-12): в `print.js` названия тиров доставки для
верхней сводки `group000010` были захардкожены (тот же класс бага, что
раньше чинили в панели «Ставки» `app.js`). Исправлено тем же приёмом —
`getTierLabels(inv)` берёт labels из первой машины текущей invoice, а не из
константы. Таблицы delivery по каждой машине багу не были подвержены (уже
брали `t.label` из модели). Проверено вживую на `325.pdf`: и сводка 000010,
и таблицы машин показывают «Poniżej 4600» / «4600-6400» / «Ponad 6400».

**Единственное известное слабое место — пагинация печати (Этап 4,
`print.js`).** Сама раскладка (суммы/тексты/колонки/рамки RAZEM) сверена
построчно с образцом и работает; пагинация (`createPaginator` /
`placeAtomicBlock` / `placeSplitBlock`) проверена только headless
Playwright-рендером (7 страниц, футер на каждой, без оторванных заголовков),
**но ни разу не сверена глазами в реальном браузерном "Печать" (Ctrl+P → Save
as PDF)**. Перед тем как считать её окончательно закрытой, стоит попросить
пользователя подтвердить на реальной печати. Также `print.js` теперь ЧИТАЕТ
текущую (отредактированную) invoice через `sessionStorage`, если она есть
(см. Architecture → `src/print.js`), но всё ещё не умеет ничего, кроме
рендера — это не менялось.

Живой сайт: `https://edgarlekh.github.io/gls-faktura-editor/` — деплоится
автоматически из `main` (GitHub Pages, ветка/root, `.nojekyll`).

Дальше по плану: ничего не запланировано явно — уточнить у пользователя.

## Commands

```
npm test          # runs all six test files, node's built-in assert, no test framework
node test/recalc.test.js
node test/ui-scenarios.test.js
node test/pdf-parser.test.js   # разбирает 10082026.pdf И 325.pdf через pdfjs-dist (devDependency);
                                # каждый образец гейтится своим fs.existsSync — оба в .gitignore,
                                # блок без файла просто печатает SKIP и не падает
node test/salary-calc.test.js
node test/ai-ops.test.js       # чистая логика операций (src/ai/ops.js) — без сети, без Anthropic API
node test/salary-copy.test.js  # текстовый формат "Скопировать сводку" (src/salary.js/buildSummaryText)
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
- **`src/print.js`** + **`src/print.css`** — a separate, independent print/PDF output module (Stage 4) whose layout (coordinates/widths/RAZEM borders) was reverse-engineered from the reference sample `10082026.pdf` via PyMuPDF — see comments with pt/mm measurements in `print.js`. It deliberately does **not** share UI code or DOM helpers with `src/app.js` (has its own `el()`/`text()`) and never touches `model.js`/`recalc.js` beyond calling `recalc()`. Vehicle-group SAP codes (`GROUP_004`, `GROUP_010`) are cosmetic labels from the sample document, kept as constants in `print.js` rather than added to the data model since they aren't business data. **Data source:** `loadInvoice()` reads `sessionStorage['gls-print-invoice']` (the same key `app.js` writes on every `render()`) and falls back to `buildSampleInvoice()` only if that key is absent/corrupt — so print always reflects whatever invoice (edited, or loaded from any PDF) is currently open in the editor, not just the fixture. The print link in `app.js` must keep `rel="opener"` explicit — Chrome ≥88 treats `target="_blank"` as implicit `noopener` otherwise, which silently breaks the sessionStorage handoff (only reproducible in a real browser, not unit tests). Delivery tier labels are **not** hardcoded: each vehicle's own table already reads `t.label` straight from the model, and the top `group000010` summary (which doesn't carry its own labels — `recalc.js` only sums qty/value there) uses `getTierLabels(inv)` to pull them from the invoice's first vehicle, falling back to `DELIVERY_TIER_LABELS` (`model.js`) only when there are no vehicles at all.
- **`src/ai/`** — Stage 5, text commands via the Anthropic API. `context-builder.js` (pure) builds a *compact* prompt context — vehicle ids + block names + current qty/unitPrice/value for every editable line, not the whole invoice. `anthropic-client.js` calls `claude-haiku-4-5` directly from the browser (`fetch` to `https://api.anthropic.com/v1/messages` with header `anthropic-dangerous-direct-browser-access: true`, no proxy/backend) with a system prompt demanding a bare JSON array (no markdown/prose); `parseOpsResponse()` still defensively strips a ```` ```json ```` fence in case the model adds one anyway. `ops.js` (pure) is where the actual safety net lives: `resolveOp(invoice, op)` validates one AI-proposed op against the *current* invoice (vehicle exists? line found by substring match? unambiguous — or does it need `"all":true`?) and returns a human-readable description plus (only if valid) an `apply()` closure over the matched line objects — nothing is mutated until `applyResolved()` is called, and only for `ok:true` entries. **The AI never computes sums** — `apply()` only sets raw fields (`qty`/`unitPrice`/`value`, `valueOverridden` when `field==='value'`) and the caller re-runs the existing `recalc()` afterward, same engine as every other edit path. `app.js` wires this to a "💬 Komenda tekstowa (AI)" panel (recognized-actions preview + explicit "Zastosuj" button — nothing is ever applied silently) and a gear-icon settings popover for the API key, stored only in `localStorage` (`gls-anthropic-api-key`) and never sent anywhere but `api.anthropic.com`.
- **`src/pdf/`** — Stage 3, the PDF import parser. Pipeline: `geometry.js` (pure — clusters raw pdf.js `getTextContent()` text fragments into reading-order cells by y/x-gap; needed because pdf.js splits words at Polish diacritics) → `tokenize.js` (walks all pages of a pdf.js document proxy through `geometry.js` into one flat cell stream, pulling out `"Strona X z Y"` footers) → `parse-invoice.js` (pure — a resilient anchor-driven scanner over that flat token stream that builds an `invoice` via `model.js` factories, plus a `printed` object mirroring every `RAZEM:` actually printed in the PDF, plus `warnings`; every block is try/caught and recovers by fast-forwarding to the next known anchor rather than throwing) → `reconcile.js` (pure — diffs `recalc(invoice)` against `printed`, grosze-exact, one row per block/vehicle). `load-browser.js` is the only browser-specific file: it points pdf.js (vendored in `vendor/pdfjs/`, not npm/CDN) at the uploaded `File` and calls the pipeline above. Node-side testing instead gets pdf.js from `pdfjs-dist` (devDependency) via `pdfjs-dist/legacy/build/pdf.mjs` — same `geometry.js`/`tokenize.js`/`parse-invoice.js` either way, since none of them import pdf.js directly. **Never assume a fixed number/order of sub-tables**: GLS omits a whole sub-table (header + rows + `RAZEM:`) when it would have 0 rows (see e.g. vehicle 1299 having no pickup or Bonus/Malus block at all in the sample) — `parse-invoice.js` identifies which sub-table it's looking at by the text label immediately before its `RAZEM:` (`SUBTABLE_KIND_BY_FOOTER`), not by position. `src/app.js`'s "📄 Загрузить PDF-фактуру" button wires this in, replacing `invoice` and rendering the reconciliation table (`.parse-report`); the loaded invoice then flows to `print.js` too via the `sessionStorage` bridge described above. Two quirks worth knowing about beyond the "0-row sub-table is omitted" rule above: (1) a vehicle's "Usługi pojazdów" table can be split across a page break, re-printing its "Pojazd"+id header a second time for the same vehicle — the parser **merges** (concats rows, sums RAZEM) rather than overwriting when a `kind` repeats for an already-known vehicle id; (2) some line items (e.g. "Dopłata paliwowa") print under a "Pojazd" anchor with **no id** — detected structurally via `readOptionalVehicleId()` (next token is a column-header cell, not an id) — and routed to a synthetic vehicle `VIRTUAL_VEHICLE_ID = '_общие'` rather than crashing; that vehicle typically has no delivery block at all, so its delivery tier labels fall back to `DELIVERY_TIER_LABELS` (harmless — its qty/value are 0). Delivery tier labels themselves are read verbatim per-vehicle from the PDF (`v.deliveryLabels`), never hardcoded, since different invoices use different weight thresholds (e.g. "Poniżej 3500" vs "Poniżej 4600").

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
