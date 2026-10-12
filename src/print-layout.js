// src/print-layout.js
// ЧИСТАЯ (без DOM) пагинация «как у GLS». Берёт блоки из print-model.js и
// раскладывает их по страницам A4 в координатах pt, воспроизводя поток
// SAP-формы GLS: НИКАКИХ «держать блок целиком» — плашка заголовка может
// остаться последней на странице (так в каждом оригинале: "Pojazdy z grupy
// pojazdów" внизу стр. 1, продолжение — на стр. 2), таблица рвётся на любой
// строке, при переносе строк шапка колонок печатается заново, а одинокий
// RAZEM на новой странице шапки не получает.
//
// ВСЕ размеры (pt) сняты PyMuPDF с четырёх оригиналов (10082026, 325,
// 092026, LPL 09/2026) — см. комментарии у констант. Главное наблюдение:
// межблочные отступы — это самостоятельные элементы потока. Отступ, который
// не влез в остаток страницы, ПЕРЕЕЗЖАЕТ наверх следующей (поэтому на стр. 2
// 325.pdf подзаголовок начинается с y=42.7, а не 28.3, а на стр. 4 заголовок
// блока — с 64.2); отступ, который влез, но за ним не влез сам элемент,
// просто теряется внизу страницы (стр. 10: заголовок ровно у верхнего поля).
// Подписи-футеры "Doręczenie, za paczkę", "Usługi (Dopłaty)", "Bonus/Malus"
// в оригинале двухстрочные (вторая строка пустая) — отсюда лишние 14.4pt
// после их RAZEM; у "Odbiór, za paczkę", OOH и "Dodatkowe pozycje" этого нет.
//
// Результат — страницы со списком элементов {type, y, h, ...} в pt от
// верхнего края листа; print.js расставляет их абсолютно (никаких измерений
// DOM, никакого округления высот строк браузером), а compare.js берёт
// отсюда номер страницы каждого блока.

export const PAGE_W_PT = 595.28; // A4
export const PAGE_H_PT = 841.89;
export const CONTENT_LEFT_PT = 70.9; // 25 мм — левое поле образца
export const CONTENT_W_PT = 498.9; // 176 мм
export const TOP_PT = 28.35; // 10 мм — верхнее поле: первый элемент страницы начинается здесь
export const BOTTOM_PT = 813.54; // нижняя граница содержимого (= 841.89 − 28.35): 811.7 влезает, 814.6 — нет
export const FOOTER_Y_PT = 821.6; // "Strona X z Y" — в нижнем поле, под содержимым
export const DOC_HEADER_H_PT = 81.45; // шапка документа (см. SPACE_AFTER_DOC_HEADER)

export const BAR_H_PT = 21.6; // обе плашки (серая 11pt и светло-серая 9pt)

// Отступ ПОСЛЕ блока (после его последнего RAZEM; это свойство предыдущего
// блока, не следующего: Doręczenie → OOH даёт 21.5, OOH → OOH даёт 14.4).
export const SPACE_AFTER_BLOCK = {
  'overall-pickup': 18.0,
  'overall-delivery': 18.0,
  pickup: 21.5,
  delivery: 21.5,
  ooh: 14.4,
  uslugi: 14.4,
  wynagrodzenie: 31.6,
  oplaty: 0,
};
export const SPACE_AFTER_DOC_HEADER = 18.0; // 28.35 + 81.45 + 18.0 = 127.8 — первая плашка во всех образцах
// Отступ между плашкой заголовка и подзаголовком "Pojazd"/"Grupa pojazdów".
export const SPACE_LG_SM = { ooh: 11.4, default: 14.4 };
// Отступ перед таблицей внутри блока (после плашки или после предыдущей таблицы).
export const SPACE_BEFORE_TABLE = { extra: 14.4, fees: 8.4 };
// Шапка колонок: высота бокса от предыдущего элемента до начала первой строки данных.
export const THEAD_H = { pickup: 14.5, tiers: 14.5, ooh: 10.6, surcharges: 14.4, bonusMalus: 14.4, extra: 14.4, fees: 14.4, wyn: 22.5 };
// Строка данных.
export const ROW_H = { pickup: 14.7, tiers: 14.7, ooh: 14.4, surcharges: 14.4, bonusMalus: 14.4, extra: 14.4, fees: 14.4, wyn: 14.4 };
// Строка RAZEM (бокс до следующего элемента).
export const RAZEM_H = { pickup: 14.55, tiers: 14.55, ooh: 14.8, surcharges: 14.8, bonusMalus: 14.8, extra: 14.8, fees: 14.8, wyn: 14.7 };
// Пустая вторая строка подписи-футера после RAZEM.
export const SPACE_AFTER_RAZEM = { tiers: 14.4, surcharges: 14.4, bonusMalus: 14.4 };
// Смещение текста внутри бокса (косметика, на разбиение не влияет).
export const TEXT_OFFSET = {
  thead: { default: 1.6, ooh: 0, wyn: 3.0 },
  row: { default: 1.6, wyn: 0.5 },
  razem: { default: 0.8, pickup: 0.55, tiers: 0.55, wyn: 0.7 },
};

