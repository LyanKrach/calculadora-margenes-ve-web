/* pro-ui.js — Capa de UI para Planes Pro, pagos manuales y funciones Pro:
 *  - Encabezado Pro + Modal de bloqueo Pro
 *  - Calculadora por lote (tab Lote)
 *  - Revalorización masiva del catálogo en 1 toque (modal)
 *  - Importar catálogo Excel (.xlsx) / CSV (modal + plantillas)
 *  - Lista de precios Imagen PNG (Canvas) y PDF con nombre del negocio
 *  - Reportes de ganancia (día/semana/mes/producto + Excel/PDF)
 *  - Gráfico 30 días BCV vs Paralelo + tasa de reposición + alertas
 *  - Página de Planes Pro ($1,99 mensual · $4,99 trimestral · $7,99 6 meses · $15,99 anual) + Admin
 */
(function (root) {
  'use strict';

  var C = root.ProCore;
  var F = root.ProFiles;
  var $ = function (id) { return document.getElementById(id); };

  var SNAP_KEY = 'cmv_reval_snapshot_v1';
  var HIST_CACHE_KEY = 'cmv_rates_hist30_v1';
  var selectedPlan = 'annual';
  var selectedMethod = 'pago_movil';
  var reportPeriod = 'day';
  var alertRuntimeState = { gapDay: '', aboveDay: '' };
  var rateSeriesCache = null; // [{date,bcv,par,gapPct}]
  var rateSeriesLoading = false;
  var pendingImportProducts = [];
  var lastRevalData = null;
  var remotePayConfig = null;
  var remotePayLoading = false;
  var activeOrder = null;
  var payStatusMsg = null;
  var payVerifying = false;
  var adminOverview = null;
  var adminLookupUser = null;
  var adminNotice = null;
  var adminBusy = false;
  var adminLoadedUid = '';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function toast(msg) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function bridge() { return root.__margenesAuthBridge || null; }
  function authState() {
    var b = bridge();
    return b ? b.getState() : { firebaseOn: false, user: null, isPro: false, subState: { isPro: false, status: 'free' }, subCurrent: null, subPending: null, prodItems: [], histItems: [], profileSettings: { businessName: '' }, alertSettings: {} };
  }
  function rates() {
    return root.getRatesSnapshot ? root.getRatesSnapshot() : { bcvUsd: 0, bcvPrevUsd: 0, binanceUsdt: 0, euroBcv: 0, custom: 0, bcvDate: '' };
  }
  function fmtDateShort(iso) {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat('es-VE', { day: '2-digit', month: 'short', year: 'numeric', timeZone: C.TZ }).format(new Date(iso));
    } catch (e) { return String(iso).slice(0, 10); }
  }
  function downloadBytes(bytes, filename, mime) {
    var blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }
  function goToPlans(planOpt) {
    if (planOpt && C.PLANS && Object.prototype.hasOwnProperty.call(C.PLANS, planOpt)) {
      selectedPlan = planOpt;
      renderPlansPage();
    }
    closeGateModal();
    if (root.setDashboardTab) root.setDashboardTab('pro');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ===== Modal de aviso Pro ===== */
  function promptUpgrade(msg) {
    var box = $('proGateMsg');
    if (box) box.textContent = msg || 'Esta herramienta forma parte de Calculadora Pro.';
    var m = $('proGateModal');
    if (m) m.hidden = false;
  }
  function closeGateModal() {
    var m = $('proGateModal');
    if (m) m.hidden = true;
  }
  function requirePro(msg) {
    var st = authState();
    if (st.isPro) return true;
    if (!st.user) {
      promptUpgrade((msg ? msg + ' ' : '') + 'Inicia sesión y activa un plan Pro para usar esta función.');
    } else {
      promptUpgrade(msg || 'Desbloquea esta función activando un plan Pro (desde $1,99/mes).');
    }
    return false;
  }

  /* ===== Header & bloqueos visuales ===== */
  function renderHeaderAndLocks() {
    var st = authState();
    var btn = $('btnHeaderPro');
    if (btn) {
      if (st.isPro) {
        btn.className = 'pro-nav-btn active-pro';
        btn.textContent = '✦ Pro · ' + st.subState.daysLeft + 'd';
      } else {
        btn.className = 'pro-nav-btn';
        btn.textContent = '💎 Pro';
      }
    }
    var loteGate = $('loteProNotice');
    if (loteGate) loteGate.hidden = st.isPro;
    var tasasLock = $('tasasProLock');
    var tasasBody = $('tasasProBody');
    if (tasasLock) tasasLock.hidden = st.isPro;
    if (tasasBody) tasasBody.hidden = !st.isPro;
    var alertsLock = $('alertsProLock');
    var alertsBody = $('alertsProBody');
    if (alertsLock) alertsLock.hidden = st.isPro;
    if (alertsBody) alertsBody.hidden = !st.isPro;
    var repLock = $('reportsProLock');
    var repBody = $('reportsProBody');
    if (repLock) repLock.hidden = st.isPro;
    if (repBody) repBody.hidden = !st.isPro;
  }

  function planLabelLong(planId) {
    var map = {
      monthly: 'Pro Mensual ($1,99 / 1 mes)',
      quarterly: 'Pro Trimestral ($4,99 / 3 meses · ahorra 16%)',
      semiannual: 'Pro 6 Meses ($7,99 / 6 meses · ahorra 33%)',
      annual: 'Pro Anual ($15,99 / 12 meses · ahorra 33%)'
    };
    return map[planId] || map.monthly;
  }
  function planLabelShort(planId) {
    var map = {
      monthly: 'Mensual ($1,99)',
      quarterly: 'Trimestral ($4,99)',
      semiannual: '6 Meses ($7,99)',
      annual: 'Anual ($15,99)'
    };
    return map[planId] || map.monthly;
  }

  /* ===== Página de Planes Pro y Pago Manual ===== */
  function renderPlansPage() {
    var st = authState();
    var r = rates();
    var pMon = C.planPrice('monthly', r.bcvUsd);
    var pQrt = C.planPrice('quarterly', r.bcvUsd);
    var pSem = C.planPrice('semiannual', r.bcvUsd);
    var pAnn = C.planPrice('annual', r.bcvUsd);
    var saveQrt = C.planSavingsPct ? C.planSavingsPct('quarterly') : 16;
    var saveSem = C.planSavingsPct ? C.planSavingsPct('semiannual') : 33;
    var saveAnn = C.annualSavingsPct();

    var mUsd = $('planMonthlyUsd'); if (mUsd && pMon) mUsd.textContent = '$' + C.fmt2(pMon.usd);
    var mBs = $('planMonthlyBs'); if (mBs && pMon) mBs.textContent = pMon.bs ? ('≈ Bs ' + C.fmt2(pMon.bs) + ' al BCV (' + C.fmt2(pMon.rate) + ')') : 'Según BCV del día';

    var qUsd = $('planQuarterlyUsd'); if (qUsd && pQrt) qUsd.textContent = '$' + C.fmt2(pQrt.usd);
    var qBs = $('planQuarterlyBs'); if (qBs && pQrt) qBs.textContent = pQrt.bs ? ('≈ Bs ' + C.fmt2(pQrt.bs) + ' al BCV (' + C.fmt2(pQrt.rate) + ')') : 'Según BCV del día';
    var qSav = $('planQuarterlySavings'); if (qSav) qSav.textContent = 'Ahorra ' + saveQrt + '%';

    var sUsd = $('planSemiannualUsd'); if (sUsd && pSem) sUsd.textContent = '$' + C.fmt2(pSem.usd);
    var sBs = $('planSemiannualBs'); if (sBs && pSem) sBs.textContent = pSem.bs ? ('≈ Bs ' + C.fmt2(pSem.bs) + ' al BCV (' + C.fmt2(pSem.rate) + ')') : 'Según BCV del día';
    var sSav = $('planSemiannualSavings'); if (sSav) sSav.textContent = 'Ahorra ' + saveSem + '%';

    var aUsd = $('planAnnualUsd'); if (aUsd && pAnn) aUsd.textContent = '$' + C.fmt2(pAnn.usd);
    var aBs = $('planAnnualBs'); if (aBs && pAnn) aBs.textContent = pAnn.bs ? ('≈ Bs ' + C.fmt2(pAnn.bs) + ' al BCV (' + C.fmt2(pAnn.rate) + ')') : 'Según BCV del día';
    var badgeSave = $('planAnnualSavings'); if (badgeSave) badgeSave.textContent = 'Ahorra ' + saveAnn + '%';

    // Estado actual de cuenta/suscripción
    var statusCard = $('proAccountStatusCard');
    if (statusCard) {
      if (!st.user) {
        statusCard.innerHTML = '<div><b>Modo invitado (Plan Gratis)</b><p class="sub" style="margin:4px 0 0">La calculadora, tasas y brecha son 100% gratis sin cuenta. <button type="button" class="btn-mini accent" id="btnProLoginNow">Entrar / Crear cuenta</button> para guardar productos, historial o activar Pro.</p></div>';
        var bl = $('btnProLoginNow');
        if (bl) bl.addEventListener('click', function () { var b = bridge(); if (b) b.openAuth(); });
      } else if (st.isPro) {
        var planLbl = planLabelShort(st.subState.plan);
        var provLbl = (st.subCurrent && st.subCurrent.provider === 'admin_owner')
          ? ' · Cuenta propietaria'
          : (st.subCurrent && st.subCurrent.note ? (' · ' + esc(st.subCurrent.note)) : '');
        statusCard.innerHTML = '<div><span class="pro-inline-tag">ACTIVO</span> <b>Pro ' + esc(planLbl) + '</b><span class="hint">' + provLbl + '</span><p class="sub" style="margin:6px 0 0">Inicio: <b>' + esc(fmtDateShort(st.subState.startDate)) + '</b> · Vence: <b>' + esc(fmtDateShort(st.subState.endDate)) + '</b> (' + st.subState.daysLeft + ' días restantes). Al vencer vuelve automáticamente a Gratis si no se renueva.</p></div>';
      } else if (st.subState.status === 'expired') {
        statusCard.innerHTML = '<div><span class="pro-warn-tag">VENCIDO</span> <b>Tu suscripción Pro venció el ' + esc(fmtDateShort(st.subState.endDate)) + '</b><p class="sub" style="margin:4px 0 0">Tu cuenta volvió al plan Gratis (tus datos se conservan, pero aplican los límites de 10 productos y 30 días de historial). Renueva abajo cuando quieras.</p></div>';
      } else {
        statusCard.innerHTML = '<div><b>Plan actual: Gratis</b> <span class="hint">(' + esc(st.user.email || st.user.displayName) + ')</span><p class="sub" style="margin:4px 0 0">Tienes hasta 10 productos e historial de 30 días / 50 cálculos. Elige un plan Pro abajo para desbloquear todas las herramientas.</p></div>';
      }
    }

    // Pago pendiente enviado (si aplica y no fue superado por una activación más reciente)
    var pendBox = $('payPendingCard');
    if (pendBox) {
      var pend = st.subPending;
      var curAt = (st.subCurrent && (st.subCurrent.updatedAt || st.subCurrent.startDate)) || '';
      var showPend = pend && pend.status === 'pending' && (!st.isPro || String(pend.requestedAt || '') > String(curAt));
      pendBox.hidden = !showPend;
      if (showPend) {
        var pl = planLabelShort(pend.plan);
        var met = pend.method === 'usdt' ? 'Binance Pay (USDT)' : 'Pago Móvil (BDV)';
        pendBox.innerHTML = '⏳ <b>Pago pendiente de verificación manual:</b> ' + esc(pl) + ' vía ' + esc(met) + ' · Referencia: <code>' + esc(pend.reference) + '</code> · Enviado: ' + esc(fmtDateShort(pend.requestedAt)) + '. El administrador activará tu Pro al verificar la referencia.';
      }
    }

    // Selector de plan y método en pago manual
    document.querySelectorAll('[data-pay-plan]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-pay-plan') === selectedPlan);
    });
    document.querySelectorAll('[data-pay-method]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-pay-method') === selectedMethod);
    });

    var price = C.planPrice(selectedPlan, r.bcvUsd);
    var sum = $('payTotalSummary');
    if (sum && price) {
      sum.innerHTML = '<b>' + esc(planLabelLong(selectedPlan)) + ':</b> $' + C.fmt2(price.usdt) + ' USDT' + (price.bs ? ' · ≈ <b>Bs ' + C.fmt2(price.bs) + '</b> (tasa BCV ' + C.fmt2(price.rate) + ')' : '');
    }

    renderPaymentInstructions();
    renderSupportBox(st);
    renderAdminSection(st);
  }

  function apiEndpoints() {
    var cfg = root.PRO_PAYMENT_CONFIG || {};
    var ep = (cfg.api && cfg.api.endpoints) || {};
    return {
      config: ep.config || 'https://getpropaymentconfig-yqgkyclg5a-uc.a.run.app',
      checkout: ep.checkout || 'https://createprocheckout-yqgkyclg5a-uc.a.run.app',
      verify: ep.verify || 'https://verifypropayment-yqgkyclg5a-uc.a.run.app',
      admin: ep.admin || 'https://adminmanagepro-yqgkyclg5a-uc.a.run.app'
    };
  }
  function mergedPaymentConfig() {
    var local = root.PRO_PAYMENT_CONFIG || {};
    var rem = (remotePayConfig && remotePayConfig.methods) || {};
    var remPm = rem.pago_movil || {};
    var remUsdt = rem.usdt || {};
    var remSup = (remotePayConfig && remotePayConfig.support) || {};
    var localPm = local.pagoMovil || {};
    var localU = local.usdt || {};
    var localSup = local.soporte || {};
    return {
      pagoMovil: {
        banco: remPm.bank || remPm.banco || localPm.banco || 'Banco de Venezuela (BDV · 0102)',
        cedulaRif: remPm.cedulaRif || localPm.cedulaRif || '31955598',
        telefono: remPm.phone || remPm.telefono || localPm.telefono || '04220336568',
        titular: remPm.holder || remPm.titular || localPm.titular || '',
        autoVerify: remPm.autoVerify !== undefined ? !!remPm.autoVerify : true
      },
      usdt: {
        red: remUsdt.network || remUsdt.red || localU.red || 'Binance Pay (USDT)',
        binanceId: remUsdt.binanceId || localU.binanceId || '916942742',
        direccion: remUsdt.address || remUsdt.direccion || localU.direccion || '',
        autoVerify: remUsdt.autoVerify !== undefined ? !!remUsdt.autoVerify : true
      },
      soporte: {
        email: remSup.email || localSup.email || '',
        whatsapp: remSup.whatsapp || localSup.whatsapp || ''
      }
    };
  }
  async function loadRemotePayConfig() {
    if (remotePayLoading || typeof root.fetch !== 'function') return;
    remotePayLoading = true;
    try {
      var res = await root.fetch(apiEndpoints().config, { method: 'GET' });
      if (res && res.ok) {
        var json = await res.json();
        if (json && json.ok) {
          remotePayConfig = json;
          renderPlansPage();
        }
      }
    } catch (e) {
      // Mantiene configuración local sin interrumpir UI offline/pruebas
    } finally {
      remotePayLoading = false;
    }
  }
  function matchingActiveOrder() {
    if (!activeOrder) return null;
    if (activeOrder.plan !== selectedPlan || activeOrder.method !== selectedMethod) return null;
    if (activeOrder.status === 'paid') return null;
    var exp = activeOrder.expiresAt ? Date.parse(activeOrder.expiresAt) : 0;
    if (exp && !(Number(activeOrder.paidAmount) > 0) && exp < Date.now()) return null;
    return activeOrder;
  }
  function renderPayOrderBox() {
    var box = $('payOrderBox');
    if (!box) return;
    var ord = matchingActiveOrder();
    if (!ord) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    var rem = Number(ord.remainingAmount != null ? ord.remainingAmount : ord.expectedTotal || 0);
    var paid = Number(ord.paidAmount || 0);
    var isBs = ord.currency === 'BS';
    var copyVal = rem.toFixed(2);
    var expStr = ord.expiresAt ? new Date(ord.expiresAt).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' }) : '';
    var partialLine = paid > 0
      ? '<div style="margin-top:4px;color:var(--accent)">✓ Abonado: <b>' + (isBs ? 'Bs ' : '$') + C.fmt2(paid) + '</b> · Resta por transferir: <b>' + (isBs ? 'Bs ' : '$') + C.fmt2(rem) + '</b></div>'
      : '';
    box.hidden = false;
    box.innerHTML = '<div><b>Orden activa:</b> <code>' + esc(ord.id) + '</code>' + (expStr ? ' <span class="hint">· Tasa BCV congelada hasta las ' + esc(expStr) + '</span>' : '') + '</div>'
      + '<div class="pay-order-amount">'
      + '<span>Monto exacto a transferir: <strong style="font-size:16px">' + (isBs ? ('Bs ' + C.fmt2(rem)) : ('$' + C.fmt2(rem) + ' USDT')) + '</strong>' + (isBs ? ' <span class="hint">(BCV ' + C.fmt2(ord.rateBs) + ')</span>' : '') + '</span>'
      + '<button type="button" class="btn-mini accent" data-copy-txt="' + esc(copyVal) + '">Copiar monto exacto</button>'
      + '</div>' + partialLine;
  }
  function renderPayStatusBanner() {
    var banner = $('payStatusBanner');
    if (!banner) return;
    if (!payStatusMsg || !payStatusMsg.html) {
      banner.hidden = true;
      banner.className = 'pay-status-banner';
      banner.innerHTML = '';
      return;
    }
    banner.hidden = false;
    banner.className = 'pay-status-banner ' + (payStatusMsg.tone || 'info');
    banner.innerHTML = payStatusMsg.html;
  }
  function configRow(label, val, copyKey) {
    var clean = String(val || '').trim();
    if (!clean) {
      return '<div class="pay-row"><span>' + esc(label) + '</span><em class="pay-missing">Valor por configurar (pro-config.js / Firestore)</em></div>';
    }
    return '<div class="pay-row"><span>' + esc(label) + '</span><code>' + esc(clean) + '</code><button type="button" class="btn-mini" data-copy-txt="' + esc(clean) + '" title="Copiar ' + esc(copyKey) + '">Copiar</button></div>';
  }
  function renderPaymentInstructions() {
    var cfg = mergedPaymentConfig();
    var mInfo = selectedMethod === 'pago_movil' ? cfg.pagoMovil : cfg.usdt;
    var badge = $('payAutoBadge');
    if (badge) {
      badge.textContent = mInfo.autoVerify ? '⚡ Verificación automática Pabilo' : '📝 Validación manual para este método';
    }
    var btnCreate = $('btnCreateOrder');
    if (btnCreate) {
      btnCreate.hidden = !mInfo.autoVerify;
    }
    var btnSubmit = $('btnSubmitPayment');
    var btnManual = $('btnSubmitManualFallback');
    if (btnSubmit && !payVerifying) {
      btnSubmit.textContent = mInfo.autoVerify ? 'Verificar pago y activar Pro' : 'Enviar referencia para validación manual';
    }
    if (btnManual && mInfo.autoVerify) {
      btnManual.hidden = true;
    }
    var refLabel = $('payRefLabel');
    var refInput = $('payReference');
    if (refLabel) {
      refLabel.textContent = selectedMethod === 'pago_movil'
        ? '3. Número de referencia bancaria'
        : '3. ID de orden de Binance Pay';
    }
    if (refInput) {
      refInput.placeholder = selectedMethod === 'pago_movil'
        ? 'Ej. últimos 6-8 dígitos o referencia completa BDV'
        : 'Ej. ID de orden de Binance Pay (verificado por Pabilo)';
    }
    var box = $('payInstructions');
    if (!box) return;
    if (selectedMethod === 'pago_movil') {
      var pm = cfg.pagoMovil || {};
      box.innerHTML = '<h4>Instrucciones · Pago Móvil (BDV)</h4>'
        + configRow('Banco', pm.banco || 'Banco de Venezuela (BDV · 0102)', 'banco')
        + configRow('Cédula / RIF', pm.cedulaRif, 'cédula o RIF')
        + configRow('Teléfono', pm.telefono, 'teléfono')
        + (String(pm.titular || '').trim() ? configRow('Titular', pm.titular, 'titular') : '')
        + '<p class="hint" style="margin:8px 0 0">Transfiere el monto exacto en bolívares indicado arriba y pega el número de referencia abajo para validar automáticamente con Pabilo.</p>';
    } else {
      var u = cfg.usdt || {};
      box.innerHTML = '<h4>Instrucciones · Binance Pay (USDT)</h4>'
        + configRow('Canal / Red', u.red || 'Binance Pay (USDT)', 'red')
        + configRow('Binance Pay ID', u.binanceId, 'Binance ID')
        + (String(u.direccion || '').trim() ? configRow('Dirección USDT', u.direccion, 'dirección USDT') : '')
        + '<p class="hint" style="margin:8px 0 0">Envía el monto exacto en USDT a nuestro Binance Pay ID y pega abajo el ID de orden de Binance para verificar automáticamente con Pabilo.</p>';
    }
    renderPayOrderBox();
    renderPayStatusBanner();
  }
  function renderSupportBox(st) {
    var box = $('proSupportCard');
    if (!box) return;
    var cfg = mergedPaymentConfig().soporte || {};
    var mail = String(cfg.email || '').trim();
    var wa = String(cfg.whatsapp || '').replace(/\D/g, '');
    if (!st.isPro) {
      box.innerHTML = '<h3>🎧 Soporte prioritario</h3><p class="sub" style="margin:4px 0 0">Disponible al activar el plan Pro para atención directa en dudas de fórmulas, importación de catálogos o pagos.</p>';
      return;
    }
    var actions = [];
    if (mail) actions.push('<a class="btn-mini accent" href="mailto:' + esc(mail) + '?subject=Soporte%20Prioritario%20Margenes%20Pro">✉ ' + esc(mail) + '</a>');
    if (wa) actions.push('<a class="btn-mini accent" target="_blank" rel="noopener noreferrer" href="https://wa.me/' + esc(wa) + '?text=' + encodeURIComponent('Hola, soy usuario Pro en Calculadora de Márgenes VE (' + (st.user ? st.user.email : '') + ')') + '">💬 WhatsApp prioritario</a>');
    box.innerHTML = '<h3>🎧 Soporte prioritario activo</h3>'
      + (actions.length
        ? '<p class="sub" style="margin:4px 0 10px">Tu cuenta Pro tiene atención directa por estos canales:</p><div style="display:flex;gap:8px;flex-wrap:wrap">' + actions.join('') + '</div>'
        : '<p class="sub" style="margin:4px 0 0">Tu cuenta tiene soporte prioritario activo. Configura el correo o WhatsApp de soporte en <code>pro-config.js</code> o <code>config/proPayments</code> para mostrar el botón directo.</p>');
  }

  async function callAuthedJson(url, payload, timeoutMs) {
    var b = bridge();
    var token = b && typeof b.getIdToken === 'function' ? await b.getIdToken() : null;
    if (!token) throw new Error('Debes iniciar sesión para continuar.');
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs || 55000) : null;
    try {
      var res = await root.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify(payload || {}),
        signal: controller ? controller.signal : undefined
      });
      var data = await res.json().catch(function () { return {}; });
      return { status: res.status, ok: res.ok, data: data };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function createOrderFlow(silent) {
    var st = authState();
    var b = bridge();
    if (!st.user) {
      toast('Entra con tu cuenta para asociar el pago a tu usuario');
      if (b) b.openAuth(function () { if (root.setDashboardTab) root.setDashboardTab('pro'); });
      return null;
    }
    var btn = $('btnCreateOrder');
    if (btn && !silent) { btn.disabled = true; btn.textContent = 'Congelando tasa…'; }
    try {
      var out = await callAuthedJson(apiEndpoints().checkout, {
        plan: selectedPlan,
        method: selectedMethod
      }, 20000);
      if (!out.data || !out.data.ok || !out.data.order) {
        throw new Error((out.data && out.data.message) || 'No se pudo generar la orden de pago.');
      }
      activeOrder = out.data.order;
      if (out.data.paymentConfig) {
        remotePayConfig = Object.assign({}, remotePayConfig || {}, {
          ok: true,
          methods: {
            pago_movil: out.data.paymentConfig.pago_movil,
            usdt: out.data.paymentConfig.usdt
          },
          support: out.data.paymentConfig.support
        });
      }
      if (!silent) {
        payStatusMsg = { tone: 'info', html: 'Orden lista. Transfiere el monto exacto indicado y luego pega la referencia abajo para activar Pro al instante.' };
        toast('Orden creada · tasa BCV congelada por 30 min');
      }
      renderPlansPage();
      return activeOrder;
    } catch (e) {
      if (!silent) {
        payStatusMsg = { tone: 'err', html: esc((e && e.message) || 'No pudimos crear la orden.') };
        renderPayStatusBanner();
      }
      throw e;
    } finally {
      if (btn && !silent) { btn.disabled = false; btn.textContent = 'Generar orden con monto exacto (congelar 30 min)'; }
    }
  }

  async function submitManualFallback() {
    var st = authState();
    var b = bridge();
    if (!st.user) {
      toast('Entra con tu cuenta para asociar el pago a tu usuario');
      if (b) b.openAuth(function () { if (root.setDashboardTab) root.setDashboardTab('pro'); });
      return;
    }
    var refEl = $('payReference');
    var ref = (refEl && refEl.value || '').trim();
    if (ref.length < 4) { toast('Escribe la referencia o hash del pago (mínimo 4 caracteres)'); if (refEl) refEl.focus(); return; }
    var r = rates();
    var price = C.planPrice(selectedPlan, r.bcvUsd);
    var btn = $('btnSubmitManualFallback');
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
    try {
      await b.submitPendingPayment({
        plan: selectedPlan,
        method: selectedMethod,
        reference: ref,
        amountUsd: price.usd,
        amountBs: price.bs,
        rateBs: price.rate
      });
      if (refEl) refEl.value = '';
      payStatusMsg = { tone: 'info', html: 'Referencia enviada para revisión manual. Activaremos tu Pro tras verificarla.' };
      renderPayStatusBanner();
      toast('Referencia enviada para validación manual.');
    } catch (e) {
      toast((e && e.message) || 'No se pudo enviar la referencia');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Enviar para validación manual'; }
    }
  }

  async function submitPayment() {
    var cfg = mergedPaymentConfig();
    var mInfo = selectedMethod === 'pago_movil' ? cfg.pagoMovil : cfg.usdt;
    if (!mInfo.autoVerify) {
      return submitManualFallback();
    }
    var st = authState();
    var b = bridge();
    if (!st.user) {
      toast('Entra con tu cuenta para asociar el pago a tu usuario');
      if (b) b.openAuth(function () { if (root.setDashboardTab) root.setDashboardTab('pro'); });
      return;
    }
    var refEl = $('payReference');
    var rawRef = (refEl && refEl.value || '').trim();
    var cleanRef = selectedMethod === 'pago_movil'
      ? rawRef.replace(/\D/g, '')
      : rawRef.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleanRef.length < (selectedMethod === 'pago_movil' ? 4 : 6)) {
      toast(selectedMethod === 'pago_movil' ? 'Escribe los dígitos de la referencia bancaria (mínimo 4)' : 'Escribe el ID de orden o TxID completo (mínimo 6 caracteres)');
      if (refEl) refEl.focus();
      return;
    }
    if (payVerifying) return;
    payVerifying = true;
    var btn = $('btnSubmitPayment');
    if (btn) { btn.disabled = true; btn.textContent = 'Verificando con Pabilo…'; }
    payStatusMsg = {
      tone: 'info',
      html: selectedMethod === 'pago_movil'
        ? '⏳ <b>Verificando tu referencia automáticamente con Pabilo…</b> Si pagaste vía BDV puede tardar 15 a 35 segundos, no cierres esta ventana.'
        : '⏳ <b>Verificando tu orden de Binance Pay automáticamente con Pabilo…</b> Un momento por favor, no cierres esta ventana.'
    };
    renderPayStatusBanner();

    try {
      var ord = matchingActiveOrder();
      if (!ord) {
        ord = await createOrderFlow(true);
      }
      var res = await callAuthedJson(apiEndpoints().verify, {
        orderId: ord.id,
        reference: cleanRef
      }, 55000);
      var data = res.data || {};

      if (data.ok && (data.code === 'ACTIVATED' || data.code === 'ALREADY_ACTIVATED')) {
        if (b && typeof b.applyActivatedSubscription === 'function' && data.subscription) {
          b.applyActivatedSubscription(data.subscription);
        }
        activeOrder = null;
        if (refEl) refEl.value = '';
        payStatusMsg = {
          tone: 'ok',
          html: '✅ <b>¡Suscripción Pro activada al instante!</b> Ya tienes todas las funciones Pro desbloqueadas en la web y en tu app Android.'
        };
        toast('¡Suscripción Pro activada!');
      } else if (data.code === 'PARTIAL_PAYMENT') {
        activeOrder = Object.assign({}, ord, {
          paidAmount: data.paidAmount,
          remainingAmount: data.remainingAmount,
          expiresAt: data.expiresAt || ord.expiresAt
        });
        if (refEl) refEl.value = '';
        var copyRem = Number(data.remainingAmount || 0).toFixed(2);
        payStatusMsg = {
          tone: 'warn',
          html: '⚠ <b>Pago parcial acreditado:</b> ' + esc(data.message)
            + ' <button type="button" class="btn-mini accent" data-copy-txt="' + esc(copyRem) + '">Copiar diferencia</button>'
        };
        toast('Pago parcial recibido · falta la diferencia');
      } else if (data.code === 'AUTO_VERIFY_UNAVAILABLE' || data.fallbackManual) {
        var btnManual = $('btnSubmitManualFallback');
        if (btnManual) btnManual.hidden = false;
        payStatusMsg = {
          tone: 'warn',
          html: '📝 ' + esc(data.message || 'Verificación automática no disponible en este momento.') + ' Puedes usar el botón «Enviar para validación manual».'
        };
      } else if (data.code === 'ORDER_EXPIRED') {
        activeOrder = null;
        payStatusMsg = { tone: 'warn', html: '⌛ ' + esc(data.message || 'La orden expiró. Pulsa verificar de nuevo para generar una con la tasa actual.') };
      } else {
        payStatusMsg = {
          tone: data.retryable ? 'warn' : 'err',
          html: esc(data.message || 'No se pudo verificar el pago. Revisa tu referencia e intenta de nuevo.')
        };
      }
    } catch (e) {
      var isTimeout = e && e.name === 'AbortError';
      if (!isTimeout) {
        var btnManualErr = $('btnSubmitManualFallback');
        if (btnManualErr) btnManualErr.hidden = false;
      }
      payStatusMsg = {
        tone: 'warn',
        html: isTimeout
          ? '⏳ La respuesta del banco tardó más de lo normal. Vuelve a presionar «Verificar pago» con la misma referencia para reconciliar automáticamente.'
          : esc((e && e.message) || 'No pudimos conectar con el servicio automático en este momento.') + ' Puedes reintentar o usar «Enviar para validación manual».'
      };
    } finally {
      payVerifying = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = mInfo.autoVerify ? 'Verificar pago y activar Pro' : 'Enviar referencia para validación manual';
      }
      renderPlansPage();
    }
  }

  /* ===== Panel Administrador Pro (solo owners autorizados) ===== */
  function isAdminUser(st) {
    return !!(st && st.user && typeof C.isAdminEmail === 'function' && C.isAdminEmail(st.user.email));
  }
  function renderAdminNotice() {
    var box = $('adminNoticeBox');
    if (!box) return;
    if (!adminNotice || !adminNotice.text) {
      box.hidden = true;
      box.className = 'pay-status-banner';
      box.textContent = '';
      return;
    }
    box.hidden = false;
    box.className = 'pay-status-banner ' + (adminNotice.tone || 'info');
    box.textContent = adminNotice.text;
  }
  function renderAdminUserHtml(u) {
    var pillCls = u.isPro ? 'pro' : 'free';
    var pillTxt = u.isPro ? ('PRO ' + planLabelShort(u.plan) + ' · ' + u.daysLeft + 'd') : 'GRATIS';
    var pendHtml = u.pending
      ? ' <span class="admin-pill pend">Pendiente: ' + esc(u.pending.reference || u.pending.method) + '</span>'
      : '';
    var ownerHtml = u.isOwner ? ' <span class="admin-pill pro">PROPIETARIO</span>' : '';
    var metaParts = [];
    if (u.endDate && u.isPro) metaParts.push('Vence: ' + fmtDateShort(u.endDate));
    if (u.note) metaParts.push('Nota: ' + u.note);
    if (u.activatedBy) metaParts.push('Por: ' + u.activatedBy);
    return '<div class="admin-user-row">'
      + '<div>'
      + '<div><b>' + esc(u.email || u.uid) + '</b> ' + (u.displayName ? '<span class="hint">(' + esc(u.displayName) + ')</span>' : '') + ' <span class="admin-pill ' + pillCls + '">' + esc(pillTxt) + '</span>' + ownerHtml + pendHtml + '</div>'
      + '<div class="hint" style="margin-top:4px">' + esc(metaParts.join(' · ') || ('UID: ' + u.uid)) + '</div>'
      + '</div>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap">'
      + '<button type="button" class="btn-mini accent" data-admin-act="monthly" data-admin-days="30" data-admin-uid="' + esc(u.uid) + '" data-admin-email="' + esc(u.email || '') + '">Regalar 1 mes</button>'
      + '<button type="button" class="btn-mini" data-admin-act="annual" data-admin-uid="' + esc(u.uid) + '" data-admin-email="' + esc(u.email || '') + '">Activar 1 año</button>'
      + (u.isPro ? '<button type="button" class="btn-mini" data-admin-deact="1" data-admin-uid="' + esc(u.uid) + '" data-admin-email="' + esc(u.email || '') + '">Desactivar</button>' : '')
      + '</div>'
      + '</div>';
  }
  function renderAdminSection(st) {
    var sec = $('adminPanelSection');
    if (!sec) return;
    var ok = isAdminUser(st);
    sec.hidden = !ok;
    if (!ok) {
      adminOverview = null;
      adminLookupUser = null;
      adminNotice = null;
      adminLoadedUid = '';
      return;
    }
    var statsBadge = $('adminStatsBadge');
    if (statsBadge) {
      if (adminOverview && adminOverview.stats) {
        statsBadge.textContent = adminOverview.stats.totalUsers + ' cuentas · ' + adminOverview.stats.activePro + ' Pro · ' + adminOverview.stats.pendingManual + ' pendientes';
      } else {
        statsBadge.textContent = adminBusy ? 'Cargando…' : 'Listo';
      }
    }
    renderAdminNotice();
    var preview = $('adminLookupPreview');
    if (preview) {
      if (adminLookupUser) {
        preview.hidden = false;
        preview.innerHTML = renderAdminUserHtml(adminLookupUser);
      } else {
        preview.hidden = true;
        preview.innerHTML = '';
      }
    }
    var listEl = $('adminUsersList');
    if (listEl) {
      var filter = String(($('adminTableFilter') && $('adminTableFilter').value) || '').trim().toLowerCase();
      var rows = (adminOverview && Array.isArray(adminOverview.users)) ? adminOverview.users : [];
      if (filter) {
        rows = rows.filter(function (u) {
          return String(u.email || '').toLowerCase().indexOf(filter) !== -1
            || String(u.displayName || '').toLowerCase().indexOf(filter) !== -1;
        });
      }
      if (!rows.length) {
        listEl.innerHTML = '<p class="hint">' + (adminOverview ? 'No hay cuentas que coincidan con el filtro.' : 'Pulsa «Actualizar lista» para cargar las cuentas registradas.') + '</p>';
      } else {
        listEl.innerHTML = rows.slice(0, 60).map(renderAdminUserHtml).join('');
      }
    }
  }
  async function callAdminApi(payload) {
    var out = await callAuthedJson(apiEndpoints().admin, payload, 25000);
    if (!out.data || !out.data.ok) {
      throw new Error((out.data && out.data.message) || ('Error del panel admin (HTTP ' + out.status + ')'));
    }
    return out.data;
  }
  async function loadAdminOverview(quiet) {
    var st = authState();
    if (!isAdminUser(st) || adminBusy) return;
    adminBusy = true;
    adminLoadedUid = st.user ? st.user.uid : '';
    renderAdminSection(st);
    try {
      var data = await callAdminApi({ action: 'overview' });
      adminOverview = data;
      if (!quiet) adminNotice = null;
    } catch (e) {
      adminNotice = { tone: 'err', text: (e && e.message) || 'No se pudo cargar el panel administrador.' };
    } finally {
      adminBusy = false;
      renderAdminSection(authState());
    }
  }
  async function adminLookupFlow() {
    var email = String(($('adminSearchEmail') && $('adminSearchEmail').value) || '').trim();
    if (!email || email.indexOf('@') === -1) { toast('Escribe un correo válido para buscar'); return; }
    adminBusy = true;
    adminNotice = null;
    renderAdminSection(authState());
    try {
      var data = await callAdminApi({ action: 'lookup', email: email });
      adminLookupUser = data.user || null;
      adminNotice = adminLookupUser ? { tone: 'info', text: 'Cuenta encontrada: ' + adminLookupUser.email } : null;
    } catch (e) {
      adminLookupUser = null;
      adminNotice = { tone: 'err', text: (e && e.message) || 'No se encontró ese usuario.' };
    } finally {
      adminBusy = false;
      renderAdminSection(authState());
    }
  }
  async function adminExecuteChange(payload) {
    adminBusy = true;
    adminNotice = null;
    renderAdminSection(authState());
    try {
      var data = await callAdminApi(payload);
      adminLookupUser = data.user || adminLookupUser;
      adminNotice = { tone: 'ok', text: data.message || 'Cambios aplicados.' };
      toast(data.message || 'Actualizado');
      renderAdminSection(authState());
      var ov = await callAdminApi({ action: 'overview' }).catch(function () { return null; });
      if (ov) adminOverview = ov;
    } catch (e) {
      adminNotice = { tone: 'err', text: (e && e.message) || 'No se pudo actualizar la suscripción.' };
      toast(adminNotice.text);
    } finally {
      adminBusy = false;
      renderAdminSection(authState());
    }
  }

  /* ===== Calculadora por lote (PRO) ===== */
  var lastBatchResults = [];
  function syncLoteDefaultsFromCalc() {
    if (!root.getCalculatorDefaults) return;
    var d = root.getCalculatorDefaults();
    var rm = $('loteMode'); if (rm && !rm.dataset.dirty) rm.value = d.mode || 'onCost';
    var rr = $('loteRate'); if (rr && !rr.dataset.dirty) rr.value = String(d.rate || '');
    var rg = $('loteMargen'); if (rg && !rg.dataset.dirty) rg.value = String(d.marginPercent != null ? d.marginPercent : 20);
    var rc = $('loteComTotal'); if (rc && !rc.dataset.dirty) rc.value = String(Math.round((d.comFraction || 0) * 10000) / 100);
    var rga = $('loteGasto'); if (rga && !rga.dataset.dirty) rga.value = String(d.fixedExpenseBs || 0);
    var rst = $('loteRound'); if (rst && !rst.dataset.dirty) rst.value = String(d.roundStep <= 1 ? 1 : d.roundStep);
  }
  function runBatch() {
    if (!requirePro('La calculadora por lote permite pegar decenas de productos y calcular todos los precios de una vez.')) return;
    var text = ($('loteInput') && $('loteInput').value) || '';
    var parsed = C.parseBatch(text);
    if (!parsed.length) { toast('Pega al menos un producto o costo para calcular'); return; }
    var r = rates();
    var rate = C.toNum($('loteRate') && $('loteRate').value, r.bcvUsd);
    var margin = C.toNum($('loteMargen') && $('loteMargen').value, 20);
    var comFrac = C.toNum($('loteComTotal') && $('loteComTotal').value, 0) / 100;
    var gasto = C.toNum($('loteGasto') && $('loteGasto').value, 0);
    var step = parseInt(($('loteRound') && $('loteRound').value) || '10', 10) || 10;
    var mode = ($('loteMode') && $('loteMode').value) || 'onCost';
    if (!(rate > 0)) { toast('Escribe una tasa mayor que 0'); return; }
    lastBatchResults = C.computeBatch(parsed, function (costUsd) {
      return root.computeSaleMetrics({
        costUsd: costUsd, rate: rate, marginPercent: margin,
        comFraction: comFrac, fixedExpenseBs: gasto, roundStep: step, mode: mode
      });
    });
    var tbody = $('loteTableBody');
    var box = $('loteResultsBox');
    if (box) box.hidden = false;
    if (tbody) {
      tbody.innerHTML = lastBatchResults.map(function (row) {
        if (row.error) {
          var errMsg = row.error === 'sum' ? 'Comisiones + margen ≥ 100%' : (row.error === 'comm' ? 'Comisiones ≥ 100%' : 'Sin costo válido');
          return '<tr class="row-err"><td>' + row.n + '</td><td>' + esc(row.line) + '</td><td colspan="4">' + esc(errMsg) + '</td></tr>';
        }
        return '<tr><td>' + row.n + '</td><td>' + esc(row.name || ('Producto ' + row.n)) + '</td><td>$' + C.fmt2(row.costUsd)
          + '</td><td><b>Bs ' + C.fmt0(row.precioFinal) + '</b></td><td>$' + C.fmt2(row.precioUsd)
          + '</td><td class="green">Bs ' + C.fmt2(row.gananciaBs) + '</td></tr>';
      }).join('');
    }
    var okCount = lastBatchResults.filter(function (x) { return !x.error; }).length;
    var sumEl = $('loteSummary'); if (sumEl) sumEl.textContent = okCount + ' calculados de ' + lastBatchResults.length + ' líneas';
  }
  function exportBatchXlsx() {
    if (!requirePro()) return;
    if (!lastBatchResults.length) { toast('Calcula primero una lista'); return; }
    var rows = [['#', 'Producto', 'Costo USD', 'Costo Bs', 'Precio Bs', 'Precio USD', 'Ganancia Bs']];
    lastBatchResults.forEach(function (r) {
      if (r.error) return;
      rows.push([r.n, r.name || ('Producto ' + r.n), r.costUsd, C.round2(r.costBs), r.precioFinal, C.round2(r.precioUsd), C.round2(r.gananciaBs)]);
    });
    downloadBytes(F.xlsxBuild([{ name: 'Calculo por lote', rows: rows }]), 'lote-precios.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    toast('Excel de lote descargado');
  }

  /* ===== Revalorización masiva en 1 toque (PRO) ===== */
  function loadRevalSnapshot() {
    try { return JSON.parse(localStorage.getItem(SNAP_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveRevalSnapshot(rows) {
    var obj = loadRevalSnapshot();
    (rows || []).forEach(function (r) { if (!r.error && typeof r.newPrice === 'number') obj[r.id] = r.newPrice; });
    try { localStorage.setItem(SNAP_KEY, JSON.stringify(obj)); } catch (e) {}
  }
  function computeRevaluationView() {
    var st = authState();
    var r = rates();
    var target = ($('revalTargetSource') && $('revalTargetSource').value) || 'bcvUsd';
    var baseSnap = loadRevalSnapshot();
    // Si no hay foto guardada aún y tenemos la tasa BCV previa del día anterior, comparamos contra esa
    // para que incluso la primera vez el vendedor vea cuánto variaron sus precios hoy.
    var effectiveSnap = Object.assign({}, baseSnap);
    if (r.bcvPrevUsd > 0) {
      var prevLive = { bcvUsd: r.bcvPrevUsd, binanceUsdt: r.binanceUsdt, euroBcv: r.euroPrevBcv || r.euroBcv };
      st.prodItems.forEach(function (it) {
        if (typeof effectiveSnap[it.id] === 'number') return;
        var p = it.data;
        if (p.rateSourceName === 'custom') return;
        var oldRate = prevLive[p.rateSourceName];
        if (!(oldRate > 0)) return;
        var com = (p.commissionPlatform || 0) + (p.commissionPaymentMethod || 0) + (p.commissionOther || 0);
        var mPrev = root.computeSaleMetrics({ costUsd: p.costUsd, rate: oldRate, marginPercent: p.marginPercent, comFraction: com, fixedExpenseBs: p.fixedExpenseBs, roundStep: p.roundStep, mode: p.marginMode });
        if (mPrev && !mPrev.error) effectiveSnap[it.id] = mPrev.precioFinal;
      });
    }
    lastRevalData = C.buildRevaluation(st.prodItems, {
      liveRates: { bcvUsd: r.bcvUsd, binanceUsdt: r.binanceUsdt, euroBcv: r.euroBcv },
      targetSource: target,
      snapshot: effectiveSnap,
      calc: function (prodLike) { return root.calcProductMetrics(prodLike); }
    });
    var tbody = $('revalTableBody');
    if (tbody) {
      tbody.innerHTML = lastRevalData.rows.map(function (row) {
        if (row.error) return '<tr><td>' + esc(row.name) + '</td><td colspan="3">Sin tasa válida</td></tr>';
        var sign = row.delta > 0 ? '+' : (row.delta < 0 ? '−' : '');
        var cls = row.delta > 0 ? 'green' : (row.delta < 0 ? 'neg' : 'muted');
        var chg = Math.abs(row.delta) < 0.01 ? 'Sin cambio' : (sign + 'Bs ' + C.fmt2(Math.abs(row.delta)) + ' (' + sign + C.fmt1(Math.abs(row.deltaPct)) + '%)');
        return '<tr><td><b>' + esc(row.name) + '</b>' + (row.category ? '<br><small>' + esc(row.category) + '</small>' : '') + '</td>'
          + '<td>Bs ' + C.fmt2(row.oldPrice) + '</td>'
          + '<td><b>Bs ' + C.fmt2(row.newPrice) + '</b></td>'
          + '<td class="' + cls + '">' + esc(chg) + '</td></tr>';
      }).join('');
    }
    var sum = $('revalSummary');
    if (sum) sum.textContent = lastRevalData.changed + ' de ' + lastRevalData.rows.length + ' productos cambiaron respecto al valor anterior (tasa de hoy aplicada).';
  }
  async function openRevalModal() {
    if (!requirePro('Revaloriza todo tu catálogo con la tasa del día en un toque y ve cuánto cambió cada precio.')) return;
    var st = authState();
    if (!st.prodItems.length) { toast('Agrega productos primero para revalorizarlos'); return; }
    var m = $('revalModal'); if (m) m.hidden = false;
    var sum = $('revalSummary'); if (sum) sum.textContent = 'Actualizando tasas en vivo…';
    if (root.refreshRatesNow) { try { await root.refreshRatesNow(); } catch (e) {} }
    computeRevaluationView();
  }
  async function applyRevaluation() {
    if (!requirePro() || !lastRevalData) return;
    var b = bridge();
    var btn = $('btnApplyReval');
    if (btn) { btn.disabled = true; btn.textContent = 'Aplicando…'; }
    try {
      if (lastRevalData.updates.length && b) {
        await b.applyRevaluationUpdates(lastRevalData.updates);
      }
      saveRevalSnapshot(lastRevalData.rows);
      computeRevaluationView();
      toast('Catálogo actualizado con la tasa de hoy (' + lastRevalData.changed + ' cambios)');
    } catch (e) {
      toast((e && e.message) || 'No se pudo aplicar la revalorización');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Confirmar actualización de precios'; }
    }
  }

  /* ===== Importar Excel (.xlsx) o CSV (PRO) ===== */
  function openImportModal() {
    if (!requirePro('Importa cientos de productos desde Excel (.xlsx) o CSV en segundos.')) return;
    pendingImportProducts = [];
    var prev = $('importPreview'); if (prev) prev.innerHTML = '';
    var btn = $('btnConfirmImport'); if (btn) btn.disabled = true;
    var fi = $('importFileInput'); if (fi) fi.value = '';
    var m = $('importModal'); if (m) m.hidden = false;
  }
  async function handleImportFile(ev) {
    var file = ev.target && ev.target.files && ev.target.files[0];
    if (!file) return;
    var prev = $('importPreview');
    var btn = $('btnConfirmImport');
    pendingImportProducts = [];
    if (btn) btn.disabled = true;
    try {
      var rows;
      if (/\.xlsx$/i.test(file.name)) {
        var buf = await file.arrayBuffer();
        rows = await F.xlsxParse(new Uint8Array(buf));
      } else {
        var text = await file.text();
        rows = C.parseCsv(text);
      }
      var res = C.rowsToProducts(rows);
      pendingImportProducts = res.products;
      var html = '<p class="sub" style="margin:6px 0"><b>' + res.products.length + '</b> productos listos para importar'
        + (res.errors.length ? (' · <span style="color:var(--red)">' + res.errors.length + ' filas con error</span>') : '') + '.</p>';
      if (res.products.length) {
        html += '<div class="import-list">' + res.products.slice(0, 8).map(function (p) {
          return '<div class="import-item"><span>' + esc(p.name) + (p.category ? ' <em>(' + esc(p.category) + ')</em>' : '') + '</span><b>$' + C.fmt2(p.costUsd) + ' · ' + C.fmt1(p.marginPercent) + '%</b></div>';
        }).join('') + (res.products.length > 8 ? '<div class="hint">…y ' + (res.products.length - 8) + ' más</div>' : '') + '</div>';
      }
      if (res.errors.length) {
        html += '<ul class="import-errors">' + res.errors.slice(0, 6).map(function (er) {
          return '<li>Fila ' + er.row + ': ' + esc(er.message) + '</li>';
        }).join('') + '</ul>';
      }
      if (prev) prev.innerHTML = html;
      if (btn) btn.disabled = res.products.length === 0;
    } catch (e) {
      if (prev) prev.innerHTML = '<p class="alert show">No se pudo leer el archivo: ' + esc(e && e.message) + '</p>';
    }
  }
  async function confirmImport() {
    if (!requirePro() || !pendingImportProducts.length) return;
    var b = bridge();
    var btn = $('btnConfirmImport');
    if (btn) { btn.disabled = true; btn.textContent = 'Importando…'; }
    try {
      var count = await b.importProductsBatch(pendingImportProducts);
      pendingImportProducts = [];
      var m = $('importModal'); if (m) m.hidden = true;
      toast(count + ' productos importados a tu catálogo');
    } catch (e) {
      toast((e && e.message) || 'Error al importar productos');
    } finally {
      if (btn) { btn.textContent = 'Importar productos válidos'; }
    }
  }

  /* ===== Lista de precios PNG + PDF con nombre del negocio (PRO) ===== */
  function selectedProductsForList() {
    var st = authState();
    var b = bridge();
    var sel = b ? b.getShareSelection() : { selectedCats: {}, includeUncat: true, overrideRate: '' };
    var rows = [];
    st.prodItems.forEach(function (it) {
      var p = it.data;
      var cat = (p.category || '').trim();
      if (cat ? !sel.selectedCats[cat.toLowerCase()] : !sel.includeUncat) return;
      var m = root.calcProductMetrics ? root.calcProductMetrics(p, sel.overrideRate) : null;
      if (!m || m.error) return;
      rows.push({ name: p.name, category: cat, price: m.precioFinal, usd: m.precioUsd });
    });
    return { sections: C.layoutPriceList(rows), overrideRate: sel.overrideRate };
  }
  function activeBusinessName() {
    var inp = $('shareBusinessName');
    var v = (inp && inp.value || '').trim();
    if (v) return v;
    var st = authState();
    return (st.profileSettings && st.profileSettings.businessName) || (st.user && st.user.displayName) || 'Mi Negocio';
  }
  function exportPriceListPdf() {
    if (!requirePro('Genera un PDF profesional de tu catálogo con el nombre de tu negocio.')) return;
    var res = selectedProductsForList();
    if (!res.sections.length) { toast('Selecciona al menos una categoría con productos'); return; }
    var biz = activeBusinessName();
    var r = rates();
    var blocks = [{ type: 'band', text: biz, sub: 'Lista de precios · ' + (r.bcvFechaTxt || ('BCV Bs ' + C.fmt2(r.bcvUsd))) }];
    res.sections.forEach(function (sec) {
      blocks.push({ type: 'heading', text: sec.category });
      sec.items.forEach(function (it) {
        blocks.push({
          type: 'row', rule: true, h: 19,
          cols: [
            { text: it.name, x: 44, size: 10.5 },
            { text: 'Bs ' + C.fmt2(it.price), x: 550, align: 'r', bold: true, color: '#0F6B43', size: 10.5 }
          ]
        });
      });
      blocks.push({ type: 'space', h: 6 });
    });
    var pdf = F.pdfBuild(blocks, { footer: biz + ' · Generado con margencalcu.online' });
    downloadBytes(pdf, 'lista-precios-' + biz.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.pdf', 'application/pdf');
    toast('PDF descargado');
  }
  function exportPriceListImage() {
    if (!requirePro('Genera una imagen lista para estados de WhatsApp e Instagram con el nombre de tu negocio.')) return;
    var res = selectedProductsForList();
    if (!res.sections.length) { toast('Selecciona al menos una categoría con productos'); return; }
    var biz = activeBusinessName();
    var totalItems = res.sections.reduce(function (a, s) { return a + s.items.length; }, 0);
    var W = 1080;
    var lineH = 54, secH = 66, padX = 72;
    var H = Math.max(1080, 290 + res.sections.length * secH + totalItems * lineH + 110);
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#07150F'); bg.addColorStop(1, '#0F241B');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#0F6B43'; ctx.fillRect(0, 0, W, 190);
    ctx.fillStyle = '#FFFFFF'; ctx.font = '800 50px Archivo, Arial, sans-serif';
    ctx.fillText(biz.slice(0, 32), padX, 95);
    ctx.fillStyle = '#B8F5D4'; ctx.font = '600 26px Archivo, Arial, sans-serif';
    var r = rates();
    ctx.fillText('LISTA DE PRECIOS · ' + (r.bcvFechaTxt || ('BCV Bs ' + C.fmt2(r.bcvUsd))), padX, 145);

    var y = 260;
    res.sections.forEach(function (sec) {
      ctx.fillStyle = '#00E599'; ctx.font = '800 28px Archivo, Arial, sans-serif';
      ctx.fillText(sec.category.toUpperCase(), padX, y);
      ctx.fillStyle = 'rgba(0,229,153,0.3)'; ctx.fillRect(padX, y + 12, W - 2 * padX, 2);
      y += secH;
      sec.items.forEach(function (it) {
        ctx.fillStyle = '#E8F3EC'; ctx.font = '600 28px Archivo, Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(it.name.slice(0, 34), padX, y);
        ctx.fillStyle = '#5BFFBD'; ctx.font = '800 30px "JetBrains Mono", monospace';
        ctx.textAlign = 'right';
        ctx.fillText('Bs ' + C.fmt2(it.price), W - padX, y);
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(padX, y + 16, W - 2 * padX, 1);
        y += lineH;
      });
    });
    ctx.fillStyle = '#8FB8A2'; ctx.font = '600 22px Archivo, Arial, sans-serif';
    ctx.fillText(biz + ' · margencalcu.online', padX, H - 42);
    cv.toBlob(function (blob) {
      if (!blob) { toast('No se pudo generar la imagen'); return; }
      downloadBytes(blob, 'lista-precios-' + biz.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.png', 'image/png');
      toast('Imagen PNG descargada para WhatsApp e Instagram');
    }, 'image/png');
  }

  /* ===== Reportes de ganancia (PRO) ===== */
  function renderReports() {
    var st = authState();
    document.querySelectorAll('[data-rep-period]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-rep-period') === reportPeriod);
    });
    if (!st.isPro) return;
    var items = st.histItems || [];
    var rep = reportPeriod === 'product' ? C.buildProductReport(items) : C.buildPeriodReport(items, reportPeriod);
    var t = rep.total;
    var sEl = function (id, txt) { var el = $(id); if (el) el.textContent = txt; };
    sEl('repTotalRev', 'Bs ' + C.fmt2(t.revenueBs));
    sEl('repTotalGain', 'Bs ' + C.fmt2(t.gainBs));
    sEl('repTotalUsd', '$' + C.fmt2(t.gainUsd));
    sEl('repAvgMargin', C.fmt1(t.marginPct) + '%');
    sEl('repCount', String(t.count));

    var head = $('reportTableHead');
    var body = $('reportTableBody');
    if (head) {
      var col1 = reportPeriod === 'product' ? 'Producto' : (reportPeriod === 'day' ? 'Día' : (reportPeriod === 'week' ? 'Semana' : 'Mes'));
      head.innerHTML = '<tr><th>' + col1 + '</th><th>Cálculos</th><th>Ventas Bs</th><th>Ganancia Bs</th><th>Ganancia $</th><th>Margen</th></tr>';
    }
    if (body) {
      if (!rep.rows.length) {
        body.innerHTML = '<tr><td colspan="6" class="hint" style="text-align:center;padding:18px">Guarda cálculos en tu historial para ver tus reportes aquí.</td></tr>';
      } else {
        body.innerHTML = rep.rows.map(function (r) {
          var nm = reportPeriod === 'product' ? r.title : r.label;
          return '<tr><td><b>' + esc(nm) + '</b></td><td>' + r.count + '</td><td>Bs ' + C.fmt2(r.revenueBs)
            + '</td><td class="green"><b>Bs ' + C.fmt2(r.gainBs) + '</b></td><td>$' + C.fmt2(r.gainUsd)
            + '</td><td>' + C.fmt1(r.marginPct) + '%</td></tr>';
        }).join('');
      }
    }
  }
  function exportReportsXlsx() {
    if (!requirePro('Exporta tus reportes de ganancia en Excel (.xlsx).')) return;
    var items = authState().histItems || [];
    if (!items.length) { toast('Aún no hay cálculos en tu historial'); return; }
    var dRep = C.buildPeriodReport(items, 'day'), wRep = C.buildPeriodReport(items, 'week');
    var mRep = C.buildPeriodReport(items, 'month'), pRep = C.buildProductReport(items);
    function toRows(labelCol, rows, isProd) {
      var out = [[labelCol, 'Cálculos', 'Ventas Bs', 'Costo Bs', 'Ganancia Bs', 'Ganancia USD', 'Margen %']];
      rows.forEach(function (r) { out.push([isProd ? r.title : r.label, r.count, r.revenueBs, r.costBs, r.gainBs, r.gainUsd, r.marginPct]); });
      return out;
    }
    var bytes = F.xlsxBuild([
      { name: 'Por dia', rows: toRows('Día', dRep.rows, false) },
      { name: 'Por semana', rows: toRows('Semana', wRep.rows, false) },
      { name: 'Por mes', rows: toRows('Mes', mRep.rows, false) },
      { name: 'Por producto', rows: toRows('Producto', pRep.rows, true) }
    ]);
    downloadBytes(bytes, 'reporte-ganancias-margenes.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    toast('Reporte Excel descargado');
  }
  function exportReportsPdf() {
    if (!requirePro('Exporta tus reportes de ganancia en PDF.')) return;
    var st = authState();
    var items = st.histItems || [];
    if (!items.length) { toast('Aún no hay cálculos en tu historial'); return; }
    var rep = reportPeriod === 'product' ? C.buildProductReport(items) : C.buildPeriodReport(items, reportPeriod);
    var pLabel = reportPeriod === 'product' ? 'Por producto' : (reportPeriod === 'day' ? 'Por día' : (reportPeriod === 'week' ? 'Por semana' : 'Por mes'));
    var blocks = [
      { type: 'band', text: 'Reporte de ganancias (' + pLabel + ')', sub: (st.profileSettings.businessName || st.user.email || 'Calculadora de Márgenes VE') + ' · Total: Bs ' + C.fmt2(rep.total.gainBs) + ' ($' + C.fmt2(rep.total.gainUsd) + ')' },
      { type: 'row', bold: true, fill: '#EEF5F0', cols: [
        { text: reportPeriod === 'product' ? 'Producto' : 'Periodo', x: 44 },
        { text: 'Calc.', x: 260, align: 'r' },
        { text: 'Ventas Bs', x: 365, align: 'r' },
        { text: 'Ganancia Bs', x: 475, align: 'r' },
        { text: 'Margen', x: 550, align: 'r' }
      ] }
    ];
    rep.rows.forEach(function (r) {
      blocks.push({
        type: 'row', rule: true,
        cols: [
          { text: (reportPeriod === 'product' ? r.title : r.label).slice(0, 30), x: 44 },
          { text: String(r.count), x: 260, align: 'r' },
          { text: 'Bs ' + C.fmt2(r.revenueBs), x: 365, align: 'r' },
          { text: 'Bs ' + C.fmt2(r.gainBs), x: 475, align: 'r', bold: true, color: '#0F6B43' },
          { text: C.fmt1(r.marginPct) + '%', x: 550, align: 'r' }
        ]
      });
    });
    downloadBytes(F.pdfBuild(blocks, { footer: 'Generado con margencalcu.online' }), 'reporte-ganancias.pdf', 'application/pdf');
    toast('Reporte PDF descargado');
  }

  /* ===== Historial 30 días + Reposición + Alertas (PRO en Tasas y Brecha) ===== */
  async function loadRateHistory30() {
    if (rateSeriesCache || rateSeriesLoading) { renderRateChartAndRep(); return; }
    try {
      var cached = JSON.parse(localStorage.getItem(HIST_CACHE_KEY) || 'null');
      if (cached && cached.ts && (Date.now() - cached.ts) < 3600000 && Array.isArray(cached.series) && cached.series.length) {
        rateSeriesCache = cached.series;
        renderRateChartAndRep();
        return;
      }
    } catch (e) {}
    rateSeriesLoading = true;
    try {
      var res = await Promise.all([
        fetch('https://ve.dolarapi.com/v1/historicos/dolares/oficial').then(function (x) { return x.ok ? x.json() : []; }),
        fetch('https://ve.dolarapi.com/v1/historicos/dolares/paralelo').then(function (x) { return x.ok ? x.json() : []; })
      ]);
      rateSeriesCache = C.buildRateSeries(res[0], res[1], 30);
      try { localStorage.setItem(HIST_CACHE_KEY, JSON.stringify({ ts: Date.now(), series: rateSeriesCache })); } catch (e) {}
    } catch (e) {
      console.warn('No se pudo cargar serie 30d:', e);
    } finally {
      rateSeriesLoading = false;
      renderRateChartAndRep();
    }
  }
  function renderRateChartAndRep() {
    var st = authState();
    if (!st.isPro) return;
    var r = rates();
    var series = rateSeriesCache || [];
    var svg = $('ratesChartSvg');
    var meta = $('ratesChartMeta');
    if (svg && series.length) {
      var paths = C.chartPaths(series, 640, 210, 14);
      svg.innerHTML = '<line x1="14" y1="196" x2="626" y2="196" stroke="currentColor" stroke-opacity="0.16"/>'
        + '<path d="' + paths.par + '" fill="none" stroke="#F59E0B" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'
        + '<path d="' + paths.bcv + '" fill="none" stroke="#00E599" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>';
      if (meta) {
        var first = series[0], last = series[series.length - 1];
        meta.textContent = C.shortDate(first.date) + ' → ' + C.shortDate(last.date) + ' · Rango Bs ' + C.fmt2(paths.min) + ' – Bs ' + C.fmt2(paths.max);
      }
    } else if (meta) {
      meta.textContent = rateSeriesLoading ? 'Cargando serie de los últimos 30 días…' : 'Sin histórico disponible ahora.';
    }
    var rec = C.recommendedReplenishmentRate(series, r.bcvUsd, r.binanceUsdt);
    var repVal = $('repRateVal'), repMeta = $('repRateMeta');
    if (rec && repVal) {
      repVal.textContent = 'Bs ' + C.fmt2(rec.rate) + ' / $';
      if (repMeta) repMeta.textContent = 'Paralelo hoy Bs ' + C.fmt2(rec.parToday) + ' · Promedio 7d Bs ' + C.fmt2(rec.avg7) + ' · Colchón tendencia +' + C.fmt1(rec.cushionPct) + '%';
    }
  }

  function syncAlertsForm(st) {
    var s = st.alertSettings || {};
    var gEn = $('alertGapEnabled'); if (gEn && document.activeElement !== gEn) gEn.checked = !!s.gapEnabled;
    var gPct = $('alertGapPct'); if (gPct && document.activeElement !== gPct) gPct.value = s.gapThresholdPct != null ? s.gapThresholdPct : 20;
    var rEn = $('alertRateEnabled'); if (rEn && document.activeElement !== rEn) rEn.checked = !!s.rateEnabled;
    var bAb = $('alertBcvAbove'); if (bAb && document.activeElement !== bAb) bAb.value = (typeof s.bcvAboveBs === 'number' && s.bcvAboveBs > 0) ? s.bcvAboveBs : '';
  }
  async function saveAlertsFromUI() {
    if (!requirePro('Configura alertas de brecha y avisos cuando el BCV publique tasa nueva.')) return;
    var b = bridge();
    var st = authState();
    var r = rates();
    var abv = parseFloat(String(($('alertBcvAbove') && $('alertBcvAbove').value) || '').replace(',', '.'));
    var payload = {
      gapEnabled: !!($('alertGapEnabled') && $('alertGapEnabled').checked),
      gapThresholdPct: C.toNum($('alertGapPct') && $('alertGapPct').value, 20),
      rateEnabled: !!($('alertRateEnabled') && $('alertRateEnabled').checked),
      bcvAboveBs: (isFinite(abv) && abv > 0) ? abv : null,
      lastSeenBcvDate: (st.alertSettings && st.alertSettings.lastSeenBcvDate) || r.bcvDate || null,
      lastSeenBcvUsd: (st.alertSettings && st.alertSettings.lastSeenBcvUsd) || (r.bcvUsd || null)
    };
    try {
      await b.saveAlertSettings(payload);
      toast('Alertas guardadas');
      evaluateProAlerts();
    } catch (e) {
      toast((e && e.message) || 'No se pudieron guardar las alertas');
    }
  }
  function evaluateProAlerts() {
    var st = authState();
    var banner = $('proAlertBanner');
    if (!st.isPro) { if (banner) banner.hidden = true; return; }
    var r = rates();
    var res = C.evaluateAlerts(st.alertSettings, { bcvUsd: r.bcvUsd, binanceUsdt: r.binanceUsdt, bcvDate: r.bcvDate }, alertRuntimeState);
    alertRuntimeState = res.state;
    if (res.seen && bridge() && (st.alertSettings.rateEnabled || !st.alertSettings.lastSeenBcvDate)) {
      bridge().saveAlertSettings(Object.assign({}, st.alertSettings, { lastSeenBcvDate: res.seen.date, lastSeenBcvUsd: res.seen.usd })).catch(function () {});
    }
    if (res.alerts.length) {
      if (banner) {
        banner.innerHTML = '🔔 <b>Aviso Pro:</b> ' + res.alerts.map(function (a) { return esc(a.message); }).join(' · ')
          + ' <button type="button" class="btn-mini" id="btnDismissAlert">Entendido</button>';
        banner.hidden = false;
        var da = $('btnDismissAlert'); if (da) da.addEventListener('click', function () { banner.hidden = true; });
      }
      toast(res.alerts[0].message);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification('Calculadora de Márgenes Pro', { body: res.alerts.map(function (a) { return a.message; }).join('\n'), icon: 'icon-192x192.png' }); } catch (e) {}
      }
    }
  }

  /* ===== Cableado ===== */
  function wire() {
    document.addEventListener('click', function (e) {
      var gp = e.target.closest ? e.target.closest('[data-go-pro]') : null;
      if (gp) { e.preventDefault(); goToPlans(gp.getAttribute('data-go-pro')); return; }
      var cp = e.target.closest ? e.target.closest('[data-copy-txt]') : null;
      if (cp) {
        var txt = cp.getAttribute('data-copy-txt');
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(function () { toast('Copiado'); });
        return;
      }
      var pp = e.target.closest ? e.target.closest('[data-choose-plan]') : null;
      if (pp) {
        selectedPlan = pp.getAttribute('data-choose-plan') || 'annual';
        renderPlansPage();
        var pb = $('paymentBox'); if (pb) pb.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      var pSel = e.target.closest ? e.target.closest('[data-pay-plan]') : null;
      if (pSel) { selectedPlan = pSel.getAttribute('data-pay-plan'); if (payStatusMsg && payStatusMsg.tone !== 'ok') payStatusMsg = null; renderPlansPage(); return; }
      var mSel = e.target.closest ? e.target.closest('[data-pay-method]') : null;
      if (mSel) {
        selectedMethod = mSel.getAttribute('data-pay-method');
        var btnManHide = $('btnSubmitManualFallback');
        if (btnManHide) btnManHide.hidden = true;
        if (payStatusMsg && payStatusMsg.tone !== 'ok') payStatusMsg = null;
        renderPlansPage();
        return;
      }
      var repBtn = e.target.closest ? e.target.closest('[data-rep-period]') : null;
      if (repBtn) { reportPeriod = repBtn.getAttribute('data-rep-period'); renderReports(); return; }
      var adAct = e.target.closest ? e.target.closest('[data-admin-act]') : null;
      if (adAct) {
        adminExecuteChange({
          action: 'activate',
          uid: adAct.getAttribute('data-admin-uid') || '',
          email: adAct.getAttribute('data-admin-email') || '',
          plan: adAct.getAttribute('data-admin-act') || 'monthly',
          days: adAct.getAttribute('data-admin-days') ? Number(adAct.getAttribute('data-admin-days')) : undefined,
          note: String(($('adminNote') && $('adminNote').value) || '').trim() || (adAct.getAttribute('data-admin-days') === '30' ? 'Regalo 1 mes' : 'Activado por admin')
        });
        return;
      }
      var adDeact = e.target.closest ? e.target.closest('[data-admin-deact]') : null;
      if (adDeact) {
        adminExecuteChange({
          action: 'deactivate',
          uid: adDeact.getAttribute('data-admin-uid') || '',
          email: adDeact.getAttribute('data-admin-email') || '',
          note: String(($('adminNote') && $('adminNote').value) || '').trim() || 'Desactivado por admin'
        });
        return;
      }
    });

    var bAdRef = $('btnAdminRefresh'); if (bAdRef) bAdRef.addEventListener('click', function () { loadAdminOverview(false); });
    var bAdLkp = $('btnAdminLookup'); if (bAdLkp) bAdLkp.addEventListener('click', adminLookupFlow);
    var adFilt = $('adminTableFilter'); if (adFilt) adFilt.addEventListener('input', function () { renderAdminSection(authState()); });
    var bAdAct = $('btnAdminActivate'); if (bAdAct) bAdAct.addEventListener('click', function () {
      var email = String(($('adminSearchEmail') && $('adminSearchEmail').value) || '').trim();
      var uid = (adminLookupUser && email.toLowerCase() === String(adminLookupUser.email || '').toLowerCase()) ? adminLookupUser.uid : '';
      if (!email && !uid) { toast('Escribe el correo de la cuenta a activar'); return; }
      var planId = ($('adminPlanSelect') && $('adminPlanSelect').value) || 'monthly';
      var rawDays = String(($('adminCustomDays') && $('adminCustomDays').value) || '').trim();
      var note = String(($('adminNote') && $('adminNote').value) || '').trim();
      adminExecuteChange({
        action: 'activate',
        uid: uid || undefined,
        email: email,
        plan: planId,
        days: rawDays ? Number(rawDays) : undefined,
        note: note || 'Activado desde panel admin'
      });
    });
    var bAdDeact = $('btnAdminDeactivate'); if (bAdDeact) bAdDeact.addEventListener('click', function () {
      var email = String(($('adminSearchEmail') && $('adminSearchEmail').value) || '').trim();
      var uid = (adminLookupUser && email.toLowerCase() === String(adminLookupUser.email || '').toLowerCase()) ? adminLookupUser.uid : '';
      if (!email && !uid) { toast('Escribe el correo de la cuenta a desactivar'); return; }
      var note = String(($('adminNote') && $('adminNote').value) || '').trim();
      adminExecuteChange({
        action: 'deactivate',
        uid: uid || undefined,
        email: email,
        note: note || 'Desactivado desde panel admin'
      });
    });

    var cgm = $('btnCloseGateModal'); if (cgm) cgm.addEventListener('click', closeGateModal);
    var gm = $('proGateModal'); if (gm) gm.addEventListener('click', function (e) { if (e.target === gm) closeGateModal(); });

    var bCreateOrder = $('btnCreateOrder'); if (bCreateOrder) bCreateOrder.addEventListener('click', function () { createOrderFlow(false); });
    var bSubPay = $('btnSubmitPayment'); if (bSubPay) bSubPay.addEventListener('click', submitPayment);
    var bSubMan = $('btnSubmitManualFallback'); if (bSubMan) bSubMan.addEventListener('click', submitManualFallback);
    var bLote = $('btnCalcLote'); if (bLote) bLote.addEventListener('click', runBatch);
    var bXlsxLote = $('btnXlsxLote'); if (bXlsxLote) bXlsxLote.addEventListener('click', exportBatchXlsx);
    var bCopyLote = $('btnCopyLote'); if (bCopyLote) bCopyLote.addEventListener('click', function () {
      if (!requirePro()) return;
      var ok = lastBatchResults.filter(function (r) { return !r.error; });
      if (!ok.length) { toast('Calcula primero una lista'); return; }
      var txt = ok.map(function (r) { return (r.name || ('Producto ' + r.n)) + ' = Bs ' + C.fmt2(r.precioFinal) + ' ($' + C.fmt2(r.precioUsd) + ')'; }).join('\n');
      navigator.clipboard.writeText(txt).then(function () { toast('Lista del lote copiada'); });
    });
    ['loteMode', 'loteRate', 'loteMargen', 'loteComTotal', 'loteGasto', 'loteRound'].forEach(function (id) {
      var el = $(id); if (el) el.addEventListener('change', function () { el.dataset.dirty = '1'; });
    });

    var bReval = $('btnRevalueCatalog'); if (bReval) bReval.addEventListener('click', openRevalModal);
    var bCloseReval = $('btnCloseReval'); if (bCloseReval) bCloseReval.addEventListener('click', function () { $('revalModal').hidden = true; });
    var bApplyReval = $('btnApplyReval'); if (bApplyReval) bApplyReval.addEventListener('click', applyRevaluation);
    var rTarget = $('revalTargetSource'); if (rTarget) rTarget.addEventListener('change', computeRevaluationView);

    var bImp = $('btnOpenImport'); if (bImp) bImp.addEventListener('click', openImportModal);
    var bCloseImp = $('btnCloseImport'); if (bCloseImp) bCloseImp.addEventListener('click', function () { $('importModal').hidden = true; });
    var impIn = $('importFileInput'); if (impIn) impIn.addEventListener('change', handleImportFile);
    var bConfImp = $('btnConfirmImport'); if (bConfImp) bConfImp.addEventListener('click', confirmImport);
    var bTplX = $('btnTplXlsx'); if (bTplX) bTplX.addEventListener('click', function () {
      downloadBytes(F.xlsxBuild([{ name: 'Plantilla productos', rows: C.IMPORT_TEMPLATE_ROWS }]), 'plantilla-productos-margenes.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    });
    var bTplC = $('btnTplCsv'); if (bTplC) bTplC.addEventListener('click', function () {
      downloadBytes(F.csvBuild(C.IMPORT_TEMPLATE_ROWS, ';'), 'plantilla-productos-margenes.csv', 'text/csv;charset=utf-8');
    });

    var bSaveBiz = $('btnSaveBizName'); if (bSaveBiz) bSaveBiz.addEventListener('click', async function () {
      var b = bridge(), st = authState();
      if (!st.user) { toast('Inicia sesión para guardar el nombre del negocio'); return; }
      try {
        await b.saveProfileSettings(($('shareBusinessName') && $('shareBusinessName').value) || '');
        toast('Nombre del negocio guardado');
      } catch (e) { toast('No se pudo guardar el nombre'); }
    });
    var bImg = $('btnShareImage'); if (bImg) bImg.addEventListener('click', exportPriceListImage);
    var bPdf = $('btnSharePdf'); if (bPdf) bPdf.addEventListener('click', exportPriceListPdf);

    var bRepX = $('btnExportReportXlsx'); if (bRepX) bRepX.addEventListener('click', exportReportsXlsx);
    var bRepP = $('btnExportReportPdf'); if (bRepP) bRepP.addEventListener('click', exportReportsPdf);

    var bSaveAl = $('btnSaveAlerts'); if (bSaveAl) bSaveAl.addEventListener('click', saveAlertsFromUI);
    var bEnNotif = $('btnEnableNotif'); if (bEnNotif) bEnNotif.addEventListener('click', function () {
      if (!requirePro()) return;
      if (typeof Notification === 'undefined') { toast('Tu navegador no admite notificaciones'); return; }
      Notification.requestPermission().then(function (perm) {
        toast(perm === 'granted' ? 'Notificaciones activadas en este navegador' : 'Permiso de notificaciones no concedido');
      });
    });
    var bApplyRep = $('btnApplyRepRate'); if (bApplyRep) bApplyRep.addEventListener('click', function () {
      if (!requirePro()) return;
      var rec = C.recommendedReplenishmentRate(rateSeriesCache || [], rates().bcvUsd, rates().binanceUsdt);
      if (!rec) return;
      if (root.selectRateSource) root.selectRateSource('custom', rec.rate);
      if (root.setDashboardTab) root.setDashboardTab('calc');
      toast('Tasa de reposición aplicada: Bs ' + C.fmt2(rec.rate));
    });
  }

  root.__margenesOnTabChange = function (tabId) {
    if (tabId === 'pro') {
      renderPlansPage();
      if (!remotePayConfig) loadRemotePayConfig();
      var st = authState();
      if (isAdminUser(st) && (!adminOverview || adminLoadedUid !== (st.user && st.user.uid))) {
        loadAdminOverview(true);
      }
    }
    else if (tabId === 'lote') syncLoteDefaultsFromCalc();
    else if (tabId === 'hist') renderReports();
    else if (tabId === 'tasas' && authState().isPro) loadRateHistory30();
  };

  var api = {
    promptUpgrade: promptUpgrade,
    goToPlans: goToPlans,
    onStateChange: function (st) {
      var bizIn = $('shareBusinessName');
      if (bizIn && document.activeElement !== bizIn && !bizIn.value && st.profileSettings && st.profileSettings.businessName) {
        bizIn.value = st.profileSettings.businessName;
      }
      renderHeaderAndLocks();
      syncAlertsForm(st);
      renderPlansPage();
      renderReports();
      if (st.isPro) {
        loadRateHistory30();
        evaluateProAlerts();
      }
    },
    onRatesUpdated: function () {
      renderPlansPage();
      evaluateProAlerts();
      if (authState().isPro) renderRateChartAndRep();
    }
  };
  root.ProUI = api;
  wire();
  renderHeaderAndLocks();
  renderPlansPage();
})(window);
