// src/fixtures/sample-invoice.js
// Реальная построчная фактура GLS на 5 машин (1203, 1210, 1220, 1240, 1299).
// Общий модуль: его переиспользуют и acceptance-тест (test/recalc.test.js),
// и UI (src/app.js) как стартовые данные для редактирования. unitPrice
// задаём через zlToGr(x) — так исходные złote-цены в коде читаются один в
// один со спецификацией, а хранятся всё равно как int gr.

import { createInvoice, createVehicle, zlToGr } from '../model.js';

// Общие для всех машин строки ooh (одинаковые названия/цены, разное qty)
function oohLines({
  dpszp, // Doręczenia Punkt Szybka Paczka
  dapm, // Doręczenie APM
  oapm, // Odbiór APM
  opszp, // Odbiór Punkt Szybka Paczka
  sApmMix,
  sApmDor,
  sApmOdb,
  sPszpMix,
  sPszpDor,
  sPszpOdb,
}) {
  return [
    { name: 'Doręczenia Punkt Szybka Paczka', qty: dpszp, unitPrice: zlToGr(0.65) },
    { name: 'Doręczenie APM', qty: dapm, unitPrice: zlToGr(0.65) },
    { name: 'Odbiór APM', qty: oapm, unitPrice: zlToGr(0.65) },
    { name: 'Odbiór Punkt Szybka Paczka', qty: opszp, unitPrice: zlToGr(0.65) },
    { name: 'STOP APM-MIX', qty: sApmMix, unitPrice: zlToGr(3.0) },
    { name: 'STOP APM-doręczenie', qty: sApmDor, unitPrice: zlToGr(3.0) },
    { name: 'STOP APM-odbiór', qty: sApmOdb, unitPrice: zlToGr(3.0) },
    { name: 'STOP Punkt Szybka Paczka-MIX', qty: sPszpMix, unitPrice: zlToGr(3.0) },
    { name: 'STOP Punkt Szybka Paczka-doręczenie', qty: sPszpDor, unitPrice: zlToGr(3.0) },
    { name: 'STOP Punkt Szybka Paczka-odbiór', qty: sPszpOdb, unitPrice: zlToGr(3.0) },
  ];
}

function surchargeLines({ cashGot, cashBezgot, exch, ident, pickReturn, pickShip, rabat }) {
  return [
    { name: 'CashService gotówkowa', qty: cashGot, unitPrice: zlToGr(0.1) },
    { name: 'CashService bezgotówkowa', qty: cashBezgot, unitPrice: zlToGr(0.5) },
    { name: 'ExchangeService', qty: exch, unitPrice: zlToGr(0.0) },
    { name: 'IdentService', qty: ident, unitPrice: zlToGr(2.0) },
    { name: 'Pick & Return', qty: pickReturn, unitPrice: zlToGr(0.0) },
    { name: 'Pick&Ship', qty: pickShip, unitPrice: zlToGr(0.0) },
    { name: 'Rabat mała paczka', qty: rabat, unitPrice: zlToGr(-1.5) },
  ];
}

function bonusMalusLines({ cqe, dqeQty, dqeRate, npseQty, npseRate }) {
  return [
    { name: 'CQE', qty: cqe, unitPrice: zlToGr(0.0) },
    { name: 'DQE', qty: dqeQty, unitPrice: zlToGr(dqeRate) },
    { name: 'NPSE', qty: npseQty, unitPrice: zlToGr(npseRate) },
  ];
}

function pgbLines(count) {
  return Array.from({ length: count }, () => ({ name: 'PGB', qty: 1, unitPrice: zlToGr(20.0) }));
}

