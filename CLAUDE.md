# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Client-side editor for monthly GLS delivery invoices (Polish: "faktura"). Pure HTML/CSS/JS (ES modules), no framework, no build step, no backend — meant to be served statically (e.g. GitHub Pages). Comments are in Russian. **UI-language split (as of the UI-translation pass):** all app-chrome text — button labels, panel/tab titles, placeholders, tooltips, status and error messages — is Russian; invoice-domain vocabulary that mirrors the literal GLS document (block names like `Doręczenie`/`Odbiór`/`OOH`/`Usługi (Dopłaty)`/`Bonus/Malus`/`Dodatkowe pozycje`/`Opłaty`/`RAZEM`/`Wynagrodzenie ogółem`, column headers `Nazwa`/`Ilość`/`Cena`/`Wartość`/`Stawka`/`Próg`, tier labels `Poniżej 3500` etc., and invoice header field labels `Okres`/`Data wydruku`/`Umowa`) stays Polish — never translate that half, it's meant to visually match the official document. When adding new UI, follow this split rather than defaulting to Polish.

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

Этап 5 (`src/ai/*` — текстовые команды через Anthropic API, панель «💬 Komenda
tekstowa (AI)» + шестерёнка настроек в `app.js`) готов: модель
`claude-haiku-4-5`, прямой вызов из браузера с заголовком
`anthropic-dangerous-direct-browser-access: true` (проверено вживую — реальный
401 от api.anthropic.com на фейковый ключ, значит CORS/заголовок настоящие, не
просто код без сети). ИИ только переводит текст в JSON-операции
(`setRates`/`deleteLine`/`setField`) — сам не считает суммы; `src/ai/ops.js`
валидирует каждую операцию против текущей invoice (машина есть? строка
найдена? однозначна?) и показывает список распознанных действий ДО применения
— ничего не меняется без клика «Zastosuj» (проверено в headless-браузере с
замоканным ответом Anthropic: строка видна до применения, удаляется только
после явного клика, recalc пересчитывает верно). Ключ — только в
localStorage браузера, в репозиторий не попадает.

Этап 7 (GitHub Pages) готов: сайт публикуется по
`https://edgarlekh.github.io/gls-faktura-editor/` (Settings → Pages уже был
настроен раньше — источник `main`/`/` root, "legacy"/Jekyll-пайплайн сборки).
Добавлен `.nojekyll` в корень, чтобы гарантированно отключить обработку
Jekyll (у нас нет ни `_config.yml`, ни файлов, которым она нужна, а
`vendor/pdfjs/*.mjs` — минифицированный сторонний код, который лучше не
пропускать через Jekyll/Liquid вообще). Все пути в HTML/JS/CSS изначально
относительные (проверено grep'ом на `href="/`, `src="/`, `from "/`,
`fetch("/`, `url(/` — ничего не нашлось), поэтому сайт корректно работает под
саб-путём `/gls-faktura-editor/`, а не только в корне домена — это
подтверждено вживую headless-браузером **на самом задеплоенном URL** (не
локально): открылась фактура-фикстура (5 машин, RAZEM 60 863,83), загрузка
реального `10082026.pdf` через `vendor/pdfjs/` дала ✓ сверку со всеми
суммами, вкладка «Расчёт зарплат», панель настроек/AI и `print.html` (7
страниц) — всё без единой ошибки в консоли/сети.

UI-текст (`index.html`, `src/app.js`, `src/salary.js`, `src/main.js`,
`src/ai/*.js`) переведён на русский — см. "UI-language split" в разделе
Project выше. На практике `src/salary.js`/`src/main.js`/`src/ai/*.js` уже были
написаны по-русски (Этапы 2.5/5); правки коснулись почти только `src/app.js`
(Этап 2/3/5 UI-строк, писавшихся по старому правилу "как домен") и заголовка
`index.html`. Проверено headless-браузером: заголовок/кнопки/подсказки —
русские, а `Doręczenie`/`Próg`/`Ilość`/`Stawka`/`Wartość` и другие
блоки/колонки самой фактуры остались польскими.

Три точечных исправления (после Этапа 7/i18n):
1. **Печать видит текущие правки.** `src/app.js`'s `render()` кладёт
   `JSON.stringify(invoice)` в `sessionStorage['gls-print-invoice']` на
   каждый рендер; `src/print.js` при загрузке читает этот ключ вместо
   `buildSampleInvoice()`, если он есть. Ловушка, найденная и исправленная
   вживую (Playwright): с Chrome 88 `<a target="_blank">` без `rel="opener"`
   ведёт себя как `rel="noopener"` — `window.opener===null` в новой вкладке,
   а без opener'а sessionStorage НЕ наследуется, и печать тихо открывалась
   бы со старой фикстурой. Кнопка "🖨 Просмотр печати" теперь имеет
   `rel="opener"` явно — без него баг не воспроизводился бы в юнит-тестах
   (там нет реального клика по ссылке), только в живом браузере.