const EPS = 0.05;

/**
 * @param {{blocks: object[]}} model — из buildPrintModel().
 * @returns {{ pages: {items: object[]}[], blockPages: Map<string, number> }}
 *   items: { type:'docHeader'|'bar'|'thead'|'row'|'razem', y, h, block?, table?, rowIndex?, bar? }
 *   blockPages: key блока → номер страницы (с 1), где начинается его первая плашка/таблица.
 */
export function paginate(model) {
  const pages = [];
  let page = null;
  let y = 0;
  const blockPages = new Map();

  function newPage() {
    page = { items: [] };
    pages.push(page);
    y = TOP_PT;
  }
  function fits(h) {
    return y + h <= BOTTOM_PT + EPS;
  }
  // Отступ: влез — занимаем; не влез — уезжает НАВЕРХ следующей страницы.
  function space(h) {
    if (!h) return;
    if (!fits(h)) newPage();
    y += h;
  }
  // Элемент: не влез — новая страница (без отступа сверху).
  function put(item, h) {
    if (!fits(h)) newPage();
    page.items.push({ ...item, y, h });
    y += h;
    return pages.length;
  }

  newPage();
  put({ type: 'docHeader' }, DOC_HEADER_H_PT);
  space(SPACE_AFTER_DOC_HEADER);

  model.blocks.forEach((block) => {
    let firstPage = null;
    block.bars.forEach((bar, i) => {
      if (i > 0) space(block.kind === 'ooh' ? SPACE_LG_SM.ooh : SPACE_LG_SM.default);
      const p = put({ type: 'bar', block, bar }, BAR_H_PT);
      if (firstPage === null) firstPage = p;
    });
    block.tables.forEach((table, ti) => {
      space(SPACE_BEFORE_TABLE[table.kind] ?? 0);
      const theadH = THEAD_H[table.kind] ?? 14.4;
      const rowH = ROW_H[table.kind] ?? 14.4;
      const razemH = RAZEM_H[table.kind] ?? 14.8;
      // шапка колонок: не влезла — целиком на следующую страницу
      let p = put({ type: 'thead', block, table, tableIndex: ti }, theadH);
      if (firstPage === null) firstPage = p;
      table.rows.forEach((row, ri) => {
        if (!fits(rowH)) {
          newPage();
          put({ type: 'thead', block, table, tableIndex: ti, repeated: true }, theadH); // перенос: шапка заново
        }
        put({ type: 'row', block, table, tableIndex: ti, rowIndex: ri, row }, rowH);
      });
      put({ type: 'razem', block, table, tableIndex: ti }, razemH); // одинокий RAZEM — без шапки
      space(SPACE_AFTER_RAZEM[table.kind] ?? 0);
    });
    if (firstPage !== null) blockPages.set(block.key, firstPage);
    space(SPACE_AFTER_BLOCK[block.kind] ?? 14.4);
  });

  return { pages, blockPages };
}
