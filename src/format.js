// format.js
// Единственное место, где целые грошы превращаются в польскую денежную
// строку (и обратно). Формат: пробел — разделитель тысяч, запятая —
// десятичные, всегда 2 знака после запятой. Пример: 5550496 -> "55 504,96".

/** gr (int) -> "12 345,67" / "-12 345,67" */
export function formatPLN(grosze) {
  const rounded = Math.round(grosze);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  const zl = Math.floor(abs / 100);
  const gr = abs % 100;
  const zlStr = String(zl).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${negative ? '-' : ''}${zlStr},${String(gr).padStart(2, '0')}`;
}

/** "12 345,67" / "12345.67" -> gr (int). Обратная операция к formatPLN. */
export function parsePLN(str) {
  const clean = String(str).trim().replace(/\s/g, '').replace(',', '.');
  return Math.round(parseFloat(clean) * 100);
}

/** Целое (qty) -> "12 345" — та же группировка по тысячам, без копеек. */
export function formatInt(n) {
  const rounded = Math.round(n);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  const str = String(abs).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${negative ? '-' : ''}${str}`;
}

/** "1 234" / "1234" -> int. Обратная операция к formatInt. */
export function parseIntPL(str) {
  const clean = String(str).trim().replace(/\s/g, '');
  return parseInt(clean, 10);
}
