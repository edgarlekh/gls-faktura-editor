// src/print-model.js
// ЧИСТАЯ (без DOM) модель распечатки: превращает invoice (уже после recalc())
// в упорядоченный список печатных блоков — ровно то, что рисует print.js и
// что сравнивает с оригиналом вкладка «Сравнение» (src/compare.js). Один
// источник правды для обоих: если блок есть здесь, он напечатается; если его
// нет — его нет и на бумаге.
//
// ПОРЯДОК БЛОКОВ — из invoice.layout (парсер записывает его дословно из PDF,
// см. src/pdf/parse-invoice.js). GLS печатает:
//   сводки (Odbiór, Doręczenie) → per-vehicle Odbiór → per-vehicle Doręczenie
//   → OOH по машинам → "Usługi pojazdów" (общий блок без номера первым, затем
//   по машинам — причём для одной машины может быть НЕСКОЛЬКО блоков: первым
//   проходом CashService/Exchange…, вторым Rabat + Bonus/Malus + Dodatkowe)
//   → Wynagrodzenie ogółem → Opłaty.
// Строки OOH/Usługi несут line.seg = номер своего печатного блока; строки без
// seg (добавлены в редакторе, фикстура) попадают в ПОСЛЕДНИЙ блок машины того
// же типа, а если такого блока нет — образуют новый блок в конце своего ряда.
// Если layout нет (фикстура, старые сохранённые invoice) — порядок по
// умолчанию, как выше, по одному блоку на машину.
//
// Блок GLS не печатает, если печатать нечего: pickup/delivery с qty=0 и
// value=0, под-таблица без строк, "Usługi pojazdów" без единой под-таблицы.
//
// Форма блока:
//   { key, kind, vehicle, seg, page,          // page — страница ОРИГИНАЛА (из layout), иначе null
//     bars: [{ type:'lg', text } | { type:'sm', variant:'group'|'vehicleGroup'|'vehicle', id, code }],
//     tables: [{ kind, nameHeader, cenaHeader, rows:[{name, qty, unitPrice, value, vehicle?, opis?}],
//                razemLabel, razemQty|null, razemValue }] }
//   kind блока: 'overall-pickup' | 'overall-delivery' | 'pickup' | 'delivery' | 'ooh' | 'uslugi' |
//               'wynagrodzenie' | 'oplaty'
//   kind таблицы: 'pickup' | 'tiers' | 'ooh' | 'surcharges' | 'bonusMalus' | 'extra' | 'wyn' | 'fees'
// key — стабильный идентификатор для сопоставления «наша ↔ оригинал»
// (вкладка сравнения): kind + машина + seg.

import { DEFAULT_GROUP_CODES, getTierTemplate, getPickupTemplate, realVehicles, VIRTUAL_VEHICLE_ID } from './model.js';

export const USLUGI_TABLE_ORDER = ['surcharges', 'bonusMalus', 'extra'];
export const USLUGI_TABLE_LABELS = {
  surcharges: 'Usługi (Dopłaty)',
  bonusMalus: 'Bonus/Malus',
  extra: 'Dodatkowe pozycje',
};

// GLS печатает "Cena jedn.(PLN)" без пробела в таблицах доставки и в Opłaty,
// "Cena jedn. (PLN)" с пробелом везде ещё (pickup, OOH, Usługi pojazdów) —
// проверено по трём образцам (см. CLAUDE.md).
const CENA_TIGHT = 'Cena jedn.(PLN)';
const CENA_SPACED = 'Cena jedn. (PLN)';

const A_OVERALL = 'Łączny przegląd dla wszystkich grup pojazdów (za paczkę)';
const A_VEHICLE_GROUP = 'Pojazdy z grupy pojazdów (za paczkę)';

const hasPickup = (v) => !(v.pickup.qty === 0 && v.pickup.value === 0);
const hasDelivery = (v) => !(v.delivery.razemQty === 0 && v.delivery.razemValue === 0);

