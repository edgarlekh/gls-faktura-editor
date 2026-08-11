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
    { name: 'CashService - płatność gotówkowa', qty: cashGot, unitPrice: zlToGr(0.1) },
    { name: 'CashService - płatność bezgotówkowa', qty: cashBezgot, unitPrice: zlToGr(0.5) },
    { name: 'ExchangeService', qty: exch, unitPrice: zlToGr(0.0) },
    { name: 'IdentService', qty: ident, unitPrice: zlToGr(2.0) },
    { name: 'Pick & Return Service', qty: pickReturn, unitPrice: zlToGr(0.0) },
    { name: 'Pick&Ship Service', qty: pickShip, unitPrice: zlToGr(0.0) },
    { name: 'Rabat mała paczka', qty: rabat, unitPrice: zlToGr(-1.5) },
  ];
}

function bonusMalusLines({ cqe, dqeQty, dqeRate, npseQty, npseRate }) {
  return [
    { name: 'Bonus/Malus za jakość odbiorów CQE', qty: cqe, unitPrice: zlToGr(0.0) },
    { name: 'Bonus/Malus za jakość DQE', qty: dqeQty, unitPrice: zlToGr(dqeRate) },
    { name: 'Bonus/Malus NPSE', qty: npseQty, unitPrice: zlToGr(npseRate) },
  ];
}

// Дословные номера PGB из образца 10082026.pdf (некоторые с "#" — так и в
// исходнике, символ верно распознан PyMuPDF по векторному глифу, не опечатка).
function pgbLines(serials) {
  return serials.map((serial) => ({ name: `PGB (${serial})`, qty: 1, unitPrice: zlToGr(20.0) }));
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
      extra: [
        ...pgbLines([
          '26610592962', '83664915102', '26610615032', '17681232510',
          '30648928143#', '62515778174', '62515778172', '62515778173',
        ]),
        { name: 'Eco Bonus (0,54_23_2788)', qty: 1, unitPrice: zlToGr(1381.4) },
      ],
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
      extra: pgbLines(['85619199414', '86684167992', '86684167989']),
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
      extra: pgbLines([
        '43618582717#', '61343653538', '83664728339', '13610950418#', '14680963505',
        '61343679274', '63616988592', '25612333012', '43618634791', '29626224384#',
        '29626224385', '30648883340#', '61343697844', '62515610679#', '62515610681',
        '44643592848', '61343712168',
      ]),
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
      extra: pgbLines([
        '62514642352', '62514642599#', '43618600171', '13610955166',
        '30648867875#', '43618668523', '43618685972',
      ]),
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
        { name: 'CashService - płatność bezgotówkowa', qty: 1, unitPrice: zlToGr(0.5) },
        { name: 'Rabat mała paczka', qty: 25, unitPrice: zlToGr(-1.5) },
      ],
      bonusMalus: [],
      // "wyr#wnanie" — дословно из образца: символ "#" в этом месте на самом
      // деле распознан из глифа документа PyMuPDF (проверено на растре), не опечатка.
      extra: [{ name: 'Extra doręczenia (N_Zara_Proces sobotni_wyr#wnanie)', qty: 1, unitPrice: zlToGr(315.74) }],
    }),
  ];

  // name = дословный код "Materiał" из образца. "Numer pojazdu"/"Opis" — тоже
  // дословные из образца, но это не бизнес-данные модели (см. model.js: line
  // не имеет таких полей), поэтому держим их в print.js как FEES_INFO —
  // тот же приём, что и для GROUP_004/GROUP_010 (см. комментарий там).
  const fees = [
    { name: 'NP_ADD_SUBC', qty: 13324, unitPrice: zlToGr(0.02) },
    // valueOverridden: qty*unitPrice = 131.00, но по факту 130.76
    { name: 'NP_ELOADING', qty: 131, unitPrice: zlToGr(1.0), value: zlToGr(130.76), valueOverridden: true },
    { name: 'NP_PNLT_KU_BRO', qty: 1, unitPrice: zlToGr(100.0) },
    { name: 'NP_REINV_COLL', qty: 300, unitPrice: zlToGr(1.0) },
    // valueOverridden: qty*unitPrice = 1793.00, но по факту 1792.99
    { name: 'NP_REINV_DEL', qty: 1793, unitPrice: zlToGr(1.0), value: zlToGr(1792.99), valueOverridden: true },
    { name: 'NP_RENTAL_SCAN', qty: 4, unitPrice: zlToGr(120.0) },
  ];

  return createInvoice({
    header: {
      // значения как в образце 10082026.pdf (Этап 4) — реальная шапка эталонной фактуры
      period: 'Lipiec 2026',
      printDate: '10.08.2026',
      supplierName: 'MELBUS EDHAR LEKH',
      supplierNo: '6169907899',
      contractNo: '4600003440',
    },
    vehicles,
    fees,
  });
}
