// src/print.js
// Печатная страница print.html (Этап 4). Берёт invoice из sessionStorage
// (мост из редактора, см. app.js/PRINT_STORAGE_KEY), прогоняет recalc() и
// рисует страницы через общий рендер src/print-render.js:
//  - ЧТО печатать и В КАКОМ ПОРЯДКЕ — src/print-model.js (порядок дословно
//    из PDF через invoice.layout);
//  - ГДЕ на каких страницах — src/print-layout.js (пагинация «как у GLS»,
//    координаты в pt, снятые с оригиналов);
//  - DOM — src/print-render.js (абсолютные координаты, никаких измерений).
// Экран, page.pdf() и реальная печать Ctrl+P дают один и тот же состав
// страниц, совпадающий с оригиналом (проверено на четырёх фактурах).

import { recalc } from './recalc.js';
import { buildSampleInvoice } from './fixtures/sample-invoice.js';
import { buildPrintPages } from './print-render.js';

// src/app.js кладёт текущий (отредактированный) invoice сюда перед каждым
// своим render() — тот же ключ, см. app.js/PRINT_STORAGE_KEY. Это единственный
// мост между редактором и печатью (отдельные страницы, отдельные module-графы).
// Если ключа нет (печать открыта напрямую, без редактора) — фикстура, как раньше.
const PRINT_STORAGE_KEY = 'gls-print-invoice';

function loadInvoice() {
  try {
    const raw = sessionStorage.getItem(PRINT_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // испорченные данные в sessionStorage — молча откатываемся на фикстуру
  }
  return buildSampleInvoice();
}

const invoice = recalc(loadInvoice());

function buildDocument() {
  const sheet = document.getElementById('sheet');
  sheet.textContent = '';
  const { pages } = buildPrintPages(invoice);
  pages.forEach((p) => sheet.appendChild(p));
}

// На узком экране (телефон) предпросмотр масштабируем ЦЕЛИКОМ через
// transform; на печать не влияет (@media print в print.css сбрасывает).
function fitSheetToViewport() {
  const sheet = document.getElementById('sheet');
  const wrap = document.getElementById('sheet-wrap');
  if (!sheet || !wrap) return;
  sheet.style.transform = '';
  const sheetW = sheet.offsetWidth;
  const avail = document.documentElement.clientWidth - 16;
  const scale = sheetW > avail ? avail / sheetW : 1;
  if (scale < 1) {
    sheet.style.transform = `scale(${scale})`;
    sheet.style.transformOrigin = 'top left';
    sheet.style.marginLeft = '8px';
    wrap.style.height = `${sheet.offsetHeight * scale}px`;
  } else {
    sheet.style.marginLeft = '';
    wrap.style.height = '';
  }
}

async function init() {
  if (document.fonts && document.fonts.ready) {
    try {
      await document.fonts.ready;
    } catch {
      /* ignore */
    }
  }
  buildDocument();
  fitSheetToViewport();
}

window.addEventListener('load', init);
window.addEventListener('resize', fitSheetToViewport);

const btn = document.getElementById('btnPrint');
if (btn) btn.addEventListener('click', () => window.print());