function lineRow(l) {
  return { name: l.name, qty: l.qty, unitPrice: l.unitPrice, value: l.value };
}
function sumValue(rows) {
  return rows.reduce((s, r) => s + r.value, 0);
}

function overallPickupBlock(invoice, groups) {
  const g = invoice.summary.pickupGroup;
  const tpl = getPickupTemplate(invoice);
  return {
    key: 'overall-pickup',
    kind: 'overall-pickup',
    vehicle: null,
    seg: null,
    page: null,
    bars: [{ type: 'lg', text: A_OVERALL }, { type: 'sm', variant: 'group', code: groups.pickup }],
    tables: [
      {
        kind: 'pickup',
        nameHeader: 'Paczki',
        cenaHeader: CENA_SPACED,
        rows: [{ name: tpl.label, qty: g.qty, unitPrice: tpl.rate, value: g.value }],
        razemLabel: 'Odbiór, za paczkę',
        razemQty: g.qty,
        razemValue: g.value,
      },
    ],
  };
}

function overallDeliveryBlock(invoice, groups) {
  const g = invoice.summary.deliveryGroup;
  const tpl = getTierTemplate(invoice);
  return {
    key: 'overall-delivery',
    kind: 'overall-delivery',
    vehicle: null,
    seg: null,
    page: null,
    bars: [{ type: 'lg', text: A_OVERALL }, { type: 'sm', variant: 'group', code: groups.delivery }],
    tables: [
      {
        kind: 'tiers',
        nameHeader: 'Paczki',
        cenaHeader: CENA_TIGHT,
        rows: g.tiers.map((t, i) => ({ name: tpl.labels[i] ?? '', qty: t.qty, unitPrice: tpl.rates[i] ?? 0, value: t.value })),
        razemLabel: 'Doręczenie, za paczkę',
        razemQty: g.razemQty,
        razemValue: g.razemValue,
      },
    ],
  };
}

function pickupBlock(v, groups) {
  return {
    key: `pickup:${v.id}`,
    kind: 'pickup',
    vehicle: v.id,
    seg: null,
    page: null,
    bars: [{ type: 'lg', text: A_VEHICLE_GROUP }, { type: 'sm', variant: 'vehicleGroup', id: v.id, code: groups.pickup }],
    tables: [
      {
        kind: 'pickup',
        nameHeader: 'Paczki',
        cenaHeader: CENA_SPACED,
        rows: [{ name: v.pickup.label, qty: v.pickup.qty, unitPrice: v.pickup.rate, value: v.pickup.value }],
        razemLabel: 'Odbiór, za paczkę',
        razemQty: v.pickup.qty,
        razemValue: v.pickup.value,
      },
    ],
  };
}

function deliveryBlock(v, groups) {
  return {
    key: `delivery:${v.id}`,
    kind: 'delivery',
    vehicle: v.id,
    seg: null,
    page: null,
    bars: [{ type: 'lg', text: A_VEHICLE_GROUP }, { type: 'sm', variant: 'vehicleGroup', id: v.id, code: groups.delivery }],
    tables: [
      {
        kind: 'tiers',
        nameHeader: 'Paczki',
        cenaHeader: CENA_TIGHT,
        rows: v.delivery.tiers.map((t) => ({ name: t.label, qty: t.qty, unitPrice: t.rate, value: t.value })),
        razemLabel: 'Doręczenie, za paczkę',
        razemQty: v.delivery.razemQty,
        razemValue: v.delivery.razemValue,
      },
    ],
  };
}

function oohBlock(v, lines, seg) {
  const rows = lines.map(lineRow);
  return {
    key: `ooh:${v.id}:${seg ?? 0}`,
    kind: 'ooh',
    vehicle: v.id,
    seg: seg ?? null,
    page: null,
    bars: [{ type: 'lg', text: 'OOH' }, { type: 'sm', variant: 'vehicle', id: v.id }],
    tables: [
      {
        kind: 'ooh',
        nameHeader: 'Nazwa usługi',
        cenaHeader: CENA_SPACED,
        rows,
        razemLabel: '',
        razemQty: null,
        razemValue: sumValue(rows),
      },
    ],
  };
}

