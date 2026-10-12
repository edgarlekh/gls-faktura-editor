// src/main.js
// Точка входа страницы index.html (Этап 2.5): переключение вкладок
// "Редактор фактуры" / "Расчёт зарплат" + связка между ними. app.js
// по-прежнему сам владеет и рендерит #app (никакой переделки Этапов 1-3);
// salary.js ничего не знает про app.js — получает invoice через
// getInvoiceState()/setOnInvoiceChange(), которые app.js экспортирует.

import { setOnInvoiceChange, getInvoiceState } from './app.js';
import { renderSalaryTab } from './salary.js';
import { renderCompareTab } from './compare.js';

const salaryEl = document.getElementById('salary');
const compareEl = document.getElementById('compare');

function refreshSalary() {
  renderSalaryTab(salaryEl, getInvoiceState());
}
// Вкладка «Сравнение» перестраивается только когда открыта (она тяжелее:
// две печатные модели + пагинация) — при переключении на неё и при каждой
// правке, пока она активна.
let compareActive = false;
function refreshCompare() {
  if (compareActive) renderCompareTab(compareEl, getInvoiceState());
}

setOnInvoiceChange(() => {
  refreshSalary();
  refreshCompare();
});
refreshSalary(); // начальное состояние (фикстура)

const tabs = [
  { btn: document.getElementById('tab-editor'), view: document.getElementById('editor-view'), id: 'editor' },
  { btn: document.getElementById('tab-salary'), view: document.getElementById('salary-view'), id: 'salary' },
  { btn: document.getElementById('tab-compare'), view: document.getElementById('compare-view'), id: 'compare' },
];

function activate(id) {
  tabs.forEach((t) => {
    const on = t.id === id;
    t.btn.classList.toggle('active', on);
    t.view.style.display = on ? '' : 'none';
  });
  compareActive = id === 'compare';
  if (id === 'salary') refreshSalary(); // на случай правок, сделанных, пока вкладка была скрыта
  if (id === 'compare') refreshCompare();
}

tabs.forEach((t) => t.btn.addEventListener('click', () => activate(t.id)));
