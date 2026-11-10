(function(){
  var $ = function(id){ return document.getElementById(id); };
  var ids = ['producto','costoUsd','comProveedor','comPasarela','comOtra','gastoFijo','redondeo','precioActual'];

  function setTxt(id, val){ var el = $(id); if (el) el.textContent = val; }
  function setHtml(id, val){ var el = $(id); if (el) el.innerHTML = val; }
  function setVal(id, val){ var el = $(id); if (el) el.value = val; }

  function formatEffDate(isoDate){
    if (!isoDate) return '';
    try {
      var clean = String(isoDate).split('T')[0];
      var parts = clean.split('-');
      if (parts.length !== 3) return 'Vigente: ' + isoDate;
      var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10), d = parseInt(parts[2], 10);
      var target = new Date(y, m - 1, d);
      var now = new Date();
      var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      var diffDays = Math.round((target - today) / (1000 * 60 * 60 * 24));
      var meses = ['','ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
      var mesTxt = meses[m] || m;
      if (diffDays === 0) return 'Vigente: Hoy (' + d + ' ' + mesTxt + ')';
      if (diffDays === 1) return 'Vigente: Mañana (' + d + ' ' + mesTxt + ')';
      return 'Vigente: ' + d + ' ' + mesTxt;
    } catch(e){
      return 'Vigente: ' + isoDate;
    }
  }

  /* ===== TASAS AUTOMÁTICAS =====
     Fuente principal BCV: BCV Today (bcv.today) - JSON público en vivo con vigencia oficial del BCV.
     Respaldo BCV: DolarAPI oficial (USD y EUR).
     Paralelo / USDT: DolarAPI paralelo. */
  var RATES = {
    bcv:     { label:'BCV · Dólar oficial',      value:899.27,   unit:'$',    fecha:'Vigente: Hoy (10 nov)' },
    binance: { label:'Binance · USDT (P2P)',     value:1077.97,  unit:'USDT', fecha:'Hoy' },
    euro:    { label:'BCV · Euro oficial',       value:1006.61,  unit:'€',    fecha:'Vigente: Hoy (10 nov)' },
    custom:  { label:'Personalizada',            value:899.27,   unit:'$',    fecha:'' }
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
      }
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

    function applyRate(key, value, fechaTxt){
      if (!value || !(value > 0)) return;
      RATES[key].value = Math.round(value * 100) / 100;
      if (fechaTxt) RATES[key].fecha = fechaTxt;
      got[key] = true;
      if (rateSource === key) {
        var elTasa = $('tasa');
        if (elTasa) elTasa.value = RATES[key].value;
      }
    }

    // 1) BCV (Dólar y Euro) — Principal: BCV Today (rápido, vigencia oficial, sin clave)
    //    Respaldo: DolarAPI oficial (USD y EUR)
    var bcvJob = fetchJSON('https://bcv.today/api/v1/rate.json')
      .then(function(d){
        if (d){
          var effDate = d.effective_date || d.date;
          var vigTxt = formatEffDate(effDate);
          if (d.USD) applyRate('bcv', d.USD, vigTxt);
          if (d.EUR) applyRate('euro', d.EUR, vigTxt);
        }
      })
      .catch(function(){
        // Respaldo DolarAPI
        return Promise.all([
          fetchJSON('https://ve.dolarapi.com/v1/dolares/oficial')
            .then(function(d){
              if (!got.bcv && d && d.promedio){
                var eff = (d.fechaActualizacion || '').split('T')[0];
                applyRate('bcv', d.promedio, formatEffDate(eff));
              }
            }).catch(function(){}),
          fetchJSON('https://ve.dolarapi.com/v1/euros/oficial')
            .then(function(d){
              if (!got.euro && d && d.promedio){
                var eff = (d.fechaActualizacion || '').split('T')[0];
                applyRate('euro', d.promedio, formatEffDate(eff));
              }
            }).catch(function(){})
        ]);
      });
    jobs.push(bcvJob);

    // 2) Binance USDT — Paralelo vía DolarAPI
    jobs.push(
      fetchJSON('https://ve.dolarapi.com/v1/dolares/paralelo')
        .then(function(d){
          if (d && d.promedio) applyRate('binance', d.promedio, 'Hoy');
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

    var costoBs = costoUsd * tasa;
    var comFraction = comTotal / 100;
    var margenFraction = margen / 100;
    var denom;
    var precioExacto;
    var alertBox = $('alertBox');

    if (marginMode === 'onCost') {
      denom = 1 - comFraction;
      if (denom <= 0 || tasa <= 0) {
        if (alertBox) {
          alertBox.classList.add('show');
          alertBox.textContent = '⚠ Comisiones (' + fmtPct.format(comTotal) + '%) >= 100%. Baja las comisiones para poder calcular el precio.';
        }
        last = null;
        window.__margenesLast = null;
        return;
      }
      if (alertBox) alertBox.classList.remove('show');
      precioExacto = ((costoBs * (1 + margenFraction)) + gasto) / denom;
    } else {
      denom = 1 - comFraction - margenFraction;
      if (denom <= 0 || tasa <= 0) {
        if (alertBox) {
          alertBox.classList.add('show');
          alertBox.textContent = '⚠ Con ese margen y esas comisiones no hay precio que funcione: comisiones + margen suman 100% o más. Baja el margen o revisa las comisiones.';
        }
        last = null;
        window.__margenesLast = null;
        return;
      }
      if (alertBox) alertBox.classList.remove('show');
      precioExacto = (costoBs + gasto) / denom;
    }

    var precioFinal = roundUp(precioExacto, step);
    var precioUsd = tasa > 0 ? precioFinal / tasa : 0;
    var comisionesBs = precioFinal * comFraction;
    var gananciaBs = precioFinal - costoBs - gasto - comisionesBs;
    var gananciaUsd = tasa > 0 ? gananciaBs / tasa : 0;
    var margenRealSale = precioFinal > 0 ? (gananciaBs / precioFinal) * 100 : 0;
    var margenRealCost = costoBs > 0 ? (gananciaBs / costoBs) * 100 : 0;

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

    // Desglose paso a paso
    setTxt('step1f', '$' + fmtBs.format(costoUsd) + ' × ' + fmtBs.format(tasa) + ' Bs/$');
    setTxt('step1r', 'Bs ' + fmtBs.format(costoBs));
    setTxt('step2f', fmtPct.format(comP) + '% + ' + fmtPct.format(comPa) + '% + ' + fmtPct.format(comO) + '%');
    setTxt('step2r', fmtPct.format(comTotal) + '% en comisiones');

    if (marginMode === 'onCost') {
      setTxt('step3f', '100% − Comisiones (divisor pasarela)');
      setTxt('step3r', '1 − ' + comFraction.toFixed(2).replace('.',',') + ' = ' + denom.toFixed(2).replace('.',','));
      setTxt('step4f', '(Bs ' + fmtBs.format(costoBs) + ' × (1 + ' + margenFraction.toFixed(2).replace('.',',') + ') + Bs ' + fmtBs.format(gasto) + ') ÷ ' + denom.toFixed(2).replace('.',','));
      setTxt('step4r', 'Bs ' + fmtBs.format(precioExacto));
      setTxt('step5r', 'Ganancia: Bs ' + fmtBs.format(gananciaBs) + ' (s/costo ' + fmtPct.format(margenRealCost) + '%)');
    } else {
      setTxt('step3f', '100% − Comisiones − Margen');
      setTxt('step3r', '1 − ' + comFraction.toFixed(2).replace('.',',') + ' − ' + margenFraction.toFixed(2).replace('.',',') + ' = ' + denom.toFixed(2).replace('.',','));
      setTxt('step4f', '(Bs ' + fmtBs.format(costoBs + gasto) + ') ÷ ' + denom.toFixed(2).replace('.',','));
      setTxt('step4r', 'Bs ' + fmtBs.format(precioExacto));
      setTxt('step5r', 'Ganancia: Bs ' + fmtBs.format(gananciaBs) + ' (' + fmtPct.format(margenRealSale) + '%)');
    }

    // Tabla comparativa
    var elTabla = $('tablaBody');
    if (elTabla){
      var margins = [10,15,20,25,30,35,40];
      var html = '';
      margins.forEach(function(m){
        var mFrac = m / 100;
        var pEx;
        if (marginMode === 'onCost') {
          pEx = ((costoBs * (1 + mFrac)) + gasto) / denom;
        } else {
          var d = 1 - comFraction - mFrac;
          if (d <= 0) return;
          pEx = (costoBs + gasto) / d;
        }
        var p = roundUp(pEx, step);
        var g = p - costoBs - gasto - p * comFraction;
        var cls = (m === margen) ? ' class="current"' : '';
        html += '<tr'+cls+'><td>' + m + '%</td><td>Bs ' + fmtBs0.format(p) + '</td><td>$' + fmtBs.format(tasa>0 ? p/tasa : 0) + '</td><td>Bs ' + fmtBs.format(g) + '</td></tr>';
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
      denom: denom
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
    var txt;
    if (last.marginMode === 'onCost') {
      txt = 'DESGLOSE (Sobre costo / Markup) — ' + last.producto + '\n'
        + '1) Costo en Bs: $' + fmtBs.format(last.costoUsd) + ' × ' + fmtBs.format(last.tasa) + ' = Bs ' + fmtBs.format(last.costoBs) + '\n'
        + '2) Comisiones: ' + fmtPct.format(last.comTotal) + '% (' + fmtPct.format(last.comP) + '% proveedor + ' + fmtPct.format(last.comPa) + '% pasarela + ' + fmtPct.format(last.comO) + '% otra)\n'
        + '3) Markup s/costo: ' + fmtPct.format(last.margen) + '% -> Costo con margen: Bs ' + fmtBs.format(last.costoBs * (1 + last.margen/100)) + '\n'
        + '4) Precio exacto: (Costo con margen + Gasto) ÷ (1 − Comisiones) = Bs ' + fmtBs.format(last.precioExacto) + '\n'
        + '5) Precio a cobrar: Bs ' + fmtBs0.format(last.precioFinal) + ' ($' + fmtBs.format(last.precioUsd) + ')\n'
        + 'Ganancia neta: Bs ' + fmtBs.format(last.gananciaBs) + ' ($' + fmtBs.format(last.gananciaUsd) + ') · Margen s/costo: ' + fmtPct.format(last.margenRealCost) + '% (s/venta: ' + fmtPct.format(last.margenReal) + '%)';
    } else {
      txt = 'DESGLOSE (Sobre venta / Comercial) — ' + last.producto + '\n'
        + '1) Costo en Bs: $' + fmtBs.format(last.costoUsd) + ' × ' + fmtBs.format(last.tasa) + ' = Bs ' + fmtBs.format(last.costoBs) + '\n'
        + '2) Comisiones totales: ' + fmtPct.format(last.comTotal) + '% (' + fmtPct.format(last.comP) + '% proveedor + ' + fmtPct.format(last.comPa) + '% pasarela + ' + fmtPct.format(last.comO) + '% otra)\n'
        + '3) Denominador: 1 − ' + fmtPct.format(last.comTotal) + '% − ' + fmtPct.format(last.margen) + '% = ' + last.denom.toFixed(2).replace('.',',') + '\n'
        + '4) Precio exacto: (Bs ' + fmtBs.format(last.costoBs + last.gasto) + ') ÷ ' + last.denom.toFixed(2).replace('.',',') + ' = Bs ' + fmtBs.format(last.precioExacto) + '\n'
        + '5) Precio a cobrar (redondeado hacia arriba): Bs ' + fmtBs0.format(last.precioFinal) + ' ($' + fmtBs.format(last.precioUsd) + ')\n'
        + 'Ganancia neta: Bs ' + fmtBs.format(last.gananciaBs) + ' ($' + fmtBs.format(last.gananciaUsd) + ') · Margen real: ' + fmtPct.format(last.margenReal) + '%';
    }
    copiar(txt, 'Desglose completo copiado');
  });

  /* ===== DASHBOARD TABS ===== */
  function setDashboardTab(tabId) {
    if (!tabId) tabId = 'calc';
    if (tabId === 'guia' && window.innerWidth > 960) {
      setDashboardTab('calc');
      var elSlot = $('desktopGuideSlot');
      if (elSlot) elSlot.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    document.querySelectorAll('.dash-tab').forEach(function(b){
      b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
    });
    document.querySelectorAll('.dash-view').forEach(function(v){
      v.classList.toggle('active', v.id === 'tabView-' + tabId);
    });
    if (tabId === 'tasas') updateGapDisplay();
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
})();
