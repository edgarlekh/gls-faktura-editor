// model.js
// Модель данных фактуры GLS + фабричные функции с дефолтами.
//
// Все денежные величины (unitPrice, rate, value, razem*) хранятся как ЦЕЛЫЕ
// ГРОШЕ (1 zł = 100 gr), а не float-złote — так суммирование по дереву не
// накапливает ошибку округления. format.js переводит грош <-> строку "zł,gr".

// ДЕФОЛТЫ ТОЛЬКО ДЛЯ ДЕМО-ФИКСТУРЫ (sample-invoice.js) и для фактуры без
// единой машины. Ничего из этого не является "контрактной константой":
// у реальных фактур число тиров, их названия, ставки, код группы и номера
// машин — любые, и всё это читается из PDF (см. src/pdf/parse-invoice.js).
// В UI/печати/ИИ брать параметры тиров через getTierTemplate()/
// getPickupTemplate() ниже, а не через эти константы напрямую.
export const DELIVERY_TIER_RATES = [650, 570, 544]; // gr = 6.50 / 5.70 / 5.44 zł
export const DELIVERY_TIER_LABELS = ['Poniżej 3500', '3500-4800', 'Ponad 4800'];
export const PICKUP_RATE = 123; // gr = 1.23 zł
export const PICKUP_LABEL = 'Ponad 0';

// "Pojazd" без номера в PDF — общие позиции (например "Dopłata paliwowa",
// "Usługi dodatkowe (...)"), не привязанные к машине. Парсер складывает их
// в виртуальную машину с этим id: она проходит через recalc() как обычная
// (её суммы входят в RAZEM), но в печати у неё НЕТ своего блока "Pojazd",
// и в UI-списках машин её надо учитывать отдельно (см. realVehicles()).
export const VIRTUAL_VEHICLE_ID = '_общие';

/** Машины без виртуальной "_общие" — для шаблонов тиров, печати, панелей. */
export function realVehicles(invoice) {
  return invoice.vehicles.filter((v) => v.id !== VIRTUAL_VEHICLE_ID);
}

/**
 * Шаблон тиров доставки ТЕКУЩЕЙ фактуры: {labels, rates} — из первой
 * реальной машины, у которой есть тиры. Число тиров любое (2, 3, 4…),
 * названия/ставки дословно из PDF. Константы выше — только если в фактуре
 * нет ни одной машины с тирами.
 */
export function getTierTemplate(invoice) {
  const v = realVehicles(invoice).find((x) => x.delivery && x.delivery.tiers && x.delivery.tiers.length > 0)
    || invoice.vehicles.find((x) => x.delivery && x.delivery.tiers && x.delivery.tiers.length > 0);
  if (v) {
    return { labels: v.delivery.tiers.map((t) => t.label), rates: v.delivery.tiers.map((t) => t.rate) };
  }
  return { labels: DELIVERY_TIER_LABELS.slice(), rates: DELIVERY_TIER_RATES.slice() };
}

/** Шаблон pickup ТЕКУЩЕЙ фактуры: {label, rate} — из первой реальной машины. */
export function getPickupTemplate(invoice) {
  const v = realVehicles(invoice).find((x) => x.pickup) || invoice.vehicles.find((x) => x.pickup);
  if (v) return { label: v.pickup.label, rate: v.pickup.rate };
  return { label: PICKUP_LABEL, rate: PICKUP_RATE };
}

// Коды "Grupa pojazdów" (SAP-номер контракта/группы) — печатаются в PDF над
// каждой сводкой/блоком pickup и delivery. Они НЕ постоянны: в образце
// 10082026.pdf доставка шла под .../000010, в 092026.pdf — под .../000017.
// Поэтому парсер читает их дословно в invoice.groups, а print.js печатает
// оттуда же; эти дефолты — только для фикстуры и старых сохранённых invoice.
export const DEFAULT_GROUP_CODES = Object.freeze({
  delivery: '5000000215/000010',
  pickup: '5000000215/000004',
});

/** zł (float) -> gr (int). Только для удобного ввода тестовых/UI данных. */
export function zlToGr(zl) {
  return Math.round(zl * 100);
}