// В Usługi pojazdów строка колонок без подписи первой колонки (в отличие от OOH).
function uslugiTable(kind, lines) {
  const rows = lines.map(lineRow);
  return {
    kind,
    nameHeader: '',
    cenaHeader: CENA_SPACED,
    rows,
    razemLabel: USLUGI_TABLE_LABELS[kind],
    razemQty: null,
    razemValue: sumValue(rows),
  };
}

function uslugiBlock(v, tablesSpec, seg) {
  // tablesSpec: [[kind, lines], ...] в порядке печати
  const tables = tablesSpec.filter(([, lines]) => lines.length > 0).map(([kind, lines]) => uslugiTable(kind, lines));
  return {
    key: `uslugi:${v.id}:${seg ?? 0}`,
    kind: 'uslugi',
    vehicle: v.id,
    seg: seg ?? null,
    page: null,
    bars: [{ type: 'lg', text: 'Usługi pojazdów' }, { type: 'sm', variant: 'vehicle', id: v.id }],
    tables,
  };
}

function wynagrodzenieBlock(invoice) {
  const s = invoice.summary;
  const w = s.wynagrodzenie;
  return {
    key: 'wynagrodzenie',
    kind: 'wynagrodzenie',
    vehicle: null,
    seg: null,
    page: null,
    bars: [],
    tables: [
      {
        kind: 'wyn',
        nameHeader: 'Wynagrodzenie ogółem (PLN)',
        cenaHeader: null,
        rows: [
          { name: 'Doręczenie (za paczkę)', qty: s.deliveryGroup.razemQty, unitPrice: null, value: w.doreczenie },
          { name: 'Odbiór (za paczkę)', qty: s.pickupGroup.qty, unitPrice: null, value: w.odbior },
          { name: 'Usługi', qty: null, unitPrice: null, value: w.uslugi },
          { name: 'Bonus/Malus', qty: null, unitPrice: null, value: w.bonusMalus },
          { name: 'Dodatkowe pozycje', qty: null, unitPrice: null, value: w.dodatkowePozycje },
          { name: 'OOH', qty: null, unitPrice: null, value: w.ooh },
        ],
        razemLabel: '',
        razemQty: null,
        razemValue: w.razem,
      },
    ],
  };
}

function oplatyBlock(invoice) {
  return {
    key: 'oplaty',
    kind: 'oplaty',
    vehicle: null,
    seg: null,
    page: null,
    bars: [{ type: 'lg', text: 'Opłaty' }],
    tables: [
      {
        kind: 'fees',
        nameHeader: 'Materiał',
        cenaHeader: CENA_TIGHT,
        rows: invoice.fees.map((f) => ({ name: f.name, vehicle: f.vehicle || '', opis: f.opis || '', qty: f.qty, unitPrice: f.unitPrice, value: f.value })),
        razemLabel: '',
        razemQty: null,
        razemValue: invoice.summary.oplaty.razem,
      },
    ],
  };
}

// Канонический порядок рядов блоков — для фактуры без layout и для вставки
// блоков, которых в layout нет (новая машина из редактора и т.п.).
const KIND_RANK = {
  'overall-pickup': 0,
  'overall-delivery': 1,
  pickup: 2,
  delivery: 3,
  ooh: 4,
  uslugi: 5,
  wynagrodzenie: 6,
  oplaty: 7,
};

