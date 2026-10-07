// src/pdf/parse-invoice.js
// Разбор фактуры GLS из плоского потока токенов (см. tokenize.js) в нашу
// модель (model.js). Чистая функция — никакой зависимости от pdf.js, поэтому
// легко тестируется отдельно от чтения самого PDF.
//
// ГЛАВНЫЙ ПРИНЦИП: НИЧЕГО ИЗ ДАННЫХ ФАКТУРЫ НЕ ЗАХАРДКОЖЕНО. Мы трижды ловили
// баги из-за "констант", которые оказались переменными от фактуры к фактуре:
// границы тиров (3500→4600), код группы доставки (000010→000017), "Pojazd"
// без номера. Поэтому:
//   - номера машин — любые строки, любое их количество;
//   - код "Grupa pojazdów" читается дословно (invoice.groups), тип блока
//     (pickup/delivery) определяется ПО СОДЕРЖИМОМУ: подпись перед RAZEM:
//     ("Odbiór, za paczkę" / "Doręczenie, za paczkę"), а если её нет —
//     по числу строк (одна строка "Ponad 0" = pickup, несколько тиров =
//     delivery);
//   - тиров доставки любое число (2, 3, 4…), названия и ставки дословно;
//   - у машины может не быть ЛЮБОГО блока (GLS не печатает под-таблицу с
//     0 строк и блок pickup/delivery с 0 паczek) — дефолт для отсутствующего
//     блока берётся из ЭТОЙ ЖЕ фактуры (общая сводка/другая машина), а
//     константы model.js — только когда в фактуре вообще нет образца;
//   - блоки читаются в ЛЮБОМ порядке (диспетчер по якорю, см. parseTokens),
//     повторные вхождения блока для той же машины (перенос таблицы на
//     следующую страницу с повторной шапкой "Pojazd"+id) СКЛЕИВАЮТСЯ, а не
//     затирают предыдущее; повторно напечатанная шапка колонок внутри
//     таблицы пропускается.
//
// СТРУКТУРА ФАКТУРЫ (якоря):
//   header: "Specyfikacja miesięczna <period>" / "Data wydruku" / "Nazwa
//     dostawcy" / "Nr dostawcy" / "Nr kontraktu" — по одной паре
//     label→следующий токен на каждое поле.
//   "Łączny przegląd dla wszystkich grup pojazdów (za paczkę)" → "Grupa
//     pojazdów" <code> → строки тиров → подпись → "RAZEM:" qty value.
//   "Pojazdy z grupy pojazdów (za paczkę)" → "Pojazd" <id> → "Grupa
//     pojazdów" <code> → то же самое, но на одну машину.
//   "OOH" → "Pojazd" <id?> → строки до "RAZEM:".
//   "Usługi pojazdów" → "Pojazd" <id?> → 0..3 под-таблицы подряд
//     (surcharges/bonusMalus/extra), у каждой своя подпись и "RAZEM:".
//     "Pojazd" без номера — общие позиции → виртуальная машина
//     VIRTUAL_VEHICLE_ID (readOptionalVehicleId).
//   "Wynagrodzenie ogółem (PLN)" → 6 строк + итоговый "RAZEM:".
//   "Opłaty" → строки [Materiał, (Numer pojazdu?), Opis, Ilość, Cena,
//     Wartość] до "RAZEM:"; любые коды Materiał. Numer pojazdu отличаем от
//     Opis чисто по форме (весь из цифр, без пробела-разделителя тысяч).
//
// Все таблицы читаются "пока не встретим RAZEM:" — число строк в любом блоке
// произвольное. Подпись блока прямо перед RAZEM: распознаётся тем, что после
// неё не следует число.
//
// УСТОЙЧИВОСТЬ: каждый блок в try/catch; при сбое пишем warnings и
// перематываем курсор до ближайшего следующего известного якоря — единичный
// сбой не должен положить весь разбор.