2. **Системный промпт AI-команд** (`src/ai/anthropic-client.js`) теперь
   начинается с жёсткой англоязычной JSON-only инструкции (дословно как
   попросили), плюс `temperature: 0` в теле запроса — детальное описание
   операций (setRates/deleteLine/setField, блоки, контекст) оставлено ниже
   этой инструкции, иначе модель не знала бы схему операций и всегда бы
   возвращала `[]`.
3. **Вёрстка карточки машины.** `.vehicle-grid` был CSS grid с auto-fit
   колонками (блоки Doręczenie/Odbiór/OOH/Usługi/Bonus-Malus/Dodatkowe
   сжимались до ~260px и становились нечитаемыми) — заменён на
   `flex-direction: column`, блоки идут вертикально во всю ширину карточки.

Формат текста «📋 Скопировать сводку» (`src/salary.js`, `buildSummaryText`,
теперь `export`) переделан под моноширинный шаблон с рамками (═/─) для
отправки курьеру в мессенджер — см. `test/salary-copy.test.js`: блок для
"Скрут 1203" сверен ПОСИМВОЛЬНО с макетом из ТЗ (это не выдуманные числа —
макет буквально построен на реальной фикстуре с дефолтным 50%). Ширина строк
для 6 позиций + "База:" — ровно 24 символа, значения `padStart()` до этой
ширины; отрицательные суммы — с типографским минусом `−` (U+2212), не ASCII
`-`. Объединённые скруты — заголовок `Курьер (id1+id2)` вместо `Скрут NNNN`.
`buildSummaryText` — DOM-независимая функция (не трогает `document`), но
использует `localStorage` через `getName()`/`getPercent()` — поэтому тест
ставит минимальный in-memory полифилл `globalThis.localStorage` (Node не
даёт его по умолчанию), никакого jsdom не нужно.

Второй реальный образец, `325.pdf` (9 машин, тоже в `.gitignore` — не
публикуем), выявил 4 бага парсера (`src/pdf/parse-invoice.js`), три из них —
по заявке пользователя, четвёртый нашёлся при добивании точных контрольных
сумм (RAZEM 62 584,71 / Opłaty 2 587,37):
1. **Названия тиров доставки хардкодились.** `readSimpleTierRow()` и раньше
   читал `label` из PDF построчно, но `parseVehicleGroupBlock()` его
   выбрасывал — в финальный `createVehicle()` уходили только `deliveryQtys`/
   `deliveryRates`, а `deliveryLabels` брался из дефолтного
   `DELIVERY_TIER_LABELS` (`model.js`). У 325.pdf тиры "Poniżej 4600" /
   "4600-6400" / "Ponad 6400" — не "Poniżej 3500" и т.п. Теперь `v.deliveryLabels`
   прокидывается дословно из PDF; `DELIVERY_TIER_LABELS` остался только
   дефолтом на случай, если у машины блок delivery в PDF не напечатан вообще.
2. **"Pojazd" без номера машины.** Общие позиции вне привязки к конкретной
   машине (например "Dopłata paliwowa") печатаются как `"Usługi pojazdów" →
   "Pojazd" → <сразу заголовок колонки, id нет>` — раньше `cur.next()` слепо
   хватал заголовок колонки как id. `readOptionalVehicleId()` (проверяет,
   не является ли следующий токен заголовком колонки из `HEADER_CELLS`)
   вместо этого направляет такие строки в виртуальную машину с id
   `VIRTUAL_VEHICLE_ID = '_общие'` — она проходит через тот же
   `createVehicle()`/`recalc()`, просто ни с одним реальным Pojazd не связана.
   Применено и в OOH, и в Usługi pojazdów.
3. **"Numer pojazdu" в Opłaty распознавался только для уже известных id.**
   Строка с номером машины, которая нигде больше в фактуре не встречается
   (например 5103 у NP_WORKING_POL_M/NP_WORKING_STK_EVO в 325.pdf), не
   матчилась — парсер путал её с Opis, дальше сыпались "не удалось
   разобрать строку" по цепочке. Заменил проверку членства в множестве
   известных id на структурную: `isVehicleIdLike()` — просто цифры без
   пробела (Ilość с пробелом-разделителем тысяч вроде "14 600" так не
   спутать). Никакой список кодов Materiał никогда не хардкодился — эта
   часть уже работала для любых кодов.
