/* pro-core.js — lógica PURA (sin DOM ni Firebase) de planes, límites Gratis/Pro,
 * desglose paso a paso, reportes, revalorización, lote, importación CSV,
 * alertas y serie de tasas. Se carga como script clásico (window.ProCore) y
 * también se puede importar en Node para las pruebas (tests/).
 *
 * NO contiene fórmulas de precio: los precios siempre los calcula
 * computeSaleMetrics() de app.js (se inyecta como función donde hace falta).
 */
(function (root) {
  'use strict';

  var MS_DAY = 86400000;
  var TZ = 'America/Caracas';

  /* ===== Esquema Gratis vs Pro ===== */
  var ADMIN_EMAILS = Object.freeze(['layankrach@gmail.com', 'soporterefillstore@gmail.com']);
  function isAdminEmail(email) {
    var clean = String(email || '').trim().toLowerCase();
    return ADMIN_EMAILS.indexOf(clean) !== -1;
  }
  var FREE_LIMITS = Object.freeze({ products: 10, historyDays: 30, historyItems: 50 });
  var PRO_HISTORY_READ_CAP = 1000; // tope técnico de lectura del historial Pro
  var PLANS = Object.freeze({
    monthly: Object.freeze({ id: 'monthly', name: 'Mensual', label: 'Pro Mensual', usd: 1.99, months: 1, days: 30, savePct: 0 }),
    quarterly: Object.freeze({ id: 'quarterly', name: 'Trimestral', label: 'Pro Trimestral', usd: 4.99, months: 3, days: 90, savePct: 16 }),
    semiannual: Object.freeze({ id: 'semiannual', name: '6 meses', label: 'Pro 6 Meses', usd: 7.99, months: 6, days: 180, savePct: 33 }),
    annual: Object.freeze({ id: 'annual', name: 'Anual', label: 'Pro Anual', usd: 15.99, months: 12, days: 365, savePct: 33 })
  });

  /* ===== Utilidades ===== */
  function toNum(v, d) {
    var n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.'));
    return isFinite(n) ? n : (d || 0);
  }
  function round2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }
  function toDate(now) {
    if (now instanceof Date) return now;
    return new Date(now == null ? Date.now() : now);
  }
  var nf2 = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var nf0 = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  var nf1 = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var nfFrac = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
  function fmt2(v) { return nf2.format(v); }
  function fmt0(v) { return nf0.format(v); }
  function fmt1(v) { return nf1.format(v); }

  var dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  /** 'YYYY-MM-DD' en hora de Venezuela para un instante (ISO/Date/ms). '' si no es válido. */
  function dayKey(v) {
    var d = typeof v === 'string' || typeof v === 'number' ? new Date(v) : v;
    if (!d || isNaN(d.getTime())) return '';
    return dayFmt.format(d);
  }
  function todayKey(now) { return dayKey(toDate(now)); }
  function dayNumber(key) { // 'YYYY-MM-DD' -> nº de día (UTC), sin efectos de horario de verano
    var p = String(key || '').split('-');
    if (p.length !== 3) return NaN;
    return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / MS_DAY);
  }
  var MESES = ['', 'ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function shortDate(key) { // '2026-11-11' -> '11 nov'
    var p = String(key || '').split('-');
    if (p.length !== 3) return String(key || '');
    return (+p[2]) + ' ' + (MESES[+p[1]] || p[1]);
  }
  /** Texto de vigencia de una tasa: 'Vigente: Hoy (11 nov)' / 'Vigente: Mañana (12 nov)' / 'Vigente: 9 nov'. */
  function vigenciaText(effKey, now) {
    var k = String(effKey || '').split('T')[0];
    var n = dayNumber(k);
    if (isNaN(n)) return k ? 'Vigente: ' + k : '';
    var diff = n - dayNumber(todayKey(now));
    var sd = shortDate(k);
    if (diff === 0) return 'Vigente: Hoy (' + sd + ')';
    if (diff === 1) return 'Vigente: Mañana (' + sd + ')';
    return 'Vigente: ' + sd;
  }

  /* ===== Suscripción ===== */
  function parseEnd(v) {
    if (!v) return NaN;
    var s = String(v);
    // Fecha sola (sin hora): vence al final de ese día en hora de Venezuela.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T23:59:59-04:00';
    return Date.parse(s);
  }
  /** Estado de la suscripción: Pro solo si status 'active' y endDate en el futuro. */
  function subscriptionState(sub, now) {
    var t = toDate(now).getTime();
    var none = { isPro: false, status: 'free', plan: null, endDate: '', startDate: '', daysLeft: 0 };
    if (!sub || typeof sub !== 'object') return none;
    var plan = (sub.plan && Object.prototype.hasOwnProperty.call(PLANS, sub.plan)) ? sub.plan : null;
    var end = parseEnd(sub.endDate);
    var out = { isPro: false, status: 'free', plan: plan, endDate: sub.endDate || '', startDate: sub.startDate || '', daysLeft: 0 };
    if (sub.status === 'active' && plan && isFinite(end)) {
      if (end > t) {
        out.isPro = true; out.status = 'pro'; out.daysLeft = Math.ceil((end - t) / MS_DAY);
      } else {
        out.status = 'expired';
      }
    } else if (sub.status === 'expired') {
      out.status = 'expired';
    }
    return out;
  }
  /** Milisegundos hasta que venza el Pro (para volver a Gratis sin recargar); null si no aplica. */
  function msUntilExpiry(sub, now) {
    var st = subscriptionState(sub, now);
    if (!st.isPro) return null;
    return Math.max(0, parseEnd(sub.endDate) - toDate(now).getTime());
  }
  function addMonthsIso(startIso, months) {
    var d = new Date(startIso);
    if (isNaN(d.getTime())) return '';
    var day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    var last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.toISOString();
  }
  /** Vencimiento de un plan que empieza en startIso (ayuda para el administrador). */
  function computeEndDate(startIso, planId) {
    var p = PLANS[planId];
    return p ? addMonthsIso(startIso, p.months) : '';
  }
  function planSavingsPct(planId) {
    var p = PLANS[planId];
    if (!p || p.months <= 1) return 0;
    var full = p.months * PLANS.monthly.usd;
    return Math.round((1 - p.usd / full) * 100);
  }
  function annualSavingsPct() {
    return planSavingsPct('annual');
  }
  function planPrice(planId, bcvRate) {
    var p = PLANS[planId];
    if (!p) return null;
    var rate = toNum(bcvRate, 0);
    return { usd: p.usd, usdt: p.usd, bs: rate > 0 ? round2(p.usd * rate) : null, rate: rate > 0 ? rate : null };
  }

  /* ===== Límites ===== */
  function canAddProduct(currentCount, isPro) {
    return !!isPro || toNum(currentCount, 0) < FREE_LIMITS.products;
  }
  function historyCutoffIso(now) {
    return new Date(toDate(now).getTime() - FREE_LIMITS.historyDays * MS_DAY).toISOString();
  }
  /** Aplica la política de historial. items: [{id,data:{timestamp}}] (cualquier orden). */
  function applyHistoryPolicy(items, isPro, now) {
    var list = (items || []).slice().sort(function (a, b) {
      return String((b.data || {}).timestamp || '').localeCompare(String((a.data || {}).timestamp || ''));
    });
    if (isPro) return list.slice(0, PRO_HISTORY_READ_CAP);
    var cut = toDate(now).getTime() - FREE_LIMITS.historyDays * MS_DAY;
    var kept = list.filter(function (it) {
      var t = Date.parse((it.data || {}).timestamp);
      return isNaN(t) ? true : t >= cut;
    });
    return kept.slice(0, FREE_LIMITS.historyItems);
  }

  /* ===== Desglose paso a paso (usa SIEMPRE las métricas ya calculadas) ===== */
  /** inp: { mode, costUsd, rate, marginPercent, comP, comPa, comO (en %), gasto (Bs), roundStep }
   *  m: resultado de computeSaleMetrics (precioExacto, precioFinal, costBs, comisionesBs, gananciaBs, ...). */
  function buildBreakdown(inp, m) {
    var onCost = inp.mode === 'onCost';
    var comTotal = toNum(inp.comP) + toNum(inp.comPa) + toNum(inp.comO);
    var com = comTotal / 100;
    var mf = toNum(inp.marginPercent) / 100;
    var gasto = toNum(inp.gasto);
    var costBs = m.costBs;
    var steps = [];
    steps.push({
      title: 'Pasa el costo a bolívares',
      formula: '$' + fmt2(inp.costUsd) + ' × ' + fmt2(inp.rate) + ' Bs/$',
      result: 'Bs ' + fmt2(costBs)
    });
    steps.push({
      title: 'Suma todo lo que te quitan',
      formula: fmt1(inp.comP) + '% + ' + fmt1(inp.comPa) + '% + ' + fmt1(inp.comO) + '%',
      result: fmt1(comTotal) + '% en comisiones'
    });
    if (onCost) {
      var conMargen = costBs * (1 + mf);
      steps.push({
        title: 'Súbele tu margen al costo (Markup)',
        formula: 'Bs ' + fmt2(costBs) + ' × (1 + ' + nfFrac.format(mf) + ')',
        result: 'Bs ' + fmt2(conMargen)
      });
      steps.push({
        title: 'Suma el gasto fijo y divide entre lo que queda tras comisiones',
        formula: '(Bs ' + fmt2(conMargen) + ' + Bs ' + fmt2(gasto) + ') ÷ (1 − ' + nfFrac.format(com) + ')',
        result: 'Bs ' + fmt2(m.precioExacto)
      });
    } else {
      steps.push({
        title: 'Saca lo que queda para ti',
        formula: '1 − ' + nfFrac.format(com) + ' − ' + nfFrac.format(mf),
        result: '= ' + nfFrac.format(1 - com - mf)
      });
      steps.push({
        title: 'Divide el costo entre eso',
        formula: '(Bs ' + fmt2(costBs) + ' + Bs ' + fmt2(gasto) + ') ÷ ' + nfFrac.format(1 - com - mf),
        result: 'Bs ' + fmt2(m.precioExacto)
      });
    }
    var gan = m.precioFinal - costBs - gasto - m.comisionesBs;
    var rounded = toNum(inp.roundStep, 1) > 1
      ? 'Precio redondeado ↑ Bs ' + fmt0(m.precioFinal)
      : 'Precio Bs ' + fmt2(m.precioFinal);
    steps.push({
      title: 'Verifica que no pierdes',
      formula: rounded + ' − Costo Bs ' + fmt2(costBs) + ' − Gasto Bs ' + fmt2(gasto) + ' − Comisiones Bs ' + fmt2(m.comisionesBs),
      result: 'Ganancia: Bs ' + fmt2(gan) + ' (' + (onCost
        ? fmt1(m.margenRealCost) + '% s/costo'
        : fmt1(m.margenRealSale) + '% s/venta') + ')',
      gain: gan
    });
    return steps;
  }

  /* ===== Tabla "¿Y si cambias el margen?" ===== */
  /** compute(marginPercent) -> métricas de computeSaleMetrics. Incluye siempre la fila del margen elegido. */
  function marginTableRows(selectedMargin, compute, baseMargins) {
    var list = (baseMargins || [10, 15, 20, 25, 30, 35, 40]).slice();
    var sel = toNum(selectedMargin, NaN);
    if (isFinite(sel) && list.indexOf(sel) === -1) list.push(sel);
    list.sort(function (a, b) { return a - b; });
    var rows = [];
    list.forEach(function (mg) {
      var m = compute(mg);
      if (!m || m.error) return;
      rows.push({ margin: mg, current: mg === sel, precioFinal: m.precioFinal, precioUsd: m.precioUsd, gananciaBs: m.gananciaBs });
    });
    return rows;
  }

  /* ===== Reportes de ganancia (a partir del historial guardado) ===== */
  function entryProfit(d) {
    if (typeof d.gananciaBs === 'number' && isFinite(d.gananciaBs)) return d.gananciaBs;
    var final = toNum(d.finalPriceBs), rate = toNum(d.rateValue), cost = toNum(d.costUsd) * rate;
    var com = toNum(d.commissionPlatform) + toNum(d.commissionPaymentMethod) + toNum(d.commissionOther);
    return final - cost - toNum(d.fixedExpenseBs) - final * com;
  }
  function weekStartKey(key) { // lunes de la semana de esa fecha
    var n = dayNumber(key);
    var dow = ((n + 3) % 7 + 7) % 7; // 0 = lunes (1970-01-01 fue jueves)
    var d = new Date((n - dow) * MS_DAY);
    return d.toISOString().slice(0, 10);
  }
  function periodKey(iso, period) {
    var k = dayKey(iso);
    if (!k) return '';
    if (period === 'month') return k.slice(0, 7);
    if (period === 'week') return weekStartKey(k);
    return k;
  }
  function periodLabel(key, period) {
    if (period === 'month') {
      var p = key.split('-');
      return (MESES[+p[1]] || p[1]) + ' ' + p[0];
    }
    if (period === 'week') return 'Semana del ' + shortDate(key);
    return shortDate(key);
  }
  function emptyAcc() { return { count: 0, revenueBs: 0, costBs: 0, gainBs: 0, gainUsd: 0 }; }
  function addEntry(acc, d) {
    var rate = toNum(d.rateValue);
    var gain = entryProfit(d);
    acc.count += 1;
    acc.revenueBs += toNum(d.finalPriceBs);
    acc.costBs += toNum(d.costUsd) * rate;
    acc.gainBs += gain;
    acc.gainUsd += rate > 0 ? gain / rate : 0;
  }
  function finishAcc(acc) {
    acc.revenueBs = round2(acc.revenueBs); acc.costBs = round2(acc.costBs);
    acc.gainBs = round2(acc.gainBs); acc.gainUsd = round2(acc.gainUsd);
    acc.marginPct = acc.revenueBs > 0 ? round2((acc.gainBs / acc.revenueBs) * 100) : 0;
    return acc;
  }
  /** period: 'day'|'week'|'month'. Devuelve filas por periodo (más reciente primero) y totales. */
  function buildPeriodReport(items, period) {
    var groups = {};
    (items || []).forEach(function (it) {
      var d = it.data || it;
      var key = periodKey(d.timestamp, period);
      if (!key) return;
      var g = groups[key] || (groups[key] = Object.assign({ key: key, label: periodLabel(key, period) }, emptyAcc()));
      addEntry(g, d);
    });
    var rows = Object.keys(groups).sort().reverse().map(function (k) { return finishAcc(groups[k]); });
    var total = emptyAcc();
    (items || []).forEach(function (it) { var d = it.data || it; if (periodKey(d.timestamp, period)) addEntry(total, d); });
    return { period: period, rows: rows, total: finishAcc(total) };
  }
  function buildProductReport(items) {
    var groups = {};
    (items || []).forEach(function (it) {
      var d = it.data || it;
      var name = String(d.title || 'Producto').trim() || 'Producto';
      var k = name.toLowerCase();
      var g = groups[k] || (groups[k] = Object.assign({ title: name }, emptyAcc()));
      addEntry(g, d);
    });
    var rows = Object.keys(groups).map(function (k) { return finishAcc(groups[k]); })
      .sort(function (a, b) { return b.gainBs - a.gainBs; });
    var total = emptyAcc();
    (items || []).forEach(function (it) { addEntry(total, it.data || it); });
    return { rows: rows, total: finishAcc(total) };
  }

  /* ===== Revalorización masiva ===== */
  /** products: [{id, data: producto normalizado}]. ctx:
   *  { liveRates:{bcvUsd,binanceUsdt,euroBcv}, targetSource, snapshot:{id:precioAnterior}, calc(prodLike)->métricas }
   *  Precio anterior = último precio revalorizado guardado en este navegador, o el precio a la tasa propia del producto.
   *  Nuevo precio = misma configuración con la tasa de hoy (los productos con tasa personalizada pasan a la tasa objetivo). */
  function buildRevaluation(products, ctx) {
    var live = ctx.liveRates || {};
    var target = ctx.targetSource || 'bcvUsd';
    var targetRate = toNum(live[target]);
    var snap = ctx.snapshot || {};
    var rows = [];
    var updates = [];
    (products || []).forEach(function (it) {
      var p = it.data;
      var isCustom = p.rateSourceName === 'custom';
      var oldRate = isCustom ? toNum(p.customRateValue) : toNum(live[p.rateSourceName]);
      var newRate = isCustom ? targetRate : oldRate;
      var oldM = ctx.calc(p);
      var newProd = isCustom ? Object.assign({}, p, { rateSourceName: 'custom', customRateValue: newRate }) : p;
      var newM = ctx.calc(newProd);
      if (!newM || newM.error) { rows.push({ id: it.id, name: p.name, error: true }); return; }
      var hasSnap = typeof snap[it.id] === 'number';
      var oldPrice = hasSnap ? snap[it.id] : ((oldM && !oldM.error) ? oldM.precioFinal : newM.precioFinal);
      var delta = newM.precioFinal - oldPrice;
      rows.push({
        id: it.id, name: p.name, category: p.category || '',
        oldPrice: oldPrice, newPrice: newM.precioFinal, delta: delta,
        deltaPct: oldPrice > 0 ? (delta / oldPrice) * 100 : 0,
        oldRate: oldRate, newRate: newRate, customRate: isCustom
      });
      if (isCustom && newRate > 0 && newRate !== p.customRateValue) updates.push({ id: it.id, customRateValue: newRate });
    });
    var changed = rows.filter(function (r) { return !r.error && Math.abs(r.delta) >= 0.005; }).length;
    return { rows: rows, updates: updates, changed: changed, targetRate: targetRate };
  }

  /* ===== Calculadora por lote ===== */
  function parseNumberLoose(tok) {
    var s = String(tok).trim().replace(/[$\s]/g, '').replace(/usd$/i, '');
    if (!/^-?\d[\d.,]*$/.test(s)) return NaN;
    var hasDot = s.indexOf('.') !== -1, hasComma = s.indexOf(',') !== -1;
    if (hasDot && hasComma) {
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (hasComma) {
      s = s.replace(',', '.');
    }
    var n = parseFloat(s);
    return isFinite(n) ? n : NaN;
  }
  /** Cada línea: "Nombre 12,5", "12.5 Nombre", "Nombre;12.5", "Nombre<TAB>12.5" o solo "12.5". */
  function parseBatch(text, max) {
    var cap = max || 200;
    var rows = [];
    String(text == null ? '' : text).split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line || rows.length >= cap) return;
      var name = '', cost = NaN, m;
      if (/[;\t]/.test(line)) {
        var parts = line.split(/[;\t]/).map(function (s) { return s.trim(); }).filter(Boolean);
        for (var i = parts.length - 1; i >= 0; i--) {
          var n = parseNumberLoose(parts[i]);
          if (!isNaN(n)) { cost = n; parts.splice(i, 1); break; }
        }
        name = parts.join(' ');
      } else if ((m = line.match(/^(.*?)[\s:=,-]*\$?\s*(-?\d[\d.,]*)\s*(?:\$|usd)?\s*$/i)) && !isNaN(parseNumberLoose(m[2]))) {
        name = m[1].trim(); cost = parseNumberLoose(m[2]);
      } else if ((m = line.match(/^\$?\s*(-?\d[\d.,]*)\s*(?:\$|usd)?[\s:=,-]+(.+)$/i)) && !isNaN(parseNumberLoose(m[1]))) {
        cost = parseNumberLoose(m[1]); name = m[2].trim();
      }
      rows.push({ line: line, name: name, costUsd: cost, valid: isFinite(cost) && cost > 0 });
    });
    return rows;
  }
  /** calc(costUsd) -> métricas de computeSaleMetrics. */
  function computeBatch(rows, calc) {
    return rows.map(function (r, i) {
      if (!r.valid) return Object.assign({ n: i + 1, error: 'sin_costo' }, r);
      var m = calc(r.costUsd);
      if (!m || m.error) return Object.assign({ n: i + 1, error: m ? m.error : 'calc' }, r);
      return Object.assign({ n: i + 1, error: null }, r, {
        costBs: m.costBs, precioFinal: m.precioFinal, precioUsd: m.precioUsd, gananciaBs: m.gananciaBs
      });
    });
  }

  /* ===== Importar catálogo (CSV / filas de Excel) ===== */
  function parseCsv(text) {
    var s = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    var firstLine = s.split(/\r?\n/)[0] || '';
    var delim = ',';
    var counts = { ',': (firstLine.match(/,/g) || []).length, ';': (firstLine.match(/;/g) || []).length, '\t': (firstLine.match(/\t/g) || []).length };
    if (counts[';'] > counts[delim]) delim = ';';
    if (counts['\t'] > counts[delim]) delim = '\t';
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(function (x) { return String(x).trim() !== ''; })) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some(function (x) { return String(x).trim() !== ''; })) rows.push(row);
    return rows;
  }
  var HEADER_ALIASES = {
    name: ['nombre', 'name', 'producto', 'product', 'titulo', 'title'],
    category: ['categoria', 'categoría', 'category', 'rubro'],
    costUsd: ['costo_usd', 'costo usd', 'costo', 'cost', 'costusd', 'costo $', 'precio_costo'],
    marginPercent: ['margen_pct', 'margen %', 'margen', 'margin', 'marginpercent', 'ganancia %'],
    comP: ['comision_proveedor_pct', 'comision proveedor %', 'comision proveedor', 'comisión proveedor', 'proveedor'],
    comPa: ['comision_pasarela_pct', 'comision pasarela %', 'comision pasarela', 'comisión pasarela', 'pasarela'],
    comO: ['comision_otra_pct', 'comision otra %', 'otra comision', 'otra comisión', 'otra'],
    fixedExpenseBs: ['gasto_fijo_bs', 'gasto fijo bs', 'gasto fijo', 'gasto', 'fixedexpensebs'],
    mode: ['modo', 'mode', 'modo_margen', 'tipo_margen'],
    rate: ['tasa', 'rate', 'fuente_tasa', 'tasa_referencia'],
    customRate: ['tasa_personalizada', 'tasa personalizada', 'tasa_bs'],
    roundStep: ['redondeo', 'round', 'roundstep']
  };
  function normHeader(h) {
    return String(h == null ? '' : h).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  function mapHeaders(headerRow) {
    var map = {};
    headerRow.forEach(function (h, idx) {
      var n = normHeader(h);
      Object.keys(HEADER_ALIASES).forEach(function (field) {
        if (map[field] != null) return;
        if (HEADER_ALIASES[field].some(function (a) { return normHeader(a) === n; })) map[field] = idx;
      });
    });
    return map;
  }
  function pctToFrac(v) { var n = toNum(v); return n < 0 ? 0 : Math.round(n * 10000) / 1000000; }
  function parseMode(v) {
    var s = normHeader(v);
    if (!s) return 'onCost';
    if (s === 'onsale' || s.indexOf('venta') !== -1 || s === 'margen') return 'onSale';
    return 'onCost';
  }
  function parseRateSource(v) {
    var s = normHeader(v);
    if (s.indexOf('binance') !== -1 || s.indexOf('usdt') !== -1 || s.indexOf('paralelo') !== -1) return 'binanceUsdt';
    if (s.indexOf('euro') !== -1) return 'euroBcv';
    if (s.indexOf('personal') !== -1 || s === 'custom') return 'custom';
    return 'bcvUsd';
  }
  /** rows: filas (arreglos). La primera es el encabezado. Devuelve {products, errors, total}. */
  function rowsToProducts(rows, maxRows) {
    var cap = maxRows || 500;
    var out = { products: [], errors: [], total: 0 };
    if (!rows || rows.length < 2) { out.errors.push({ row: 1, message: 'El archivo no tiene filas de productos.' }); return out; }
    var map = mapHeaders(rows[0]);
    if (map.name == null || map.costUsd == null) {
      out.errors.push({ row: 1, message: 'Faltan las columnas "nombre" y "costo_usd" en el encabezado.' });
      return out;
    }
    var get = function (r, f) { return map[f] != null ? r[map[f]] : ''; };
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (!r || !r.some(function (x) { return String(x == null ? '' : x).trim() !== ''; })) continue;
      out.total++;
      if (out.products.length >= cap) { out.errors.push({ row: i + 1, message: 'Se importan máximo ' + cap + ' productos por archivo.' }); break; }
      var name = String(get(r, 'name') || '').trim();
      var cost = parseNumberLoose(get(r, 'costUsd'));
      var margenRaw = String(get(r, 'marginPercent')).trim();
      var margin = margenRaw === '' ? 20 : parseNumberLoose(margenRaw);
      var comP = String(get(r, 'comP')).trim() === '' ? 0 : parseNumberLoose(get(r, 'comP'));
      var comPa = String(get(r, 'comPa')).trim() === '' ? 0 : parseNumberLoose(get(r, 'comPa'));
      var comO = String(get(r, 'comO')).trim() === '' ? 0 : parseNumberLoose(get(r, 'comO'));
      var gasto = String(get(r, 'fixedExpenseBs')).trim() === '' ? 0 : parseNumberLoose(get(r, 'fixedExpenseBs'));
      var mode = parseMode(get(r, 'mode'));
      var src = parseRateSource(get(r, 'rate'));
      var custom = parseNumberLoose(get(r, 'customRate'));
      var step = String(get(r, 'roundStep')).trim() === '' ? 10 : parseNumberLoose(get(r, 'roundStep'));
      var err = '';
      if (!name) err = 'Falta el nombre.';
      else if (name.length > 120) err = 'El nombre supera 120 caracteres.';
      else if (!(cost > 0)) err = 'El costo debe ser un número mayor que 0.';
      else if (isNaN(margin) || margin < 0 || margin >= 100) err = 'El margen debe estar entre 0 y 99,9.';
      else if (isNaN(comP) || isNaN(comPa) || isNaN(comO) || comP < 0 || comPa < 0 || comO < 0) err = 'Las comisiones deben ser números válidos.';
      else if (comP + comPa + comO >= 100) err = 'Las comisiones deben sumar menos de 100%.';
      else if (mode === 'onSale' && comP + comPa + comO + margin >= 100) err = 'En modo sobre venta, comisiones + margen deben sumar menos de 100%.';
      else if (isNaN(gasto) || gasto < 0) err = 'El gasto fijo debe ser 0 o más.';
      else if (isNaN(step) || [0, 1, 10, 50, 100].indexOf(step) === -1) err = 'El redondeo debe ser 0, 1, 10, 50 o 100.';
      else if (src === 'custom' && !(custom > 0)) err = 'La tasa personalizada necesita un valor mayor que 0 (columna tasa_personalizada).';
      if (err) { out.errors.push({ row: i + 1, message: err }); continue; }
      var prod = {
        name: name,
        category: String(get(r, 'category') || '').trim().slice(0, 80),
        costUsd: cost,
        marginPercent: margin,
        fixedExpenseBs: gasto,
        commissionPlatform: pctToFrac(comP),
        commissionPaymentMethod: pctToFrac(comPa),
        commissionOther: pctToFrac(comO),
        roundStep: step,
        rateSourceName: src,
        marginMode: mode
      };
      if (src === 'custom') prod.customRateValue = custom;
      out.products.push(prod);
    }
    return out;
  }
  var IMPORT_TEMPLATE_ROWS = [
    ['nombre', 'categoria', 'costo_usd', 'margen_pct', 'comision_proveedor_pct', 'comision_pasarela_pct', 'comision_otra_pct', 'gasto_fijo_bs', 'modo', 'tasa', 'redondeo'],
    ['100 + 10 Diamantes', 'Free Fire', 0.66, 30, 0, 0, 0, 0, 'sobre costo', 'bcv', 10],
    ['Tarjeta Mensual', 'Free Fire', 6.5, 20, 2, 5, 0, 0, 'sobre venta', 'bcv', 10]
  ];

  /* ===== Alertas de brecha y de tasa (se evalúan mientras la página está abierta) ===== */
  function gapPct(bcv, par) { return bcv > 0 && par > 0 ? ((par - bcv) / bcv) * 100 : NaN; }
  /** settings: {gapEnabled,gapThresholdPct,rateEnabled,bcvAboveBs,lastSeenBcvDate}
   *  rates: {bcvUsd, binanceUsdt, bcvDate}; state: {gapDay, aboveDay} (qué ya se avisó hoy).
   *  Devuelve {alerts:[{type,message}], state, seen:{date,usd}|null} */
  function evaluateAlerts(settings, rates, state, now) {
    var s = settings || {};
    var st = Object.assign({ gapDay: '', aboveDay: '' }, state || {});
    var today = todayKey(now);
    var alerts = [];
    var seen = null;
    var gp = gapPct(toNum(rates.bcvUsd), toNum(rates.binanceUsdt));
    if (s.gapEnabled && isFinite(gp)) {
      if (gp > toNum(s.gapThresholdPct)) {
        if (st.gapDay !== today) {
          alerts.push({ type: 'gap', message: 'La brecha cambiaria está en ' + fmt1(gp) + '%, por encima de tu límite de ' + fmt1(toNum(s.gapThresholdPct)) + '%.' });
          st.gapDay = today;
        }
      } else if (st.gapDay) {
        st.gapDay = ''; // volvió a estar por debajo: podrá avisar de nuevo
      }
    }
    if (s.rateEnabled && rates.bcvDate) {
      if (s.lastSeenBcvDate && rates.bcvDate !== s.lastSeenBcvDate) {
        alerts.push({ type: 'rate', message: 'El BCV publicó la tasa nueva: Bs ' + fmt2(rates.bcvUsd) + ' por $, ' + vigenciaText(rates.bcvDate, now).toLowerCase() + '.' });
      }
      if (rates.bcvDate !== s.lastSeenBcvDate) seen = { date: rates.bcvDate, usd: round2(toNum(rates.bcvUsd)) };
      var lim = s.bcvAboveBs;
      if (typeof lim === 'number' && lim > 0 && toNum(rates.bcvUsd) >= lim && st.aboveDay !== today) {
        alerts.push({ type: 'above', message: 'El dólar BCV llegó a Bs ' + fmt2(rates.bcvUsd) + ' (tu aviso: Bs ' + fmt2(lim) + ' o más).' });
        st.aboveDay = today;
      }
    }
    return { alerts: alerts, state: st, seen: seen };
  }

  /* ===== Historial de tasas (30 días) y tasa de reposición ===== */
  /** official/parallel: [{fecha:'YYYY-MM-DD', promedio:number}] (formato DolarAPI). */
  function buildRateSeries(official, parallel, days, now) {
    var from = dayNumber(todayKey(now)) - (days || 30);
    function toMap(arr) {
      var m = {};
      (Array.isArray(arr) ? arr : []).forEach(function (r) {
        if (!r) return;
        var d = dayNumber(r.fecha), v = toNum(r.promedio);
        if (!isNaN(d) && v > 0) m[d] = v;
      });
      return m;
    }
    var mo = toMap(official), mp = toMap(parallel);
    var allDays = Object.keys(mo).concat(Object.keys(mp)).map(Number).filter(function (d) { return d >= from; });
    var uniq = {}; allDays.forEach(function (d) { uniq[d] = true; });
    var sorted = Object.keys(uniq).map(Number).sort(function (a, b) { return a - b; });
    var lastB = null, lastP = null;
    // arrastra el último valor conocido anterior a la ventana para no dejar huecos al inicio
    Object.keys(mo).map(Number).filter(function (d) { return d < from; }).sort(function (a, b) { return a - b; }).forEach(function (d) { lastB = mo[d]; });
    Object.keys(mp).map(Number).filter(function (d) { return d < from; }).sort(function (a, b) { return a - b; }).forEach(function (d) { lastP = mp[d]; });
    return sorted.map(function (d) {
      if (mo[d]) lastB = mo[d];
      if (mp[d]) lastP = mp[d];
      return { date: new Date(d * MS_DAY).toISOString().slice(0, 10), bcv: lastB, par: lastP, gapPct: lastB && lastP ? gapPct(lastB, lastP) : null };
    });
  }
  /** Tasa de reposición = la mayor entre el paralelo de hoy y su promedio de 7 días, más un colchón
   *  igual a la tendencia semanal al alza (máx. 3%). Es una guía, no una garantía. */
  function recommendedReplenishmentRate(series, bcvToday, parToday) {
    var pts = (series || []).filter(function (p) { return p.par > 0; });
    var parNow = toNum(parToday) > 0 ? toNum(parToday) : (pts.length ? pts[pts.length - 1].par : 0);
    if (!(parNow > 0)) return null;
    var last7 = pts.slice(-7);
    var avg7 = last7.length ? last7.reduce(function (a, p) { return a + p.par; }, 0) / last7.length : parNow;
    var ref = pts.length >= 8 ? pts[pts.length - 8].par : (pts.length ? pts[0].par : parNow);
    var trend = ref > 0 ? ((parNow - ref) / ref) * 100 : 0;
    var cushion = Math.min(3, Math.max(0, trend));
    var base = Math.max(parNow, avg7);
    var rate = round2(base * (1 + cushion / 100));
    return {
      rate: rate, parToday: round2(parNow), avg7: round2(avg7), trendPct: round2(trend), cushionPct: round2(cushion),
      gapPct: bcvToday > 0 ? round2(gapPct(bcvToday, parNow)) : null
    };
  }
  /** Rutas SVG (viewBox w×h) de dos series. */
  function chartPaths(series, w, h, pad) {
    var p = pad || 8;
    var vals = [];
    series.forEach(function (s) { if (s.bcv) vals.push(s.bcv); if (s.par) vals.push(s.par); });
    if (!series.length || !vals.length) return { bcv: '', par: '', min: 0, max: 0 };
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (max === min) { max += 1; min -= 1; }
    var n = series.length;
    function px(i) { return p + (n === 1 ? (w - 2 * p) / 2 : (i * (w - 2 * p)) / (n - 1)); }
    function py(v) { return p + (1 - (v - min) / (max - min)) * (h - 2 * p); }
    function path(key) {
      var d = '', pen = false;
      series.forEach(function (s, i) {
        if (!s[key]) { pen = false; return; }
        d += (pen ? 'L' : 'M') + px(i).toFixed(1) + ' ' + py(s[key]).toFixed(1) + ' ';
        pen = true;
      });
      return d.trim();
    }
    return { bcv: path('bcv'), par: path('par'), min: min, max: max };
  }

  /* ===== Lista de precios (datos comunes a imagen y PDF) ===== */
  /** rows: [{name, category, price (Bs)}]. Devuelve secciones ordenadas por categoría y nombre natural. */
  function layoutPriceList(rows) {
    var collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
    var by = {};
    (rows || []).forEach(function (r) {
      var cat = (r.category || '').trim() || 'Otros productos';
      (by[cat] || (by[cat] = [])).push(r);
    });
    var cats = Object.keys(by).sort(function (a, b) {
      if (a === 'Otros productos') return 1;
      if (b === 'Otros productos') return -1;
      return collator.compare(a, b);
    });
    return cats.map(function (c) {
      return { category: c, items: by[c].slice().sort(function (a, b) { return collator.compare(a.name, b.name); }) };
    });
  }

  var api = {
    ADMIN_EMAILS: ADMIN_EMAILS, isAdminEmail: isAdminEmail,
    FREE_LIMITS: FREE_LIMITS, PRO_HISTORY_READ_CAP: PRO_HISTORY_READ_CAP, PLANS: PLANS, TZ: TZ,
    fmt0: fmt0, fmt1: fmt1, fmt2: fmt2, round2: round2, toNum: toNum,
    dayKey: dayKey, todayKey: todayKey, dayNumber: dayNumber, shortDate: shortDate, vigenciaText: vigenciaText,
    subscriptionState: subscriptionState, msUntilExpiry: msUntilExpiry, computeEndDate: computeEndDate,
    planSavingsPct: planSavingsPct, annualSavingsPct: annualSavingsPct, planPrice: planPrice,
    canAddProduct: canAddProduct, historyCutoffIso: historyCutoffIso, applyHistoryPolicy: applyHistoryPolicy,
    buildBreakdown: buildBreakdown, marginTableRows: marginTableRows,
    entryProfit: entryProfit, buildPeriodReport: buildPeriodReport, buildProductReport: buildProductReport,
    buildRevaluation: buildRevaluation, parseBatch: parseBatch, computeBatch: computeBatch,
    parseNumberLoose: parseNumberLoose, parseCsv: parseCsv, rowsToProducts: rowsToProducts, IMPORT_TEMPLATE_ROWS: IMPORT_TEMPLATE_ROWS,
    evaluateAlerts: evaluateAlerts, gapPct: gapPct,
    buildRateSeries: buildRateSeries, recommendedReplenishmentRate: recommendedReplenishmentRate, chartPaths: chartPaths,
    layoutPriceList: layoutPriceList
  };
  root.ProCore = api;
})(typeof window !== 'undefined' ? window : globalThis);