import {
  createInvoice,
  createVehicle,
  DELIVERY_TIER_RATES,
  DELIVERY_TIER_LABELS,
  PICKUP_RATE,
  PICKUP_LABEL,
  VIRTUAL_VEHICLE_ID,
} from '../model.js';
import { parsePLN, parseIntPL } from '../format.js';

// re-export для обратной совместимости (print.js и тесты импортировали отсюда)
export { VIRTUAL_VEHICLE_ID };

const norm = (s) => String(s).replace(/\s+/g, '').toLowerCase();

const A_OVERALL = norm('Łączny przegląd dla wszystkich grup pojazdów (za paczkę)');
const A_VEHICLE_GROUP = norm('Pojazdy z grupy pojazdów (za paczkę)');
const A_OOH = norm('OOH');
const A_USLUGI = norm('Usługi pojazdów');
const A_WYNAGRODZENIE = norm('Wynagrodzenie ogółem (PLN)');
const A_OPLATY = norm('Opłaty');
const A_RAZEM = norm('RAZEM:');
const ALL_ANCHORS = [A_OVERALL, A_VEHICLE_GROUP, A_OOH, A_USLUGI, A_WYNAGRODZENIE, A_OPLATY];

const HEADER_CELLS = new Set([
  'paczki',
  'ilość',
  'cenajedn.(pln)',
  'wartość(pln)',
  'nazwausługi',
  'materiał',
  'numerpojazdu',
  'opis',
  'paczki(ilość)',
  'wynagrodzenie-razem',
]);

const isIntLike = (tok) => typeof tok === 'string' && /^-?\d[\d ]*$/.test(tok);
// "Numer pojazdu" в Opłaty — короткое число БЕЗ пробелов (5103, 1240); в
// отличие от Ilość у него никогда нет пробела-разделителя тысяч (реальные
// qty вроде "14 600" его содержат) — этим и отличаем поле от Ilość.
const isVehicleIdLike = (tok) => typeof tok === 'string' && /^\d+$/.test(tok);
const isHeaderCell = (tok) => typeof tok === 'string' && HEADER_CELLS.has(norm(tok));

function readOptionalVehicleId(cur) {
  if (!cur.atEnd() && isHeaderCell(cur.peek())) return VIRTUAL_VEHICLE_ID;
  return cur.next();
}

// Под-таблицы "Usługi pojazdów" распознаём по подписи перед их RAZEM:, а не
// по позиции — GLS печатает только непустые.
const SUBTABLE_KIND_BY_FOOTER = new Map([
  [norm('Usługi (Dopłaty)'), 'surcharges'],
  [norm('Bonus/Malus'), 'bonusMalus'],
  [norm('Dodatkowe pozycje'), 'extra'],
]);

class Cursor {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek(offset = 0) {
    return this.tokens[this.pos + offset];
  }
  next() {
    return this.tokens[this.pos++];
  }
  atEnd() {
    return this.pos >= this.tokens.length;
  }
}

function mustInt(tok) {
  const n = parseIntPL(tok);
  if (!Number.isFinite(n)) throw new Error(`ожидалось целое число, получили "${tok}"`);
  return n;
}
function mustMoney(tok) {
  const n = parsePLN(tok);
  if (!Number.isFinite(n)) throw new Error(`ожидалась сумма, получили "${tok}"`);
  return n;
}

function recoverToNextAnchor(cur, anchorsNorm = ALL_ANCHORS) {
  while (!cur.atEnd() && !anchorsNorm.includes(norm(cur.peek()))) {
    cur.next();
  }
}

function skipHeaderCells(cur, max = 8) {
  let count = 0;
  while (!cur.atEnd() && count < max && isHeaderCell(cur.peek())) {
    cur.next();
    count += 1;
  }
}

function takeValue(cur, warnings, section) {
  if (cur.atEnd()) {
    warnings.push({ section, message: 'ожидалось значение, поток токенов кончился' });
    return '';
  }
  return cur.next();
}

