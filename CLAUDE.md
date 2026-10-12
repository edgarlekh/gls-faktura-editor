# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Client-side editor for monthly GLS delivery invoices (Polish: "faktura"). Pure HTML/CSS/JS (ES modules), no framework, no build step, no backend — meant to be served statically (e.g. GitHub Pages). Comments are in Russian. **UI-language split (as of the UI-translation pass):** all app-chrome text — button labels, panel/tab titles, placeholders, tooltips, status and error messages — is Russian; invoice-domain vocabulary that mirrors the literal GLS document (block names like `Doręczenie`/`Odbiór`/`OOH`/`Usługi (Dopłaty)`/`Bonus/Malus`/`Dodatkowe pozycje`/`Opłaty`/`RAZEM`/`Wynagrodzenie ogółem`, column headers `Nazwa`/`Ilość`/`Cena`/`Wartość`/`Stawka`/`Próg`, tier labels `Poniżej 3500` etc., and invoice header field labels `Okres`/`Data wydruku`/`Umowa`) stays Polish — never translate that half, it's meant to visually match the official document. When adding new UI, follow this split rather than defaulting to Polish.

## Текущий статус (на 2026-10-07, конец сессии)

Готово и сверено: Этап 1 (модель/пересчёт), Этап 2 (редактор), Этап 2.5
(расчёт зарплат курьеров), Этап 3 (парсер PDF), Этап 5 (AI-команды), Этап 7
(GitHub Pages), UI-перевод на русский. Подробности каждого модуля — в разделе
Architecture ниже; там же зафиксированы нетривиальные находки по формату
GLS PDF (динамические тиры, "Pojazd" без номера, перенос таблиц между
страницами и т.п.), чтобы будущие правки их не сломали.

Правки 2026-08-12: (1) в `print.js` названия тиров доставки для верхней
сводки `group000010` были захардкожены (тот же класс бага, что раньше
чинили в панели «Ставки» `app.js`). Исправлено тем же приёмом —
`getTierLabels(vehicles)` берёт labels из первой машины текущей invoice, а
не из константы. Таблицы delivery по каждой машине багу не были подвержены
(уже брали `t.label` из модели). Проверено вживую на `325.pdf`: и сводка
000010, и таблицы машин показывают «Poniżej 4600» / «4600-6400» /
«Ponad 6400». (2) `print.js` рисовал служебную виртуальную машину
`VIRTUAL_VEHICLE_ID = '_общие'` (см. `src/pdf/`) как настоящий блок
"Pojazd _общие" с пустой таблицей Doręczenie — в PDF-образце у неё
никогда не было своего блока. Теперь `VIRTUAL_VEHICLE_ID` экспортирован
из `parse-invoice.js`, и `buildDocument()` фильтрует её из всех
per-vehicle циклов (`printedVehicles`) — pickup/delivery/OOH/Usługi
pojazdów. `Wynagrodzenie ogółem`/`Opłaty` не затронуты: они считаются из
`invoice.summary`/`invoice.fees` через `recalc()` напрямую, не из этих
блоков, так что вклад виртуальной машины в RAZEM остаётся — проверено
вживую на `325.pdf` (RAZEM всё ещё 62 584,71, `_общие` нигде в тексте
страницы не встречается).

