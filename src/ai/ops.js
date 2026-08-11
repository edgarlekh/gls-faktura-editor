// src/ai/ops.js
// Этап 5: чистая логика операций редактирования, которые ИИ формирует из
// текстовой команды пользователя. Ничего не знает про Anthropic API — только
// принимает уже распарсенный JSON-массив операций и invoice, проверяет каждую
// операцию (машина существует? строка найдена? однозначно?) и возвращает
// человекочитаемое описание + (если операция валидна) функцию apply(),
// которая её выполнит. ИИ не считает суммы — apply() только мутирует
// qty/unitPrice/value/rate, а recalc() (вызывается снаружи, после применения
// всех операций) пересчитывает всё остальное — как и везде в приложении.

import { formatPLN } from '../format.js';

const BLOCK_LABELS = {
  ooh: 'OOH',
  surcharges: 'Usługi (Dopłaty)',
  bonusMalus: 'Bonus/Malus',
  extra: 'Dodatkowe pozycje',
  fees: 'Opłaty',
};
const VEHICLE_BLOCKS = ['ooh', 'surcharges', 'bonusMalus', 'extra'];
const FIELD_LABELS = { qty: 'Ilość', unitPrice: 'Cena', value: 'Wartość' };

function zlToGr(zl) {
  return Math.round(zl * 100);
}

function getLines(invoice, vehicle, block) {
  if (block === 'fees') return invoice.fees;
  if (!vehicle) return null;
  if (!VEHICLE_BLOCKS.includes(block)) return null;
  return vehicle[block] || null;
}

function findMatches(lines, match) {
  if (!lines || typeof match !== 'string' || !match.trim()) return [];
  const needle = match.trim().toLowerCase();
  return lines.filter((l) => l.name.toLowerCase().includes(needle));
}

/**
 * Проверяет одну операцию против invoice (как она есть СЕЙЧАС) и возвращает:
 *   { op, ok: true,  description, apply: () => void }  — apply() мутирует
 *     ровно те объекты invoice, что были найдены при проверке (замыкание),
 *     поэтому apply() надо вызывать без промежуточных структурных изменений
 *     invoice (удаления/добавления строк) между resolveOp() и apply().
 *   { op, ok: false, description, error }               — не применяется.
 * Сама resolveOp() invoice не мутирует.
 */
export function resolveOp(invoice, op) {
  if (!op || typeof op !== 'object' || typeof op.op !== 'string') {
    return { op, ok: false, description: 'Некорректная операция (не объект с полем "op")', error: 'bad-op' };
  }

  if (op.op === 'setRates') {
    const rates = op.rates;
    const valid = Array.isArray(rates) && rates.length === 3 && rates.every((r) => typeof r === 'number' && Number.isFinite(r));
    if (!valid) {
      return { op, ok: false, description: 'setRates: ожидался массив из 3 чисел (zł)', error: 'bad-rates' };
    }
    const gr = rates.map(zlToGr);
    return {
      op,
      ok: true,
      description: `Ставки доставки (все машины): ${gr.map((g) => formatPLN(g)).join(' / ')} zł`,
      apply: () => {
        invoice.vehicles.forEach((v) => {
          v.delivery.tiers.forEach((t, i) => {
            t.rate = gr[i];
          });
        });
      },
    };
  }

  if (op.op === 'deleteLine' || op.op === 'setField') {
    const block = op.block;
    const label = BLOCK_LABELS[block];
    if (!label) {
      return { op, ok: false, description: `Неизвестный блок «${block}»`, error: 'bad-block' };
    }

    let vehicle = null;
    if (block !== 'fees') {
      vehicle = invoice.vehicles.find((v) => v.id === op.vehicle);
      if (!vehicle) {
        return { op, ok: false, description: `Машина «${op.vehicle}» не найдена`, error: 'no-vehicle' };
      }
    }
    const vehiclePart = vehicle ? `у машины ${vehicle.id} ` : '';

    const lines = getLines(invoice, vehicle, block);
    if (!lines) {
      return { op, ok: false, description: `Блок «${block}» недоступен`, error: 'bad-block' };
    }

    const matches = findMatches(lines, op.match);
    if (matches.length === 0) {
      return { op, ok: false, description: `Не найдена строка «${op.match}» ${vehiclePart}(${label})`, error: 'not-found' };
    }
    if (matches.length > 1 && !op.all) {
      return {
        op,
        ok: false,
        description: `Найдено ${matches.length} совпадений «${op.match}» ${vehiclePart}(${label}) — уточните название или добавьте "all":true`,
        error: 'ambiguous',
      };
    }
    const targets = op.all ? matches : [matches[0]];

    if (op.op === 'deleteLine') {
      const names = targets.map((l) => l.name).join('; ');
      return {
        op,
        ok: true,
        description: `Удалить ${vehiclePart}(${label}): ${names}`,
        apply: () => {
          targets.forEach((t) => {
            const i = lines.indexOf(t);
            if (i !== -1) lines.splice(i, 1);
          });
        },
      };
    }

    // setField
    const field = op.field;
    if (!FIELD_LABELS[field]) {
      return { op, ok: false, description: `Неизвестное поле «${field}» (ожидались qty/unitPrice/value)`, error: 'bad-field' };
    }
    if (typeof op.value !== 'number' || !Number.isFinite(op.value)) {
      return { op, ok: false, description: `setField: некорректное значение «${op.value}»`, error: 'bad-value' };
    }
    const newRaw = field === 'qty' ? Math.round(op.value) : zlToGr(op.value);
    const fromDisplay = (l) => (field === 'qty' ? String(l.qty) : formatPLN(l[field]));
    const toDisplay = field === 'qty' ? String(newRaw) : formatPLN(newRaw);
    const namesFrom = targets.map((l) => `«${l.name}»: ${fromDisplay(l)} → ${toDisplay}`).join('; ');
    return {
      op,
      ok: true,
      description: `${vehiclePart}(${label}), ${FIELD_LABELS[field]}: ${namesFrom}`,
      apply: () => {
        targets.forEach((l) => {
          l[field] = newRaw;
          if (field === 'value') l.valueOverridden = true;
        });
      },
    };
  }

  return { op, ok: false, description: `Неизвестная операция «${op.op}»`, error: 'unknown-op' };
}

/** resolveOp() для каждой операции массива. */
export function resolveOps(invoice, ops) {
  if (!Array.isArray(ops)) return [];
  return ops.map((op) => resolveOp(invoice, op));
}

/** Применяет только валидные (ok:true) резолвы — вызывать после resolveOps(). recalc() снаружи. */
export function applyResolved(resolved) {
  resolved.filter((r) => r.ok).forEach((r) => r.apply());
}
