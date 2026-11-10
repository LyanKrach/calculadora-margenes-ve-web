(function(){
  var $ = function(id){ return document.getElementById(id); };
  var ids = ['producto','costoUsd','margen','margenRange','comProveedor','comPasarela','comOtra','gastoFijo','redondeo','precioActual'];

  /* ===== TASAS AUTOMÁTICAS =====
     Respaldo guardado: tasas reales consultadas el 09/11/2026, 2:25 p. m. (hora de Caracas).
     BCV dólar y euro BCV: DolarAPI (fuente oficial BCV). Binance USDT: P2P USDT/VES. */
  var RATES = {
    bcv:     { label:'BCV · Dólar oficial',      value:897.54,   unit:'$',    fecha:'09/11/2026' },
    binance: { label:'Binance · USDT (P2P)',     value:1045.00,  unit:'USDT', fecha:'09/11/2026' },
    euro:    { label:'BCV · Euro oficial',       value:1001.19,  unit:'€',    fecha:'09/11/2026' },
    custom:  { label:'Personalizada',            value:100,      unit:'$',    fecha:'' }
  };
  var rateSource = 'custom';
  var fmtBs = new Intl.NumberFormat('es-VE',{minimumFractionDigits:2, maximumFractionDigits:2});
  var fmtBs0 = new Intl.NumberFormat('es-VE',{minimumFractionDigits:0, maximumFractionDigits:0});
  var fmtPct = new Intl.NumberFormat('es-VE',{minimumFractionDigits:1, maximumFractionDigits:1});

  function num(id, def){
    var v = parseFloat(String($(id).value).replace(',','.'));
    return isNaN(v) || v < 0 ? (def||0) : v;
  }
  function toast(msg){
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
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
    });
    document.querySelectorAll('.rate-card').forEach(function(c){
      c.classList.toggle('active', c.getAttribute('data-rate') === rateSource);
    });
    var lbl = $('tasaFuenteLabel');
    if (lbl) lbl.textContent = rateSource === 'custom' ? 'Personalizada · escrita a mano' : RATES[rateSource].label + (RATES[rateSource].fecha ? ' · ' + RATES[rateSource].fecha : '');
  }
  function setStatus(state, msg){
    var d = $('rateDot');
    d.className = 'dot' + (state === 'ok' ? ' ok' : state === 'err' ? ' err' : '');
    $('rateStatus').textContent = msg;
  }
  function selectRate(key, fromUser){
    rateSource = key;
    if (key === 'custom'){ RATES.custom.value = num('tasa') || RATES.custom.value; }
    else { $('tasa').value = RATES[key].value; }
    renderRates();
    calc();
    if (fromUser && key !== 'custom') toast('Tasa activa: ' + RATES[key].label + ' — Bs ' + fmtBs.format(RATES[key].value));
  }
  function horaAhora(){
    try { return new Intl.DateTimeFormat('es-VE',{hour:'numeric',minute:'2-digit'}).format(new Date()); }
    catch(e){ return ''; }
  }
  function findRateIn(obj, patterns, depth){
    if (!obj || typeof obj !== 'object' || depth > 5) return null;
    for (var k in obj){
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k], lk = String(k).toLowerCase();
      if (typeof v === 'number' && v > 10 && v < 1000000){
        for (var i = 0; i < patterns.length; i++){ if (lk.indexOf(patterns[i]) !== -1) return v; }
      }
    }
    for (var k2 in obj){
      if (!Object.prototype.hasOwnProperty.call(obj, k2)) continue;
      var r = findRateIn(obj[k2], patterns, depth + 1);
      if (r !== null) return r;
    }
    return null;
  }
  function fetchJSON(url, opts){
    return fetch(url, opts || {}).then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function median(arr){ var s = arr.slice().sort(function(a,b){ return a-b; }); return s[Math.floor(s.length/2)]; }

  function refreshRates(){
    var btn = $('btnRefreshRates');
    btn.disabled = true; btn.textContent = 'Actualizando…';
    setStatus('', 'Buscando tasas en vivo…');
    var got = { bcv:false, euro:false, binance:false };
    var jobs = [];

    function applyRate(key, value, fechaTxt){
      if (!value || !(value > 0)) return;
      RATES[key].value = Math.round(value * 100) / 100;
      if (fechaTxt) RATES[key].fecha = fechaTxt;
      got[key] = true;
      if (rateSource === key) $('tasa').value = RATES[key].value;
    }

    jobs.push(fetchJSON('https://ve.dolarapi.com/v1/dolares/oficial')
      .then(function(d){ if (!got.bcv) applyRate('bcv', d && d.promedio, 'Hoy'); })
      .catch(function(){}));
    jobs.push(fetchJSON('https://ve.dolarapi.com/v1/euros/oficial')
      .then(function(d){ if (!got.euro) applyRate('euro', d && d.promedio, 'Hoy'); })
      .catch(function(){}));
    jobs.push(fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ fiat:'VES', page:1, rows:10, tradeType:'BUY', asset:'USDT', countries:[], proMerchantAds:false, shieldMerchantAds:false, filterType:'all', periods:[], additionalKycVerifyFilter:0, publisherType:null, payTypes:[], classifies:['mass','profession','fiat_trade'] })
      }).then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(d){
        var prices = ((d && d.data) || []).map(function(x){ return parseFloat(x && x.adv && x.adv.price); }).filter(function(p){ return p > 0; });
        if (prices.length >= 3) applyRate('binance', median(prices), 'Hoy');
      }).catch(function(){}));

    Promise.all(jobs).then(function(){
      btn.disabled = false; btn.textContent = '↻ Actualizar tasas';
      renderRates(); calc();
      var n = (got.bcv?1:0) + (got.euro?1:0) + (got.binance?1:0);
      if (n === 3) setStatus('ok', 'Tasas en vivo · actualizadas hoy a las ' + horaAhora());
      else if (n > 0) setStatus('ok', 'Tasas actualizadas · ' + horaAhora());
      else setStatus('err', 'Sin conexión: se usan las tasas guardadas.');
    });
  }

  function calc(){
    var producto = $('producto').value.trim() || 'Producto';
    var costoUsd = num('costoUsd');
    var tasa = num('tasa');
    var margen = num('margen');
    var comP = num('comProveedor'), comPa = num('comPasarela'), comO = num('comOtra');
    var comTotal = comP + comPa + comO;
    var gasto = num('gastoFijo');
    var step = parseFloat($('redondeo').value) || 1;

    // Sync slider + chips
    $('margenRange').value = Math.min(60, Math.max(0, margen));
    $('margenBig').textContent = fmtPct.format(margen).replace(',0','');
    document.querySelectorAll('#marginChips .chip').forEach(function(c){
      c.classList.toggle('active', parseFloat(c.getAttribute('data-margen')) === margen);
    });
    $('comTotalLabel').textContent = fmtPct.format(comTotal) + '%';
    $('resProducto').textContent = producto;

    var costoBs = costoUsd * tasa;
    var denom = 1 - comTotal/100 - margen/100;
    var alertBox = $('alertBox');

    if (denom <= 0 || tasa <= 0){
      alertBox.classList.add('show');
      last = null;
      window.__margenesLast = null; // gancho para auth.js (historial)
      return;
    }
    alertBox.classList.remove('show');

    var precioExacto = (costoBs + gasto) / denom;
    var precioFinal = roundUp(precioExacto, step);
    var precioUsd = tasa > 0 ? precioFinal / tasa : 0;
    var comisionesBs = precioFinal * (comTotal/100);
    var gananciaBs = precioFinal - costoBs - gasto - comisionesBs;
    var gananciaUsd = tasa > 0 ? gananciaBs / tasa : 0;
    var margenReal = precioFinal > 0 ? (gananciaBs / precioFinal) * 100 : 0;

    $('precioFinal').textContent = fmtBs0.format(precioFinal);
    $('precioExacto').textContent = 'Bs ' + fmtBs.format(precioExacto);
    $('precioUsd').textContent = '$' + fmtBs.format(precioUsd);
    $('roundedNote').textContent = step <= 1 ? 'Precio exacto, sin redondeo aplicado' : '↑ Precio exacto Bs ' + fmtBs.format(precioExacto) + ' → redondeado hacia arriba a Bs ' + fmtBs0.format(precioFinal);
    $('gananciaBs').textContent = 'Bs ' + fmtBs.format(gananciaBs);
    $('gananciaUsd').textContent = '$' + fmtBs.format(gananciaUsd) + ' por venta · margen real ' + fmtPct.format(margenReal) + '%';
    $('comisionesBs').textContent = 'Bs ' + fmtBs.format(comisionesBs);
    $('comisionesPct').textContent = fmtPct.format(comTotal) + '% del precio';
    $('costoBsLabel').textContent = 'Bs ' + fmtBs.format(costoBs + gasto);
    $('costoUsdLabel').textContent = '$' + fmtBs.format(costoUsd) + ' al proveedor' + (gasto>0 ? ' + gasto fijo' : '');

    var pCosto = precioFinal>0 ? ((costoBs+gasto)/precioFinal)*100 : 0;
    var pCom = comTotal;
    var pGan = precioFinal>0 ? (gananciaBs/precioFinal)*100 : 0;
    $('barCosto').style.width = Math.max(0,pCosto) + '%';
    $('barCom').style.width = Math.max(0,pCom) + '%';
    $('barGan').style.width = Math.max(0,pGan) + '%';
    $('legCosto').textContent = fmtPct.format(pCosto) + '%';
    $('legCom').textContent = fmtPct.format(pCom) + '%';
    $('legGan').textContent = fmtPct.format(pGan) + '%';

    // Steps
    $('step1f').textContent = '$' + fmtBs.format(costoUsd) + ' × ' + fmtBs.format(tasa) + ' Bs/$';
    $('step1r').textContent = 'Bs ' + fmtBs.format(costoBs);
    $('step2f').textContent = fmtPct.format(comP) + '% + ' + fmtPct.format(comPa) + '% + ' + fmtPct.format(comO) + '%';
    $('step2r').textContent = fmtPct.format(comTotal) + '% en comisiones';
    $('step3r').textContent = '1 − ' + (comTotal/100).toFixed(2).replace('.',',') + ' − ' + (margen/100).toFixed(2).replace('.',',') + ' = ' + denom.toFixed(2).replace('.',',');
    $('step4f').textContent = '(Bs ' + fmtBs.format(costoBs + gasto) + ') ÷ ' + denom.toFixed(2).replace('.',',');
    $('step4r').textContent = 'Bs ' + fmtBs.format(precioExacto);
    $('step5r').textContent = 'Ganancia: Bs ' + fmtBs.format(gananciaBs) + ' (' + fmtPct.format(margenReal) + '%)';

    // Table
    var margins = [10,15,20,25,30,35,40];
    var html = '';
    margins.forEach(function(m){
      var d = 1 - comTotal/100 - m/100;
      if (d <= 0){ return; }
      var p = roundUp((costoBs + gasto) / d, step);
      var g = p - costoBs - gasto - p*(comTotal/100);
      var cls = (m === margen) ? ' class="current"' : '';
      html += '<tr'+cls+'><td>' + m + '%</td><td>Bs ' + fmtBs0.format(p) + '</td><td>$' + fmtBs.format(tasa>0 ? p/tasa : 0) + '</td><td>Bs ' + fmtBs.format(g) + '</td></tr>';
    });
    $('tablaBody').innerHTML = html;

    // Reverse
    var precioActual = num('precioActual');
    var vBox = $('verdictBox');
    if (precioActual > 0){
      var comBsA = precioActual * (comTotal/100);
      var ganA = precioActual - costoBs - gasto - comBsA;
      var margenA = (ganA / precioActual) * 100;
      $('verdictBig').textContent = 'Margen real: ' + fmtPct.format(margenA) + '%';
      vBox.className = 'verdict ' + (ganA < 0 ? 'bad' : (margenA < 10 ? 'warn' : 'good'));
      if (ganA < 0){
        $('verdictText').textContent = 'Estás PERDIENDO Bs ' + fmtBs.format(Math.abs(ganA)) + ' en cada venta ( $' + fmtBs.format(tasa>0 ? Math.abs(ganA)/tasa : 0) + ' ). Sube el precio al menos a Bs ' + fmtBs0.format(precioFinal) + ' para ganar el ' + fmtPct.format(margen) + '% que quieres.';
      } else if (margenA < 10){
        $('verdictText').textContent = 'Ganas Bs ' + fmtBs.format(ganA) + ' por venta, pero el margen es muy bajo: cualquier subida de tasa o comisión te pone en pérdida. El precio sano para ti es Bs ' + fmtBs0.format(precioFinal) + '.';
      } else {
        $('verdictText').textContent = 'Ganas Bs ' + fmtBs.format(ganA) + ' por venta ( $' + fmtBs.format(tasa>0 ? ganA/tasa : 0) + ' ). Margen sano. Compáralo con tu meta del ' + fmtPct.format(margen) + '%: el precio para esa meta es Bs ' + fmtBs0.format(precioFinal) + '.';
      }
    } else {
      vBox.className = 'verdict warn';
      $('verdictBig').textContent = 'Margen real: —';
      $('verdictText').textContent = 'Escribe un precio para ver tu margen real.';
    }

    last = { producto:producto, costoUsd:costoUsd, tasa:tasa, margen:margen, comTotal:comTotal, comP:comP, comPa:comPa, comO:comO, gasto:gasto, costoBs:costoBs, precioExacto:precioExacto, precioFinal:precioFinal, precioUsd:precioUsd, comisionesBs:comisionesBs, gananciaBs:gananciaBs, gananciaUsd:gananciaUsd, margenReal:margenReal, denom:denom };
    window.__margenesLast = last; // gancho para auth.js (historial)
  }

  ids.forEach(function(id){ $(id).addEventListener('input', calc); $(id).addEventListener('change', calc); });

  // Tasa: tarjetas de fuente + edición manual
  document.querySelectorAll('.rate-card').forEach(function(c){
    c.addEventListener('click', function(){ selectRate(c.getAttribute('data-rate'), true); });
  });
  $('tasa').addEventListener('input', function(){
    RATES.custom.value = num('tasa');
    if (rateSource !== 'custom'){ rateSource = 'custom'; }
    renderRates(); calc();
  });
  $('tasa').addEventListener('change', calc);
  $('btnRefreshRates').addEventListener('click', refreshRates);
  $('margenRange').addEventListener('input', function(){ $('margen').value = this.value; calc(); });
  $('margen').addEventListener('input', function(){ $('margenRange').value = this.value; });
  document.querySelectorAll('#marginChips .chip').forEach(function(c){
    c.addEventListener('click', function(){ $('margen').value = c.getAttribute('data-margen'); calc(); });
  });

  $('btnCopiarPrecio').addEventListener('click', function(){
    if(!last) return;
    copiar('Bs ' + fmtBs0.format(last.precioFinal) + ' ($' + fmtBs.format(last.precioUsd) + ')', 'Precio copiado: Bs ' + fmtBs0.format(last.precioFinal));
    if (window.__margenesOnCopyPrice) window.__margenesOnCopyPrice(); // guardado automático en el historial
  });
  $('btnCopiarMensaje').addEventListener('click', function(){
    if(!last) return;
    var txt = last.producto + '\nPrecio: Bs ' + fmtBs0.format(last.precioFinal) + ' ($' + fmtBs.format(last.precioUsd) + ')\nTasa: Bs ' + fmtBs.format(last.tasa) + ' por $1\nPago Móvil disponible. Entrega inmediata.';
    copiar(txt, 'Mensaje para el cliente copiado');
  });
  $('btnCopiarDesglose').addEventListener('click', function(){
    if(!last) return;
    var txt = 'DESGLOSE — ' + last.producto + '\n'
      + '1) Costo en Bs: $' + fmtBs.format(last.costoUsd) + ' × ' + fmtBs.format(last.tasa) + ' = Bs ' + fmtBs.format(last.costoBs) + '\n'
      + '2) Comisiones totales: ' + fmtPct.format(last.comTotal) + '% (' + fmtPct.format(last.comP) + '% proveedor + ' + fmtPct.format(last.comPa) + '% pasarela + ' + fmtPct.format(last.comO) + '% otra)\n'
      + '3) Denominador: 1 − ' + fmtPct.format(last.comTotal) + '% − ' + fmtPct.format(last.margen) + '% = ' + last.denom.toFixed(2).replace('.',',') + '\n'
      + '4) Precio exacto: (Bs ' + fmtBs.format(last.costoBs + last.gasto) + ') ÷ ' + last.denom.toFixed(2).replace('.',',') + ' = Bs ' + fmtBs.format(last.precioExacto) + '\n'
      + '5) Precio a cobrar (redondeado hacia arriba): Bs ' + fmtBs0.format(last.precioFinal) + ' ($' + fmtBs.format(last.precioUsd) + ')\n'
      + 'Ganancia neta: Bs ' + fmtBs.format(last.gananciaBs) + ' ($' + fmtBs.format(last.gananciaUsd) + ') · Margen real: ' + fmtPct.format(last.margenReal) + '%';
    copiar(txt, 'Desglose completo copiado');
  });

  renderRates();
  calc();
  refreshRates();
})();