Правки 2026-10-07 (фактура `092026.pdf`, Wrzesień 2026): номер группы
доставки в ней `5000000215/000017`, а не `/000010` — парсер определял тип
блока pickup/delivery по суффиксу кода и падал («Łączny przegląd не найден
RAZEM», «Wynagrodzenie ogółem блок не найден», Doręczenie/Odbiór = 0).
Хардкод `000010`/`000004` убран ВЕЗДЕ: (1) `parse-invoice.js` определяет
тип блока ПО СТРУКТУРЕ (`readTierRowsUntilFooter` + `tierKindByRows`:
1 строка «Ponad 0» = pickup, 3 тира = delivery), а код группы читает
дословно в `invoice.groups.{delivery,pickup}` (`rememberGroupCode`,
расхождение кодов между блоками одной фактуры — warning); (2) `model.js`:
`createInvoice({groups})` + `DEFAULT_GROUP_CODES` (дефолт фикстуры и
старых sessionStorage-invoice без поля `groups`); (3) `recalc.js`: ключи
summary переименованы `group000010`→`deliveryGroup`,
`group000004`→`pickupGroup` (тесты обновлены); (4) `app.js`/`reconcile.js`
— подписи «grupa NNNNNN» из `invoice.groups` (`groupNo()`); (5) `print.js`
— `GROUP_004`/`GROUP_010` константы заменены на `GROUPS` из
`invoice.groups` (на `325.pdf` теперь печатается её настоящий префикс
`5000000712/…`, раньше молча печатался `5000000215`). Попутно: строки
`Opłaty` теперь несут `vehicle`/`opis` на самой строке (`createLine`
пробрасывает их, если заданы) — один код `NP_PNLT_KU_NPD` встречается
дважды для 1220 и 1240, per-code словарь (`feesInfo`, `FEES_INFO` в
`print.js`) такую пару терял; `FEES_INFO` оставлен только фолбэком для
демо-фикстуры. Проверено вживую (Playwright, локальный static server):
все три PDF грузятся без warnings, сверка зелёная, предпросмотр печати
рисует `000017`/`000004` и обе строки `NP_PNLT_KU_NPD` с номерами машин.

