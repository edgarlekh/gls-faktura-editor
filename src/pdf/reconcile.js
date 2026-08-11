// src/pdf/reconcile.js
// ОБЯЗАТЕЛЬНАЯ сверка: сравнивает то, что посчитал recalc(invoice), с тем,
// что НАПЕЧАТАНО в самом PDF (printed — см. parse-invoice.js). Это защита от
// ошибок парсинга: если разбор где-то ошибся, суммы разойдутся и это будет
// видно построчно, а не потонет в общем "похоже похоже".
//
// Сравнение — по целым грошам, толеранс 0 (это не округление, а честное
// совпадение печатных сумм с суммой по нашей модели).

export function reconcile(invoice, printed) {
  const rows = [];
  const add = (label, computed, printedValue, kind = 'money') => {
    const hasPrinted = printedValue !== undefined && printedValue !== null;
    rows.push({
      label,
      computed,
      printed: hasPrinted ? printedValue : null,
      ok: hasPrinted && computed === printedValue,
      kind,
    });
  };

  const s = invoice.summary;

  if (printed.group000004) {
    add('Odbiór — ogółem, grupa 000004 (Ilość)', s.group000004.qty, printed.group000004.qty, 'int');
    add('Odbiór — ogółem, grupa 000004 (Wartość)', s.group000004.value, printed.group000004.value);
  }
  if (printed.group000010) {
    add('Doręczenie — ogółem, grupa 000010 (Ilość)', s.group000010.razemQty, printed.group000010.qty, 'int');
    add('Doręczenie — ogółem, grupa 000010 (Wartość)', s.group000010.razemValue, printed.group000010.value);
  }

  for (const v of invoice.vehicles) {
    const p = printed.vehicles[v.id] || {};
    if (p.delivery) {
      add(`Pojazd ${v.id} — Doręczenie (Ilość)`, v.delivery.razemQty, p.delivery.qty, 'int');
      add(`Pojazd ${v.id} — Doręczenie (Wartość)`, v.delivery.razemValue, p.delivery.value);
    }
    if (p.pickup) {
      add(`Pojazd ${v.id} — Odbiór (Wartość)`, v.pickup.value, p.pickup.value);
    }
    if (p.ooh) add(`Pojazd ${v.id} — OOH RAZEM`, v.oohRazem, p.ooh.value);
    if (p.surcharges) add(`Pojazd ${v.id} — Usługi (Dopłaty) RAZEM`, v.surchargesRazem, p.surcharges.value);
    if (p.bonusMalus) add(`Pojazd ${v.id} — Bonus/Malus RAZEM`, v.bonusMalusRazem, p.bonusMalus.value);
    if (p.extra) add(`Pojazd ${v.id} — Dodatkowe pozycje RAZEM`, v.extraRazem, p.extra.value);
  }

  const w = s.wynagrodzenie;
  const pw = printed.wynagrodzenie || {};
  if (pw.doreczenie) add('Wynagrodzenie ogółem — Doręczenie', w.doreczenie, pw.doreczenie.value);
  if (pw.odbior) add('Wynagrodzenie ogółem — Odbiór', w.odbior, pw.odbior.value);
  if (pw.uslugi !== undefined) add('Wynagrodzenie ogółem — Usługi', w.uslugi, pw.uslugi);
  if (pw.bonusMalus !== undefined) add('Wynagrodzenie ogółem — Bonus/Malus', w.bonusMalus, pw.bonusMalus);
  if (pw.dodatkowePozycje !== undefined) add('Wynagrodzenie ogółem — Dodatkowe pozycje', w.dodatkowePozycje, pw.dodatkowePozycje);
  if (pw.ooh !== undefined) add('Wynagrodzenie ogółem — OOH', w.ooh, pw.ooh);
  if (pw.razem !== undefined) add('Wynagrodzenie ogółem — RAZEM', w.razem, pw.razem);

  if (printed.oplaty && printed.oplaty.razem !== undefined && printed.oplaty.razem !== null) {
    add('Opłaty — RAZEM', s.oplaty.razem, printed.oplaty.razem);
  }

  return rows;
}