export function buildSampleInvoice() {
  const vehicles = [
    createVehicle({
      id: '1203',
      deliveryQtys: [848, 320, 1105],
      pickupQty: 552,
      ooh: oohLines({
        dpszp: 337, dapm: 178, oapm: 26, opszp: 49,
        sApmMix: 16, sApmDor: 78, sApmOdb: 4, sPszpMix: 27, sPszpDor: 179, sPszpOdb: 9,
      }),
      surcharges: surchargeLines({
        cashGot: 117, cashBezgot: 57, exch: 7, ident: 9, pickReturn: 65, pickShip: 17, rabat: 965,
      }),
      bonusMalus: bonusMalusLines({ cqe: 21, dqeQty: 23, dqeRate: 5.0, npseQty: 23, npseRate: 14.0 }),
      extra: [...pgbLines(8), { name: 'Eco Bonus (0,54_23_2788)', qty: 1, unitPrice: zlToGr(1381.4) }],
    }),
    createVehicle({
      id: '1210',
      deliveryQtys: [839, 142, 1226],
      pickupQty: 70,
      ooh: oohLines({
        dpszp: 386, dapm: 52, oapm: 18, opszp: 63,
        sApmMix: 7, sApmDor: 20, sApmOdb: 5, sPszpMix: 38, sPszpDor: 184, sPszpOdb: 15,
      }),
      surcharges: surchargeLines({
        cashGot: 42, cashBezgot: 19, exch: 11, ident: 2, pickReturn: 46, pickShip: 10, rabat: 1104,
      }),
      bonusMalus: bonusMalusLines({ cqe: 18, dqeQty: 19, dqeRate: 20.0, npseQty: 19, npseRate: 0.0 }),
      extra: pgbLines(3),
    }),
    createVehicle({
      id: '1220',
      deliveryQtys: [937, 404, 1271],
      pickupQty: 108,
      ooh: oohLines({
        dpszp: 426, dapm: 106, oapm: 13, opszp: 41,
        sApmMix: 8, sApmDor: 32, sApmOdb: 1, sPszpMix: 24, sPszpDor: 223, sPszpOdb: 7,
      }),
      surcharges: surchargeLines({
        cashGot: 121, cashBezgot: 50, exch: 12, ident: 4, pickReturn: 48, pickShip: 18, rabat: 1105,
      }),
      bonusMalus: bonusMalusLines({ cqe: 21, dqeQty: 23, dqeRate: 25.0, npseQty: 23, npseRate: 14.0 }),
      extra: pgbLines(17),
    }),
    createVehicle({
      id: '1240',
      deliveryQtys: [876, 434, 1030],
      pickupQty: 1001,
      ooh: oohLines({
        dpszp: 187, dapm: 192, oapm: 27, opszp: 20,
        sApmMix: 14, sApmDor: 95, sApmOdb: 2, sPszpMix: 10, sPszpDor: 106, sPszpOdb: 8,
      }),
      surcharges: surchargeLines({
        cashGot: 88, cashBezgot: 84, exch: 7, ident: 2, pickReturn: 57, pickShip: 14, rabat: 805,
      }),
      bonusMalus: bonusMalusLines({ cqe: 20, dqeQty: 23, dqeRate: 10.0, npseQty: 23, npseRate: 0.0 }),
      extra: pgbLines(7),
    }),
    createVehicle({
      id: '1299',
      deliveryQtys: [0, 0, 27],
      pickupQty: 0,
      ooh: [
        { name: 'Doręczenia Punkt Szybka Paczka', qty: 1, unitPrice: zlToGr(0.65) },
        { name: 'STOP Punkt Szybka Paczka-doręczenie', qty: 1, unitPrice: zlToGr(3.0) },
      ],
      surcharges: [
        { name: 'CashService bezgotówkowa', qty: 1, unitPrice: zlToGr(0.5) },
        { name: 'Rabat mała paczka', qty: 25, unitPrice: zlToGr(-1.5) },
      ],
      bonusMalus: [],
      extra: [{ name: 'Extra doręczenia (N_Zara_Proces sobotni_wyrównanie)', qty: 1, unitPrice: zlToGr(315.74) }],
    }),
  ];

  const fees = [
    { name: 'NP_ADD_SUBC', qty: 13324, unitPrice: zlToGr(0.02) },
    // valueOverridden: qty*unitPrice = 131.00, но по факту 130.76
    { name: 'NP_ELOADING', qty: 131, unitPrice: zlToGr(1.0), value: zlToGr(130.76), valueOverridden: true },
    { name: 'NP_PNLT_KU_BRO (1240)', qty: 1, unitPrice: zlToGr(100.0) },
    { name: 'NP_REINV_COLL (1203)', qty: 300, unitPrice: zlToGr(1.0) },
    // valueOverridden: qty*unitPrice = 1793.00, но по факту 1792.99
    { name: 'NP_REINV_DEL', qty: 1793, unitPrice: zlToGr(1.0), value: zlToGr(1792.99), valueOverridden: true },
    { name: 'NP_RENTAL_SCAN', qty: 4, unitPrice: zlToGr(120.0) },
  ];

  return createInvoice({
    header: {
      period: '2026-07',
      printDate: '2026-08-01',
      supplierName: 'Test Supplier Sp. z o.o.',
      supplierNo: 'TEST-0001',
      contractNo: 'UM/TEST/0001',
    },
    vehicles,
    fees,
  });
}