Правки 2026-10-07, вторая часть — «гибкость под любую фактуру» + мобильная
версия. **Правило проекта: ничего из ДАННЫХ фактуры не хардкодить** —
номера машин и их число (1…30+), коды групп, число/названия/ставки тиров
(2, 3, 4…), подпись/ставка pickup, названия строк и коды Opłaty — всё
только из PDF. Что сделано: (1) `model.js`: `VIRTUAL_VEHICLE_ID` переехал
сюда (parse-invoice.js его re-export'ит), добавлены `realVehicles(inv)`,
`getTierTemplate(inv)` → `{labels, rates}` и `getPickupTemplate(inv)` →
`{label, rate}` — единственный способ, которым app.js/print.js/ai берут
параметры тиров (из первой реальной машины текущей фактуры, константы
`DELIVERY_TIER_*`/`PICKUP_*` — только для фикстуры и пустой фактуры);
`createVehicle` принимает `pickupLabel`, число тиров = длине
`deliveryRates`/`deliveryLabels`. (2) `recalc.js`: `deliveryGroup.tiers`
длиной max по машинам, не 3. (3) `parse-invoice.js` переписан: диспетчер
по якорю (блоки в любом порядке), тип pickup/delivery по подписи перед
RAZEM: («Odbiór, za paczkę» / «Doręczenie, za paczkę»), fallback по числу
строк; повторы блока для той же машины склеиваются (`mergeTierRows`,
`appendLines`), повторные шапки колонок внутри таблиц и повторный якорь
«Opłaty» (перенос страницы) пропускаются/склеиваются; машина без блока
получает шаблон тиров/pickup ИЗ ЭТОЙ ЖЕ фактуры (общая сводка → другая
машина → константы). (4) `print.js`: `FEES_INFO` удалён (vehicle/opis
теперь в фикстуре на строках), число строк тиров в высоте блока —
динамическое, общие сводки и per-vehicle pickup/delivery печатаются только
если qty/value ≠ 0 (как GLS), `fitSheetToViewport()` масштабирует `#sheet`
через `transform` на узком экране после `buildDocument()`
(getBoundingClientRect учитывает transform — до раскладки нельзя), на
печать не влияет (`@media print` сбрасывает). (5) `ai/ops.js` setRates
принимает ровно столько ставок, сколько тиров в фактуре;
`context-builder.js` перечисляет реальные тиры; системный промпт больше
не называет «Poniżej 3500». (6) `test/flex-synthetic.test.js` — 17
синтетических тестов с генератором потока токенов «как из PDF»
(`buildTokens(spec)`): 4 и 2 тира с другими границами, коды групп
`…/000077`, машины `5110`/`7`/`A12`/`99999`, 30 машин, машины без
pickup/delivery/OOH/Bonus, виртуальный «Pojazd», перенос таблиц, другой
порядок блоков, нестандартная подпись pickup; проверяют model/recalc/
parse/reconcile/salary-calc/ai. (7) Мобильная версия: `style.css`
`@media (max-width: 640px)` — таблицы прокручиваются по горизонтали
внутри `.block`/карточек, кнопки/поля ≥44px, сводки и карточки курьеров в
одну колонку, поповер настроек в экран; проверено Playwright-эмуляцией
360×780 и 390×844 (iPhone 13): нет горизонтального скролла страницы,
загрузка PDF, ставки, редактируемая ячейка, AI-панель, вкладка зарплат,
«Скопировать сводку», предпросмотр печати (scale ≈0.52/0.56, RAZEM
отражает правки из редактора). Шаблон печати не менялся.
`salary.js/DEFAULT_PERCENTS` — проценты демо-фикстуры по id, это не
данные фактуры (для любого другого id — `FALLBACK_PERCENT`), оставлен.

Правки 2026-10-12 — «структура распечатки 1-в-1 с оригиналом», пороги,
вкладка сравнения. Повод: пользователь сравнил нашу распечатку (`сверка.pdf`)
с оригиналом LPL за 09/2026 (`ориг лпл.pdf`, 11 страниц, оба в `.gitignore`)
— суммы сходились, структура нет: (а) GLS печатает для ОДНОЙ машины
НЕСКОЛЬКО блоков «Usługi pojazdów» (сначала у всех машин CashService/
Exchange…, потом вторым проходом Rabat + Bonus/Malus + Dodatkowe), мы
склеивали в один; (б) порядок машин у нас был «по первому появлению», у GLS
— как в документе (5156 между 5150 и 5160); (в) 9 страниц против 11 — GLS
НЕ держит блоки целиком и имеет свои отступы. Сделано:
(1) `tokenize.js` отдаёт `tokenPages` (страница каждого токена);
`parse-invoice.js` пишет `invoice.layout` — порядок блоков дословно из PDF
с номером страницы, каждый якорь «Usługi pojazdów»/«OOH» = отдельный `seg`,
строки OOH/Usługi получают `line.seg` (`createLine` пробрасывает);
`createInvoice({layout})`. (2) Новый чистый `src/print-model.js`:
`buildPrintModel(invoice)` → упорядоченные блоки/таблицы/строки для печати
(по layout; без layout — прежний порядок; строки без seg → в последний блок
машины; новые машины — в конец своего ряда; пустые блоки не печатаются).
(3) Новый чистый `src/print-layout.js`: пагинация «как у GLS» в pt —
константы сняты PyMuPDF с четырёх оригиналов (10082026/325/092026/LPL
09-2026): отступы — элементы потока (не влез → уезжает НАВЕРХ следующей
страницы; влез, но следующий элемент нет → теряется), плашка может
остаться одна внизу, таблица рвётся на любой строке с повтором шапки,
одинокий RAZEM без шапки; футеры «Doręczenie»/«Usługi (Dopłaty)»/«Bonus/
Malus» двухстрочные (+14.4pt). Проверено: на всех четырёх оригиналах состав
каждой страницы (последовательность плашек и RAZEM) совпадает, Δy ≤ 2.4pt;
`test/pdf-parser.test.js` теперь это проверяет регрессионно (число страниц
= страницам PDF, каждый блок начинается на той же странице). (4) `print.js`
переписан: никакого `measure()`/таблиц — каждый элемент абсолютно
позиционирован по top/height из раскладки, строки = CSS grid (`<table>`
округлял высоты строк до px и за страницу набегало ~3мм); `.page` = печатная
область под `@page margin: 10mm 9mm 2.5mm 25mm`, футер в нижнем поле на
y=821.6pt как у GLS. (5) Панель «Ставки и пороги»: у каждого тира редактируется
и ПОРОГ (текст «Poniżej 4600»), и ставка — ко всем машинам (`rates.labels`,
`applyRates`); AI-операция `setTierLabels` (`ops.js`, промпт). (6) Вкладка
«Сравнение с оригиналом» (`src/compare.js`, `main.js`, `index.html`,
`style.css`): слева наша фактура как уйдёт на печать, справа оригинал
(снимок после загрузки PDF) — обе через `buildPrintModel`; блоки сопоставлены
по `key` (kind+машина+seg), строки — по названию (тиры/pickup/Wyn — по
позиции), подсветка совпадает/отличается/только у нас/только в оригинале,
страница у нас (print-layout) ↔ в оригинале (из PDF), сводка (порядок,
страницы, RAZEM), переключатель «только различия». `getInvoiceState()`
дополнительно отдаёт `printed`/`fileName`. Мобильная версия (360px): колонки
сравнения в столбик, проверено Playwright. Тесты: `test/print-model.test.js`
(модель/пагинация/сравнение), +3 в `flex-synthetic`, +2 в `ai-ops`, структура
1-в-1 для трёх образцов в `pdf-parser`. Итого 116 тестов.

Что НЕ проверялось глазами: реальная печать Ctrl+P → Save as PDF
пользователем (headless `page.pdf()` с `prefer_css_page_size` даёт ровно
11/11/7/8 страниц без пустых).

Живой сайт: `https://edgarlekh.github.io/gls-faktura-editor/` — деплоится
автоматически из `main` (GitHub Pages, ветка/root, `.nojekyll`).

Дальше по плану: ничего не запланировано явно — уточнить у пользователя.

## Commands

```
npm test          # runs all eight test files, node's built-in assert, no test framework
node test/recalc.test.js
node test/ui-scenarios.test.js
node test/pdf-parser.test.js   # разбирает 10082026.pdf, 325.pdf И 092026.pdf через pdfjs-dist (devDependency);
                                # каждый образец гейтится своим fs.existsSync — все три в .gitignore,
                                # блок без файла просто печатает SKIP и не падает
node test/salary-calc.test.js
node test/ai-ops.test.js       # чистая логика операций (src/ai/ops.js) — без сети, без Anthropic API
node test/salary-copy.test.js  # текстовый формат "Скопировать сводку" (src/salary.js/buildSummaryText)
node test/flex-synthetic.test.js # ГИБКОСТЬ: синтетические фактуры (2/4 тира, другие группы/машины, 30 машин,
                                 # машины без блоков, перенос таблиц) — генератор токенов "как из PDF", без файлов
node test/print-model.test.js  # печать: модель блоков (print-model.js), пагинация «как у GLS» (print-layout.js),
                               # сравнение с оригиналом (compare.js/diffModels) — без DOM и без PDF
```

There is no build/lint step and no bundler — `index.html` and `print.html` load `src/*.js` directly as ES modules (`type="module"`). To view the app, open `index.html` (or `print.html`) via a local static server (opening `file://` directly may break module imports in some browsers).

Each test file is its own tiny hand-rolled runner (array of `{name, fn}`, run in a loop, `process.exit(1)` on failure) — there's no test framework like Jest/Vitest. To run a "single test," temporarily comment out the other `test(...)` calls in the relevant file, or add a `.only`-style filter yourself; there's no built-in flag for it.

## Architecture

**Data flow is one-directional and hub-based:** UI mutation → `recalc(invoice)` → full re-render. There is no partial state update or diffing.

- **`src/model.js`** — factory functions for the invoice shape (`createInvoice`, `createVehicle`, `createLine`, `createTier`, `createPickup`) plus the only sanctioned way to read "what this invoice's tiers/pickup look like": `getTierTemplate(inv)` → `{labels, rates}`, `getPickupTemplate(inv)` → `{label, rate}`, `realVehicles(inv)` (drops `VIRTUAL_VEHICLE_ID`, which lives here). **Nothing about tiers is fixed** — count (2/3/4…), labels, rates all come from the invoice; `DELIVERY_TIER_*`/`PICKUP_*` constants exist only for the demo fixture and an invoice with zero vehicles. All money fields (`unitPrice`, `rate`, `value`, `razem*`) are stored as **integer grosze** (1 zł = 100 gr), never floats — this is the load-bearing invariant of the whole codebase, so summing across the tree never accumulates rounding error. Only `format.js` converts grosze ↔ display strings.
- **`src/recalc.js`** — the sole place that derives totals. `summary.deliveryGroup.tiers` is sized to the max tier count across vehicles (not 3). `recalc(invoice)` mutates the invoice bottom-up (line → vehicle → invoice.summary) and can be safely re-run after any qty/unitPrice/override edit. Key mechanic: a line's `value` is normally `qty * unitPrice`, but setting `valueOverridden = true` freezes `value` at whatever was typed, independent of qty×unitPrice (used for manual corrections that don't fit the formula — see the DQE/NPSE and Eco Bonus cases in `test/recalc.test.js`).
- **`src/format.js`** — the sole place that converts grosze ↔ Polish-formatted strings (`formatPLN`/`parsePLN` for money with space thousands-separator and comma decimals, `formatInt`/`parseIntPL` for plain quantities).
- **`src/fixtures/sample-invoice.js`** — a real 5-vehicle invoice (ids 1203/1210/1220/1240/1299) built from `model.js` factories, shared as the seed data by both the acceptance test (`test/recalc.test.js`) and the UI's initial/reset state (`src/app.js`). If you change this fixture, re-check the hardcoded expected sums in the tests.
- **`src/app.js`** — the editor UI (Stage 2). No framework: plain DOM built via small `el()`/`text()` helpers. Rendering strategy is **full re-render on every commit**: any edit calls `recalcAndRender()`, which reruns `recalc()` then rebuilds `#app` from scratch. This is intentional (invoice is small — 5 vehicles) to avoid any risk of the DOM getting out of sync with computed sums; don't introduce partial/incremental DOM patching without a reason. The "Ставки и пороги" panel edits both the tier *labels* (thresholds, `rates.labels`) and rates for all vehicles at once (`applyRates`). Editable cells follow a click-to-`<input>` pattern (`editableCell()`): click swaps a `<td>`'s display span for an input; commit happens on Enter/blur, cancel on Escape — this avoids re-rendering (and losing cursor position) on every keystroke.
- **`src/style.css`** — the editor/salary styles; the trailing `@media (max-width: 640px)` block is the whole mobile layout (horizontal scroll *inside* `.block`/cards instead of breaking tables, ≥44px tap targets, single-column grids). Keep new UI inside that contract.
- **`src/main.js`** — the page entry point loaded by `index.html` (Stage 2.5); owns tab-switching between `#editor-view` (`src/app.js`'s `#app`) and `#salary-view` (`src/salary.js`'s `#salary`). `app.js` still fully owns and self-renders `#app` exactly as in Stage 2 — it's unaware `main.js`/`salary.js` exist. The only coupling is one-directional and explicit: `app.js` exports `setOnInvoiceChange(cb)` (called at the end of every `render()`) and `getInvoiceState()` (returns `{current, original}`, both already `recalc()`'d — `original` is a `structuredClone()` snapshot taken at the same three points `ORIGINAL_RAZEM` resets: initial load, `resetToOriginal()`, successful PDF load). `main.js` wires `getInvoiceState` → `renderSalaryTab`.
- **`src/salary-calc.js`** + **`src/salary.js`** — Stage 2.5, "Расчёт зарплат курьеров" (courier payout calculator), a read-only view over the already-`recalc()`'d invoice; never mutates `invoice`/`model.js`/`recalc.js`. `salary-calc.js` is pure (no DOM/localStorage, mirrors the `recalc.js`/`format.js` separation): `vehicleBase(vehicle)` sums the same six components `recalc.js` sums into `wynagrodzenie.razem` (`doreczenie`+`odbior`+`uslugi`+`bonusMalus`+`dodatkowe`+`ooh`), so `Σ vehicleBase(v) === invoice.summary.wynagrodzenie.razem` always holds — that identity is the UI's red/green control-sum row. `buildCourierRows(vehicles, groups, percentById)` turns vehicles into courier rows, honoring `groups` (`{id, memberIds, percentSourceId}`) for merged "one courier drove under two skruty" cases; `compareCourierRows(before, after)` matches by `groupId` to compute before/after deltas. `salary.js` is the DOM layer: percent-per-vehicle and courier name are persisted to `localStorage` (`gls-salary-percent-<id>` / `gls-salary-name-<id>`, with `DEFAULT_PERCENTS` seeding the demo fixture's 1203/1210/1220/1240/1299 only as an initial default); vehicle-merge `groups` are **session-only, module-level state, deliberately not persisted** (re-merging is a manual per-run action). Re-renders the whole `#salary` container on every change, same full-rebuild philosophy as `app.js`.
- **`src/print-model.js`** (pure) — `buildPrintModel(invoice)` → `{header, groups, blocks}`: the ordered list of printed blocks (`kind`: overall-pickup/overall-delivery/pickup/delivery/ooh/uslugi/wynagrodzenie/oplaty; `bars`, `tables[{kind, rows, razemLabel, razemQty, razemValue}]`, `key` = kind+vehicle+seg, `page` = page in the original PDF from layout). Order comes from `invoice.layout` (the parser's verbatim block order); OOH/Usługi lines are routed to the block whose `seg` they carry, lines without `seg` (editor-added, fixture) go to the vehicle's *last* block of that kind, vehicles/blocks missing from the layout are appended at the end of their kind's run, empty blocks are dropped (GLS prints nothing for them). Without a layout the canonical order (summaries → pickups → deliveries → OOH → Usługi with the virtual vehicle first → Wynagrodzenie → Opłaty) is used. This is the *single source of truth* for both print.js and the comparison tab.
- **`src/print-layout.js`** (pure) — `paginate(model)` → `{pages[{items[{type, y, h, …}]}], blockPages}` in pt, emulating the GLS SAP-form flow with constants measured (PyMuPDF) on four originals: content 28.35…813.54 pt, bars 21.6, data rows 14.4 (tiers 14.7), RAZEM 14.8/14.55, LG→SM gap 14.4 (OOH 11.4), space *after* a block 18.0/21.5/14.4/31.6 by kind, +14.4 after the two-line footers (Doręczenie, Usługi (Dopłaty), Bonus/Malus), +14.4 before a Dodatkowe table, +8.4 before the Opłaty table. **Rules:** no keep-together at all (a title bar may be last on a page); a spacing element that doesn't fit moves to the *top of the next page* (that's why GLS pages start at y=42.7 or 64.2 sometimes), a spacing that fits but whose following element doesn't is simply dropped; a table breaks on any row, the column header repeats before continued rows, a lone RAZEM continues without a header. Verified: identical per-page bar/RAZEM sequence on all four originals (Δy ≤ 2.4 pt); `test/pdf-parser.test.js` asserts page count and per-block start page against each sample PDF.
- **`src/print.js`** + **`src/print.css`** — the print page (`print.html`). Pure DOM: every layout item becomes an absolutely positioned div (`top`/`height` in pt from `paginate()`), rows are CSS grid (`.trow`) — **never `<table>`**: Chrome rounds table row heights to whole px, which accumulated ~3 mm per page and broke page-break parity. `.page` height = printable area under `@page margin: 10mm 9mm 2.5mm 25mm`; the footer `Strona X z Y` sits in the bottom margin at y=821.6 pt like GLS. Column widths (`STD_WIDTHS_MM`, `FEES_WIDTHS_MM` `[36,22,56,16,23,23]` — the original is MyriadPro, narrower than Arial, so Materiał/`Numer pojazdu` are wider), header coordinates, `Cena jedn.(PLN)` (no space in delivery tables and Opłaty) vs `Cena jedn. (PLN)`, two-line `Nazwa dostawcy` (`\n` kept by the parser, 17 pt pitch) are as before. `fitSheetToViewport()` scales `#sheet` on narrow screens (reset under `@media print`). **Data source:** `sessionStorage['gls-print-invoice']` written by `app.js` on every `render()` (the print link keeps `rel="opener"` — Chrome ≥88 otherwise drops the sessionStorage handoff), fallback `buildSampleInvoice()`. Group codes, tier labels/rates, pickup label all come from the invoice via print-model; the virtual vehicle (`VIRTUAL_VEHICLE_ID`) prints as a real "Usługi pojazdów" block with an empty `Pojazd` id, first among them, exactly where the layout says.
- **`src/compare.js`** — the "Сравнение с оригиналом" tab (`#compare`, third tab in `main.js`/`index.html`). Pure part `diffModels(oursModel, oursPages, origModel, origPages)` / `buildComparison(current, original)`: both sides go through `buildPrintModel`, blocks are matched by `key`, tables by kind, rows by name (tiers/pickup/Wynagrodzenie positionally), statuses `same`/`changed`/`only-ours`/`only-orig`, per-block page ours (`paginate`) vs original (`block.page` from the PDF; falls back to our pagination for the fixture), `orderSame`, summary (counts, pages, `identical`). DOM part renders left = current invoice as it will print, right = `original` snapshot from `getInvoiceState()` (which now also returns `printed` and `fileName`), with a "show only differences" toggle; re-rendered only while the tab is active. On mobile the two columns stack.
- **`src/ai/`** — Stage 5, text commands via the Anthropic API. `context-builder.js` (pure) builds a *compact* prompt context — vehicle ids + block names + current qty/unitPrice/value for every editable line, not the whole invoice. `anthropic-client.js` calls `claude-haiku-4-5` directly from the browser (`fetch` to `https://api.anthropic.com/v1/messages` with header `anthropic-dangerous-direct-browser-access: true`, no proxy/backend) with a system prompt demanding a bare JSON array (no markdown/prose); `parseOpsResponse()` still defensively strips a ```` ```json ```` fence in case the model adds one anyway. `ops.js` (pure) is where the actual safety net lives: `resolveOp(invoice, op)` validates one AI-proposed op against the *current* invoice (vehicle exists? line found by substring match? unambiguous — or does it need `"all":true`?) and returns a human-readable description plus (only if valid) an `apply()` closure over the matched line objects — nothing is mutated until `applyResolved()` is called, and only for `ok:true` entries. **The AI never computes sums** — `apply()` only sets raw fields (`qty`/`unitPrice`/`value`, `valueOverridden` when `field==='value'`; `setRates`/`setTierLabels` set tier `rate`/`label` on every vehicle) and the caller re-runs the existing `recalc()` afterward, same engine as every other edit path. `app.js` wires this to a "💬 Komenda tekstowa (AI)" panel (recognized-actions preview + explicit "Zastosuj" button — nothing is ever applied silently) and a gear-icon settings popover for the API key, stored only in `localStorage` (`gls-anthropic-api-key`) and never sent anywhere but `api.anthropic.com`.
- **`src/pdf/`** — Stage 3, the PDF import parser. Pipeline: `geometry.js` (pure — clusters raw pdf.js `getTextContent()` text fragments into reading-order cells by y/x-gap; needed because pdf.js splits words at Polish diacritics) → `tokenize.js` (walks all pages of a pdf.js document proxy through `geometry.js` into one flat cell stream, pulling out `"Strona X z Y"` footers) → `parse-invoice.js` (pure — a resilient anchor-driven scanner over that flat token stream that builds an `invoice` via `model.js` factories, plus a `printed` object mirroring every `RAZEM:` actually printed in the PDF, plus `warnings`; every block is try/caught and recovers by fast-forwarding to the next known anchor rather than throwing) → `reconcile.js` (pure — diffs `recalc(invoice)` against `printed`, grosze-exact, one row per block/vehicle). `load-browser.js` is the only browser-specific file: it points pdf.js (vendored in `vendor/pdfjs/`, not npm/CDN) at the uploaded `File` and calls the pipeline above. Node-side testing instead gets pdf.js from `pdfjs-dist` (devDependency) via `pdfjs-dist/legacy/build/pdf.mjs` — same `geometry.js`/`tokenize.js`/`parse-invoice.js` either way, since none of them import pdf.js directly. **Never assume a fixed number/order of sub-tables**: GLS omits a whole sub-table (header + rows + `RAZEM:`) when it would have 0 rows (see e.g. vehicle 1299 having no pickup or Bonus/Malus block at all in the sample) — `parse-invoice.js` identifies which sub-table it's looking at by the text label immediately before its `RAZEM:` (`SUBTABLE_KIND_BY_FOOTER`), not by position. `src/app.js`'s "📄 Загрузить PDF-фактуру" button wires this in, replacing `invoice` and rendering the reconciliation table (`.parse-report`); the loaded invoice then flows to `print.js` too via the `sessionStorage` bridge described above. **The parser is a dispatcher over anchors** (`parseTokens` loops `while (!atEnd)` and routes each known anchor to its handler), so block order is not assumed; pickup vs. delivery is told apart by the footer label before `RAZEM:` (`tierKind`), never by the group code; repeated blocks for the same vehicle are merged, repeated column headers mid-table are skipped. Vehicles missing a block in the PDF get their tier/pickup template from *this invoice* (overall summary rows → another vehicle → constants). **Layout:** `parseTokens(tokens, tokenPages)` also records `invoice.layout` — every printed block in document order with its PDF page (`tokenPages` from `tokenize.js`); each "Usługi pojazdów"/"OOH" anchor is a separate `seg` (GLS prints several Usługi blocks per vehicle in 325.pdf/LPL 09-2026), its lines get `line.seg`, repeated pickup/delivery/summary blocks merge into the first entry. `printed.vehicles[id].<kind>` stays the per-vehicle sum, so `reconcile.js` is unchanged. `test/flex-synthetic.test.js` has a `buildTokens(spec)` generator that emits the same token layout as `tokenize.js` does for real PDFs — extend it when adding a parser feature. Two quirks worth knowing about beyond the "0-row sub-table is omitted" rule above: (1) a vehicle's "Usługi pojazdów" table can be split across a page break, re-printing its "Pojazd"+id header a second time for the same vehicle — the parser **merges** (concats rows, sums RAZEM) rather than overwriting when a `kind` repeats for an already-known vehicle id; (2) some line items (e.g. "Dopłata paliwowa") print under a "Pojazd" anchor with **no id** — detected structurally via `readOptionalVehicleId()` (next token is a column-header cell, not an id) — and routed to a synthetic vehicle `VIRTUAL_VEHICLE_ID = '_общие'` rather than crashing; that vehicle typically has no delivery block at all, so its delivery tier labels fall back to `DELIVERY_TIER_LABELS` (harmless — its qty/value are 0). Delivery tier labels themselves are read verbatim per-vehicle from the PDF (`v.deliveryLabels`), never hardcoded, since different invoices use different weight thresholds (e.g. "Poniżej 3500" vs "Poniżej 4600").

### Invoice shape (informal)

```
invoice = { header, groups: {delivery, pickup}, vehicles: [vehicle...], fees: [line...], layout: [...]|null, summary }
layout entry = { kind:'overall', sub } | { kind:'pickup'|'delivery', vehicle } | { kind:'ooh', vehicle, seg }
             | { kind:'uslugi', vehicle, seg, tables:['surcharges'|'bonusMalus'|'extra'...] } | { kind:'wynagrodzenie'|'oplaty' }
             — each with page (PDF page the block starts on); see src/pdf/parse-invoice.js
vehicle = { id, delivery: { tiers: [tier x3], razemQty, razemValue },
            pickup: tier-shaped, ooh: [line...], surcharges: [line...],
            bonusMalus: [line...], extra: [line...],
            oohRazem, surchargesRazem, bonusMalusRazem, extraRazem }  // razem* set by recalc()
tier  = { label, qty, rate, value }               // value = qty*rate, no override
line  = { name, qty, unitPrice, value, valueOverridden, vehicle?, opis?, seg? }  // vehicle/opis — только у fees; seg — печатный блок (ooh/surcharges/bonusMalus/extra), из PDF
```

`invoice.summary` (entirely computed by `recalc()`, never hand-edited) holds `deliveryGroup` (delivery tiers totals across all vehicles), `pickupGroup` (pickup totals), `wynagrodzenie` (the six components + `razem` grand total), and `oplaty` (fees total — explicitly **excluded** from the grand `razem`).

`invoice.groups = { delivery, pickup }` — the literal "Grupa pojazdów" codes from the PDF (e.g. `5000000215/000017`). **Never hardcode these**: the delivery group number differs between invoices (`/000010` in 10082026.pdf, `/000017` in 092026.pdf) and the contract prefix differs too (`5000000712/…` in 325.pdf). The parser tells pickup from delivery by *structure* (one "Ponad 0" row vs. three tiers), not by code; `DEFAULT_GROUP_CODES` (`model.js`) is only the fixture/legacy fallback. Fee lines (`invoice.fees`) may additionally carry `vehicle` and `opis` (literal "Numer pojazdu"/"Opis" from the PDF) — kept per line, not per code, because one Materiał code can repeat for different vehicles.

### Working with money

Always construct/compare amounts in grosze (integers). Use `zlToGr(x)` (in `model.js`) when writing test/fixture data from a złoty figure for readability — never do float złoty arithmetic directly on model fields.
