import test from 'node:test';
import assert from 'node:assert/strict';
import '../pro-core.js';

const C = globalThis.ProCore;
const NOW = new Date('2026-11-11T16:00:00Z'); // 12:00 en Caracas

test('plan anual ahorra 37% frente a 12 x $1,99', () => {
  assert.equal(C.PLANS.monthly.usd, 1.99);
  assert.equal(C.PLANS.annual.usd, 15);
  assert.equal(Math.round(12 * C.PLANS.monthly.usd * 100) / 100, 23.88);
  assert.equal(C.annualSavingsPct(), 37);
});

test('precios de plan en Bs al cambio del día', () => {
  const m = C.planPrice('monthly', 901.62);
  const a = C.planPrice('annual', 901.62);
  assert.equal(m.usd, 1.99);
  assert.equal(m.bs, 1794.22);   // 1,99 × 901,62
  assert.equal(a.bs, 13524.3);   // 15 × 901,62
  assert.equal(C.planPrice('monthly', 0).bs, null);
});

test('suscripción: solo es Pro si está activa y no venció', () => {
  const active = { plan: 'monthly', status: 'active', startDate: '2026-11-01T00:00:00Z', endDate: '2026-12-01T00:00:00Z' };
  assert.equal(C.subscriptionState(active, NOW).isPro, true);
  assert.equal(C.subscriptionState(active, NOW).status, 'pro');
  assert.equal(C.subscriptionState(active, new Date('2026-12-02T00:00:00Z')).isPro, false);
  assert.equal(C.subscriptionState(active, new Date('2026-12-02T00:00:00Z')).status, 'expired');
  assert.equal(C.subscriptionState(null, NOW).isPro, false);
  assert.equal(C.subscriptionState({ plan: 'annual', status: 'canceled', endDate: '2027-01-01T00:00:00Z' }, NOW).isPro, false);
  assert.equal(C.subscriptionState({ plan: 'gold', status: 'active', endDate: '2027-01-01T00:00:00Z' }, NOW).isPro, false);
  assert.equal(C.subscriptionState({ plan: 'annual', status: 'active', endDate: 'basura' }, NOW).isPro, false);
  // fecha sola: vale hasta el final de ese día en hora de Venezuela
  const dateOnly = { plan: 'monthly', status: 'active', endDate: '2026-11-11' };
  assert.equal(C.subscriptionState(dateOnly, new Date('2026-11-12T02:00:00Z')).isPro, true);  // 22:00 del 11 en Caracas
  assert.equal(C.subscriptionState(dateOnly, new Date('2026-11-12T04:30:00Z')).isPro, false); // 00:30 del 12
  assert.ok(C.msUntilExpiry(active, NOW) > 0);
  assert.equal(C.msUntilExpiry(null, NOW), null);
});

test('vencimientos de planes', () => {
  assert.equal(C.computeEndDate('2026-11-11T00:00:00.000Z', 'monthly'), '2026-12-11T00:00:00.000Z');
  assert.equal(C.computeEndDate('2026-11-11T00:00:00.000Z', 'annual'), '2027-11-11T00:00:00.000Z');
  assert.equal(C.computeEndDate('2026-01-31T00:00:00.000Z', 'monthly'), '2026-02-28T00:00:00.000Z');
});

test('Gratis: no puede guardar el producto 11; Pro sí', () => {
  assert.equal(C.FREE_LIMITS.products, 10);
  for (let n = 0; n < 10; n++) assert.equal(C.canAddProduct(n, false), true, 'producto ' + (n + 1));
  assert.equal(C.canAddProduct(10, false), false);
  assert.equal(C.canAddProduct(11, false), false);
  assert.equal(C.canAddProduct(10, true), true);
  assert.equal(C.canAddProduct(500, true), true);
});