/** Порядок по умолчанию (без layout): как в образце 10082026.pdf. */
function defaultBlocks(invoice, groups) {
  const real = realVehicles(invoice);
  const virtual = invoice.vehicles.filter((v) => v.id === VIRTUAL_VEHICLE_ID);
  const uslugiVehicles = virtual.concat(real); // общий блок без номера — первым
  const out = [];
  if (real.some(hasPickup)) out.push(overallPickupBlock(invoice, groups));
  if (real.some(hasDelivery)) out.push(overallDeliveryBlock(invoice, groups));
  real.filter(hasPickup).forEach((v) => out.push(pickupBlock(v, groups)));
  real.filter(hasDelivery).forEach((v) => out.push(deliveryBlock(v, groups)));
  uslugiVehicles.filter((v) => v.ooh.length).forEach((v) => out.push(oohBlock(v, v.ooh, null)));
  uslugiVehicles.forEach((v) => {
    const spec = USLUGI_TABLE_ORDER.map((k) => [k, v[k]]);
    if (spec.every(([, lines]) => lines.length === 0)) return;
    out.push(uslugiBlock(v, spec, null));
  });
  out.push(wynagrodzenieBlock(invoice));
  out.push(oplatyBlock(invoice));
  return out;
}

/**
 * Порядок из layout. Строки с seg → в свой блок; строки без seg → в последний
 * блок машины (того же типа), иначе новый блок в конце соответствующего ряда.
 * Блоки машин, которых в layout нет (добавлены в редакторе), — в конец ряда
 * своего типа. Пустые блоки (всё удалено) — пропускаются.
 */
