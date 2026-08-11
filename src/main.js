// src/main.js
// Точка входа страницы index.html (Этап 2.5): переключение вкладок
// "Редактор фактуры" / "Расчёт зарплат" + связка между ними. app.js
// по-прежнему сам владеет и рендерит #app (никакой переделки Этапов 1-3);
// salary.js ничего не знает про app.js — получает invoice через
// getInvoiceState()/setOnInvoiceChange(), которые app.js экспортирует.

import { setOnInvoiceChange, getInvoiceState } from './app.js';
import { renderSalaryTab } from './salary.js';

const salaryEl = document.getElementById('salary');

function refreshSalary() {
  renderSalaryTab(salaryEl, getInvoiceState());
}

setOnInvoiceChange(refreshSalary);
refreshSalary(); // начальное состояние (фикстура)

const tabEditorBtn = document.getElementById('tab-editor');
const tabSalaryBtn = document.getElementById('tab-salary');
const editorView = document.getElementById('editor-view');
const salaryView = document.getElementById('salary-view');

function activate(activeBtn, activeView, otherBtn, otherView) {
  activeBtn.classList.add('active');
  otherBtn.classList.remove('active');
  activeView.style.display = '';
  otherView.style.display = 'none';
}

tabEditorBtn.addEventListener('click', () => activate(tabEditorBtn, editorView, tabSalaryBtn, salaryView));
tabSalaryBtn.addEventListener('click', () => {
  activate(tabSalaryBtn, salaryView, tabEditorBtn, editorView);
  refreshSalary(); // на случай правок, сделанных, пока вкладка была скрыта
});