test('Gratis: historial últimos 30 días o 50 cálculos (lo que se cumpla primero)', () => {
  const day = 86400000;
  const mk = (n, ageDays) => ({ id: 'h' + n, data: { timestamp: new Date(NOW.getTime() - ageDays * day).toISOString() } });
  // 3 recientes + 2 de hace 31 y 90 días
  const a = [mk(1, 1), mk(2, 5), mk(3, 29.5), mk(4, 31), mk(5, 90)];
  const free = C.applyHistoryPolicy(a, false, NOW);
  assert.deepEqual(free.map(x => x.id), ['h1', 'h2', 'h3']);
  assert.equal(C.applyHistoryPolicy(a, true, NOW).length, 5);
  // 60 cálculos recientes: tope de 50
  const many = Array.from({ length: 60 }, (_, i) => mk(i, i / 10));
  assert.equal(C.applyHistoryPolicy(many, false, NOW).length, 50);
  assert.equal(C.applyHistoryPolicy(many, true, NOW).length, 60);
  // orden: más reciente primero
  assert.equal(free[0].id, 'h1');
  const cut = C.historyCutoffIso(NOW);
  assert.equal(cut, new Date(NOW.getTime() - 30 * day).toISOString());
});

test('vigencia de tasas: hoy / mañana / fecha, en hora de Venezuela', () => {
  assert.equal(C.vigenciaText('2026-11-11', NOW), 'Vigente: Hoy (11 nov)');
  assert.equal(C.vigenciaText('2026-11-12', NOW), 'Vigente: Mañana (12 nov)');
  assert.equal(C.vigenciaText('2026-11-09', NOW), 'Vigente: 9 nov');
  // 02:00 UTC del 12 = 22:00 del 11 en Caracas: sigue siendo "hoy 11"
  assert.equal(C.vigenciaText('2026-11-11', new Date('2026-11-12T02:00:00Z')), 'Vigente: Hoy (11 nov)');
  assert.equal(C.vigenciaText('2026-11-11T00:00:00-04:00', NOW), 'Vigente: Hoy (11 nov)');
  assert.equal(C.vigenciaText('', NOW), '');
});

test('reportes por día, semana, mes y producto', () => {
  const e = (ts, title, final, gan, rate = 900) => ({ id: ts + title, data: { timestamp: ts, title, finalPriceBs: final, gananciaBs: gan, rateValue: rate, costUsd: 1 } });
  const items = [
    e('2026-11-11T15:00:00Z', 'Diamantes', 1000, 200),
    e('2026-11-11T18:00:00Z', 'Diamantes', 1000, 300),
    e('2026-11-10T15:00:00Z', 'Pase', 500, 50),
    e('2026-11-02T15:00:00Z', 'Pase', 500, 40),  // lunes de otra semana
    e('2026-10-15T15:00:00Z', 'Pase', 500, 10)
  ];
  const day = C.buildPeriodReport(items, 'day');
  assert.equal(day.rows.length, 4);
  assert.equal(day.rows[0].key, '2026-11-11');
  assert.equal(day.rows[0].count, 2);
  assert.equal(day.rows[0].gainBs, 500);
  assert.equal(day.rows[0].revenueBs, 2000);
  assert.equal(day.rows[0].marginPct, 25);
  const week = C.buildPeriodReport(items, 'week');
  assert.deepEqual(week.rows.map(r => r.key), ['2026-11-09', '2026-11-02', '2026-10-12']);
  assert.equal(week.rows[0].gainBs, 550); // 11 y 10 nov (lunes 9 nov – domingo 15 nov)... el 10 cae en la misma semana
  const month = C.buildPeriodReport(items, 'month');
  assert.deepEqual(month.rows.map(r => r.key), ['2026-11', '2026-10']);
  assert.equal(month.rows[0].gainBs, 590);
  assert.equal(month.total.gainBs, 600);
  const prod = C.buildProductReport(items);
  assert.equal(prod.rows[0].title, 'Diamantes');
  assert.equal(prod.rows[0].gainBs, 500);
  assert.equal(prod.rows[1].title, 'Pase');
  assert.equal(prod.rows[1].count, 3);
  // entradas de la app sin gananciaBs: se calcula con el precio final
  const noGain = [{ data: { timestamp: '2026-11-11T15:00:00Z', title: 'X', finalPriceBs: 1000, rateValue: 100, costUsd: 5, commissionPlatform: 0.02, commissionPaymentMethod: 0.05, commissionOther: 0, fixedExpenseBs: 10 } }];
  assert.equal(C.buildPeriodReport(noGain, 'day').rows[0].gainBs, 420); // 1000 - 500 - 10 - 70
});

