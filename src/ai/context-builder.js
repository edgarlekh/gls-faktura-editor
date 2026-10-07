// src/ai/context-builder.js
// Этап 5: строит КОМПАКТНЫЙ текстовый контекст фактуры для промпта — только
// id машин, названия блоков и текущие qty/cena/wartość редактируемых строк
// (то, что нужно ИИ, чтобы сопоставить "match" из команды с реальной
// строкой). Не вся фактура целиком — дёшево и быстро, как и просили.

import { formatPLN } from '../format.js';
import { getTierTemplate } from '../model.js';

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

  if (invoice.vehicles.length) {
    // тиры — из текущей фактуры: их число и названия не фиксированы
    const tpl = getTierTemplate(invoice);
    out.push(`Тиры доставки (${tpl.labels.length} шт., все машины): ${tpl.labels.join(' / ')}`);
    out.push(`Ставки доставки по тирам: ${tpl.rates.map((r) => formatPLN(r)).join(' / ')} zł`);
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
