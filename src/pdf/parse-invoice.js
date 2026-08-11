// src/pdf/parse-invoice.js
// Разбор фактуры GLS из плоского потока токенов (см. tokenize.js) в нашу
// модель (model.js). Чистая функция — никакой зависимости от pdf.js, поэтому
// легко тестируется отдельно от чтения самого PDF.
//
// СТРУКТУРА ФАКТУРЫ (якоря, по которым идёт разбор — линейно, сверху вниз):
//   header: "Specyfikacja miesięczna <period>" / "Data wydruku" / "Nazwa
//     dostawcy" / "Nr dostawcy" / "Nr kontraktu" — по одной паре
//     label→следующий токен на каждое поле.
//   2× "Łączny przegląd dla wszystkich grup pojazdów (za paczkę)" — общие
//     сводки group000004 (pickup, код "…/000004") и group000010 (delivery,
//     код "…/000010"; определяем по суффиксу кода, не по порядку).
//   N× "Pojazdy z grupy pojazdów (za paczkę)" → "Pojazd" <id> → "Grupa
//     pojazdów" <code> — то же самое, но на одну машину (1 строка pickup
//     или 3 строки delivery). Машин и блоков — сколько есть, не захардкожено.
//   N× "OOH" → "Pojazd" <id> → строки до "RAZEM:".
//   N× "Usługi pojazdów" → "Pojazd" <id> → 3 таблицы подряд без повторного
//     "Pojazd" (surcharges/bonusMalus/extra), у каждой своя "RAZEM:".
//   "Wynagrodzenie ogółem (PLN)" → 6 строк + итоговый "RAZEM:".
//   "Opłaty" → строки [Materiał, (Numer pojazdu?), Opis, Ilość, Cena,
//     Wartość] до "RAZEM:"; Numer pojazdu распознаём по совпадению с уже
//     известным id машины (а не по позиции — он не у всех строк есть).
//
// Все таблицы читаются "пока не встретим RAZEM:" (readQuadRowsUntilRazem) —
// поэтому число строк в любом блоке произвольное. Подпись блока прямо перед
// RAZEM: (например "Bonus/Malus", "Usługi (Dopłaty)") распознаётся тем, что
// после неё не следует число — она просто проглатывается.
//
// УСТОЙЧИВОСТЬ: каждый блок в try/catch; при сбое пишем warnings и
// перематываем курсор до ближайшего следующего известного якоря — единичный
// сбой не должен положить весь разбор.

import { createInvoice, createVehicle, DELIVERY_TIER_RATES, PICKUP_RATE } from '../model.js';
import { parsePLN, parseIntPL } from '../format.js';

const norm = (s) => String(s).replace(/\s+/g, '').toLowerCase();

const A_OVERALL = norm('Łączny przegląd dla wszystkich grup pojazdów (za paczkę)');
const A_VEHICLE_GROUP = norm('Pojazdy z grupy pojazdów (za paczkę)');
const A_OOH = norm('OOH');
const A_USLUGI = norm('Usługi pojazdów');
const A_WYNAGRODZENIE = norm('Wynagrodzenie ogółem (PLN)');
const A_OPLATY = norm('Opłaty');
const A_RAZEM = norm('RAZEM:');

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

// Внутри "Usługi pojazdów" может идти 0..3 под-таблиц (surcharges/bonusMalus/
// extra) в этом порядке, но GLS печатает только непустые — если у машины,
// скажем, 0 строк Bonus/Malus, всей его под-таблицы (шапка+RAZEM) в PDF нет
// вообще. Поэтому определяем, какая это под-таблица, не по позиции, а по
// текстовой подписи перед её RAZEM: (см. readQuadRowsUntilRazem/footerLabel).
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

function recoverToNextAnchor(cur, anchorsNorm) {
  while (!cur.atEnd() && !anchorsNorm.includes(norm(cur.peek()))) {
    cur.next();
  }
}

