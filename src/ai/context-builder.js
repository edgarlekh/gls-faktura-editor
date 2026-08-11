// src/ai/context-builder.js
// Этап 5: строит КОМПАКТНЫЙ текстовый контекст фактуры для промпта — только
// id машин, названия блоков и текущие qty/cena/wartość редактируемых строк
// (то, что нужно ИИ, чтобы сопоставить "match" из команды с реальной
// строкой). Не вся фактура целиком — дёшево и быстро, как и просили.

import { formatPLN } from '../format.js';

const BLOCK_LABELS = [
  ['ooh', 'OOH'],
  ['surcharges', 'Usługi (Dopłaty)'],
  ['bonusMalus', 'Bonus/Malus'],
  ['extra', 'Dodatkowe pozycje'],
];

function lineRow(l) {
  return `    - ${l.name} | qty=${l.qty} | cena=${formatPLN(l.unitPrice)} | wartość=${formatPLN(l.value)}`;
}

/** @returns {string} компактный список машин/блоков/строк для системного промпта. */
export function buildInvoiceContext(invoice) {
  const out = [];

  if (invoice.vehicles[0]) {
    const rates = invoice.vehicles[0].delivery.tiers.map((t) => formatPLN(t.rate)).join(' / ');
    out.push(`Ставки доставки (все машины, Poniżej 3500 / 3500-4800 / Ponad 4800): ${rates} zł`);
  }

  invoice.vehicles.forEach((v) => {
    out.push(`Машина ${v.id}:`);
    BLOCK_LABELS.forEach(([key, label]) => {
      const lines = v[key];
      if (!lines || !lines.length) return;
      out.push(`  ${label} (block="${key}"):`);
      lines.forEach((l) => out.push(lineRow(l)));
    });
  });

  if (invoice.fees.length) {
    out.push('Opłaty (block="fees", без vehicle):');
    invoice.fees.forEach((l) => out.push(lineRow(l)));
  }

  return out.join('\n');
}