test('lote: parseo de líneas', () => {
  const r = C.parseBatch('Diamantes 100  12,5\n3.25\n$4.50 Pase\nAlgo;7,10\nSin precio\nTarjeta\t1.250,75\n\n');
  assert.equal(r.length, 6);
  assert.deepEqual(r.map(x => x.costUsd).map(x => isNaN(x) ? null : x), [12.5, 3.25, 4.5, 7.1, null, 1250.75]);
  assert.equal(r[0].name, 'Diamantes 100');
  assert.equal(r[2].name, 'Pase');
  assert.equal(r[3].name, 'Algo');
  assert.equal(r[4].valid, false);
  assert.equal(C.parseBatch('a 1\n'.repeat(500)).length, 200); // tope
});

test('importar CSV: encabezados, separador ; y validaciones', () => {
  const csv = 'nombre;categoria;costo_usd;margen_pct;comision_proveedor_pct;comision_pasarela_pct;gasto_fijo_bs;modo;tasa;redondeo\r\n'
    + '"100 + 10 Diamantes";Free Fire;0,66;30;0;0;0;sobre costo;bcv;10\r\n'
    + 'Tarjeta Mensual;Free Fire;6.5;20;2;5;0;sobre venta;binance;50\r\n'
    + ';Roblox;3;20;0;0;0;;;\r\n'
    + 'Malo;Roblox;-1;20\r\n'
    + 'Custom;;2;10;0;0;0;;personalizada;10\r\n';
  const out = C.rowsToProducts(C.parseCsv(csv));
  assert.equal(out.total, 5);
  assert.equal(out.products.length, 2);
  assert.equal(out.errors.length, 3);
  const p0 = out.products[0];
  assert.equal(p0.name, '100 + 10 Diamantes');
  assert.equal(p0.costUsd, 0.66);
  assert.equal(p0.marginMode, 'onCost');
  assert.equal(p0.rateSourceName, 'bcvUsd');
  const p1 = out.products[1];
  assert.equal(p1.marginMode, 'onSale');
  assert.equal(p1.rateSourceName, 'binanceUsdt');
  assert.equal(p1.commissionPlatform, 0.02);   // 2% -> 0,02
  assert.equal(p1.commissionPaymentMethod, 0.05);
  assert.equal(p1.roundStep, 50);
  assert.ok(out.errors.some(e => /nombre/i.test(e.message)));
  assert.ok(out.errors.some(e => /costo/i.test(e.message)));
  assert.ok(out.errors.some(e => /personalizada/i.test(e.message)));
  // sin columnas obligatorias
  assert.equal(C.rowsToProducts([['a', 'b'], ['1', '2']]).products.length, 0);
  assert.equal(C.rowsToProducts([]).errors.length, 1);
});

test('alertas de brecha y de tasa', () => {
  const now = NOW;
  const rates = { bcvUsd: 900, binanceUsdt: 1100, bcvDate: '2026-11-11' }; // brecha 22,2%
  let r = C.evaluateAlerts({ gapEnabled: true, gapThresholdPct: 20 }, rates, {}, now);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].type, 'gap');
  // no repite el mismo día
  const r2 = C.evaluateAlerts({ gapEnabled: true, gapThresholdPct: 20 }, rates, r.state, now);
  assert.equal(r2.alerts.length, 0);
  // por debajo del límite: no avisa
  assert.equal(C.evaluateAlerts({ gapEnabled: true, gapThresholdPct: 25 }, rates, {}, now).alerts.length, 0);
  // tasa nueva del BCV
  const s = { rateEnabled: true, lastSeenBcvDate: '2026-11-10' };
  const t = C.evaluateAlerts(s, rates, {}, now);
  assert.equal(t.alerts[0].type, 'rate');
  assert.deepEqual(t.seen, { date: '2026-11-11', usd: 900 });
  // primera vez (nunca visto): solo registra, no avisa
  const first = C.evaluateAlerts({ rateEnabled: true }, rates, {}, now);
  assert.equal(first.alerts.length, 0);
  assert.equal(first.seen.date, '2026-11-11');
  // misma fecha: nada
  assert.equal(C.evaluateAlerts({ rateEnabled: true, lastSeenBcvDate: '2026-11-11' }, rates, {}, now).alerts.length, 0);
  // límite por valor
  const a = C.evaluateAlerts({ rateEnabled: true, lastSeenBcvDate: '2026-11-11', bcvAboveBs: 890 }, rates, {}, now);
  assert.equal(a.alerts[0].type, 'above');
});