const HEADER_LABELS = new Set(['datawydruku', 'nazwadostawcy', 'nrdostawcy', 'nrkontraktu'].map(norm));
const isHeaderLabelOrAnchor = (tok) =>
  HEADER_LABELS.has(norm(tok)) || ALL_ANCHORS.includes(norm(tok)) || /^Specyfikacja miesięczna /.test(tok);

// Значение поля шапки может занимать НЕСКОЛЬКО строк (325.pdf: "LPL LOGISTICS
// SPOLKA Z OGRANICZONA" / "ODPOWIEDZIALNOSCIA") — дочитываем продолжения до
// следующей подписи/якоря и склеиваем через перевод строки, чтобы print.js перенёс
// строку ровно там же, где GLS.
function takeMultilineValue(cur, warnings, section) {
  const first = takeValue(cur, warnings, section);
  const parts = [first];
  while (!cur.atEnd() && parts.length < 4 && !isHeaderLabelOrAnchor(cur.peek())) {
    parts.push(cur.next());
  }
  return parts.join('\n');
}

function parseHeader(cur, header, warnings) {
  let guard = 0;
  while (!cur.atEnd() && guard < 20 && !ALL_ANCHORS.includes(norm(cur.peek()))) {
    guard += 1;
    const tok = cur.peek();
    const periodMatch = /^Specyfikacja miesięczna (.+)$/.exec(tok);
    if (periodMatch) {
      header.period = periodMatch[1];
      cur.next();
      continue;
    }
    const n = norm(tok);
    if (n === norm('Data wydruku')) {
      cur.next();
      header.printDate = takeValue(cur, warnings, 'header');
    } else if (n === norm('Nazwa dostawcy')) {
      cur.next();
      header.supplierName = takeMultilineValue(cur, warnings, 'header');
    } else if (n === norm('Nr dostawcy')) {
      cur.next();
      header.supplierNo = takeValue(cur, warnings, 'header');
    } else if (n === norm('Nr kontraktu')) {
      cur.next();
      header.contractNo = takeValue(cur, warnings, 'header');
    } else {
      // неизвестный токен в шапке — пропускаем, не падаем
      cur.next();
    }
  }
}

// ---------------------------------------------------------------------------
// pickup / delivery (строки-тиры [label, qty, rate, value])

function readSimpleTierRow(cur) {
  const label = cur.next();
  const qty = mustInt(cur.next());
  const rate = mustMoney(cur.next());
  const value = mustMoney(cur.next());
  return { label, qty, rate, value };
}

/**
 * Читает строки-тиры до текстовой подписи блока ("Odbiór, za paczkę" /
 * "Doręczenie, za paczkę") или до RAZEM:. Строка данных отличается от
 * подписи тем, что после label идёт целое число. Повторно напечатанная
 * шапка колонок (перенос на следующую страницу) пропускается.
 * @returns {{rows: object[], footerLabel: string|null}}
 */
function readTierRowsUntilFooter(cur) {
  const rows = [];
  let footerLabel = null;
  let guard = 0;
  while (!cur.atEnd() && norm(cur.peek()) !== A_RAZEM) {
    guard += 1;
    if (guard > 50) throw new Error('слишком много строк-тиров в блоке pickup/delivery');
    if (isHeaderCell(cur.peek())) {
      cur.next();
      continue;
    }
    if (isIntLike(cur.peek(1))) {
      rows.push(readSimpleTierRow(cur));
    } else {
      footerLabel = cur.next(); // подпись блока перед RAZEM:
    }
  }
  return { rows, footerLabel };
}

/**
 * Тип блока pickup/delivery ПО СОДЕРЖИМОМУ — никаких номеров групп:
 *  1) подпись перед RAZEM: ("Odbiór, za paczkę" → pickup, "Doręczenie, za
 *     paczkę" → delivery) — самый надёжный признак, он есть в каждом блоке;
 *  2) иначе по строкам: одна строка (в образцах "Ponad 0") → pickup,
 *     две и больше (тиры) → delivery.
 */