function layoutBlocks(invoice, groups) {
  const layout = invoice.layout;
  const byId = new Map(invoice.vehicles.map((v) => [v.id, v]));
  const real = realVehicles(invoice);

  // --- какие строки идут в какой seg
  const segOf = (lines) => {
    const m = new Map();
    lines.forEach((l) => {
      const k = l.seg ?? null;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(l);
    });
    return m;
  };

  const out = [];
  const seen = new Set(); // ключи блоков, уже построенных из layout
  const lastUslugiEntryOfVehicle = new Map();
  const lastOohEntryOfVehicle = new Map();
  layout.forEach((e) => {
    if (e.kind === 'uslugi') lastUslugiEntryOfVehicle.set(e.vehicle, e);
    if (e.kind === 'ooh') lastOohEntryOfVehicle.set(e.vehicle, e);
  });

  layout.forEach((e) => {
    let block = null;
    if (e.kind === 'overall') {
      if (e.sub === 'pickup' && real.some(hasPickup)) block = overallPickupBlock(invoice, groups);
      if (e.sub === 'delivery' && real.some(hasDelivery)) block = overallDeliveryBlock(invoice, groups);
    } else if (e.kind === 'pickup' || e.kind === 'delivery') {
      const v = byId.get(e.vehicle);
      if (v && v.id !== VIRTUAL_VEHICLE_ID) {
        if (e.kind === 'pickup' && hasPickup(v)) block = pickupBlock(v, groups);
        if (e.kind === 'delivery' && hasDelivery(v)) block = deliveryBlock(v, groups);
      }
    } else if (e.kind === 'ooh') {
      const v = byId.get(e.vehicle);
      if (v) {
        const groupsBySeg = segOf(v.ooh);
        let lines = groupsBySeg.get(e.seg) || [];
        // строки без seg — в последний OOH-блок этой машины
        if (lastOohEntryOfVehicle.get(v.id) === e) lines = lines.concat(groupsBySeg.get(null) || []);
        if (lines.length) block = oohBlock(v, lines, e.seg);
      }
    } else if (e.kind === 'uslugi') {
      const v = byId.get(e.vehicle);
      if (v) {
        const isLast = lastUslugiEntryOfVehicle.get(v.id) === e;
        // порядок под-таблиц — как в PDF (e.tables), затем те, которых там не было
        const order = (e.tables || []).concat(USLUGI_TABLE_ORDER.filter((k) => !(e.tables || []).includes(k)));
        const spec = order.map((k) => {
          const g = segOf(v[k]);
          let lines = g.get(e.seg) || [];
          if (isLast) lines = lines.concat(g.get(null) || []);
          return [k, lines];
        });
        if (spec.some(([, lines]) => lines.length)) block = uslugiBlock(v, spec, e.seg);
      }
    } else if (e.kind === 'wynagrodzenie') {
      block = wynagrodzenieBlock(invoice);
    } else if (e.kind === 'oplaty') {
      block = oplatyBlock(invoice);
    }
    if (block) {
      block.page = e.page ?? null;
      block.y = e.y ?? null; // y якоря в PDF (pt от верха) — подсветка на картинке оригинала
      if (!seen.has(block.key)) {
        seen.add(block.key);
        out.push(block);
      }
    }
  });

  // --- блоки, которых в layout не было (новая машина / строки у машины без блока)
  const extras = [];
  if (!seen.has('overall-pickup') && real.some(hasPickup)) extras.push(overallPickupBlock(invoice, groups));
  if (!seen.has('overall-delivery') && real.some(hasDelivery)) extras.push(overallDeliveryBlock(invoice, groups));
  real.forEach((v) => {
    if (hasPickup(v) && !seen.has(`pickup:${v.id}`)) extras.push(pickupBlock(v, groups));
    if (hasDelivery(v) && !seen.has(`delivery:${v.id}`)) extras.push(deliveryBlock(v, groups));
  });
  invoice.vehicles.forEach((v) => {
    if (!lastOohEntryOfVehicle.has(v.id)) {
      const lines = v.ooh.filter((l) => l.seg == null || !layout.some((e) => e.kind === 'ooh' && e.seg === l.seg));
      if (lines.length) extras.push(oohBlock(v, lines, null));
    } else {
      // строки с seg, которого в layout нет (не должно быть, но не теряем)
      const orphan = v.ooh.filter((l) => l.seg != null && !layout.some((e) => e.kind === 'ooh' && e.vehicle === v.id && e.seg === l.seg));
      if (orphan.length) extras.push(oohBlock(v, orphan, null));
    }
    const knownSeg = (k, l) => l.seg != null && layout.some((e) => e.kind === 'uslugi' && e.vehicle === v.id && e.seg === l.seg);
    if (!lastUslugiEntryOfVehicle.has(v.id)) {
      const spec = USLUGI_TABLE_ORDER.map((k) => [k, v[k].filter((l) => !knownSeg(k, l))]);
      if (spec.some(([, lines]) => lines.length)) extras.push(uslugiBlock(v, spec, null));
    } else {
      const spec = USLUGI_TABLE_ORDER.map((k) => [k, v[k].filter((l) => l.seg != null && !knownSeg(k, l))]);
      if (spec.some(([, lines]) => lines.length)) extras.push(uslugiBlock(v, spec, null));
    }
  });
  if (!seen.has('wynagrodzenie')) extras.push(wynagrodzenieBlock(invoice));
  if (!seen.has('oplaty')) extras.push(oplatyBlock(invoice));

  // вставка: после последнего блока того же ряда (kind), иначе по рангу
  extras.forEach((b) => {
    let idx = -1;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (out[i].kind === b.kind) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      // первый блок с рангом выше — перед ним
      idx = out.findIndex((o) => KIND_RANK[o.kind] > KIND_RANK[b.kind]);
      if (idx === -1) idx = out.length;
      out.splice(idx, 0, b);
    } else {
      out.splice(idx + 1, 0, b);
    }
  });

  return out;
}

/**
 * @param {object} invoice — уже после recalc().
 * @returns {{ header: object, groups: {pickup:string, delivery:string}, blocks: object[] }}
 */
export function buildPrintModel(invoice) {
  const groups = { ...DEFAULT_GROUP_CODES, ...(invoice.groups || {}) };
  const blocks = Array.isArray(invoice.layout) && invoice.layout.length ? layoutBlocks(invoice, groups) : defaultBlocks(invoice, groups);
  return { header: invoice.header, groups, blocks };
}