test('serie de tasas 30 días y tasa de reposición', () => {
  const off = [], par = [];
  for (let i = 40; i >= 0; i--) {
    const d = new Date(Date.UTC(2026, 10, 11) - i * 86400000).toISOString().slice(0, 10);
    off.push({ fecha: d, promedio: 800 + (40 - i) * 2.5 });
    par.push({ fecha: d, promedio: 950 + (40 - i) * 3 });
  }
  const series = C.buildRateSeries(off, par, 30, NOW);
  assert.equal(series.length, 31);
  assert.equal(series[series.length - 1].date, '2026-11-11');
  assert.ok(series.every(p => p.bcv > 0 && p.par > 0));
  const rec = C.recommendedReplenishmentRate(series, 900, 1070);
  assert.ok(rec.rate >= 1070);
  assert.ok(rec.cushionPct <= 3 && rec.cushionPct >= 0);
  assert.equal(rec.parToday, 1070);
  assert.equal(C.recommendedReplenishmentRate([], 900, 0), null);
  const paths = C.chartPaths(series, 600, 200);
  assert.ok(paths.bcv.startsWith('M') && paths.par.startsWith('M'));
  assert.ok(paths.max > paths.min);
});

test('lista de precios: agrupa por categoría y orden natural', () => {
  const rows = [
    { name: '310 + 31', category: 'Free Fire', price: 1 }, { name: '100 + 10', category: 'Free Fire', price: 1 },
    { name: '1060 + 106', category: 'Free Fire', price: 1 }, { name: 'Robux', category: 'Roblox', price: 1 }, { name: 'Suelto', category: '', price: 1 }
  ];
  const l = C.layoutPriceList(rows);
  assert.deepEqual(l.map(s => s.category), ['Free Fire', 'Roblox', 'Otros productos']);
  assert.deepEqual(l[0].items.map(i => i.name), ['100 + 10', '310 + 31', '1060 + 106']);
});

test('revalorización masiva muestra cuánto cambió cada precio', () => {
  const calc = (p) => {
    const rate = p.rateSourceName === 'custom' ? p.customRateValue : { bcvUsd: 900, binanceUsdt: 1000 }[p.rateSourceName];
    return { error: null, precioFinal: Math.ceil(p.costUsd * rate / 0.8 / 10) * 10 };
  };
  const products = [
    { id: 'a', data: { name: 'A', costUsd: 1, rateSourceName: 'custom', customRateValue: 800 } },
    { id: 'b', data: { name: 'B', costUsd: 2, rateSourceName: 'bcvUsd' } },
    { id: 'c', data: { name: 'C', costUsd: 3, rateSourceName: 'custom', customRateValue: 900 } }
  ];
  const out = C.buildRevaluation(products, { liveRates: { bcvUsd: 900, binanceUsdt: 1000 }, targetSource: 'bcvUsd', snapshot: {}, calc });
  assert.equal(out.rows.length, 3);
  assert.equal(out.rows[0].oldPrice, 1000); // 800/0.8
  assert.equal(out.rows[0].newPrice, 1130); // 900/0.8 = 1125 -> 1130
  assert.equal(out.rows[0].delta, 130);
  assert.equal(out.rows[1].delta, 0);       // BCV: ya iba con la tasa viva
  assert.equal(out.rows[2].delta, 0);       // tasa propia = tasa de hoy
  assert.deepEqual(out.updates, [{ id: 'a', customRateValue: 900 }]);
  assert.equal(out.changed, 1);
  // con una foto del último precio revalorizado, compara contra esa
  const out2 = C.buildRevaluation(products, { liveRates: { bcvUsd: 900 }, targetSource: 'bcvUsd', snapshot: { b: 2000 }, calc });
  assert.equal(out2.rows[1].oldPrice, 2000);
  assert.equal(out2.rows[1].newPrice, 2250);
  assert.equal(out2.rows[1].delta, 250);
});