function tierKind(rows, footerLabel) {
  const f = norm(footerLabel || '');
  if (f.startsWith(norm('Odbiór'))) return 'pickup';
  if (f.startsWith(norm('Doręczenie'))) return 'delivery';
  if (rows.length === 1) return 'pickup';
  if (rows.length >= 2) return 'delivery';
  return null;
}

// Запоминаем код группы (дословно из PDF). Если в разных блоках одной
// фактуры для одного типа встретились разные коды — первый выигрывает,
// а расхождение уходит в warnings: это не ломает суммы, но надо глазами.
function rememberGroupCode(groups, kind, code, warnings, section) {
  if (!code) return;
  if (!groups[kind]) {
    groups[kind] = code;
  } else if (groups[kind] !== code) {
    warnings.push({ section, message: `код группы ${kind} отличается: "${groups[kind]}" и "${code}" — требует проверки` });
  }
}

function readTierBlockTail(cur, section, warnings) {
  const { rows, footerLabel } = readTierRowsUntilFooter(cur);
  if (cur.atEnd() || norm(cur.peek()) !== A_RAZEM) {
    warnings.push({ section, message: 'не найден RAZEM: для блока pickup/delivery' });
    return null;
  }
  cur.next(); // 'RAZEM:'
  const razemQty = mustInt(cur.next());
  const razemValue = mustMoney(cur.next());
  return { rows, kind: tierKind(rows, footerLabel), razemQty, razemValue };
}

function parseOverallGroupBlock(cur, ctx) {
  const { printed, groups, warnings } = ctx;
  try {
    cur.next(); // anchor
    cur.next(); // 'Grupa pojazdów'
    const code = cur.next();
    skipHeaderCells(cur);
    const tail = readTierBlockTail(cur, 'Łączny przegląd', warnings);
    if (!tail) return;
    const { rows, kind, razemQty, razemValue } = tail;
    if (!kind) {
      warnings.push({ section: 'Łączny przegląd', message: `не удалось определить тип сводки (код "${code}", строк ${rows.length}) — сводка пропущена` });
      return;
    }
    const key = kind === 'pickup' ? 'pickupGroup' : 'deliveryGroup';
    const prev = printed[key];
    // повтор сводки того же типа (перенос) — складываем
    printed[key] = prev
      ? { qty: prev.qty + razemQty, value: prev.value + razemValue, rows: mergeTierRows(prev.rows, rows) }
      : { qty: razemQty, value: razemValue, rows };
    rememberGroupCode(groups, kind, code, warnings, 'Łączny przegląd');
  } catch (err) {
    warnings.push({ section: 'Łączny przegląd', message: `ошибка разбора: ${err.message}` });
    recoverToNextAnchor(cur);
  }
}