function skipHeaderCells(cur, max = 8) {
  let count = 0;
  while (!cur.atEnd() && count < max && HEADER_CELLS.has(norm(cur.peek()))) {
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

function parseHeader(cur, header, warnings) {
  let guard = 0;
  while (!cur.atEnd() && guard < 20 && norm(cur.peek()) !== A_OVERALL) {
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
      header.supplierName = takeValue(cur, warnings, 'header');
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

function readSimpleTierRow(cur) {
  const label = cur.next();
  const qty = mustInt(cur.next());
  const rate = mustMoney(cur.next());
  const value = mustMoney(cur.next());
  return { label, qty, rate, value };
}

/**
 * Читает строки [name, qty, unitPrice, value] пока не встретит "RAZEM:".
 * Текстовая подпись блока прямо перед RAZEM: (например "Bonus/Malus" или
 * "Usługi (Dopłaty)") не похожа на строку данных (после неё не идёт число) —
 * она проглатывается, но запоминается как footerLabel: по ней потом можно
 * узнать, какой именно это был блок (см. SUBTABLE_KIND_BY_FOOTER — GLS
 * вообще не печатает под-таблицу, если в ней 0 строк, поэтому угадывать
 * "это третья по счёту таблица — значит extra" нельзя, только по подписи).
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
    const name = cur.next();
    if (cur.atEnd() || !isIntLike(cur.peek())) {
      // это не строка данных, а текстовая подпись блока перед RAZEM: —
      // проглатываем, запоминаем и идём дальше
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

function readFeesRowsUntilRazem(cur, vehicleIds, warnings) {
  const rows = [];
  const info = {};
  let guard = 0;
  while (!cur.atEnd() && norm(cur.peek()) !== A_RAZEM) {
    guard += 1;
    if (guard > 200) {
      warnings.push({ section: 'Opłaty', message: 'слишком много строк без RAZEM: — прерываю блок' });
      break;
    }
    const code = cur.next();
    let vehicle = '';
    if (!cur.atEnd() && vehicleIds.has(cur.peek())) {
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
    rows.push({ name: code, qty, unitPrice, value });
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

function parseOverallGroupBlock(cur, printed, warnings) {
  try {
    cur.next(); // anchor
    cur.next(); // 'Grupa pojazdów'
    const code = cur.next();
    const kind = code && code.endsWith('/000004') ? 'group000004' : code && code.endsWith('/000010') ? 'group000010' : null;
    skipHeaderCells(cur);
    const rowCount = kind === 'group000010' ? 3 : 1;
    const rows = [];
    for (let i = 0; i < rowCount; i += 1) rows.push(readSimpleTierRow(cur));
    if (!cur.atEnd() && norm(cur.peek()) !== A_RAZEM) cur.next(); // футер-подпись блока
    if (cur.atEnd() || norm(cur.peek()) !== A_RAZEM) {
      warnings.push({ section: 'Łączny przegląd', message: 'не найден RAZEM: для общей сводки' });
      return;
    }
    cur.next();
    const qty = mustInt(cur.next());
    const value = mustMoney(cur.next());
    if (kind) printed[kind] = { qty, value, rows };
    else warnings.push({ section: 'Łączny przegląd', message: `неизвестный код группы "${code}" — сводка пропущена` });
  } catch (err) {
    warnings.push({ section: 'Łączny przegląd', message: `ошибка разбора: ${err.message}` });
    recoverToNextAnchor(cur, [A_OVERALL, A_VEHICLE_GROUP]);
  }
}

function parseVehicleGroupBlock(cur, getVehicle, printed, warnings) {
  try {
    cur.next(); // anchor
    cur.next(); // 'Pojazd'
    const id = cur.next();
    cur.next(); // 'Grupa pojazdów'
    const code = cur.next();
    const kind = code && code.endsWith('/000004') ? 'pickup' : code && code.endsWith('/000010') ? 'delivery' : null;
    skipHeaderCells(cur);
    const rowCount = kind === 'delivery' ? 3 : 1;
    const rows = [];
    for (let i = 0; i < rowCount; i += 1) rows.push(readSimpleTierRow(cur));
    if (!cur.atEnd() && norm(cur.peek()) !== A_RAZEM) cur.next(); // футер-подпись блока
    if (cur.atEnd() || norm(cur.peek()) !== A_RAZEM) {
      warnings.push({ section: `Pojazd ${id ?? '?'}`, message: 'не найден RAZEM: для блока pickup/delivery' });
      return;
    }
    cur.next();
    const razemQty = mustInt(cur.next());
    const razemValue = mustMoney(cur.next());

    if (!id || !kind) {
      warnings.push({ section: 'Pojazdy z grupy pojazdów', message: `не удалось определить машину/тип блока (id=${id}, code=${code})` });
      return;
    }
    const v = getVehicle(id);
    if (kind === 'pickup') {
      v.pickupQty = rows[0].qty;
      v.pickupRate = rows[0].rate;
      printed.vehicles[id].pickup = { qty: razemQty, value: razemValue };
    } else {
      v.deliveryQtys = rows.map((r) => r.qty);
      v.deliveryRates = rows.map((r) => r.rate);
      printed.vehicles[id].delivery = { qty: razemQty, value: razemValue };
    }
  } catch (err) {
    warnings.push({ section: 'Pojazdy z grupy pojazdów', message: `ошибка разбора: ${err.message}` });
    recoverToNextAnchor(cur, [A_VEHICLE_GROUP, A_OOH, A_USLUGI]);
  }
}

function parseOohBlock(cur, getVehicle, printed, warnings) {
  try {
    cur.next(); // 'OOH'
    cur.next(); // 'Pojazd'
    const id = cur.next();
    skipHeaderCells(cur);
    const { rows, razemValue } = readQuadRowsUntilRazem(cur, warnings, `OOH — Pojazd ${id ?? '?'}`);
    if (!id) {
      warnings.push({ section: 'OOH', message: 'не удалось определить id машины' });
      return;
    }
    const v = getVehicle(id);
    v.ooh = rows;
    printed.vehicles[id].ooh = { value: razemValue };
  } catch (err) {
    warnings.push({ section: 'OOH', message: `ошибка разбора: ${err.message}` });
    recoverToNextAnchor(cur, [A_OOH, A_USLUGI]);
  }
}

function parseUslugiBlock(cur, getVehicle, printed, warnings) {
  const label = `Usługi pojazdów`;
  try {
    cur.next(); // 'Usługi pojazdów'
    cur.next(); // 'Pojazd'
    const id = cur.next();
    if (!id) {
      warnings.push({ section: label, message: 'не удалось определить id машины' });
      recoverToNextAnchor(cur, [A_USLUGI, A_WYNAGRODZENIE]);
      return;
    }
    const v = getVehicle(id);

    // 0..3 под-таблицы, только те, что реально есть (см. SUBTABLE_KIND_BY_FOOTER)
    let guard = 0;
    while (!cur.atEnd() && guard < 5 && HEADER_CELLS.has(norm(cur.peek()))) {
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
      v[kind] = rows;
      if (razemValue !== null) printed.vehicles[id][kind] = { value: razemValue };
    }
  } catch (err) {
    warnings.push({ section: label, message: `ошибка разбора: ${err.message}` });
    recoverToNextAnchor(cur, [A_USLUGI, A_WYNAGRODZENIE]);
  }
}

function parseWynagrodzenieBlock(cur, printed, warnings) {
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
    recoverToNextAnchor(cur, [A_OPLATY]);
  }
}

function parseOplatyBlock(cur, vehiclesById, printed, feesInfo, warnings) {
  try {
    cur.next(); // anchor
    skipHeaderCells(cur);
    const { rows, info, razemValue } = readFeesRowsUntilRazem(cur, vehiclesById, warnings);
    printed.oplaty = { rows, razem: razemValue };
    Object.assign(feesInfo, info);
  } catch (err) {
    warnings.push({ section: 'Opłaty', message: `ошибка разбора: ${err.message}` });
  }
}

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
  const printed = { group000004: null, group000010: null, vehicles: {}, wynagrodzenie: {}, oplaty: {} };
  const feesInfo = {};
  const vehiclesById = new Map();

  function getVehicle(id) {
    if (!vehiclesById.has(id)) {
      vehiclesById.set(id, {
        id,
        // дефолты на случай, если блок для машины в PDF вообще не напечатан
        // (GLS опускает целиком pickup/delivery/под-таблицы с 0 строк) —
        // ставки берём стандартные контрактные (model.js), т.к. на value=0
        // при qty=0 они не влияют, но так честнее, чем ставка 0,00 zł
        deliveryQtys: [0, 0, 0],
        deliveryRates: DELIVERY_TIER_RATES.slice(),
        pickupQty: 0,
        pickupRate: PICKUP_RATE,
        ooh: [],
        surcharges: [],
        bonusMalus: [],
        extra: [],
      });
      printed.vehicles[id] = {};
    }
    return vehiclesById.get(id);
  }

  parseHeader(cur, header, warnings);

  while (!cur.atEnd() && norm(cur.peek()) === A_OVERALL) {
    parseOverallGroupBlock(cur, printed, warnings);
  }

  while (!cur.atEnd() && norm(cur.peek()) === A_VEHICLE_GROUP) {
    parseVehicleGroupBlock(cur, getVehicle, printed, warnings);
  }

  while (!cur.atEnd() && norm(cur.peek()) === A_OOH) {
    parseOohBlock(cur, getVehicle, printed, warnings);
  }

  while (!cur.atEnd() && norm(cur.peek()) === A_USLUGI) {
    parseUslugiBlock(cur, getVehicle, printed, warnings);
  }

  if (!cur.atEnd() && norm(cur.peek()) === A_WYNAGRODZENIE) {
    parseWynagrodzenieBlock(cur, printed, warnings);
  } else {
    warnings.push({ section: 'Wynagrodzenie ogółem', message: 'блок не найден на ожидаемом месте' });
    recoverToNextAnchor(cur, [A_OPLATY]);
  }

  if (!cur.atEnd() && norm(cur.peek()) === A_OPLATY) {
    parseOplatyBlock(cur, vehiclesById, printed, feesInfo, warnings);
  } else {
    warnings.push({ section: 'Opłaty', message: 'блок не найден на ожидаемом месте' });
  }

  if (!cur.atEnd()) {
    warnings.push({
      section: 'document',
      message: `после разбора остались нераспознанные токены (${tokens.length - cur.pos}), начиная с "${cur.peek()}"`,
    });
  }

  const vehicles = [...vehiclesById.values()].map((v) =>
    createVehicle({
      id: v.id,
      deliveryQtys: v.deliveryQtys,
      deliveryRates: v.deliveryRates,
      pickupQty: v.pickupQty,
      pickupRate: v.pickupRate,
      ooh: v.ooh,
      surcharges: v.surcharges,
      bonusMalus: v.bonusMalus,
      extra: v.extra,
    })
  );

  const fees = (printed.oplaty && printed.oplaty.rows) || [];
  const invoice = createInvoice({ header, vehicles, fees });

  return { invoice, printed, feesInfo, warnings };
}
