// src/tiers.js
// Пороги тиров доставки и ПЕРЕРАСПРЕДЕЛЕНИЕ количеств при их смене. Чистая
// логика (без DOM), используется панелью «Ставки и пороги» (app.js) и
// AI-операцией setTierLabels (ai/ops.js).
//
// Семантика порогов у GLS — НАКОПИТЕЛЬНАЯ по всей фактуре: первые T1 paczek
// месяца идут по ставке тира 1 («Poniżej 4600»), следующие до T2 — по
// ставке тира 2 («4600-6400»), остальные — по тиру 3 («Ponad 6400»). В
// сводке это видно буквально: 4 600 / 1 800 / 8 365 при 14 765 paczek. Но у
// отдельной машины разбивка зависит от того, КОГДА она возила (машина,
// работавшая в начале месяца, попадает в тир 1 целиком), — этой хронологии
// в фактуре нет. Поэтому при смене порогов считаем так: исходная разбивка
// каждой машины задаёт её накопительную кривую F_v(x) = «сколько paczek
// машины v среди первых x paczek фактуры», известную в узлах x = 0, X1, X2,
// …, G (накопленные итоги сводки по тирам, G — всего paczek) и ЛИНЕЙНУЮ
// между узлами (внутри тира paczki машины считаем равномерно разложенными
// по времени). Новые пороги T'1 < T'2 < … → новые количества машины:
// F_v(T'1), F_v(T'2) − F_v(T'1), …, total_v − F_v(T'_{N−1}). Так как
// Σ_v F_v(x) = x в узлах и линейно между ними, суммы по тирам в сводке
// получаются ровно T'1, T'2 − T'1, …, а сумма по каждой машине не меняется.
// Округление до целых — методом наибольших остатков с точной подгонкой
// сумм по тирам.
//
// Числа порогов — ИЗ НАЗВАНИЙ ТИРОВ (они и так редактируются как текст и
// приходят из PDF): для тира i < N−1 берётся последнее число в названии
// («Poniżej 4600» → 4600, «4600-6400» → 6400); последний тир («Ponad …»)
// порога не задаёт. Формат названий не захардкожен: любые слова, лишь бы
// числа шли по возрастанию.

/**
 * @param {string[]} labels — названия тиров по порядку.
 * @returns {number[]|null} пороги длины N−1 (возрастающие) или null, если не распознаны.
 */
export function parseThresholds(labels) {
  if (!Array.isArray(labels) || labels.length < 2) return null;
  const out = [];
  for (let i = 0; i < labels.length - 1; i += 1) {
    const nums = String(labels[i] ?? '').match(/\d[\d\s]*/g);
    if (!nums || !nums.length) return null;
    const last = parseInt(nums[nums.length - 1].replace(/\s+/g, ''), 10);
    if (!Number.isFinite(last) || last <= 0) return null;
    out.push(last);
  }
  for (let i = 1; i < out.length; i += 1) if (out[i] <= out[i - 1]) return null;
  return out;
}

/** Кусочно-линейная интерполяция по узлам xs (неубывающие) / ys. */
function interp(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i += 1) {
    if (x <= xs[i]) {
      const dx = xs[i] - xs[i - 1];
      if (dx === 0) return ys[i];
      return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xs[i - 1])) / dx;
    }
  }
  return ys[ys.length - 1];
}

/**
 * Перераспределяет qty тиров доставки всех машин под новые пороги.
 * Мутирует vehicles[*].delivery.tiers[*].qty; значения/сводку пересчитает recalc().
 * @param {object[]} vehicles — invoice.vehicles (у всех одинаковое число тиров N).
 * @param {number[]} newThresholds — N−1 возрастающих порогов (накопительных).
 * @returns {{tierTotals:number[], total:number}} новые суммы по тирам и общее число paczek.
 */