/**
 * Строка ooh/surcharges/bonusMalus/extra/fees.
 * value по умолчанию = qty*unitPrice; если передан явный value, отличающийся
 * от qty*unitPrice, флаг valueOverridden выставляется автоматически (можно
 * задать и вручную — явный параметр всегда побеждает автоопределение).
 */
export function createLine({ name = '', qty = 0, unitPrice = 0, value, valueOverridden, vehicle, opis } = {}) {
  const computed = qty * unitPrice;
  const hasValue = value !== undefined;
  const v = hasValue ? value : computed;
  const overridden = valueOverridden !== undefined ? valueOverridden : hasValue && value !== computed;
  const line = { name, qty, unitPrice, value: v, valueOverridden: overridden };
  // Только у строк Opłaty: "Numer pojazdu" и "Opis" дословно из PDF. Один и
  // тот же код Materiał может встретиться дважды для разных машин (см.
  // NP_PNLT_KU_NPD для 1220 и 1240 в 092026.pdf), поэтому хранить это
  // per-code нельзя — только на самой строке. У остальных line полей нет.
  if (vehicle !== undefined) line.vehicle = vehicle;
  if (opis !== undefined) line.opis = opis;
  return line;
}

/** Один тариф внутри delivery (группа доставки): {label, qty, rate, value}. */
export function createTier(label, qty = 0, rate = 0) {
  return { label, qty, rate, value: qty * rate };
}

/** pickup (группа отбора) — по форме совпадает с tier: {label, qty, rate, value}. */
export function createPickup({ qty = 0, rate = PICKUP_RATE, label = PICKUP_LABEL } = {}) {
  return { label, qty, rate, value: qty * rate };
}

// Число тиров = max(длина rates, длина labels): любое, не только 3.
function createDeliveryTiers(qtys = [], rates = DELIVERY_TIER_RATES, labels = DELIVERY_TIER_LABELS) {
  const n = Math.max(rates.length, labels.length);
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(createTier(labels[i] ?? `Tier ${i + 1}`, qtys[i] ?? 0, rates[i] ?? 0));
  return out;
}

/**
 * Машина. id — любая строка из PDF ("1203", "5110", …). deliveryQtys —
 * [qty по каждому тиру] группы доставки, число тиров = длине deliveryRates/
 * deliveryLabels (любое). ooh/surcharges/bonusMalus/extra — массивы опций
 * createLine(). pickupLabel — подпись строки pickup ("Ponad 0" в образцах,
 * но читается из PDF).
 */
export function createVehicle({
  id,
  deliveryQtys = [],
  deliveryRates = DELIVERY_TIER_RATES,
  deliveryLabels = DELIVERY_TIER_LABELS,
  pickupQty = 0,
  pickupRate = PICKUP_RATE,
  pickupLabel = PICKUP_LABEL,
  ooh = [],
  surcharges = [],
  bonusMalus = [],
  extra = [],
} = {}) {
  return {
    id,
    delivery: {
      tiers: createDeliveryTiers(deliveryQtys, deliveryRates, deliveryLabels),
      razemQty: 0, // считает recalc()
      razemValue: 0, // считает recalc()
    },
    pickup: createPickup({ qty: pickupQty, rate: pickupRate, label: pickupLabel }),
    ooh: ooh.map(createLine),
    surcharges: surcharges.map(createLine),
    bonusMalus: bonusMalus.map(createLine),
    extra: extra.map(createLine),
  };
}

/**
 * Фактура целиком: header + groups + vehicles[] + fees[] (Opłaty, вне общего
 * RAZEM). groups — коды "Grupa pojazdów" дословно из PDF (см.
 * DEFAULT_GROUP_CODES), печатаются как есть.
 */
export function createInvoice({ header = {}, groups = {}, vehicles = [], fees = [] } = {}) {
  return {
    header: {
      period: '',
      printDate: '',
      supplierName: '',
      supplierNo: '',
      contractNo: '',
      ...header,
    },
    groups: { ...DEFAULT_GROUP_CODES, ...groups },
    vehicles,
    fees: fees.map(createLine),
    summary: null, // заполняется recalc()
  };
}
