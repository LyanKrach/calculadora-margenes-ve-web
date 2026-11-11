(function(){
  var $ = function(id){ return document.getElementById(id); };
  var ids = ['producto','costoUsd','comProveedor','comPasarela','comOtra','gastoFijo','redondeo','precioActual'];

  function setTxt(id, val){ var el = $(id); if (el) el.textContent = val; }
  function setHtml(id, val){ var el = $(id); if (el) el.innerHTML = val; }
  function setVal(id, val){ var el = $(id); if (el) el.value = val; }

  /* Texto de vigencia de una tasa ("Vigente: Hoy (11 nov)" / "Mañana" / fecha).
     Una sola función para la calculadora y la pestaña Tasas; compara contra el día de Venezuela. */
  function formatEffDate(isoDate){
    if (!isoDate) return '';
    try {
      return window.ProCore ? window.ProCore.vigenciaText(isoDate) : 'Vigente: ' + String(isoDate).split('T')[0];
    } catch(e){
      return 'Vigente: ' + isoDate;
    }
  }
  function effDateKey(isoDate){
    return isoDate ? String(isoDate).split('T')[0] : '';
  }

  /* ===== TASAS AUTOMÁTICAS =====
     Fuente principal BCV: DolarVZLA CDN (rates.dolarvzla.com/bcv/current.json) - JSON público sin clave con CORS *, actualiza apenas publica el BCV.
     Respaldos BCV: BCV Today (bcv.today) -> DolarAPI oficial (USD y EUR).
     Paralelo / USDT: DolarAPI paralelo. */
  var RATES = {
    // Valores de arranque (sin conexión). La vigencia real llega con la tasa en vivo.
    bcv:     { label:'BCV · Dólar oficial',      value:901.62,   unit:'$',    fecha:'Tasa guardada (sin confirmar vigencia)', date:'' },
    binance: { label:'Binance · USDT (P2P)',     value:1077.97,  unit:'USDT', fecha:'Tasa guardada', date:'' },
    euro:    { label:'BCV · Euro oficial',       value:1007.96,  unit:'€',    fecha:'Tasa guardada (sin confirmar vigencia)', date:'' },
    custom:  { label:'Personalizada',            value:901.62,   unit:'$',    fecha:'', date:'' }
  };
  var rateSource = 'bcv';
  var fmtBs = new Intl.NumberFormat('es-VE',{minimumFractionDigits:2, maximumFractionDigits:2});
  var fmtBs0 = new Intl.NumberFormat('es-VE',{minimumFractionDigits:0, maximumFractionDigits:0});
  var fmtPct = new Intl.NumberFormat('es-VE',{minimumFractionDigits:1, maximumFractionDigits:1});

  /* ===== MODO DE MARGEN (onCost vs onSale) ===== */
  var marginMode = 'onCost';
  try {
    var savedMode = localStorage.getItem('cmv_margin_mode');
    if (savedMode === 'onSale' || savedMode === 'onCost') marginMode = savedMode;
  } catch(e){}

  function num(id, def){
    var el = $(id);
    if (!el) return def || 0;
    var v = parseFloat(String(el.value).replace(',','.'));
    return isNaN(v) || v < 0 ? (def||0) : v;
  }
  function toast(msg){
    var t = $('toast');
    if (!t) return;
    t.textContent = msg; t.classList.add('show');
    setTimeout(function(){ t.classList.remove('show'); }, 2200);
  }
  function copiar(texto, msg){
    function done(){ toast(msg); }
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(texto).then(done).catch(function(){ fallback(); });
    } else { fallback(); }
    function fallback(){
      var ta = document.createElement('textarea'); ta.value = texto; ta.style.position='fixed'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch(e){ toast('No se pudo copiar, selecciónalo a mano'); }
      document.body.removeChild(ta);
    }
  }
  function roundUp(v, step){ return step <= 1 ? v : Math.ceil(v / step) * step; }

  function computeSaleMetrics(opts) {
    var costUsd = opts.costUsd || 0;
    var rate = opts.rate || 0;
    var marginFrac = (opts.marginPercent || 0) / 100;
    var comFrac = opts.comFraction || 0;
    var gasto = opts.fixedExpenseBs || 0;
    var step = opts.roundStep != null ? opts.roundStep : 10;
    var mode = opts.mode || 'onCost';
    var costBs = costUsd * rate;

    if (rate <= 0 || costUsd <= 0) return { error: 'rate_or_cost' };
    var denom = (mode === 'onCost') ? (1 - comFrac) : (1 - comFrac - marginFrac);
    if (denom <= 0) return { error: mode === 'onCost' ? 'comm' : 'sum' };

    var precioExacto = (mode === 'onCost')
      ? ((costBs * (1 + marginFrac)) + gasto) / denom
      : (costBs + gasto) / denom;
    var precioFinal = roundUp(precioExacto, step);
    var comisionesBs = precioFinal * comFrac;
    var gananciaBs = precioFinal - costBs - gasto - comisionesBs;
    return {
      error: null,
      rate: rate,
      denom: denom,
      costBs: costBs,
      precioExacto: precioExacto,
      precioFinal: precioFinal,
      precioUsd: precioFinal / rate,
      comisionesBs: comisionesBs,
      gananciaBs: gananciaBs,
      gananciaUsd: gananciaBs / rate,
      margenRealSale: precioFinal > 0 ? (gananciaBs / precioFinal) * 100 : 0,
      margenRealCost: costBs > 0 ? (gananciaBs / costBs) * 100 : 0
    };
  }

  function mapFirestoreRateKey(name) {
    if (name === 'binanceUsdt') return 'binance';
    if (name === 'euroBcv') return 'euro';
    if (name === 'custom') return 'custom';
    return 'bcv';
  }

  function notifyRatesUpdated() {
    if (typeof window.__margenesOnRatesUpdated === 'function') {
      try { window.__margenesOnRatesUpdated(); } catch (e) {}
    }
  }

  var last = null;

  /* ===== LÓGICA DE TASAS ===== */
  function fmtRate(v){ return 'Bs ' + fmtBs.format(v); }
  function renderRates(){
    ['bcv','binance','euro','custom'].forEach(function(k){
      var el = $('rateVal-' + k);
      if (el) el.innerHTML = fmtRate(RATES[k].value) + ' <small>/ ' + RATES[k].unit + '</small>';
      var elSrc = $('rateSrc-' + k);
      if (elSrc) {
        if (k === 'bcv') elSrc.textContent = RATES.bcv.fecha || 'Oficial';
        else if (k === 'euro') elSrc.textContent = RATES.euro.fecha || 'Oficial EUR';
        else if (k === 'binance') elSrc.textContent = RATES.binance.fecha || 'Paralelo / USDT';
      }
    });
    // Pestaña "Tasas y Brecha": mismos datos y misma vigencia que las tarjetas de la calculadora.
    ['bcv','euro','binance'].forEach(function(k){
      setTxt('tasasVal-' + k, fmtRate(RATES[k].value) + ' / ' + RATES[k].unit);
      setTxt('tasasFecha-' + k, RATES[k].fecha || '—');
    });
    document.querySelectorAll('.rate-card').forEach(function(c){
      c.classList.toggle('active', c.getAttribute('data-rate') === rateSource);
    });
    var lbl = $('tasaFuenteLabel');
    if (lbl) lbl.textContent = rateSource === 'custom' ? 'Personalizada · escrita a mano' : RATES[rateSource].label + (RATES[rateSource].fecha ? ' · ' + RATES[rateSource].fecha : '');
    updateGapDisplay();
  }
  function updateGapDisplay(){
    var bcv = RATES.bcv.value;
    var binance = RATES.binance.value;
    var elPct = $('gapPct');
    var elDiff = $('gapDiff');
    if (!elPct || !elDiff || !bcv || !binance) return;
    var diff = binance - bcv;
    var pct = (diff / bcv) * 100;
    var sign = diff >= 0 ? '+' : '';
    elPct.textContent = sign + pct.toFixed(2).replace('.', ',') + '%';
    elDiff.textContent = 'Diferencia: ' + sign + 'Bs ' + fmtBs.format(diff) + ' por USD';
  }
  function setStatus(state, msg){
    var d = $('rateDot');
    if (d) d.className = 'dot' + (state === 'ok' ? ' ok' : state === 'err' ? ' err' : '');
    var s = $('rateStatus');
    if (s) s.textContent = msg;
  }
  function selectRate(key, fromUser){
    rateSource = key;
    var elTasa = $('tasa');
    if (key === 'custom'){
      RATES.custom.value = num('tasa') || RATES.custom.value;
    } else {
      if (elTasa) elTasa.value = RATES[key].value;
    }
    renderRates();
    calc();
    notifyRatesUpdated();
    if (fromUser && key !== 'custom') toast('Tasa activa: ' + RATES[key].label + ' — Bs ' + fmtBs.format(RATES[key].value));
  }
  function horaAhora(){
    try { return new Intl.DateTimeFormat('es-VE',{hour:'numeric',minute:'2-digit'}).format(new Date()); }
    catch(e){ return ''; }
  }
  function fetchJSON(url, opts){
    return fetch(url, opts || {}).then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  function refreshRates(){
    var btn = $('btnRefreshRates');
    if (btn) { btn.disabled = true; btn.textContent = 'Actualizando…'; }
    setStatus('', 'Buscando tasas en vivo…');
    var got = { bcv:false, euro:false, binance:false };
    var jobs = [];

    function applyRate(key, value, effIso, textOverride){
      if (!value || !(value > 0)) return;
      RATES[key].value = Math.round(value * 100) / 100;
      if (effIso) { RATES[key].date = effDateKey(effIso); RATES[key].fecha = textOverride || formatEffDate(effIso); }
      got[key] = true;
      if (rateSource === key) {
        var elTasa = $('tasa');
        if (elTasa) elTasa.value = RATES[key].value;
      }
    }

    // 1) BCV (Dólar y Euro) — Principal: DolarVZLA CDN JSON (rápido, sin clave, CORS *, vigencia oficial apenas publica BCV)
    //    Respaldo 1: BCV Today · Respaldo 2: DolarAPI oficial (USD y EUR)
    function fetchDolarApiFallback() {
      var tasks = [];
      if (!got.bcv) {
        tasks.push(
          fetchJSON('https://ve.dolarapi.com/v1/dolares/oficial')
            .then(function(d){
              if (!got.bcv && d && d.promedio){
                var eff = (d.fechaActualizacion || '').split('T')[0];
                applyRate('bcv', d.promedio, eff);
              }
            }).catch(function(){})
        );
      }
      if (!got.euro) {
        tasks.push(
          fetchJSON('https://ve.dolarapi.com/v1/euros/oficial')
            .then(function(d){
              if (!got.euro && d && d.promedio){
                var eff = (d.fechaActualizacion || '').split('T')[0];
                applyRate('euro', d.promedio, eff);
              }
            }).catch(function(){})
        );
      }
      return tasks.length ? Promise.all(tasks) : Promise.resolve();
    }

    function fetchBcvTodayFallback() {
      return fetchJSON('https://bcv.today/api/v1/rate.json')
        .then(function(d){
          if (d){
            var effDate = d.effective_date || d.date;
            if (!got.bcv && d.USD) applyRate('bcv', d.USD, effDate);
            if (!got.euro && d.EUR) applyRate('euro', d.EUR, effDate);
          }
          if (!got.bcv || !got.euro) return fetchDolarApiFallback();
        })
        .catch(fetchDolarApiFallback);
    }

    var bcvJob = fetchJSON('https://rates.dolarvzla.com/bcv/current.json')
      .then(function(d){
        var cur = d && d.current;
        var prev = d && d.previous;
        if (prev){
          if (prev.usd > 0) RATES.bcv.prevValue = Math.round(prev.usd * 100) / 100;
          if (prev.eur > 0) RATES.euro.prevValue = Math.round(prev.eur * 100) / 100;
        }
        if (cur){
          if (cur.usd) applyRate('bcv', cur.usd, cur.date);
          if (cur.eur) applyRate('euro', cur.eur, cur.date);
        }
        if (!got.bcv || !got.euro) return fetchBcvTodayFallback();
      })
      .catch(fetchBcvTodayFallback);
    jobs.push(bcvJob);

    // 2) Binance USDT — Paralelo vía DolarAPI
    jobs.push(
      fetchJSON('https://ve.dolarapi.com/v1/dolares/paralelo')
        .then(function(d){
          if (d && d.promedio) applyRate('binance', d.promedio, window.ProCore ? window.ProCore.todayKey() : new Date().toISOString().slice(0,10), 'Actualizado: Hoy');
        })
        .catch(function(){})
    );

    Promise.all(jobs).then(function(){
      if (btn) { btn.disabled = false; btn.textContent = '↻ Actualizar tasas'; }
      renderRates();
      try { calc(); } catch(e){ console.error('calc error:', e); }
      var n = (got.bcv?1:0) + (got.euro?1:0) + (got.binance?1:0);
      if (n === 3) setStatus('ok', 'Tasas en vivo · actualizadas hoy a las ' + horaAhora());
      else if (n > 0) setStatus('ok', 'Tasas actualizadas · ' + horaAhora());
      else setStatus('err', 'Sin conexión: se usan las tasas guardadas.');
      notifyRatesUpdated();
    }).catch(function(err){
      if (btn) { btn.disabled = false; btn.textContent = '↻ Actualizar tasas'; }
      setStatus('err', 'Sin conexión: se usan las tasas guardadas.');
    });
  }

  /* ===== SLIDER DE MARGEN & CHIPS ===== */
  function updateSliderFill(val){
    var r = $('margenRange');
    if (!r) return;
    var min = parseFloat(r.min) || 0;
    var max = parseFloat(r.max) || 60;
    var pct = Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
    r.style.background = 'linear-gradient(to right, #00e599 0%, #00e599 ' + pct + '%, #24352b ' + pct + '%, #24352b 100%)';
  }

  function syncMarginChips(val){
    document.querySelectorAll('#marginChips .chip').forEach(function(c){
      c.classList.toggle('active', parseFloat(c.getAttribute('data-margen')) === val);
    });
  }

  /* ===== GESTIÓN DE MODO DE MARGEN ===== */
  function setMarginMode(mode){
    if (mode !== 'onSale') mode = 'onCost';
    marginMode = mode;
    try { localStorage.setItem('cmv_margin_mode', mode); } catch(e){}
    var btnCost = $('btnModeCost');
    var btnSale = $('btnModeSale');
    if (btnCost) btnCost.classList.toggle('active', mode === 'onCost');
    if (btnSale) btnSale.classList.toggle('active', mode === 'onSale');
    var hint = $('modeFormulaHint');
    if (hint) {
      hint.textContent = mode === 'onCost'
        ? 'Markup directo: Precio = Costo × (1 + Margen) ÷ (1 − Comisiones)'
        : 'Margen comercial: Precio = Costo ÷ (1 − Comisiones − Margen)';
    }
    var heroF = $('heroFormula');
    if (heroF) {
      heroF.textContent = mode === 'onCost'
        ? 'Precio = (Costo Bs × (1 + Margen) + Gasto fijo) ÷ (1 − Comisiones)'
        : 'Precio = (Costo Bs + Gasto fijo) ÷ (1 − Comisiones − Margen)';
    }
    var heroSub = $('heroFormulaSub');
    if (heroSub) {
      heroSub.innerHTML = mode === 'onCost'
        ? 'El margen se calcula como <strong>porcentaje directo del costo</strong> (Markup).'
        : 'El margen se calcula <strong>sobre el precio de venta</strong> para no perder capital al reponer.';
    }
    var suffix = $('margenSuffix');
    if (suffix) {
      suffix.textContent = mode === 'onCost' ? '% sobre el costo' : '% sobre la venta';
    }
    calc();
  }
  window.getMarginMode = function(){ return marginMode; };
  window.setMarginMode = function(m){ setMarginMode(m); };
  // Ganchos para las funciones Pro (pro-ui.js): usan la MISMA fórmula y las MISMAS tasas de la calculadora.
  window.computeSaleMetrics = computeSaleMetrics;
  window.refreshRatesNow = function(){ return refreshRates(); };
  window.getRatesSnapshot = function(){
    return {
      bcvUsd: RATES.bcv.value,
      bcvPrevUsd: RATES.bcv.prevValue || 0,
      binanceUsdt: RATES.binance.value,
      euroBcv: RATES.euro.value,
      euroPrevBcv: RATES.euro.prevValue || 0,
      custom: RATES.custom.value,
      bcvDate: RATES.bcv.date || '',
      bcvFechaTxt: RATES.bcv.fecha || '',
      euroDate: RATES.euro.date || '',
      binanceFechaTxt: RATES.binance.fecha || '',
      fmtBs: function(v){ return fmtBs.format(v); }
    };
  };
  window.getCalculatorDefaults = function(){
    var comTotal = num('comProveedor') + num('comPasarela') + num('comOtra');
    var elR = $('redondeo');
    return {
      rateSource: rateSource,
      rate: num('tasa') || RATES.bcv.value,
      marginPercent: num('margen', 20),
      comFraction: comTotal / 100,
      fixedExpenseBs: num('gastoFijo', 0),
      roundStep: elR ? (parseFloat(elR.value) || 1) : 10,
      mode: marginMode
    };
  };
  window.selectRateSource = function(rateSourceName, customVal){
    var key = mapFirestoreRateKey(rateSourceName);
    if (key === 'custom' && customVal && customVal > 0) {
      RATES.custom.value = customVal;
      var elTasa = $('tasa');
      if (elTasa) elTasa.value = customVal;
    }
    selectRate(key, false);
  };
  window.calcProductMetrics = function(prod, overrideRateSourceName){
    var srcName = overrideRateSourceName || (prod && prod.rateSourceName) || 'bcvUsd';
    var key = mapFirestoreRateKey(srcName);
    var rate = (key === 'custom')
      ? ((prod && prod.customRateValue > 0) ? prod.customRateValue : (RATES.custom.value || RATES.bcv.value))
      : ((RATES[key] && RATES[key].value) || 0);
    var comFrac = ((prod && prod.commissionPlatform) || 0)
      + ((prod && prod.commissionPaymentMethod) || 0)
      + ((prod && prod.commissionOther) || 0);
    var m = computeSaleMetrics({
      costUsd: prod ? prod.costUsd : 0,
      rate: rate,
      marginPercent: prod ? prod.marginPercent : 0,
      comFraction: comFrac,
      fixedExpenseBs: prod ? prod.fixedExpenseBs : 0,
      roundStep: (prod && prod.roundStep != null) ? prod.roundStep : 10,
      mode: (prod && prod.marginMode) || 'onCost'
    });
    m.rateSourceName = srcName;
    return m;
  };

  /* ===== UNIFICACIÓN GUÍA EN PC & MÓVIL ===== */
  function syncGuideSlot(){
    var content = $('guideContent');
    var desktopSlot = $('desktopGuideSlot');
    var mobileSlot = $('mobileGuideSlot');
    if (!content || !desktopSlot || !mobileSlot) return;
    if (window.innerWidth > 960) {
      if (content.parentNode !== desktopSlot) {
        desktopSlot.appendChild(content);
      }
    } else {
      if (content.parentNode !== mobileSlot) {
        mobileSlot.appendChild(content);
      }
    }
  }
  window.addEventListener('resize', syncGuideSlot);

  /* ===== CÁLCULO PRINCIPAL ===== */
  function calc(){
    var elProducto = $('producto');
    var producto = (elProducto && elProducto.value.trim()) || 'Producto';
    var costoUsd = num('costoUsd');
    var tasa = num('tasa');
    var margen = num('margen');
    var comP = num('comProveedor'), comPa = num('comPasarela'), comO = num('comOtra');
    var comTotal = comP + comPa + comO;
    var gasto = num('gastoFijo');
    var elRedondeo = $('redondeo');
    var step = elRedondeo ? (parseFloat(elRedondeo.value) || 1) : 1;

    // Actualiza indicador grande, chips y barra deslizable
    setTxt('margenBig', fmtPct.format(margen).replace(',0',''));
    updateSliderFill(Math.min(60, Math.max(0, margen)));
    syncMarginChips(margen);
    setTxt('comTotalLabel', fmtPct.format(comTotal) + '%');
    setTxt('resProducto', producto);

    var comFraction = comTotal / 100;
    var alertBox = $('alertBox');
    var metrics = computeSaleMetrics({
      costUsd: costoUsd,
      rate: tasa,
      marginPercent: margen,
      comFraction: comFraction,
      fixedExpenseBs: gasto,
      roundStep: step,
      mode: marginMode
    });

    if (metrics.error) {
      if (alertBox) {
        alertBox.classList.add('show');
        alertBox.textContent = (metrics.error === 'comm')
          ? '⚠ Comisiones (' + fmtPct.format(comTotal) + '%) >= 100%. Baja las comisiones para poder calcular el precio.'
          : (metrics.error === 'sum')
            ? '⚠ Con ese margen y esas comisiones no hay precio que funcione: comisiones + margen suman 100% o más. Baja el margen o revisa las comisiones.'
            : '⚠ Escribe un costo y una tasa mayores a 0 para calcular.';
      }
      last = null;
      window.__margenesLast = null;
      return;
    }
    if (alertBox) alertBox.classList.remove('show');

    var costoBs = metrics.costBs;
    var precioExacto = metrics.precioExacto;
    var precioFinal = metrics.precioFinal;
    var precioUsd = metrics.precioUsd;
    var comisionesBs = metrics.comisionesBs;
    var gananciaBs = metrics.gananciaBs;
    var gananciaUsd = metrics.gananciaUsd;
    var margenRealSale = metrics.margenRealSale;
    var margenRealCost = metrics.margenRealCost;

    setTxt('precioFinal', fmtBs0.format(precioFinal));
    setTxt('precioExacto', 'Bs ' + fmtBs.format(precioExacto));
    setTxt('precioUsd', '$' + fmtBs.format(precioUsd));
    setTxt('roundedNote', step <= 1 ? 'Precio exacto, sin redondeo aplicado' : '↑ Precio exacto Bs ' + fmtBs.format(precioExacto) + ' → redondeado hacia arriba a Bs ' + fmtBs0.format(precioFinal));
    setTxt('gananciaBs', 'Bs ' + fmtBs.format(gananciaBs));

    if (marginMode === 'onCost') {
      setTxt('gananciaUsd', '$' + fmtBs.format(gananciaUsd) + ' por venta · margen s/costo ' + fmtPct.format(margenRealCost) + '% (s/venta: ' + fmtPct.format(margenRealSale) + '%)');
    } else {
      setTxt('gananciaUsd', '$' + fmtBs.format(gananciaUsd) + ' por venta · margen real ' + fmtPct.format(margenRealSale) + '%');
    }

    setTxt('comisionesBs', 'Bs ' + fmtBs.format(comisionesBs));
    setTxt('comisionesPct', fmtPct.format(comTotal) + '% del precio');
    setTxt('costoBsLabel', 'Bs ' + fmtBs.format(costoBs + gasto));
    setTxt('costoUsdLabel', '$' + fmtBs.format(costoUsd) + ' al proveedor' + (gasto>0 ? ' + gasto fijo' : ''));

    var pCosto = precioFinal>0 ? ((costoBs+gasto)/precioFinal)*100 : 0;
    var pCom = comTotal;
    var pGan = precioFinal>0 ? (gananciaBs/precioFinal)*100 : 0;

    var barC = $('barCosto'), barCm = $('barCom'), barG = $('barGan');
    if (barC) barC.style.width = Math.max(0,pCosto) + '%';
    if (barCm) barCm.style.width = Math.max(0,pCom) + '%';
    if (barG) barG.style.width = Math.max(0,pGan) + '%';

    setTxt('legCosto', fmtPct.format(pCosto) + '%');
    setTxt('legCom', fmtPct.format(pCom) + '%');
    setTxt('legGan', fmtPct.format(pGan) + '%');

    // Desglose paso a paso: cada paso usa la fórmula del modo elegido y sale de las MISMAS métricas
    // del resultado principal (así los números coinciden al centavo).
    var steps = window.ProCore.buildBreakdown({
      mode: marginMode, costUsd: costoUsd, rate: tasa, marginPercent: margen,
      comP: comP, comPa: comPa, comO: comO, gasto: gasto, roundStep: step
    }, metrics);
    steps.forEach(function(s, i){
      setTxt('step' + (i + 1) + 't', s.title);
      setTxt('step' + (i + 1) + 'f', s.formula);
      setTxt('step' + (i + 1) + 'r', s.result);
    });

    // Tabla comparativa "¿Y si cambias el margen?": reutiliza computeSaleMetrics (sin fórmulas duplicadas)
    var elTabla = $('tablaBody');
    if (elTabla){
      var tRows = window.ProCore.marginTableRows(margen, function(mg){
        return computeSaleMetrics({
          costUsd: costoUsd, rate: tasa, marginPercent: mg, comFraction: comFraction,
          fixedExpenseBs: gasto, roundStep: step, mode: marginMode
        });
      });
      var html = '';
      tRows.forEach(function(r){
        var cls = r.current ? ' class="current"' : '';
        html += '<tr'+cls+'><td>' + fmtPct.format(r.margin).replace(',0','') + '%</td><td>Bs ' + fmtBs0.format(r.precioFinal) + '</td><td>$' + fmtBs.format(r.precioUsd) + '</td><td>Bs ' + fmtBs.format(r.gananciaBs) + '</td></tr>';
      });
      elTabla.innerHTML = html;
    }

    // Calculadora inversa
    var precioActual = num('precioActual');
    var vBox = $('verdictBox');
    if (vBox){
      if (precioActual > 0){
        var comBsA = precioActual * comFraction;
        var ganA = precioActual - costoBs - gasto - comBsA;
        var margenRealA = (ganA / precioActual) * 100;
        var margenRealCostA = costoBs > 0 ? (ganA / costoBs) * 100 : 0;
        if (marginMode === 'onCost') {
          setTxt('verdictBig', 'Margen s/costo: ' + fmtPct.format(margenRealCostA) + '% (s/venta: ' + fmtPct.format(margenRealA) + '%)');
        } else {
          setTxt('verdictBig', 'Margen real: ' + fmtPct.format(margenRealA) + '%');
        }
        vBox.className = 'verdict ' + (ganA < 0 ? 'bad' : (margenRealA < 10 ? 'warn' : 'good'));
        if (ganA < 0){
          setTxt('verdictText', 'Estás PERDIENDO Bs ' + fmtBs.format(Math.abs(ganA)) + ' en cada venta ( $' + fmtBs.format(tasa>0 ? Math.abs(ganA)/tasa : 0) + ' ). Sube el precio al menos a Bs ' + fmtBs0.format(precioFinal) + ' para ganar el ' + fmtPct.format(margen) + '% que quieres.');
        } else if (margenRealA < 10){
          setTxt('verdictText', 'Ganas Bs ' + fmtBs.format(ganA) + ' por venta, pero el margen es muy bajo: cualquier subida de tasa o comisión te pone en pérdida. El precio sano para ti es Bs ' + fmtBs0.format(precioFinal) + '.');
        } else {
          setTxt('verdictText', 'Ganas Bs ' + fmtBs.format(ganA) + ' por venta ( $' + fmtBs.format(tasa>0 ? ganA/tasa : 0) + ' ). Margen sano. Compáralo con tu meta del ' + fmtPct.format(margen) + '%: el precio para esa meta es Bs ' + fmtBs0.format(precioFinal) + '.');
        }
      } else {
        vBox.className = 'verdict warn';
        setTxt('verdictBig', 'Margen real: —');
        setTxt('verdictText', 'Escribe un precio para ver tu margen real.');
      }
    }

    last = {
      producto: producto,
      costoUsd: costoUsd,
      tasa: tasa,
      margen: margen,
      marginMode: marginMode,
      comTotal: comTotal,
      comP: comP,
      comPa: comPa,
      comO: comO,
      gasto: gasto,
      costoBs: costoBs,
      precioExacto: precioExacto,
      precioFinal: precioFinal,
      precioUsd: precioUsd,
      comisionesBs: comisionesBs,
      gananciaBs: gananciaBs,
      gananciaUsd: gananciaUsd,
      margenReal: margenRealSale,
      margenRealCost: margenRealCost,
      denom: metrics.denom,
      steps: steps
    };
    window.__margenesLast = last; // gancho para auth.js (historial)
  }

  // Escucha inputs numéricos genéricos
  ids.forEach(function(id){
    var el = $(id);
    if (el) {
      el.addEventListener('input', calc);
      el.addEventListener('change', calc);
    }
  });

  // Slider de margen deslizable continuo (nunca se traba ni reinicia al arrastrar)
  var elRange = $('margenRange');
  var elMargen = $('margen');
  if (elRange) {
    elRange.addEventListener('input', function(){
      var val = parseFloat(this.value);
      if (isNaN(val)) return;
      if (elMargen) elMargen.value = val;
      setTxt('margenBig', fmtPct.format(val).replace(',0',''));
      updateSliderFill(val);
      syncMarginChips(val);
      calc();
    });
  }
  if (elMargen) {
    elMargen.addEventListener('input', function(){
      var val = parseFloat(this.value);
      if (!isNaN(val)) {
        if (elRange) elRange.value = Math.min(60, Math.max(0, val));
        setTxt('margenBig', fmtPct.format(val).replace(',0',''));
        updateSliderFill(Math.min(60, Math.max(0, val)));
        syncMarginChips(val);
      }
      calc();
    });
    elMargen.addEventListener('change', calc);
  }

  // Chips de margen rápido
  document.querySelectorAll('#marginChips .chip').forEach(function(c){
    c.addEventListener('click', function(){
      var val = parseFloat(c.getAttribute('data-margen'));
      if (!isNaN(val)) {
        if (elMargen) elMargen.value = val;
        if (elRange) elRange.value = val;
        setTxt('margenBig', fmtPct.format(val).replace(',0',''));
        updateSliderFill(val);
        syncMarginChips(val);
        calc();
      }
    });
  });

  // Botones de selección de modo de margen (Sobre costo vs Sobre venta)
  var btnModeCost = $('btnModeCost');
  if (btnModeCost) btnModeCost.addEventListener('click', function(){ setMarginMode('onCost'); });
  var btnModeSale = $('btnModeSale');
  if (btnModeSale) btnModeSale.addEventListener('click', function(){ setMarginMode('onSale'); });

  // Tasa: tarjetas de fuente + edición manual
  document.querySelectorAll('.rate-card').forEach(function(c){
    c.addEventListener('click', function(){ selectRate(c.getAttribute('data-rate'), true); });
  });

  var elTasa = $('tasa');
  if (elTasa) {
    elTasa.addEventListener('input', function(){
      RATES.custom.value = num('tasa');
      if (rateSource !== 'custom'){ rateSource = 'custom'; }
      renderRates(); calc();
    });
    elTasa.addEventListener('change', calc);
  }

  var btnRef = $('btnRefreshRates');
  if (btnRef) btnRef.addEventListener('click', refreshRates);

  // Botones de acción y portapapeles
  var bcp = $('btnCopiarPrecio');
  if (bcp) bcp.addEventListener('click', function(){
    if(!last) return;
    copiar('Bs ' + fmtBs0.format(last.precioFinal) + ' ($' + fmtBs.format(last.precioUsd) + ')', 'Precio copiado: Bs ' + fmtBs0.format(last.precioFinal));
    if (window.__margenesOnCopyPrice) window.__margenesOnCopyPrice(); // guardado automático en el historial
  });

  var bcm = $('btnCopiarMensaje');
  if (bcm) bcm.addEventListener('click', function(){
    if(!last) return;
    var txt = last.producto + '\nPrecio: Bs ' + fmtBs0.format(last.precioFinal) + ' ($' + fmtBs.format(last.precioUsd) + ')\nTasa: Bs ' + fmtBs.format(last.tasa) + ' por $1\nPago Móvil disponible. Entrega inmediata.';
    copiar(txt, 'Mensaje para el cliente copiado');
  });

  var bcd = $('btnCopiarDesglose');
  if (bcd) bcd.addEventListener('click', function(){
    if(!last) return;
    // El texto sale de los mismos pasos que se ven en pantalla (mismos números del resultado principal).
    var modeTxt = last.marginMode === 'onCost' ? 'Sobre costo / Markup' : 'Sobre venta / Margen';
    var txt = 'DESGLOSE (' + modeTxt + ') — ' + last.producto + '\n';
    (last.steps || []).forEach(function(s, i){
      txt += (i + 1) + ') ' + s.title + ': ' + s.formula + ' = ' + s.result.replace(/^= /, '') + '\n';
    });
    txt += 'Precio a cobrar: Bs ' + fmtBs0.format(last.precioFinal) + ' ($' + fmtBs.format(last.precioUsd) + ')';
    copiar(txt, 'Desglose completo copiado');
  });

  /* ===== DASHBOARD TABS ===== */
  function setDashboardTab(tabId) {
    if (!tabId || tabId === 'planes') tabId = tabId === 'planes' ? 'pro' : 'calc';
    if (tabId === 'guia' && window.innerWidth > 960) {
      setDashboardTab('calc');
      var elSlot = $('desktopGuideSlot');
      if (elSlot) elSlot.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    var view = $('tabView-' + tabId);
    if (!view) tabId = 'calc';
    document.querySelectorAll('.dash-tab').forEach(function(b){
      b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
    });
    document.querySelectorAll('.dash-view').forEach(function(v){
      v.classList.toggle('active', v.id === 'tabView-' + tabId);
    });
    if (tabId === 'tasas') updateGapDisplay();
    if (typeof window.__margenesOnTabChange === 'function') {
      try { window.__margenesOnTabChange(tabId); } catch (e) {}
    }
  }
  window.setDashboardTab = setDashboardTab;

  document.querySelectorAll('.dash-tab').forEach(function(btn){
    btn.addEventListener('click', function(){
      var tid = btn.getAttribute('data-tab');
      setDashboardTab(tid);
    });
  });

  // Inicialización
  syncGuideSlot();
  setMarginMode(marginMode);
  renderRates();
  refreshRates();
  try {
    var hTab = (typeof location !== 'undefined' && location.hash) ? location.hash.replace('#', '').toLowerCase() : '';
    if (hTab && $('tabView-' + (hTab === 'planes' ? 'pro' : hTab))) setDashboardTab(hTab);
  } catch (e) {}
})();