export function redistributeTiers(vehicles, newThresholds) {
  const n = vehicles.reduce((m, v) => Math.max(m, v.delivery.tiers.length), 0);
  if (n < 2 || !Array.isArray(newThresholds) || newThresholds.length !== n - 1) {
    throw new Error(`redistributeTiers: ожидалось ${Math.max(0, n - 1)} порогов, получено ${Array.isArray(newThresholds) ? newThresholds.length : 'не массив'}`);
  }
  // узлы по ИСХОДНЫМ данным: накопленные итоги сводки по тирам
  const oldTierTotals = Array.from({ length: n }, (_, i) => vehicles.reduce((s, v) => s + (v.delivery.tiers[i]?.qty ?? 0), 0));
  const xs = [0];
  oldTierTotals.forEach((t) => xs.push(xs[xs.length - 1] + t));
  const total = xs[xs.length - 1];
  // новые накопительные границы: не больше общего числа paczek, неубывающие
  const targets = [];
  newThresholds.forEach((t) => targets.push(Math.min(total, Math.max(t, targets.length ? targets[targets.length - 1] : 0))));

  // вещественные накопленные значения каждой машины в новых границах
  const real = vehicles.map((v) => {
    const ys = [0];
    v.delivery.tiers.forEach((t) => ys.push(ys[ys.length - 1] + t.qty));
    while (ys.length < xs.length) ys.push(ys[ys.length - 1]);
    return targets.map((x) => interp(xs, ys, x));
  });
  const vehicleTotal = vehicles.map((v) => v.delivery.tiers.reduce((s, t) => s + t.qty, 0));

  // округление по каждой границе: наибольшие остатки, Σ_v cum_v,i = targets[i] ровно,
  // монотонность по i внутри машины и cum ≤ total машины
  const cum = vehicles.map(() => []);
  targets.forEach((target, i) => {
    const floors = real.map((r) => Math.floor(r[i] + 1e-9));
    let sum = floors.reduce((s, f) => s + f, 0);
    const order = real.map((r, vi) => ({ vi, frac: r[i] - Math.floor(r[i] + 1e-9) })).sort((a, b) => b.frac - a.frac);
    const vals = floors.slice();
    for (const { vi } of order) {
      if (sum >= target) break;
      if (vals[vi] < vehicleTotal[vi]) {
        vals[vi] += 1;
        sum += 1;
      }
    }
    // монотонность и потолок машины
    vals.forEach((val, vi) => {
      const prev = i > 0 ? cum[vi][i - 1] : 0;
      cum[vi][i] = Math.min(vehicleTotal[vi], Math.max(prev, val));
    });
    // точная подгонка суммы после клампов
    let diff = target - cum.reduce((s, c) => s + c[i], 0);
    let guard = 0;
    while (diff !== 0 && guard < 100000) {
      guard += 1;
      let changed = false;
      for (const { vi } of order) {
        if (diff > 0 && cum[vi][i] < vehicleTotal[vi]) {
          cum[vi][i] += 1;
          diff -= 1;
          changed = true;
        } else if (diff < 0 && cum[vi][i] > (i > 0 ? cum[vi][i - 1] : 0)) {
          cum[vi][i] -= 1;
          diff += 1;
          changed = true;
        }
        if (diff === 0) break;
      }
      if (!changed) break;
    }
  });

  vehicles.forEach((v, vi) => {
    const c = cum[vi];
    v.delivery.tiers.forEach((t, i) => {
      const lo = i === 0 ? 0 : c[i - 1];
      const hi = i === n - 1 ? vehicleTotal[vi] : c[i];
      t.qty = Math.max(0, hi - lo);
    });
  });

  const tierTotals = Array.from({ length: n }, (_, i) => vehicles.reduce((s, v) => s + (v.delivery.tiers[i]?.qty ?? 0), 0));
  return { tierTotals, total };
}

/**
 * Меняет названия тиров у всех машин и, если пороги распознаны и изменились,
 * перераспределяет количества. Не вызывает recalc().
 * @returns {{redistributed:boolean, thresholds:number[]|null, reason?:string}}
 */
export function applyTierLabels(vehicles, newLabels) {
  const first = vehicles.find((v) => v.delivery.tiers.length === newLabels.length);
  const oldLabels = first ? first.delivery.tiers.map((t) => t.label) : [];
  const oldT = parseThresholds(oldLabels);
  const newT = parseThresholds(newLabels);
  vehicles.forEach((v) => {
    v.delivery.tiers.forEach((t, i) => {
      if (newLabels[i] !== undefined) t.label = newLabels[i];
    });
  });
  if (!newT) return { redistributed: false, thresholds: null, reason: 'в названиях тиров не распознаны возрастающие числовые пороги' };
  const same = oldT && oldT.length === newT.length && oldT.every((t, i) => t === newT[i]);
  if (same) return { redistributed: false, thresholds: newT };
  redistributeTiers(vehicles, newT);
  return { redistributed: true, thresholds: newT };
}