4. **(найден по пути) Usługi pojazdów одной машины может печататься в НЕСКОЛЬКО
   отдельных вхождений**, если таблица переносится на следующую страницу —
   "Usługi pojazdów"+"Pojazd"+тот же id печатаются заново, с новой RAZEM: для
   того же под-типа (surcharges/bonusMalus/extra). Код раньше делал
   `v[kind] = rows` (перезапись) — второе вхождение стирало первое. Теперь
   `v[kind] = v[kind].concat(rows)` и суммирование `printed…[kind].value`,
   если этот kind у машины уже встречался; для единственного вхождения (как
   почти всегда) ведёт себя как раньше. Та же логика — в OOH, на случай
   такого же переноса там.

`test/pdf-parser.test.js` теперь гоняет ОБА образца независимо (каждый в
своём `if (fs.existsSync(...))` блоке — отсутствие одного не блокирует тесты
другого; если нет ни одного — файл целиком SKIP). Проверено: и в узловом
тесте, и вживую в браузере (реальная загрузка 325.pdf через UI) — сверка
полностью зелёная, 0 warnings, 10 карточек машин (9 реальных + `_общие`).

Следом всплыл тот же класс бага в самом редакторе, не только в парсере:
`src/app.js` держал `const TIER_LABELS = ['Poniżej 3500', '3500-4800', 'Ponad 4800']`
как модульную константу — панель «Ставки» и карточка «Łączny przegląd —
grupa 000010» показывали эти названия ВСЕГДА, даже после загрузки фактуры с
другими тирами (325.pdf → «Poniżej 4600» и т.д.). Заменил на `getTierLabels(inv)` —
берёт `label` из тиров delivery первой машины ТЕКУЩЕЙ invoice (с фолбэком на
`DELIVERY_TIER_LABELS` из `model.js`, если машин ещё нет), вызывается заново
на каждый `render()`, а не один раз при загрузке модуля. Проверено вживую:
после `.setInputFiles('325.pdf')` и панель ставок, и сводка 000010
показывают «Poniżej 4600» / «4600-6400» / «Ponad 6400» вместо дефолтных.

Дальше по плану: ничего не запланировано явно — уточнить у пользователя.

## Commands

```
npm test          # runs all five test files, node's built-in assert, no test framework
node test/recalc.test.js
node test/ui-scenarios.test.js
node test/pdf-parser.test.js   # разбирает 10082026.pdf через pdfjs-dist (devDependency);
                                # если файла нет локально (он в .gitignore) — тест просто печатает
                                # SKIP и завершается успешно, а не падает
node test/salary-calc.test.js
node test/ai-ops.test.js       # чистая логика операций (src/ai/ops.js) — без сети, без Anthropic API
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
- **`src/ai/`** — Stage 5, text commands via the Anthropic API. `context-builder.js` (pure) builds a *compact* prompt context — vehicle ids + block names + current qty/unitPrice/value for every editable line, not the whole invoice. `anthropic-client.js` calls `claude-haiku-4-5` directly from the browser (`fetch` to `https://api.anthropic.com/v1/messages` with header `anthropic-dangerous-direct-browser-access: true`, no proxy/backend) with a system prompt demanding a bare JSON array (no markdown/prose); `parseOpsResponse()` still defensively strips a ```` ```json ```` fence in case the model adds one anyway. `ops.js` (pure) is where the actual safety net lives: `resolveOp(invoice, op)` validates one AI-proposed op against the *current* invoice (vehicle exists? line found by substring match? unambiguous — or does it need `"all":true`?) and returns a human-readable description plus (only if valid) an `apply()` closure over the matched line objects — nothing is mutated until `applyResolved()` is called, and only for `ok:true` entries. **The AI never computes sums** — `apply()` only sets raw fields (`qty`/`unitPrice`/`value`, `valueOverridden` when `field==='value'`) and the caller re-runs the existing `recalc()` afterward, same engine as every other edit path. `app.js` wires this to a "💬 Komenda tekstowa (AI)" panel (recognized-actions preview + explicit "Zastosuj" button — nothing is ever applied silently) and a gear-icon settings popover for the API key, stored only in `localStorage` (`gls-anthropic-api-key`) and never sent anywhere but `api.anthropic.com`.
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
