// recalc.js
// Движок пересчёта фактуры "снизу вверх". Чистая мутация: перезаписывает
// все производные поля (line.value, tier.value, razem*, invoice.summary),
// поэтому его можно безопасно перезапускать после любой правки qty/unitPrice/
// override в UI.

/** Строка: value = qty*unitPrice, если не задан valueOverridden. */
function recalcLine(line) {
  if (!line.valueOverridden) {
    line.value = line.qty * line.unitPrice;
  }
  return line.value;
}

/** Tier/pickup: value всегда = qty*rate (override для них не предусмотрен). */
function recalcTier(tier) {
  tier.value = tier.qty * tier.rate;
  return tier;
}

function sumValue(lines) {
  return lines.reduce((s, l) => s + l.value, 0);
}

/**
 * Пересчитывает всю фактуру и записывает invoice.summary:
 *  - group000010: {tiers:[{qty,value} x3], razemQty, razemValue} — сумма по всем машинам
 *  - group000004: {qty, value} — сумма pickup по всем машинам
 *  - wynagrodzenie: {doreczenie, odbior, uslugi, bonusMalus, dodatkowePozycje, ooh, razem}
 *  - oplaty: {razem} — Opłaty, В ОБЩИЙ razem НЕ входит
 * Возвращает тот же invoice (для удобства чейнинга).
 */
export function recalc(invoice) {
  const g10Tiers = [0, 1, 2].map(() => ({ qty: 0, value: 0 }));
  let g4Qty = 0;
  let g4Value = 0;

  let doreczenie = 0;
  let odbior = 0;
  let uslugi = 0;
  let bonusMalus = 0;
  let dodatkowe = 0;
  let ooh = 0;

  for (const v of invoice.vehicles) {
    // delivery — группа 000010
    v.delivery.tiers.forEach((tier, i) => {
      recalcTier(tier);
      g10Tiers[i].qty += tier.qty;
      g10Tiers[i].value += tier.value;
    });
    v.delivery.razemQty = v.delivery.tiers.reduce((s, t) => s + t.qty, 0);
    v.delivery.razemValue = v.delivery.tiers.reduce((s, t) => s + t.value, 0);
    doreczenie += v.delivery.razemValue;

    // pickup — группа 000004
    recalcTier(v.pickup);
    g4Qty += v.pickup.qty;
    g4Value += v.pickup.value;
    odbior += v.pickup.value;

    // ooh / surcharges (Usługi Dopłaty) / bonusMalus / extra (Dodatkowe pozycje)
    v.ooh.forEach(recalcLine);
    v.oohRazem = sumValue(v.ooh);
    ooh += v.oohRazem;

    v.surcharges.forEach(recalcLine);
    v.surchargesRazem = sumValue(v.surcharges);
    uslugi += v.surchargesRazem;

    v.bonusMalus.forEach(recalcLine);
    v.bonusMalusRazem = sumValue(v.bonusMalus);
    bonusMalus += v.bonusMalusRazem;

    v.extra.forEach(recalcLine);
    v.extraRazem = sumValue(v.extra);
    dodatkowe += v.extraRazem;
  }

  const g10RazemQty = g10Tiers.reduce((s, t) => s + t.qty, 0);
  const g10RazemValue = g10Tiers.reduce((s, t) => s + t.value, 0);

  // Opłaty — отдельная таблица, свой RAZEM, в общий итог не входит
  invoice.fees.forEach(recalcLine);
  const feesRazem = sumValue(invoice.fees);

  const razem = doreczenie + odbior + uslugi + bonusMalus + dodatkowe + ooh;

  invoice.summary = {
    group000010: { tiers: g10Tiers, razemQty: g10RazemQty, razemValue: g10RazemValue },
    group000004: { qty: g4Qty, value: g4Value },
    wynagrodzenie: {
      doreczenie,
      odbior,
      uslugi,
      bonusMalus,
      dodatkowePozycje: dodatkowe,
      ooh,
      razem,
    },
    oplaty: { razem: feesRazem },
  };

  return invoice;
}