// Склейка строк-тиров при повторе блока для той же машины: одинаковый label
// → суммируем qty/value, новый label → добавляем в конец.
function mergeTierRows(prevRows, rows) {
  const out = prevRows.map((r) => ({ ...r }));
  for (const r of rows) {
    const same = out.find((o) => norm(o.label) === norm(r.label));
    if (same) {
      same.qty += r.qty;
      same.value += r.value;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

function parseVehicleGroupBlock(cur, ctx) {
  const { getVehicle, printed, groups, warnings } = ctx;
  try {
    cur.next(); // anchor
    cur.next(); // 'Pojazd'
    const id = readOptionalVehicleId(cur);
    let code = null;
    if (!cur.atEnd() && norm(cur.peek()) === norm('Grupa pojazdów')) {
      cur.next();
      code = cur.next();
    }
    skipHeaderCells(cur);
    const tail = readTierBlockTail(cur, `Pojazd ${id ?? '?'}`, warnings);
    if (!tail) return;
    const { rows, kind, razemQty, razemValue } = tail;
    if (!id || !kind) {
      warnings.push({ section: 'Pojazdy z grupy pojazdów', message: `не удалось определить машину/тип блока (id=${id}, code=${code})` });
      return;
    }
    const v = getVehicle(id);
    rememberGroupCode(groups, kind, code, warnings, `Pojazd ${id}`);
    const p = printed.vehicles[id];
    if (kind === 'pickup') {
      v.pickupRows = v.pickupRows ? mergeTierRows(v.pickupRows, rows) : rows;
      p.pickup = p.pickup
        ? { qty: p.pickup.qty + razemQty, value: p.pickup.value + razemValue }
        : { qty: razemQty, value: razemValue };
    } else {
      // названия/ставки тиров — дословно из PDF, число тиров любое
      v.deliveryRows = v.deliveryRows ? mergeTierRows(v.deliveryRows, rows) : rows;
      p.delivery = p.delivery
        ? { qty: p.delivery.qty + razemQty, value: p.delivery.value + razemValue }
        : { qty: razemQty, value: razemValue };
    }
  } catch (err) {
    warnings.push({ section: 'Pojazdy z grupy pojazdów', message: `ошибка разбора: ${err.message}` });
    recoverToNextAnchor(cur);
  }
}

// ---------------------------------------------------------------------------
// строки [name, qty, unitPrice, value] (OOH / Usługi pojazdów)

/**
 * Читает строки до "RAZEM:". Текстовая подпись блока прямо перед RAZEM:
 * (например "Bonus/Malus") не похожа на строку данных (после неё не идёт
 * число) — она проглатывается, но запоминается как footerLabel. Повторно
 * напечатанная шапка колонок внутри таблицы (перенос страницы) пропускается.
 */
function readQuadRowsUntilRazem(cur, warnings, sectionLabel) {
  const rows = [];
  let footerLabel = null;
  let guard = 0;
  while (!cur.atEnd() && norm(cur.peek()) !== A_RAZEM) {
    guard += 1;
    if (guard > 500) {
      warnings.push({ section: sectionLabel, message: 'слишком много строк без RAZEM: — прерываю блок' });
      break;
    }
    if (isHeaderCell(cur.peek()) && !isIntLike(cur.peek(1))) {
      cur.next(); // повторная шапка колонок
      continue;
    }
    const name = cur.next();
    if (cur.atEnd() || !isIntLike(cur.peek())) {
      footerLabel = name;
      continue;
    }
    const qty = mustInt(cur.next());
    const unitPrice = mustMoney(cur.next());
    const value = mustMoney(cur.next());
    rows.push({ name, qty, unitPrice, value });
  }
  if (cur.atEnd()) {
    warnings.push({ section: sectionLabel, message: 'не найден RAZEM: — блок не закрыт, часть строк могла потеряться' });
    return { rows, razemValue: null, footerLabel };
  }
  cur.next(); // 'RAZEM:'
  const razemValue = mustMoney(cur.next());
  return { rows, razemValue, footerLabel };
}

function appendLines(v, kind, rows) {
  v[kind] = v[kind] && v[kind].length ? v[kind].concat(rows) : rows;
}
function addPrinted(p, kind, razemValue) {
  if (razemValue === null) return;
  const prev = p[kind];
  p[kind] = { value: (prev ? prev.value : 0) + razemValue };
}

function parseOohBlock(cur, ctx) {
  const { getVehicle, printed, warnings } = ctx;
  try {
    cur.next(); // 'OOH'
    if (!cur.atEnd() && norm(cur.peek()) === norm('Pojazd')) cur.next();
    const id = readOptionalVehicleId(cur);
    skipHeaderCells(cur);
    const { rows, razemValue } = readQuadRowsUntilRazem(cur, warnings, `OOH — Pojazd ${id ?? '?'}`);
    if (!id) {
      warnings.push({ section: 'OOH', message: 'не удалось определить id машины' });
      return;
    }
    const v = getVehicle(id);
    // повтор OOH для той же машины (перенос) — дописываем, не затираем
    appendLines(v, 'ooh', rows);
    addPrinted(printed.vehicles[id], 'ooh', razemValue);
  } catch (err) {
    warnings.push({ section: 'OOH', message: `ошибка разбора: ${err.message}` });
    recoverToNextAnchor(cur);
  }
}

function parseUslugiBlock(cur, ctx) {
  const { getVehicle, printed, warnings } = ctx;
  const label = 'Usługi pojazdów';
  try {
    cur.next(); // 'Usługi pojazdów'
    if (!cur.atEnd() && norm(cur.peek()) === norm('Pojazd')) cur.next();
    const id = readOptionalVehicleId(cur);
    if (!id) {
      warnings.push({ section: label, message: 'не удалось определить id машины' });
      recoverToNextAnchor(cur);
      return;
    }
    const v = getVehicle(id);

    // 0..3 под-таблицы, только те, что реально есть (SUBTABLE_KIND_BY_FOOTER).
    // Перенос таблицы на следующую страницу печатает "Usługi pojazdów" +
    // "Pojazd" + тот же id заново — строки ДОПИСЫВАЕМ и RAZEM СКЛАДЫВАЕМ.
    let guard = 0;
    while (!cur.atEnd() && guard < 5 && isHeaderCell(cur.peek())) {
      guard += 1;
      skipHeaderCells(cur);
      const { rows, razemValue, footerLabel } = readQuadRowsUntilRazem(cur, warnings, `${label} — Pojazd ${id}`);
      const kind = SUBTABLE_KIND_BY_FOOTER.get(norm(footerLabel || ''));
      if (!kind) {
        warnings.push({
          section: `${label} — Pojazd ${id}`,
          message: `не удалось определить тип под-таблицы (подпись "${footerLabel}") — строки (${rows.length}) пропущены, требует проверки`,
        });
        continue;
      }
      appendLines(v, kind, rows);
      addPrinted(printed.vehicles[id], kind, razemValue);
    }
  } catch (err) {
    warnings.push({ section: label, message: `ошибка разбора: ${err.message}` });
    recoverToNextAnchor(cur);
  }
}

// ---------------------------------------------------------------------------
// Wynagrodzenie ogółem / Opłaty

function parseWynagrodzenieBlock(cur, ctx) {
  const { printed, warnings } = ctx;
  try {
    cur.next(); // anchor
    skipHeaderCells(cur);
    const w = {};
    const readQtyValueRow = (labelNorm, key) => {
      if (cur.atEnd() || norm(cur.peek()) !== labelNorm) {
        warnings.push({ section: 'Wynagrodzenie ogółem', message: `ожидалась строка "${key}"` });
        return;
      }
      cur.next();
      w[key] = { qty: mustInt(cur.next()), value: mustMoney(cur.next()) };
    };
    const readValueRow = (labelNorm, key) => {
      if (cur.atEnd() || norm(cur.peek()) !== labelNorm) {
        warnings.push({ section: 'Wynagrodzenie ogółem', message: `ожидалась строка "${key}"` });
        return;
      }
      cur.next();
      w[key] = mustMoney(cur.next());
    };
    readQtyValueRow(norm('Doręczenie (za paczkę)'), 'doreczenie');
    readQtyValueRow(norm('Odbiór (za paczkę)'), 'odbior');
    readValueRow(norm('Usługi'), 'uslugi');
    readValueRow(norm('Bonus/Malus'), 'bonusMalus');
    readValueRow(norm('Dodatkowe pozycje'), 'dodatkowePozycje');
    readValueRow(norm('OOH'), 'ooh');
    if (!cur.atEnd() && norm(cur.peek()) === A_RAZEM) {
      cur.next();
      w.razem = mustMoney(cur.next());
    } else {
      warnings.push({ section: 'Wynagrodzenie ogółem', message: 'не найден итоговый RAZEM:' });
    }
    printed.wynagrodzenie = w;
  } catch (err) {
    warnings.push({ section: 'Wynagrodzenie ogółem', message: `ошибка разбора: ${err.message}` });
    recoverToNextAnchor(cur);
  }
}

function readFeesRowsUntilRazem(cur, warnings) {
  const rows = [];
  const info = {};
  let guard = 0;
  while (!cur.atEnd() && norm(cur.peek()) !== A_RAZEM) {
    guard += 1;
    if (guard > 200) {
      warnings.push({ section: 'Opłaty', message: 'слишком много строк без RAZEM: — прерываю блок' });
      break;
    }
    if (isHeaderCell(cur.peek())) {
      cur.next(); // повторная шапка колонок (перенос страницы)
      continue;
    }
    const code = cur.next();
    // "Numer pojazdu" — не у каждой строки есть; когда есть — ЛЮБОЙ номер
    // машины, необязательно из уже встреченных в фактуре. Отличаем от Opis
    // чисто по форме: весь из цифр без пробела.
    let vehicle = '';
    if (!cur.atEnd() && isVehicleIdLike(cur.peek())) {
      vehicle = cur.next();
    }
    if (cur.atEnd()) {
      warnings.push({ section: 'Opłaty', message: `строка "${code}" оборвана до конца потока` });
      break;
    }
    const opis = cur.next();
    if (cur.atEnd() || !isIntLike(cur.peek())) {
      warnings.push({ section: 'Opłaty', message: `не удалось разобрать строку "${code}" — требует проверки` });
      continue;
    }
    const qty = mustInt(cur.next());
    const unitPrice = mustMoney(cur.next());
    const value = mustMoney(cur.next());
    // vehicle/opis — на самой строке: один код может повториться для разных
    // машин (NP_PNLT_KU_NPD для 1220 и 1240 в 092026.pdf); per-code map
    // (info, оставлен для обратной совместимости) такую пару теряет.
    rows.push({ name: code, qty, unitPrice, value, vehicle, opis });
    info[code] = { vehicle, opis };
  }
  if (cur.atEnd()) {
    warnings.push({ section: 'Opłaty', message: 'не найден RAZEM: — блок Opłaty не закрыт' });
    return { rows, info, razemValue: null };
  }
  cur.next();
  const razemValue = mustMoney(cur.next());
  return { rows, info, razemValue };
}

function parseOplatyBlock(cur, ctx) {
  const { printed, feesInfo, warnings } = ctx;
  try {
    cur.next(); // anchor
    skipHeaderCells(cur);
    const { rows, info, razemValue } = readFeesRowsUntilRazem(cur, warnings);
    // повтор "Opłaty" (перенос таблицы с повторным якорем) — склеиваем
    const prev = printed.oplaty && printed.oplaty.rows ? printed.oplaty : null;
    printed.oplaty = prev
      ? { rows: prev.rows.concat(rows), razem: razemValue === null ? prev.razem : (prev.razem || 0) + razemValue }
      : { rows, razem: razemValue };
    Object.assign(feesInfo, info);
  } catch (err) {
    warnings.push({ section: 'Opłaty', message: `ошибка разбора: ${err.message}` });
    recoverToNextAnchor(cur);
  }
}

// ---------------------------------------------------------------------------

/**
 * @param {string[]} tokens — плоский поток ячеек (см. tokenize.js).
 * @returns {{invoice: object, printed: object, feesInfo: object, warnings: {section:string,message:string}[]}}
 *   invoice — ещё БЕЗ recalc() (вызывающий код сам решает, когда пересчитывать).
 *   printed — то, что напечатано в самом PDF (для сверки с recalc), см. reconcile.js.
 */
export function parseTokens(tokens) {
  const cur = new Cursor(tokens);
  const warnings = [];
  const header = { period: '', printDate: '', supplierName: '', supplierNo: '', contractNo: '' };
  const printed = { pickupGroup: null, deliveryGroup: null, vehicles: {}, wynagrodzenie: {}, oplaty: {} };
  const feesInfo = {};
  // коды "Grupa pojazdów" дословно из PDF; если какого-то блока в PDF нет,
  // createInvoice подставит DEFAULT_GROUP_CODES
  const groups = {};
  const vehiclesById = new Map();

  function getVehicle(id) {
    if (!vehiclesById.has(id)) {
      // Никаких дефолтов тиров/ставок здесь: что у машины реально напечатано
      // (deliveryRows/pickupRows), то и будет; для отсутствующих блоков
      // шаблон подбирается ниже из ЭТОЙ ЖЕ фактуры (см. tierTemplate).
      vehiclesById.set(id, { id, deliveryRows: null, pickupRows: null, ooh: [], surcharges: [], bonusMalus: [], extra: [] });
      printed.vehicles[id] = {};
    }
    return vehiclesById.get(id);
  }

  const ctx = { getVehicle, printed, groups, feesInfo, warnings };

  parseHeader(cur, header, warnings);

  // Диспетчер по якорю: блоки в ЛЮБОМ порядке и в любом количестве
  // (повторы для той же машины склеиваются внутри обработчиков).
  const HANDLERS = new Map([
    [A_OVERALL, parseOverallGroupBlock],
    [A_VEHICLE_GROUP, parseVehicleGroupBlock],
    [A_OOH, parseOohBlock],
    [A_USLUGI, parseUslugiBlock],
    [A_WYNAGRODZENIE, parseWynagrodzenieBlock],
    [A_OPLATY, parseOplatyBlock],
  ]);
  let seenWynagrodzenie = false;
  let seenOplaty = false;
  const unknown = [];
  while (!cur.atEnd()) {
    const key = norm(cur.peek());
    const handler = HANDLERS.get(key);
    if (!handler) {
      unknown.push(cur.next());
      continue;
    }
    if (key === A_WYNAGRODZENIE) seenWynagrodzenie = true;
    if (key === A_OPLATY) seenOplaty = true;
    const before = cur.pos;
    handler(cur, ctx);
    if (cur.pos === before) cur.next(); // защита от зацикливания
  }
  if (!seenWynagrodzenie) warnings.push({ section: 'Wynagrodzenie ogółem', message: 'блок не найден' });
  if (!seenOplaty) warnings.push({ section: 'Opłaty', message: 'блок не найден' });
  if (unknown.length) {
    warnings.push({
      section: 'document',
      message: `нераспознанные токены вне блоков (${unknown.length}), начиная с "${unknown[0]}"`,
    });
  }

  // Шаблон тиров/ставок для машин, у которых блок в PDF не напечатан
  // (0 paczek): сначала общая сводка этой фактуры, иначе первая машина с
  // блоком, и только если в фактуре вообще нет образца — константы model.js.
  const allVehicles = [...vehiclesById.values()];
  const deliveryTemplate =
    (printed.deliveryGroup && printed.deliveryGroup.rows) ||
    (allVehicles.find((v) => v.deliveryRows) || {}).deliveryRows ||
    DELIVERY_TIER_LABELS.map((label, i) => ({ label, rate: DELIVERY_TIER_RATES[i] }));
  const pickupTemplate =
    (printed.pickupGroup && printed.pickupGroup.rows && printed.pickupGroup.rows[0]) ||
    (allVehicles.find((v) => v.pickupRows) || { pickupRows: null }).pickupRows?.[0] ||
    { label: PICKUP_LABEL, rate: PICKUP_RATE };

  const vehicles = allVehicles.map((v) => {
    const dRows = v.deliveryRows || deliveryTemplate.map((t) => ({ label: t.label, rate: t.rate, qty: 0 }));
    const pRow = v.pickupRows ? v.pickupRows[0] : { label: pickupTemplate.label, rate: pickupTemplate.rate, qty: 0 };
    return createVehicle({
      id: v.id,
      deliveryQtys: dRows.map((r) => r.qty),
      deliveryRates: dRows.map((r) => r.rate),
      deliveryLabels: dRows.map((r) => r.label),
      pickupQty: pRow.qty,
      pickupRate: pRow.rate,
      pickupLabel: pRow.label,
      ooh: v.ooh,
      surcharges: v.surcharges,
      bonusMalus: v.bonusMalus,
      extra: v.extra,
    });
  });

  const fees = (printed.oplaty && printed.oplaty.rows) || [];
  const invoice = createInvoice({ header, groups, vehicles, fees });

  return { invoice, printed, feesInfo, warnings };
}
