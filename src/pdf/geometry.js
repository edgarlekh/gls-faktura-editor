// src/pdf/geometry.js
// Чистая геометрия: превращает "сырые" текстовые фрагменты одной страницы
// (как их отдаёт pdf.js из page.getTextContent().items — {str, transform,
// width}) в список текстовых ЯЧЕЕК в порядке чтения (сверху вниз, слева
// направо). Никакой зависимости от pdf.js здесь нет — вход это просто
// массив объектов с нужными полями, поэтому geometry.js тестируется без PDF.
//
// Почему это нужно: pdf.js режет один и тот же визуальный "кусок текста" на
// несколько фрагментов при смене шрифта (в этом отчёте GLS это происходит на
// польских диакритиках ą/ę/ć/ł/ń/ś/ź/ż — они берутся из отдельного подшрифта),
// поэтому нельзя просто брать item.str по одному. А вот разрыв (gap) между
// концом одного фрагмента и началом следующего внутри строки — надёжный
// сигнал: на образце 10082026.pdf внутристрочные разрывы (продолжение
// слова/ячейки) ≤ 1.48pt, а разрывы между КОЛОНКАМИ таблицы начинаются от
// 3.4pt и выше — чистая граница, проверено по всем 7 страницам образца.
// Берём порог с запасом (2.5pt) между этими двумя кластерами.

const ROW_TOL_PT = 1.5; // насколько может "дрожать" y у фрагментов одной визуальной строки
const CELL_GAP_TOL_PT = 2.5; // разрыв x, при котором фрагменты ещё считаются одной ячейкой

/**
 * items: [{str, transform:[a,b,c,d,x,y], width}] — как из pdf.js TextItem.
 * Возвращает массив строк — по одной на текстовую ячейку, в порядке чтения.
 * Пустые ("" после нормализации пробелов) ячейки отбрасываются.
 */
export function extractPageCells(items) {
  // str.length===0 фрагменты (нулевой ширины, служебные) выбрасываем сразу,
  // а вот str==='' после этого уже не бывает — но осмысленные "пробельные"
  // фрагменты (str===' ') ОСТАВЛЯЕМ: они бывают единственным носителем
  // пробела между двумя соседними склеенными кусками одной ячейки (иначе,
  // например, "Wartość" + "(PLN)" склеятся без пробела в "Wartość(PLN)").
  const filtered = items.filter((it) => it.str.length > 0);

  const sorted = [...filtered].sort((a, b) => {
    const dy = b.transform[5] - a.transform[5]; // y убывает = сверху вниз (PDF: y растёт вверх)
    if (dy !== 0) return dy;
    return a.transform[4] - b.transform[4]; // x возрастает = слева направо
  });

  const rows = [];
  for (const it of sorted) {
    const y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) <= ROW_TOL_PT);
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push(it);
  }
  rows.sort((a, b) => b.y - a.y);

  const cells = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.transform[4] - b.transform[4]);
    let current = null;
    let prevEnd = null;
    for (const it of row.items) {
      const x = it.transform[4];
      if (prevEnd !== null && x - prevEnd <= CELL_GAP_TOL_PT) {
        current.text += it.str;
      } else {
        if (current) cells.push(current.text);
        current = { text: it.str };
      }
      prevEnd = x + (it.width || 0);
    }
    if (current) cells.push(current.text);
  }

  return cells.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
