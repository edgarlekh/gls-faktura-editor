// src/salary-calc.js
// Этап 2.5: чистая логика расчёта зарплат курьеров. Не трогает model.js/
// recalc.js/print.js — только читает уже готовую (recalc()'нутую) invoice и
// считает производные суммы. Никакого DOM/localStorage здесь нет — это делает
// src/salary.js, а сама логика (и вход в неё — «объединение скрутов»,
// «выплата = база × процент») тестируется отдельно, без браузера.

/**
 * База скрута (машины) — сумма тех же 6 позиций, что recalc.js суммирует по
 * всем машинам в invoice.summary.wynagrodzenie (doreczenie/odbior/uslugi/
 * bonusMalus/dodatkowePozycje/ooh), но для ОДНОЙ машины. Поэтому сумма баз
 * всех машин всегда равна invoice.summary.wynagrodzenie.razem — это и есть
 * контрольная строка в UI.
 */
export function vehicleBreakdown(vehicle) {
  return {
    doreczenie: vehicle.delivery.razemValue,
    odbior: vehicle.pickup.value,
    uslugi: vehicle.surchargesRazem,
    bonusMalus: vehicle.bonusMalusRazem,
    dodatkowe: vehicle.extraRazem,
    ooh: vehicle.oohRazem,
  };
}

const BREAKDOWN_KEYS = ['doreczenie', 'odbior', 'uslugi', 'bonusMalus', 'dodatkowe', 'ooh'];

export function sumBreakdowns(breakdowns) {
  const acc = { doreczenie: 0, odbior: 0, uslugi: 0, bonusMalus: 0, dodatkowe: 0, ooh: 0 };
  for (const b of breakdowns) {
    for (const key of BREAKDOWN_KEYS) acc[key] += b[key];
  }
  return acc;
}

export function breakdownTotal(b) {
  return BREAKDOWN_KEYS.reduce((s, key) => s + b[key], 0);
}

/** База машины = сумма её 6 позиций (см. vehicleBreakdown). */
export function vehicleBase(vehicle) {
  return breakdownTotal(vehicleBreakdown(vehicle));
}

/** Выплата = база × процент/100, округление до гроша. */
export function payout(base, percent) {
  return Math.round((base * percent) / 100);
}

/**
 * Строит строки таблицы курьеров: по одной на группу (объединённые скруты)
 * плюс по одной на каждый скрут, не входящий ни в одну группу.
 *
 * @param vehicles - invoice.vehicles (уже recalc()'нутые)
 * @param groups - [{ id, memberIds: [vehicleId...], percentSourceId? }] —
 *   разовое объединение скрутов в курьера, memberIds.length может быть 1..N
 * @param percentById - Map(vehicleId -> percent), откуда берётся ставка
 * @returns [{ groupId, memberIds, merged, percentSourceId, breakdown, base, percent, payout }]
 */
export function buildCourierRows(vehicles, groups, percentById) {
  const byId = new Map(vehicles.map((v) => [v.id, v]));
  const grouped = new Set(groups.flatMap((g) => g.memberIds));
  const rows = [];

  for (const g of groups) {
    const members = g.memberIds.map((id) => byId.get(id)).filter(Boolean);
    if (!members.length) continue;
    const breakdown = sumBreakdowns(members.map(vehicleBreakdown));
    const base = breakdownTotal(breakdown);
    const percentSourceId = g.percentSourceId && g.memberIds.includes(g.percentSourceId) ? g.percentSourceId : g.memberIds[0];
    const percent = percentById.get(percentSourceId) ?? 50;
    rows.push({
      groupId: g.id,
      memberIds: g.memberIds,
      merged: g.memberIds.length > 1,
      percentSourceId,
      breakdown,
      base,
      percent,
      payout: payout(base, percent),
    });
  }

  for (const v of vehicles) {
    if (grouped.has(v.id)) continue;
    const breakdown = vehicleBreakdown(v);
    const base = breakdownTotal(breakdown);
    const percent = percentById.get(v.id) ?? 50;
    rows.push({
      groupId: v.id,
      memberIds: [v.id],
      merged: false,
      percentSourceId: v.id,
      breakdown,
      base,
      percent,
      payout: payout(base, percent),
    });
  }

  return rows;
}

/**
 * Сопоставляет строки "до" и "после" по groupId (одна и та же конфигурация
 * групп передаётся в buildCourierRows для обоих расчётов, поэтому groupId
 * стабилен) и добавляет дельты.
 */
export function compareCourierRows(beforeRows, afterRows) {
  const beforeById = new Map(beforeRows.map((r) => [r.groupId, r]));
  return afterRows.map((after) => {
    const before = beforeById.get(after.groupId) || null;
    return {
      ...after,
      before,
      deltaBase: after.base - (before ? before.base : 0),
      deltaPayout: after.payout - (before ? before.payout : 0),
    };
  });
}
