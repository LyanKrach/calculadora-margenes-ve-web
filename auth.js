/* auth.js — cuentas (Google + correo/contraseña), historial de cálculos y
 * productos guardados, con Firebase (SDK modular vía CDN, sin build).
 * La calculadora funciona como invitada sin sesión; el historial y los
 * productos exigen haber entrado. Si firebase-config.js aún tiene los
 * valores de ejemplo, Firebase queda desactivado y se avisa en pantalla.
 *
 * ESQUEMA COMPARTIDO CON LA APP FLUTTER (mismo proyecto, mismos usuarios):
 * historial en users/{uid}/history y productos en users/{uid}/products, con
 * los mismos campos y unidades de la app (ver README). La app lee el campo
 * 'id' DENTRO de cada documento y parsea las fechas como strings ISO-8601,
 * así que la web genera el ID del documento antes de escribirlo y nunca usa
 * serverTimestamp(). marginPercent va en porcentaje y las comisiones en
 * fracción; marginMode siempre es 'onSale' (la fórmula de esta web es
 * margen sobre el precio de venta).
 */
(function () {
  'use strict';

  var FIREBASE_VERSION = '11.1.0';
  var SDK = function (name) { return 'https://www.gstatic.com/firebasejs/' + FIREBASE_VERSION + '/' + name; };

  var $ = function (id) { return document.getElementById(id); };
  var fmtBs = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var fmtBs0 = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  var fmtFecha = new Intl.DateTimeFormat('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  var F = null; // módulos de Firebase cargados por CDN
  var auth = null, db = null;
  var user = null;
  var firebaseOn = false;
  var unsubHist = null, unsubProd = null;
  var unsubSubCur = null, unsubSubPend = null, unsubProf = null, unsubAlerts = null;
  var expiryTimer = null;
  var histQueryIsPro = null;
  var authMode = 'login'; // 'login' | 'register'
  var histItems = [];
  var prodItems = [];
  var subCurrent = null;
  var subPending = null;
  var profileSettings = { businessName: '' };
  var alertSettings = { gapEnabled: false, gapThresholdPct: 20, rateEnabled: false, bcvAboveBs: null, lastSeenBcvDate: null, lastSeenBcvUsd: null };
  var afterLoginAction = null;

  function currentSubState() {
    return window.ProCore ? window.ProCore.subscriptionState(subCurrent) : { isPro: false, status: 'free', plan: null, endDate: '', startDate: '', daysLeft: 0 };
  }
  function isProUser() {
    return currentSubState().isPro;
  }
  function getBridgeState() {
    return {
      firebaseOn: firebaseOn,
      user: user ? { uid: user.uid, email: user.email || '', displayName: user.displayName || '', emailVerified: !!user.emailVerified } : null,
      isPro: isProUser(),
      subState: currentSubState(),
      subCurrent: subCurrent,
      subPending: subPending,
      prodItems: prodItems.map(function (it) { return { id: it.id, data: normalizeProduct(it.data), raw: it.data }; }),
      histItems: histItems.slice(),
      profileSettings: Object.assign({}, profileSettings),
      alertSettings: Object.assign({}, alertSettings)
    };
  }
  function notifyProUI() {
    if (window.ProUI && typeof window.ProUI.onStateChange === 'function') {
      try { window.ProUI.onStateChange(getBridgeState()); } catch (e) { console.error(e); }
    }
  }
  function scheduleExpiryTimer() {
    if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
    if (!window.ProCore || !subCurrent) return;
    var ms = window.ProCore.msUntilExpiry(subCurrent);
    if (ms == null) return;
    // setTimeout tiene límite de ~24,8 días (2^31-1 ms): si falta más, reevaluamos en 20 días.
    var delay = Math.min(ms + 1000, 1728000000);
    expiryTimer = setTimeout(function () {
      scheduleExpiryTimer();
      handleSubscriptionTransition();
    }, delay);
  }
  function handleSubscriptionTransition() {
    var pro = isProUser();
    if (user && histQueryIsPro !== pro) {
      subscribeHistory();
    } else {
      renderHistory();
    }
    renderProducts();
    notifyProUI();
  }
  function stopSubAndSettings() {
    if (unsubSubCur) { unsubSubCur(); unsubSubCur = null; }
    if (unsubSubPend) { unsubSubPend(); unsubSubPend = null; }
    if (unsubProf) { unsubProf(); unsubProf = null; }
    if (unsubAlerts) { unsubAlerts(); unsubAlerts = null; }
    if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
    histQueryIsPro = null;
    subCurrent = null;
    subPending = null;
    profileSettings = { businessName: '' };
    alertSettings = { gapEnabled: false, gapThresholdPct: 20, rateEnabled: false, bcvAboveBs: null, lastSeenBcvDate: null, lastSeenBcvUsd: null };
  }
  function subscribeSubAndSettings() {
    stopSubAndSettings();
    if (!user || !db) return;
    unsubSubCur = F.fs.onSnapshot(
      F.fs.doc(db, 'users', user.uid, 'subscription', 'current'),
      function (snap) {
        subCurrent = snap.exists() ? (snap.data() || null) : null;
        scheduleExpiryTimer();
        handleSubscriptionTransition();
      },
      function (e) { console.warn('subscription/current read:', e); }
    );
    unsubSubPend = F.fs.onSnapshot(
      F.fs.doc(db, 'users', user.uid, 'subscription', 'pending'),
      function (snap) {
        subPending = snap.exists() ? (snap.data() || null) : null;
        notifyProUI();
      },
      function (e) { console.warn('subscription/pending read:', e); }
    );
    unsubProf = F.fs.onSnapshot(
      F.fs.doc(db, 'users', user.uid, 'settings', 'profile'),
      function (snap) {
        profileSettings = snap.exists() ? Object.assign({ businessName: '' }, snap.data() || {}) : { businessName: '' };
        notifyProUI();
      },
      function () {}
    );
    unsubAlerts = F.fs.onSnapshot(
      F.fs.doc(db, 'users', user.uid, 'settings', 'alerts'),
      function (snap) {
        alertSettings = snap.exists()
          ? Object.assign({ gapEnabled: false, gapThresholdPct: 20, rateEnabled: false, bcvAboveBs: null, lastSeenBcvDate: null, lastSeenBcvUsd: null }, snap.data() || {})
          : { gapEnabled: false, gapThresholdPct: 20, rateEnabled: false, bcvAboveBs: null, lastSeenBcvDate: null, lastSeenBcvUsd: null };
        notifyProUI();
      },
      function () {}
    );
  }

  function toast(msg) {
    var t = $('toast');
    if (!t) { alert(msg); return; }
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function numVal(id, def) {
    var el = $(id);
    if (!el) return def || 0;
    var v = parseFloat(String(el.value).replace(',', '.'));
    return isNaN(v) || v < 0 ? (def || 0) : v;
  }
  function setInput(id, v) {
    var el = $(id);
    if (!el) return;
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ===== Esquema compartido con la app Flutter ===== */
  var RATE_SOURCE_MAP = { bcv: 'bcvUsd', binance: 'binanceUsdt', euro: 'euroBcv', custom: 'custom' };
  // La fuente de tasa activa se lee de la tarjeta marcada en la página
  // (app.js marca la activa con la clase .active; la clave no es global).
  function currentRateSourceName() {
    var card = document.querySelector('.rate-card.active');
    var key = card ? card.getAttribute('data-rate') : '';
    if (RATE_SOURCE_MAP[key]) return RATE_SOURCE_MAP[key];
    var lbl = ($('tasaFuenteLabel') && $('tasaFuenteLabel').textContent) || '';
    if (lbl.indexOf('Binance') !== -1) return 'binanceUsdt';
    if (lbl.indexOf('Euro') !== -1) return 'euroBcv';
    if (lbl.indexOf('Personalizada') !== -1) return 'custom';
    return 'bcvUsd';
  }
  function currentRoundStep() {
    var v = parseInt(($('redondeo') && $('redondeo').value) || '10', 10);
    return [1, 10, 50, 100].indexOf(v) !== -1 ? v : 10;
  }
  function pctToFrac(v) { // % (ej. 1.5) -> fracción (ej. 0.015)
    var n = parseFloat(v);
    return (isNaN(n) || n < 0) ? 0 : Math.round(n * 10000) / 1000000;
  }
  function fracToPct(v) { // fracción (ej. 0.015) -> % (ej. 1.5)
    var n = parseFloat(v);
    return isNaN(n) ? 0 : Math.round(n * 10000) / 100;
  }
  function isoDate(v) {
    // Acepta string ISO, Date o Timestamp de Firestore; devuelve string ISO o ''.
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (v instanceof Date) return v.toISOString();
    if (v.toDate) { try { return v.toDate().toISOString(); } catch (e) { return ''; } }
    return '';
  }
  // Referencia a un documento nuevo con ID generado por el cliente: el ID se
  // guarda también DENTRO del documento (campo 'id'), como exige la app.
  function newDocRef(colName) {
    return F.fs.doc(F.fs.collection(db, 'users', user.uid, colName));
  }
  // Normaliza un producto leído de Firestore al esquema de la app. Como
  // respaldo entiende el esquema viejo de la web (nombre, margenSugerido,
  // comisiones en %, Timestamps) para no perder datos ya guardados.
  function normalizeProduct(d) {
    d = d || {};
    var comP = (d.commissionPlatform != null) ? d.commissionPlatform : pctToFrac(d.comProveedor);
    var comPa = (d.commissionPaymentMethod != null) ? d.commissionPaymentMethod : pctToFrac(d.comPasarela);
    var comO = (d.commissionOther != null) ? d.commissionOther : pctToFrac(d.comOtra);
    var rawCat = (d.category != null) ? d.category : (d.categoria != null ? d.categoria : '');
    return {
      name: (d.name != null ? d.name : d.nombre || '').toString().trim(),
      category: String(rawCat).trim(),
      costUsd: d.costUsd || 0,
      marginPercent: (d.marginPercent != null) ? d.marginPercent : (d.margenSugerido || 0),
      fixedExpenseBs: d.fixedExpenseBs || d.gastoFijo || 0,
      commissionPlatform: comP,
      commissionPaymentMethod: comPa,
      commissionOther: comO,
      roundStep: (d.roundStep != null) ? d.roundStep : 10,
      rateSourceName: d.rateSourceName || 'bcvUsd',
      marginMode: d.marginMode || 'onCost',
      customRateValue: (typeof d.customRateValue === 'number') ? d.customRateValue : null,
      createdAt: isoDate(d.createdAt),
      updatedAt: isoDate(d.updatedAt)
    };
  }

  function extractUniqueCategories(items) {
    var byLower = {};
    var list = [];
    (items || []).forEach(function (entry) {
      var raw = entry && entry.data ? normalizeProduct(entry.data) : normalizeProduct(entry);
      var cat = (raw.category || '').trim();
      if (!cat) return;
      var low = cat.toLowerCase();
      if (!byLower[low]) {
        byLower[low] = cat;
        list.push(cat);
      }
    });
    list.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
    return list;
  }

  function compareNaturalProductNames(a, b) {
    var tokRe = /\d+|\D+/g;
    var ta = String(a || '').trim().match(tokRe) || [];
    var tb = String(b || '').trim().match(tokRe) || [];
    var n = Math.min(ta.length, tb.length);
    for (var i = 0; i < n; i++) {
      var sa = ta[i], sb = tb[i];
      var isNumA = /^\d+$/.test(sa), isNumB = /^\d+$/.test(sb);
      if (isNumA && isNumB) {
        var diff = parseInt(sa, 10) - parseInt(sb, 10);
        if (diff !== 0) return diff;
        if (sa.length !== sb.length) return sa.length - sb.length;
        continue;
      }
      if (isNumA && !isNumB) return -1;
      if (!isNumA && isNumB) return 1;
      var cmp = sa.trim().toLowerCase().localeCompare(sb.trim().toLowerCase());
      if (cmp !== 0) return cmp;
    }
    return ta.length - tb.length;
  }

  function prefixIconForProduct(name, category) {
    var t = String(name || '').trim();
    if (!t) return '• ';
    if (!/^[A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ]/.test(t)) return '';
    var low = (t + ' ' + String(category || '')).toLowerCase();
    if (/diamant|diamond|robux|gema|\buc\b|\bcp\b|moneda|coin/.test(low)) return '💎 ';
    if (/\bpase\b|booyah|\bvip\b|elite|promo|oferta/.test(low)) return '🔥 ';
    if (/tarjeta|card|gift|\bpin\b|c[oó]digo|vale/.test(low)) return '💳 ';
    if (/paquete|combo|\bpack\b|\bkit\b|nivel/.test(low)) return '📦 ';
    return '• ';
  }

  function formatRateLabel(rateSourceName, customRateValue) {
    var snap = window.getRatesSnapshot ? window.getRatesSnapshot() : null;
    if (rateSourceName === 'binanceUsdt') {
      return 'Binance USDT' + (snap && snap.binanceUsdt ? ' (' + fmtBs.format(snap.binanceUsdt) + ')' : '');
    }
    if (rateSourceName === 'euroBcv') {
      return 'BCV Euro' + (snap && snap.euroBcv ? ' (' + fmtBs.format(snap.euroBcv) + ')' : '');
    }
    if (rateSourceName === 'custom') {
      var rv = customRateValue || (snap && snap.custom) || 0;
      return 'Personalizada' + (rv > 0 ? ' (' + fmtBs.format(rv) + ')' : '');
    }
    return 'BCV dólar' + (snap && snap.bcvUsd ? ' (' + fmtBs.format(snap.bcvUsd) + ')' : '');
  }

  function buildWhatsAppPriceList(opts) {
    var items = opts.items || [];
    var selectedCats = opts.selectedCategories || {};
    var includeUncat = !!opts.includeUncategorized;
    var overrideRate = opts.overrideRate || '';
    var metricFn = opts.calcMetricsFn || window.calcProductMetrics;

    var grouped = {};
    var labels = {};
    items.forEach(function (entry) {
      var d = entry && entry.data ? normalizeProduct(entry.data) : normalizeProduct(entry);
      var cat = (d.category || '').trim();
      var low = cat.toLowerCase();
      var isInc = cat ? !!selectedCats[low] : includeUncat;
      if (!isInc) return;
      var key = cat ? low : '';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(d);
      if (cat && !labels[key]) labels[key] = cat;
    });

    var nonEmptyKeys = [];
    Object.keys(grouped).forEach(function (k) {
      grouped[k].sort(function (a, b) { return compareNaturalProductNames(a.name, b.name); });
      var priced = [];
      grouped[k].forEach(function (d) {
        var m = metricFn ? metricFn(d, overrideRate) : null;
        if (m && !m.error && m.precioFinal > 0) priced.push({ item: d, price: m.precioFinal });
      });
      grouped[k] = priced;
      if (priced.length) nonEmptyKeys.push(k);
    });
    if (!nonEmptyKeys.length) return '';

    nonEmptyKeys.sort(function (a, b) {
      if (a === '') return 1;
      if (b === '') return -1;
      return (labels[a] || a).toLowerCase().localeCompare((labels[b] || b).toLowerCase());
    });

    var namedCount = nonEmptyKeys.filter(function (k) { return k !== ''; }).length;
    var singleNamedOnly = nonEmptyKeys.length === 1 && namedCount === 1;
    var lines = [];
    if (singleNamedOnly) {
      lines.push('¡Hola! 🔥 Aquí tienes los precios de *' + labels[nonEmptyKeys[0]] + '*:');
    } else {
      lines.push('¡Hola! 🔥 Aquí tienes nuestra lista de precios:');
    }

    nonEmptyKeys.forEach(function (k) {
      lines.push('');
      if (!singleNamedOnly && nonEmptyKeys.length > 1) {
        lines.push('*' + (k === '' ? 'Otros productos' : labels[k]) + ':*');
      }
      grouped[k].forEach(function (row) {
        var icon = prefixIconForProduct(row.item.name, row.item.category);
        lines.push(icon + row.item.name + ' = ' + fmtBs.format(row.price) + ' Bs');
      });
    });
    return lines.join('\n').trim();
  }

  window.__margenesCatalogHelpers = {
    normalizeProduct: normalizeProduct,
    extractUniqueCategories: extractUniqueCategories,
    compareNaturalProductNames: compareNaturalProductNames,
    buildWhatsAppPriceList: buildWhatsAppPriceList
  };

  /* ===== Config y arranque ===== */
  function configLista() {
    var c = window.FIREBASE_CONFIG || {};
    var keys = ['apiKey', 'authDomain', 'projectId', 'appId'];
    for (var i = 0; i < keys.length; i++) {
      var v = c[keys[i]];
      if (!v || typeof v !== 'string' || v.indexOf('TU_') === 0) return false;
    }
    return true;
  }
  async function cargarConfigHostingSiFalta() {
    if (configLista()) return true;
    try {
      if (typeof location !== 'undefined' && location.protocol === 'file:') return false;
      var res = await fetch('/__/firebase/init.json', { cache: 'no-store' });
      if (!res.ok) return false;
      var cfg = await res.json();
      if (cfg && cfg.apiKey && cfg.projectId) {
        window.FIREBASE_CONFIG = cfg;
        return configLista();
      }
    } catch (e) { /* fuera de Firebase Hosting */ }
    return false;
  }
  function setFirebaseState(state) {
    var notice = $('fbNotice');
    if (notice) notice.hidden = (state !== 'noconfig' && state !== 'error');
    if (notice && state === 'error') notice.textContent = '⚠ No se pudo cargar Firebase (¿sin internet?). La calculadora sigue funcionando como invitada.';
  }

  async function initFirebase() {
    if (!(await cargarConfigHostingSiFalta())) { setFirebaseState('noconfig'); return; }
    try {
      var appMod = await import(SDK('firebase-app.js'));
      var authMod = await import(SDK('firebase-auth.js'));
      var fsMod = await import(SDK('firebase-firestore.js'));
      F = { app: appMod, auth: authMod, fs: fsMod };
      var fbApp = appMod.initializeApp(window.FIREBASE_CONFIG);
      auth = authMod.getAuth(fbApp);
      await authMod.setPersistence(auth, authMod.browserLocalPersistence);
      db = fsMod.getFirestore(fbApp);
      firebaseOn = true;
      try { await authMod.getRedirectResult(auth); } catch (e) { /* sin redirect pendiente */ }
      authMod.onAuthStateChanged(auth, onUser);
      setFirebaseState('ok');
    } catch (e) {
      console.error('Firebase no se pudo iniciar:', e);
      setFirebaseState('error');
      toast('No se pudo cargar Firebase (¿sin internet?). La calculadora sigue funcionando como invitada.');
    }
  }

  /* ===== Sesión y UI de cuenta ===== */
  function onUser(u) {
    user = u;
    var btnEntrar = $('btnEntrar');
    var chip = $('authUser');
    if (u) {
      if (btnEntrar) btnEntrar.hidden = true;
      if (chip) {
        chip.hidden = false;
        var nameEl = $('authUserName');
        if (nameEl) nameEl.textContent = u.displayName || u.email || 'Mi cuenta';
      }
      document.querySelectorAll('[data-needs-login]').forEach(function (el) { el.hidden = true; });
      var pb = $('prodBox'); if (pb) pb.hidden = false;
      var hb = $('histBox'); if (hb) hb.hidden = false;
      subscribeSubAndSettings();
      subscribeHistory();
      subscribeProducts();
      resetProdForm();
      notifyProUI();
      if (typeof afterLoginAction === 'function') {
        var cb = afterLoginAction;
        afterLoginAction = null;
        try { cb(u); } catch (e) {}
      }
    } else {
      if (btnEntrar) btnEntrar.hidden = false;
      if (chip) chip.hidden = true;
      document.querySelectorAll('[data-needs-login]').forEach(function (el) { el.hidden = false; });
      var pb2 = $('prodBox'); if (pb2) pb2.hidden = true;
      var hb2 = $('histBox'); if (hb2) hb2.hidden = true;
      stopSubAndSettings();
      if (unsubHist) { unsubHist(); unsubHist = null; }
      if (unsubProd) { unsubProd(); unsubProd = null; }
      histItems = []; prodItems = [];
      renderHistory(); renderProducts();
      notifyProUI();
    }
  }

  function showAuthError(e) {
    var box = $('authError');
    var msg = 'No se pudo entrar. Revisa los datos e inténtalo de nuevo.';
    if (e && e.code) {
      if (e.code === 'auth/invalid-credential' || e.code === 'auth/wrong-password' || e.code === 'auth/user-not-found') msg = 'Correo o contraseña incorrectos.';
      else if (e.code === 'auth/email-already-in-use') msg = 'Ese correo ya tiene cuenta. Entra con él en vez de crear otra.';
      else if (e.code === 'auth/weak-password') msg = 'La contraseña debe tener al menos 6 caracteres.';
      else if (e.code === 'auth/invalid-email') msg = 'Revisa el correo, no tiene formato válido.';
      else if (e.code === 'auth/too-many-requests') msg = 'Demasiados intentos. Espera un rato e inténtalo de nuevo.';
      else if (e.code === 'auth/network-request-failed') msg = 'Sin conexión. Revisa internet e inténtalo de nuevo.';
      else if (e.code === 'auth/operation-not-allowed') msg = 'Ese proveedor no está activado. Actívalo en la consola de Firebase → Authentication → Sign-in method.';
      else if (e.code === 'auth/configuration-not-found') msg = 'Falta la configuración de Firebase en firebase-config.js.';
    }
    if (box) { box.textContent = msg; box.classList.add('show'); }
    else { toast(msg); }
  }
  function clearAuthError() {
    var box = $('authError');
    if (box) { box.textContent = ''; box.classList.remove('show'); }
  }

  function openAuth() {
    var m = $('authModal');
    if (m) {
      m.hidden = false;
      m.style.display = 'grid';
    }
  }
  function closeAuth() {
    var m = $('authModal');
    if (m) {
      m.hidden = true;
      m.style.display = 'none';
    }
    clearAuthError();
  }
  function setAuthMode(mode) {
    authMode = mode;
    var isReg = mode === 'register';
    var t = $('authTitle'); if (t) t.textContent = isReg ? 'Crear cuenta' : 'Entrar';
    var s = $('btnAuthSubmit'); if (s) s.textContent = isReg ? 'Registrarme' : 'Entrar';
    var ln = $('lblNombre');
    if (ln) {
      ln.hidden = !isReg;
      ln.style.display = isReg ? 'flex' : 'none';
    }
    var wn = $('wrapNombre');
    if (wn) {
      wn.hidden = !isReg;
      wn.style.display = isReg ? 'flex' : 'none';
    }
    var lr = $('linkResetWrap');
    if (lr) {
      lr.hidden = isReg;
      lr.style.display = isReg ? 'none' : 'block';
    }
    var tl = $('tabLogin'); if (tl) tl.classList.toggle('active', !isReg);
    var tr = $('tabRegister'); if (tr) tr.classList.toggle('active', isReg);
    var pass = $('authPass'); if (pass) pass.setAttribute('autocomplete', isReg ? 'new-password' : 'current-password');
    var hint = $('authHint');
    if (hint) hint.textContent = isReg ? 'Tu cuenta guarda tu historial y tus productos en la nube.' : '';
    clearAuthError();
  }
  function showReset(show) {
    var fb = $('authFormBox'); if (fb) fb.hidden = show;
    var rb = $('authResetBox'); if (rb) rb.hidden = !show;
    clearAuthError();
  }

  async function loginGoogle() {
    if (!firebaseOn) { toast('Primero pega tu config de Firebase en firebase-config.js'); return; }
    var provider = new F.auth.GoogleAuthProvider();
    try {
      await F.auth.signInWithPopup(auth, provider);
      closeAuth();
      toast('Sesión iniciada con Google');
    } catch (e) {
      if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/popup-closed-by-user' || e.code === 'auth/operation-not-supported-in-this-environment' || e.code === 'auth/cancelled-popup-request')) {
        try { await F.auth.signInWithRedirect(auth, provider); }
        catch (e2) { showAuthError(e2); }
      } else { showAuthError(e); }
    }
  }
  async function submitEmail() {
    if (!firebaseOn) { toast('Primero pega tu config de Firebase en firebase-config.js'); return; }
    var email = ($('authEmail').value || '').trim();
    var pass = $('authPass').value || '';
    if (!email || !pass) { showAuthError({ code: 'auth/invalid-email' }); return; }
    clearAuthError();
    try {
      if (authMode === 'register') {
        var nombre = ($('authNombre').value || '').trim();
        if (pass.length < 6) { showAuthError({ code: 'auth/weak-password' }); return; }
        var cred = await F.auth.createUserWithEmailAndPassword(auth, email, pass);
        if (nombre) await F.auth.updateProfile(cred.user, { displayName: nombre });
        toast('Cuenta creada. Bienvenido' + (nombre ? ', ' + nombre : ''));
      } else {
        await F.auth.signInWithEmailAndPassword(auth, email, pass);
        toast('Sesión iniciada');
      }
      closeAuth();
    } catch (e) { showAuthError(e); }
  }
  async function sendReset() {
    if (!firebaseOn) { toast('Primero pega tu config de Firebase en firebase-config.js'); return; }
    var email = ($('resetEmail').value || '').trim();
    var msg = $('resetMsg');
    if (!email) {
      if (msg) { msg.textContent = 'Escribe tu correo para enviarte el enlace.'; msg.classList.add('show'); }
      return;
    }
    try {
      await F.auth.sendPasswordResetEmail(auth, email);
      if (msg) { msg.textContent = 'Listo. Revisa tu correo: te llegó un enlace para crear una contraseña nueva.'; msg.classList.add('show'); }
    } catch (e) {
      if (msg) { msg.textContent = 'No se pudo enviar. Revisa el correo e inténtalo de nuevo.'; msg.classList.add('show'); }
    }
  }

  /* ===== Historial: users/{uid}/history (mismo esquema que la app Flutter) ===== */
  function currentCalculation() {
    var last = window.__margenesLast;
    if (!last) return null;
    // app.js entrega margen y comisiones en PORCENTAJE; la app los guarda
    // como marginPercent (porcentaje) y comisiones (fracción).
    return {
      title: last.producto,
      costUsd: last.costoUsd,
      marginPercent: last.margen,
      fixedExpenseBs: last.gasto,
      commissionPlatform: pctToFrac(last.comP),
      commissionPaymentMethod: pctToFrac(last.comPa),
      commissionOther: pctToFrac(last.comO),
      roundStep: currentRoundStep(),
      rateSourceName: currentRateSourceName(),
      marginMode: (window.getMarginMode ? window.getMarginMode() : 'onCost'),
      rateValue: last.tasa,
      finalPriceBs: last.precioFinal,
      precioExactoBs: last.precioExacto, // extras: la app los ignora
      gananciaBs: last.gananciaBs
    };
  }
  async function saveCalculation(silent) {
    if (!user) { toast('Inicia sesión para guardar tus cálculos en el historial'); return false; }
    var c = currentCalculation();
    // La app descarta entradas con costo, tasa o precio final <= 0.
    if (!c || c.costUsd <= 0 || c.rateValue <= 0 || c.finalPriceBs <= 0) { toast('Revisa los números: ese cálculo no es válido para guardar'); return false; }
    try {
      var ref = newDocRef('history');
      c.v = 1;
      c.id = ref.id;
      c.timestamp = new Date().toISOString();
      await F.fs.setDoc(ref, c);
      if (!silent) toast('Cálculo guardado en tu historial');
      return true;
    } catch (e) {
      console.error(e);
      toast('No se pudo guardar el cálculo');
      return false;
    }
  }
  // Guardado automático al pulsar "Copiar precio" (app.js llama a este hook).
  // Como invitado no hace nada en silencio: el historial pide sesión en su sección.
  window.__margenesOnCopyPrice = function () {
    if (!user) return;
    saveCalculation(true).then(function (ok) {
      if (ok) toast('Precio copiado y cálculo guardado en tu historial');
    });
  };

  function subscribeHistory() {
    if (unsubHist) { unsubHist(); unsubHist = null; }
    if (!user || !db) return;
    var pro = isProUser();
    histQueryIsPro = pro;
    var colRef = F.fs.collection(db, 'users', user.uid, 'history');
    var q = (!pro && window.ProCore)
      ? F.fs.query(
          colRef,
          F.fs.where('timestamp', '>=', window.ProCore.historyCutoffIso()),
          F.fs.orderBy('timestamp', 'desc'),
          F.fs.limit(window.ProCore.FREE_LIMITS.historyItems)
        )
      : F.fs.query(
          colRef,
          F.fs.orderBy('timestamp', 'desc'),
          F.fs.limit(window.ProCore ? window.ProCore.PRO_HISTORY_READ_CAP : 1000)
        );
    unsubHist = F.fs.onSnapshot(q, function (snap) {
      var raw = [];
      snap.forEach(function (d) { raw.push({ id: d.id, data: d.data() }); });
      histItems = window.ProCore ? window.ProCore.applyHistoryPolicy(raw, isProUser()) : raw;
      renderHistory();
      notifyProUI();
    }, function (e) { console.error(e); toast('No se pudo leer tu historial'); });
  }
  function renderHistory() {
    var b = $('badgeHist');
    if (b) {
      b.textContent = histItems.length;
      b.hidden = histItems.length === 0;
    }
    var hintEl = $('histPlanHint');
    if (hintEl) {
      if (isProUser()) {
        hintEl.textContent = 'Plan Pro activo · Historial ilimitado (' + histItems.length + ' cálculos).';
      } else {
        hintEl.textContent = 'Plan Gratis: últimos 30 días o 50 cálculos, lo que se cumpla primero (' + histItems.length + ' visibles).';
      }
    }
    var list = $('histList');
    if (!list) return;
    var empty = $('histEmpty');
    if (empty) empty.style.display = histItems.length ? 'none' : '';
    var html = '';
    histItems.forEach(function (it) {
      var d = it.data;
      var ts = d.timestamp ? new Date(d.timestamp) : null;
      var fecha = (ts && !isNaN(ts.getTime())) ? fmtFecha.format(ts) : 'ahora mismo';
      // gananciaBs es un extra que solo escribe la web; las entradas de la
      // app no lo traen y entonces no se muestra.
      var gan = (typeof d.gananciaBs === 'number')
        ? '<span class="green">+ Bs ' + fmtBs.format(d.gananciaBs) + '</span>' : '';
      var modeLabel = (d.marginMode === 'onCost') ? 's/costo' : 's/venta';
      html += '<div class="item-row">'
        + '<div class="item-meta"><b>' + esc(d.title || 'Producto') + '</b>'
        + '<span>' + esc(fecha) + ' · Tasa Bs ' + fmtBs.format(d.rateValue || 0) + ' (' + modeLabel + ')</span></div>'
        + '<div class="item-vals"><strong>Bs ' + fmtBs0.format(d.finalPriceBs || 0) + '</strong>'
        + gan + '</div>'
        + '<div class="item-actions"><button type="button" class="btn-mini" data-load-hist="' + it.id + '">Cargar</button>'
        + '<button type="button" class="btn-mini danger" data-del-hist="' + it.id + '">✕</button></div></div>';
    });
    list.innerHTML = html;
  }
  function loadHistory(id) {
    var it = null;
    for (var i = 0; i < histItems.length; i++) { if (histItems[i].id === id) { it = histItems[i]; break; } }
    if (!it) return;
    var d = it.data;
    setInput('producto', d.title || '');
    setInput('costoUsd', d.costUsd || 0);
    setInput('tasa', d.rateValue || 0);
    setInput('margen', d.marginPercent || 0);
    setInput('comProveedor', fracToPct(d.commissionPlatform));
    setInput('comPasarela', fracToPct(d.commissionPaymentMethod));
    setInput('comOtra', fracToPct(d.commissionOther));
    setInput('gastoFijo', d.fixedExpenseBs || 0);
    if (window.setMarginMode) window.setMarginMode(d.marginMode || 'onSale');
    var r = $('redondeo');
    if (r && d.roundStep && r.querySelector('option[value="' + d.roundStep + '"]')) {
      r.value = String(d.roundStep);
      r.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (window.setDashboardTab) window.setDashboardTab('calc');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('Cálculo cargado en la calculadora');
  }
  async function deleteHistory(id) {
    if (!user) return;
    try { await F.fs.deleteDoc(F.fs.doc(db, 'users', user.uid, 'history', id)); }
    catch (e) { toast('No se pudo borrar ese cálculo'); }
  }
  async function clearHistory() {
    if (!user) return;
    if (!histItems.length) { toast('Tu historial ya está vacío'); return; }
    if (!window.confirm('¿Borrar todo tu historial de cálculos? No se puede deshacer.')) return;
    try {
      var batch = F.fs.writeBatch(db);
      histItems.forEach(function (it) { batch.delete(F.fs.doc(db, 'users', user.uid, 'history', it.id)); });
      await batch.commit();
      toast('Historial limpio');
    } catch (e) { toast('No se pudo limpiar el historial'); }
  }

  /* ===== Productos: users/{uid}/products (mismo esquema que la app Flutter) ===== */
  var backfilledProds = {};
  // Migración única de productos viejos de la web al esquema de la app: les
  // pone el campo 'id', convierte las fechas a strings ISO y deja las
  // comisiones en fracción, para que la app también pueda leerlos.
  var catalogOverrideRate = '';
  var shareSelectedCats = {};
  var shareIncludeUncat = false;

  function currentProdRateSource() {
    var el = $('prodRateSource');
    return (el && el.value) ? el.value : currentRateSourceName();
  }

  function currentProdRoundStep() {
    var el = $('prodRoundStep');
    var v = parseInt((el && el.value) || '10', 10);
    return [0, 1, 10, 50, 100].indexOf(v) !== -1 ? v : 10;
  }

  function toggleNewCatWrap(show) {
    var w = $('prodCatNewWrap');
    if (w) w.hidden = !show;
  }

  function toggleCustomRateWrap(show) {
    var w = $('prodCustomRateWrap');
    if (w) w.hidden = !show;
  }

  function populateProdCategorySelect(preferredValue) {
    var sel = $('prodCatSelect');
    if (!sel) return;
    var cats = extractUniqueCategories(prodItems);
    var prev = preferredValue !== undefined ? preferredValue : sel.value;

    // Si estaba escribiendo una nueva categoría no cancelamos su edición al llegar un snapshot.
    if (preferredValue === undefined && prev === '__new__') {
      return;
    }

    if (prev && prev !== '__new__') {
      var found = cats.some(function (c) { return c.toLowerCase() === prev.toLowerCase(); });
      if (!found) {
        cats.push(prev);
        cats.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
      } else {
        for (var i = 0; i < cats.length; i++) {
          if (cats[i].toLowerCase() === prev.toLowerCase()) { prev = cats[i]; break; }
        }
      }
    }

    var html = '<option value="">Sin categoría</option>';
    cats.forEach(function (c) {
      html += '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    });
    html += '<option value="__new__">+ Crear nueva categoría...</option>';
    sel.innerHTML = html;
    sel.value = prev || '';
    toggleNewCatWrap(sel.value === '__new__');
  }

  function maybeBackfillProduct(docSnap) {
    var d = docSnap.data();
    var legacy = !d.id || d.nombre != null || d.margenSugerido != null ||
      (d.createdAt && d.createdAt.toDate) || (d.updatedAt && d.updatedAt.toDate);
    if (!legacy || backfilledProds[docSnap.id]) return;
    backfilledProds[docSnap.id] = true;
    var n = normalizeProduct(d);
    if (!n.name || n.costUsd <= 0 || n.marginPercent >= 100) return;
    var full = {
      v: 1, id: docSnap.id, name: n.name, costUsd: n.costUsd,
      marginPercent: n.marginPercent, fixedExpenseBs: n.fixedExpenseBs,
      commissionPlatform: n.commissionPlatform,
      commissionPaymentMethod: n.commissionPaymentMethod,
      commissionOther: n.commissionOther,
      roundStep: n.roundStep, rateSourceName: n.rateSourceName,
      marginMode: n.marginMode || 'onCost',
      createdAt: n.createdAt || new Date().toISOString(),
      updatedAt: n.updatedAt || new Date().toISOString()
    };
    if (n.category) full.category = n.category;
    if (n.customRateValue != null && n.customRateValue >= 0) full.customRateValue = n.customRateValue;
    F.fs.setDoc(docSnap.ref, full, { merge: true }).catch(function (e) { console.error(e); });
  }
  function subscribeProducts() {
    if (unsubProd) { unsubProd(); unsubProd = null; }
    if (!user || !db) return;
    var q = F.fs.collection(db, 'users', user.uid, 'products');
    unsubProd = F.fs.onSnapshot(q, function (snap) {
      prodItems = [];
      snap.forEach(function (d) {
        var raw = d.data() || {};
        if (!raw.id) raw.id = d.id;
        prodItems.push({ id: d.id, data: raw });
        maybeBackfillProduct(d);
      });
      prodItems.sort(function (a, b) {
        return compareNaturalProductNames(normalizeProduct(a.data).name, normalizeProduct(b.data).name);
      });
      populateProdCategorySelect();
      renderProducts();
      notifyProUI();
    }, function (e) { console.error(e); toast('No se pudieron leer tus productos'); });
  }
  function renderProductCardHtml(it) {
    var d = normalizeProduct(it.data);
    var modeLabel = (d.marginMode === 'onCost') ? 's/costo' : 's/venta';
    var activeRateSrc = catalogOverrideRate || d.rateSourceName;
    var m = window.calcProductMetrics ? window.calcProductMetrics(d, catalogOverrideRate) : null;
    var priceTxt = (m && !m.error) ? (fmtBs.format(m.precioFinal) + ' Bs') : '—';
    var rateTxt = formatRateLabel(activeRateSrc, d.customRateValue);
    var comPct = (d.commissionPlatform + d.commissionPaymentMethod + d.commissionOther) * 100;
    var gainTxt = (m && !m.error) ? (' · Ganancia ' + fmtBs.format(m.gananciaBs) + ' Bs') : '';
    var catBadge = d.category ? ('<span class="cat-pill">' + esc(d.category) + '</span>') : '';

    return '<div class="prod-card">'
      + '<div class="item-meta"><div class="prod-head"><b>' + esc(d.name || 'Producto') + '</b>' + catBadge + '</div>'
      + '<span>Costo $' + fmtBs.format(d.costUsd || 0)
      + ' · Margen ' + fmtBs.format(d.marginPercent || 0) + '% (' + modeLabel + ')'
      + ' · Comisiones ' + fmtBs.format(comPct) + '%' + gainTxt + '</span></div>'
      + '<div class="prod-price-col"><strong>' + esc(priceTxt) + '</strong><span>' + esc(rateTxt) + '</span></div>'
      + '<div class="prod-actions">'
      + '<button type="button" class="btn-mini accent" data-copy-bs="' + it.id + '">Copiar Bs</button>'
      + '<button type="button" class="btn-mini" data-wa-prod="' + it.id + '">WhatsApp</button>'
      + '<button type="button" class="btn-mini" data-load-prod="' + it.id + '">Cargar</button>'
      + '<button type="button" class="btn-mini" data-edit-prod="' + it.id + '">Editar</button>'
      + '<button type="button" class="btn-mini danger" data-del-prod="' + it.id + '">✕</button>'
      + '</div></div>';
  }
  function renderProducts() {
    var b = $('badgeProd');
    if (b) {
      b.textContent = prodItems.length;
      b.hidden = prodItems.length === 0;
    }
    var pro = isProUser();
    var quotaEl = $('prodQuotaInfo');
    if (quotaEl) {
      if (pro) {
        quotaEl.innerHTML = '<span class="pro-inline-tag">PRO</span> ' + prodItems.length + ' productos · Ilimitados, organizados por categorías';
      } else {
        var maxFree = window.ProCore ? window.ProCore.FREE_LIMITS.products : 10;
        quotaEl.innerHTML = 'Plan Gratis: <b>' + prodItems.length + ' / ' + maxFree + '</b> productos en la nube · <a href="#pro" data-go-pro>Desbloquea ilimitados</a>';
      }
    }
    var tools = $('catalogTools');
    if (tools) tools.hidden = prodItems.length === 0;

    var list = $('prodList');
    if (!list) return;
    var empty = $('prodEmpty');
    var qEl = $('prodSearch');
    var q = (qEl && qEl.value || '').trim().toLowerCase();

    var filtered = prodItems.filter(function (it) {
      if (!q) return true;
      var d = normalizeProduct(it.data);
      return d.name.toLowerCase().indexOf(q) !== -1 ||
        d.category.toLowerCase().indexOf(q) !== -1;
    });

    if (empty) {
      if (prodItems.length === 0) {
        empty.textContent = 'Aún no tienes productos guardados.';
        empty.style.display = '';
      } else if (filtered.length === 0) {
        empty.textContent = 'Ningún producto coincide con tu búsqueda.';
        empty.style.display = '';
      } else {
        empty.style.display = 'none';
      }
    }

    var html = '';
    if (pro && filtered.length) {
      var byCat = {};
      filtered.forEach(function (it) {
        var c = normalizeProduct(it.data).category || 'Sin categoría';
        if (!byCat[c]) byCat[c] = [];
        byCat[c].push(it);
      });
      var catCollator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
      var catNames = Object.keys(byCat).sort(function (a, b2) {
        if (a === 'Sin categoría') return 1;
        if (b2 === 'Sin categoría') return -1;
        return catCollator.compare(a, b2);
      });
      catNames.forEach(function (catName) {
        html += '<div class="prod-cat-group"><div class="prod-cat-head"><span>' + esc(catName) + '</span><small>' + byCat[catName].length + '</small></div>';
        byCat[catName].forEach(function (it) { html += renderProductCardHtml(it); });
        html += '</div>';
      });
    } else {
      filtered.forEach(function (it) { html += renderProductCardHtml(it); });
    }
    list.innerHTML = html;
  }
  function findProd(id) {
    for (var i = 0; i < prodItems.length; i++) { if (prodItems[i].id === id) return prodItems[i]; }
    return null;
  }
  function copyText(txt, msgOk) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast(msgOk); })
        .catch(function () { toast('No se pudo copiar'); });
    } else {
      toast(msgOk);
    }
  }
  function openWhatsAppText(msg) {
    if (!msg) return;
    var url = 'https://wa.me/?text=' + encodeURIComponent(msg);
    var w = window.open(url, '_blank', 'noopener,noreferrer');
    if (!w) copyText(msg, 'Lista copiada (abre WhatsApp para pegar)');
  }
  function copyProdBs(id) {
    var it = findProd(id);
    if (!it) return;
    var d = normalizeProduct(it.data);
    var m = window.calcProductMetrics ? window.calcProductMetrics(d, catalogOverrideRate) : null;
    if (!m || m.error) { toast('Tasa no disponible para copiar el precio'); return; }
    copyText(fmtBs.format(m.precioFinal) + ' Bs', 'Copiado: ' + fmtBs.format(m.precioFinal) + ' Bs');
  }
  function shareSingleProdWa(id) {
    var it = findProd(id);
    if (!it) return;
    var d = normalizeProduct(it.data);
    var m = window.calcProductMetrics ? window.calcProductMetrics(d, catalogOverrideRate) : null;
    if (!m || m.error) { toast('Tasa no disponible para compartir'); return; }
    var icon = prefixIconForProduct(d.name, d.category);
    openWhatsAppText(icon + d.name + ' = ' + fmtBs.format(m.precioFinal) + ' Bs');
  }
  function loadProduct(id) {
    var it = findProd(id);
    if (!it) return;
    var d = normalizeProduct(it.data);
    if (window.selectRateSource) window.selectRateSource(d.rateSourceName || 'bcvUsd', d.customRateValue);
    setInput('producto', d.name || '');
    setInput('costoUsd', d.costUsd || 0);
    setInput('margen', d.marginPercent || 0);
    setInput('comProveedor', fracToPct(d.commissionPlatform));
    setInput('comPasarela', fracToPct(d.commissionPaymentMethod));
    setInput('comOtra', fracToPct(d.commissionOther));
    setInput('gastoFijo', d.fixedExpenseBs || 0);
    if (window.setMarginMode) window.setMarginMode(d.marginMode || 'onCost');
    var r = $('redondeo');
    var mappedStep = (d.roundStep != null && d.roundStep <= 1) ? '1' : String(d.roundStep || 10);
    if (r && r.querySelector('option[value="' + mappedStep + '"]')) {
      r.value = mappedStep;
      r.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (window.setDashboardTab) window.setDashboardTab('calc');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('Producto cargado en la calculadora');
  }
  function editProduct(id) {
    var it = findProd(id);
    if (!it) return;
    var d = normalizeProduct(it.data);
    $('prodNombre').value = d.name || '';
    populateProdCategorySelect(d.category || '');
    $('prodCatNew').value = '';
    $('prodCosto').value = d.costUsd || 0;
    $('prodMargen').value = d.marginPercent || 0;
    $('prodMarginMode').value = d.marginMode || 'onCost';
    $('prodRateSource').value = d.rateSourceName || 'bcvUsd';
    var isCustom = $('prodRateSource').value === 'custom';
    toggleCustomRateWrap(isCustom);
    $('prodCustomRate').value = (isCustom && d.customRateValue) ? d.customRateValue : '';
    $('prodRoundStep').value = (d.roundStep != null && d.roundStep <= 1) ? '0' : String(d.roundStep || 10);
    $('prodComP').value = fracToPct(d.commissionPlatform);
    $('prodComPa').value = fracToPct(d.commissionPaymentMethod);
    $('prodComO').value = fracToPct(d.commissionOther);
    $('prodGasto').value = d.fixedExpenseBs || 0;
    $('prodEditId').value = id;
    var btn = $('btnProdGuardar'); if (btn) btn.textContent = 'Guardar cambios';
    var cancel = $('btnProdCancelar'); if (cancel) cancel.hidden = false;
    $('prodNombre').focus();
    $('prodForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function resetProdForm() {
    var form = $('prodForm');
    if (form) form.reset();
    $('prodEditId').value = '';
    populateProdCategorySelect('');
    if ($('prodCatNew')) $('prodCatNew').value = '';
    toggleNewCatWrap(false);
    if ($('prodMarginMode') && window.getMarginMode) $('prodMarginMode').value = window.getMarginMode() || 'onCost';
    if ($('prodRateSource')) $('prodRateSource').value = currentRateSourceName();
    toggleCustomRateWrap($('prodRateSource') && $('prodRateSource').value === 'custom');
    if ($('prodRoundStep')) {
      var st = currentRoundStep();
      $('prodRoundStep').value = st <= 1 ? '0' : String(st);
    }
    var btn = $('btnProdGuardar'); if (btn) btn.textContent = 'Agregar producto';
    var cancel = $('btnProdCancelar'); if (cancel) cancel.hidden = true;
  }
  async function saveProduct(ev) {
    if (ev) ev.preventDefault();
    if (!user) { toast('Inicia sesión para guardar productos'); return; }
    var editId = $('prodEditId').value;
    if (!editId && window.ProCore && !window.ProCore.canAddProduct(prodItems.length, isProUser())) {
      if (window.ProUI && typeof window.ProUI.promptUpgrade === 'function') {
        window.ProUI.promptUpgrade('En el plan Gratis puedes guardar hasta ' + window.ProCore.FREE_LIMITS.products + ' productos en la nube. Pásate a Pro para guardar productos ilimitados.');
      } else {
        toast('Plan Gratis: límite de ' + window.ProCore.FREE_LIMITS.products + ' productos alcanzado. Activa Pro para guardar más.');
      }
      return;
    }
    var nombre = ($('prodNombre').value || '').trim();
    if (!nombre) { toast('Ponle un nombre al producto'); $('prodNombre').focus(); return; }
    if (nombre.length > 120) { toast('El nombre no puede superar 120 caracteres'); $('prodNombre').focus(); return; }

    var catSel = $('prodCatSelect') ? $('prodCatSelect').value : '';
    var categoria = (catSel === '__new__' ? ($('prodCatNew').value || '') : catSel).trim();
    if (catSel === '__new__' && !categoria) {
      toast('Escribe el nombre de la nueva categoría o elige "Sin categoría"');
      if ($('prodCatNew')) $('prodCatNew').focus();
      return;
    }
    if (categoria.length > 80) { toast('La categoría no puede superar 80 caracteres'); return; }

    var costo = numVal('prodCosto', 0);
    if (costo <= 0) { toast('El costo debe ser mayor que 0'); $('prodCosto').focus(); return; }

    var margen = numVal('prodMargen', 20);
    if (margen < 0 || margen >= 100) {
      toast('El margen debe estar entre 0% y 99,9%');
      $('prodMargen').focus();
      return;
    }

    var comP = pctToFrac(numVal('prodComP', 0));
    var comPa = pctToFrac(numVal('prodComPa', 0));
    var comO = pctToFrac(numVal('prodComO', 0));
    var mode = ($('prodMarginMode') && $('prodMarginMode').value) || 'onCost';
    if (comP + comPa + comO >= 1) {
      toast('Las comisiones deben sumar menos de 100%');
      return;
    }
    if (mode === 'onSale' && (comP + comPa + comO + (margen / 100)) >= 1) {
      toast('En cálculo sobre venta, comisiones + margen deben sumar menos de 100%');
      return;
    }

    var rateName = currentProdRateSource();
    var cr = 0;
    if (rateName === 'custom') {
      cr = numVal('prodCustomRate', 0) || numVal('tasa', 0);
      if (cr <= 0) {
        toast('Escribe una tasa personalizada mayor que 0');
        if ($('prodCustomRate')) $('prodCustomRate').focus();
        return;
      }
    }

    var now = new Date().toISOString();
    var stored = editId ? normalizeProduct((findProd(editId) || { data: {} }).data) : null;
    var data = {
      v: 1,
      name: nombre,
      costUsd: costo,
      marginPercent: margen,
      fixedExpenseBs: numVal('prodGasto', 0),
      commissionPlatform: comP,
      commissionPaymentMethod: comPa,
      commissionOther: comO,
      roundStep: currentProdRoundStep(),
      rateSourceName: rateName,
      marginMode: mode,
      updatedAt: now
    };
    if (categoria) data.category = categoria;
    if (rateName === 'custom') data.customRateValue = cr;

    try {
      if (editId) {
        data.id = editId;
        data.createdAt = (stored && stored.createdAt) || now;
        if (!categoria) data.category = F.fs.deleteField();
        if (rateName !== 'custom') data.customRateValue = F.fs.deleteField();
        // Limpia los campos del esquema viejo, si los tenía el documento.
        data.nombre = F.fs.deleteField();
        data.margenSugerido = F.fs.deleteField();
        data.comProveedor = F.fs.deleteField();
        data.comPasarela = F.fs.deleteField();
        data.comOtra = F.fs.deleteField();
        data.gastoFijo = F.fs.deleteField();
        await F.fs.updateDoc(F.fs.doc(db, 'users', user.uid, 'products', editId), data);
        toast('Producto actualizado');
      } else {
        var ref = newDocRef('products');
        data.id = ref.id;
        data.createdAt = now;
        await F.fs.setDoc(ref, data);
        toast('Producto guardado');
      }
      resetProdForm();
    } catch (e) {
      console.error(e);
      toast('No se pudo guardar: ' + (e && (e.code || e.message) ? (e.code || e.message) : 'revisa tu conexión'));
    }
  }
  async function deleteProduct(id) {
    if (!user) return;
    if (!window.confirm('¿Eliminar este producto?')) return;
    try { await F.fs.deleteDoc(F.fs.doc(db, 'users', user.uid, 'products', id)); }
    catch (e) { toast('No se pudo eliminar el producto'); }
  }

  /* ===== Compartir lista WhatsApp por categorías ===== */
  function openShareModal() {
    if (!prodItems.length) { toast('Agrega productos primero para armar una lista'); return; }
    var cats = extractUniqueCategories(prodItems);
    var hasUncat = prodItems.some(function (it) { return !normalizeProduct(it.data).category; });
    var q = ($('prodSearch') && $('prodSearch').value || '').trim().toLowerCase();
    var matched = q ? cats.filter(function (c) { return c.toLowerCase().indexOf(q) !== -1; }) : [];

    shareSelectedCats = {};
    if (matched.length) {
      matched.forEach(function (c) { shareSelectedCats[c.toLowerCase()] = true; });
      shareIncludeUncat = false;
    } else {
      cats.forEach(function (c) { shareSelectedCats[c.toLowerCase()] = true; });
      shareIncludeUncat = hasUncat;
    }

    var rateSel = $('shareRateOverride');
    if (rateSel) rateSel.value = catalogOverrideRate || '';
    renderShareCategoryChips(cats, hasUncat);
    regenerateSharePreview();
    var m = $('shareListModal');
    if (m) m.hidden = false;
  }
  function closeShareModal() {
    var m = $('shareListModal');
    if (m) m.hidden = true;
  }
  function renderShareCategoryChips(cats, hasUncat) {
    var wrap = $('shareCatChips');
    if (!wrap) return;
    var counts = {};
    var uncatCount = 0;
    prodItems.forEach(function (it) {
      var c = normalizeProduct(it.data).category;
      if (!c) { uncatCount++; return; }
      var k = c.toLowerCase();
      counts[k] = (counts[k] || 0) + 1;
    });
    var html = '';
    cats.forEach(function (c) {
      var low = c.toLowerCase();
      var active = !!shareSelectedCats[low];
      html += '<button type="button" class="chip' + (active ? ' active' : '') + '" data-share-cat="' + esc(low) + '">'
        + esc(c) + ' (' + (counts[low] || 0) + ')</button>';
    });
    if (hasUncat) {
      html += '<button type="button" class="chip' + (shareIncludeUncat ? ' active' : '') + '" data-share-cat="__uncat__">'
        + 'Sin categoría (' + uncatCount + ')</button>';
    }
    wrap.innerHTML = html;
  }
  function regenerateSharePreview() {
    var area = $('sharePreview');
    if (!area) return;
    var overrideRate = ($('shareRateOverride') && $('shareRateOverride').value) || '';
    area.value = buildWhatsAppPriceList({
      items: prodItems,
      selectedCategories: shareSelectedCats,
      includeUncategorized: shareIncludeUncat,
      overrideRate: overrideRate
    });
  }

  /* ===== Cableado de la UI ===== */
  function wire() {
    var btnEntrar = $('btnEntrar');
    if (btnEntrar) btnEntrar.addEventListener('click', function () { showReset(false); setAuthMode('login'); openAuth(); });
    var btnSalir = $('btnSalir');
    if (btnSalir) btnSalir.addEventListener('click', async function () {
      if (!auth) return;
      try { await F.auth.signOut(auth); toast('Sesión cerrada'); }
      catch (e) { toast('No se pudo cerrar la sesión'); }
    });
    var btnCerrar = $('btnCerrarModal');
    if (btnCerrar) {
      btnCerrar.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        closeAuth();
      });
    }
    var modal = $('authModal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeAuth();
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeAuth(); closeShareModal(); }
    });
    var tabLogin = $('tabLogin');
    if (tabLogin) tabLogin.addEventListener('click', function () { setAuthMode('login'); });
    var tabRegister = $('tabRegister');
    if (tabRegister) tabRegister.addEventListener('click', function () { setAuthMode('register'); });
    var btnGoogle = $('btnGoogle');
    if (btnGoogle) btnGoogle.addEventListener('click', loginGoogle);
    var btnSubmit = $('btnAuthSubmit');
    if (btnSubmit) btnSubmit.addEventListener('click', submitEmail);
    var authPass = $('authPass');
    if (authPass) authPass.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitEmail(); });
    var linkReset = $('linkReset');
    if (linkReset) linkReset.addEventListener('click', function (e) { e.preventDefault(); showReset(true); });
    var linkVolver = $('linkVolverLogin');
    if (linkVolver) linkVolver.addEventListener('click', function (e) { e.preventDefault(); showReset(false); });
    var btnReset = $('btnResetSend');
    if (btnReset) btnReset.addEventListener('click', sendReset);

    document.querySelectorAll('[data-open-auth]').forEach(function (b) {
      b.addEventListener('click', function () { showReset(false); setAuthMode('login'); openAuth(); });
    });

    var btnGuardar = $('btnGuardarCalculo');
    if (btnGuardar) btnGuardar.addEventListener('click', function () { saveCalculation(false); });

    var btnLimpiar = $('btnLimpiarHist');
    if (btnLimpiar) btnLimpiar.addEventListener('click', clearHistory);
    var histList = $('histList');
    if (histList) histList.addEventListener('click', function (e) {
      var t = e.target;
      if (!t.getAttribute) return;
      var loadId = t.getAttribute('data-load-hist');
      var delId = t.getAttribute('data-del-hist');
      if (loadId) loadHistory(loadId);
      else if (delId) deleteHistory(delId);
    });

    var prodForm = $('prodForm');
    if (prodForm) prodForm.addEventListener('submit', saveProduct);
    var btnCancel = $('btnProdCancelar');
    if (btnCancel) btnCancel.addEventListener('click', resetProdForm);

    var catSel = $('prodCatSelect');
    if (catSel) {
      catSel.addEventListener('change', function () {
        var isNew = catSel.value === '__new__';
        toggleNewCatWrap(isNew);
        if (isNew && $('prodCatNew')) $('prodCatNew').focus();
      });
    }
    var prodRateSel = $('prodRateSource');
    if (prodRateSel) {
      prodRateSel.addEventListener('change', function () {
        var isCust = prodRateSel.value === 'custom';
        toggleCustomRateWrap(isCust);
        if (isCust && $('prodCustomRate') && !$('prodCustomRate').value && $('tasa')) {
          $('prodCustomRate').value = $('tasa').value || '';
        }
      });
    }
    var prodSearch = $('prodSearch');
    if (prodSearch) prodSearch.addEventListener('input', renderProducts);

    var rateChips = $('prodRateChips');
    if (rateChips) {
      rateChips.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-rate-override]') : null;
        if (!btn) return;
        catalogOverrideRate = btn.getAttribute('data-rate-override') || '';
        rateChips.querySelectorAll('[data-rate-override]').forEach(function (c) {
          c.classList.toggle('active', c === btn);
        });
        renderProducts();
      });
    }

    var prodList = $('prodList');
    if (prodList) prodList.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button') : e.target;
      if (!t || !t.getAttribute) return;
      var copyId = t.getAttribute('data-copy-bs');
      var waId = t.getAttribute('data-wa-prod');
      var loadId = t.getAttribute('data-load-prod');
      var editId = t.getAttribute('data-edit-prod');
      var delId = t.getAttribute('data-del-prod');
      if (copyId) copyProdBs(copyId);
      else if (waId) shareSingleProdWa(waId);
      else if (loadId) loadProduct(loadId);
      else if (editId) editProduct(editId);
      else if (delId) deleteProduct(delId);
    });

    var btnShare = $('btnOpenShareList');
    if (btnShare) btnShare.addEventListener('click', openShareModal);
    var btnCloseShare = $('btnCloseShareModal');
    if (btnCloseShare) btnCloseShare.addEventListener('click', closeShareModal);
    var shareModal = $('shareListModal');
    if (shareModal) {
      shareModal.addEventListener('click', function (e) {
        if (e.target === shareModal) closeShareModal();
      });
    }
    var shareCatsWrap = $('shareCatChips');
    if (shareCatsWrap) {
      shareCatsWrap.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-share-cat]') : null;
        if (!btn) return;
        var key = btn.getAttribute('data-share-cat');
        if (key === '__uncat__') {
          shareIncludeUncat = !shareIncludeUncat;
          btn.classList.toggle('active', shareIncludeUncat);
        } else {
          shareSelectedCats[key] = !shareSelectedCats[key];
          btn.classList.toggle('active', !!shareSelectedCats[key]);
        }
        regenerateSharePreview();
      });
    }
    var btnShareAll = $('btnShareAll');
    if (btnShareAll) {
      btnShareAll.addEventListener('click', function () {
        var cats = extractUniqueCategories(prodItems);
        var hasUncat = prodItems.some(function (it) { return !normalizeProduct(it.data).category; });
        shareSelectedCats = {};
        cats.forEach(function (c) { shareSelectedCats[c.toLowerCase()] = true; });
        shareIncludeUncat = hasUncat;
        renderShareCategoryChips(cats, hasUncat);
        regenerateSharePreview();
      });
    }
    var btnShareNone = $('btnShareNone');
    if (btnShareNone) {
      btnShareNone.addEventListener('click', function () {
        var cats = extractUniqueCategories(prodItems);
        var hasUncat = prodItems.some(function (it) { return !normalizeProduct(it.data).category; });
        shareSelectedCats = {};
        shareIncludeUncat = false;
        renderShareCategoryChips(cats, hasUncat);
        regenerateSharePreview();
      });
    }
    var shareRateSel = $('shareRateOverride');
    if (shareRateSel) shareRateSel.addEventListener('change', regenerateSharePreview);
    var btnShareRegen = $('btnShareRegen');
    if (btnShareRegen) btnShareRegen.addEventListener('click', regenerateSharePreview);
    var btnCopyShare = $('btnCopyShareList');
    if (btnCopyShare) {
      btnCopyShare.addEventListener('click', function () {
        var txt = ($('sharePreview') && $('sharePreview').value || '').trim();
        if (!txt) { toast('Selecciona al menos una categoría con productos'); return; }
        copyText(txt, 'Lista de precios copiada');
      });
    }
    var btnSendWa = $('btnSendShareWa');
    if (btnSendWa) {
      btnSendWa.addEventListener('click', function () {
        var txt = ($('sharePreview') && $('sharePreview').value || '').trim();
        if (!txt) { toast('Selecciona al menos una categoría con productos'); return; }
        openWhatsAppText(txt);
      });
    }

    window.__margenesOnRatesUpdated = function () {
      renderProducts();
      var sm = $('shareListModal');
      if (sm && !sm.hidden) regenerateSharePreview();
      if (window.ProUI && typeof window.ProUI.onRatesUpdated === 'function') {
        try { window.ProUI.onRatesUpdated(); } catch (e) {}
      }
    };
  }

  window.__margenesAuthBridge = {
    getState: getBridgeState,
    openAuth: function (cb) {
      afterLoginAction = typeof cb === 'function' ? cb : null;
      showReset(false);
      setAuthMode('login');
      openAuth();
    },
    getShareSelection: function () {
      return {
        selectedCats: Object.assign({}, shareSelectedCats),
        includeUncat: shareIncludeUncat,
        overrideRate: ($('shareRateOverride') && $('shareRateOverride').value) || catalogOverrideRate || ''
      };
    },
    submitPendingPayment: async function (payload) {
      if (!user || !db) throw new Error('Inicia sesión primero para registrar tu referencia de pago.');
      var refTxt = String((payload && payload.reference) || '').trim();
      if (refTxt.length < 4 || refTxt.length > 60) throw new Error('La referencia debe tener entre 4 y 60 caracteres.');
      var rawPlan = payload && payload.plan;
      var planPrices = { monthly: 1.99, quarterly: 4.99, semiannual: 7.99, annual: 14.99 };
      var planId = Object.prototype.hasOwnProperty.call(planPrices, rawPlan) ? rawPlan : 'monthly';
      var method = (payload && payload.method) === 'usdt' ? 'usdt' : 'pago_movil';
      var amountUsd = (window.ProCore && window.ProCore.PLANS && window.ProCore.PLANS[planId])
        ? window.ProCore.PLANS[planId].usd
        : planPrices[planId];
      var docData = {
        v: 1,
        plan: planId,
        method: method,
        reference: refTxt,
        amountUsd: amountUsd,
        status: 'pending',
        provider: 'manual',
        requestedAt: new Date().toISOString()
      };
      if (payload && typeof payload.amountBs === 'number' && payload.amountBs >= 0 && isFinite(payload.amountBs)) {
        docData.amountBs = Math.round(payload.amountBs * 100) / 100;
      }
      if (payload && typeof payload.rateBs === 'number' && payload.rateBs >= 0 && isFinite(payload.rateBs)) {
        docData.rateBs = Math.round(payload.rateBs * 100) / 100;
      }
      await F.fs.setDoc(F.fs.doc(db, 'users', user.uid, 'subscription', 'pending'), docData);
      return docData;
    },
    saveProfileSettings: async function (businessName) {
      if (!user || !db) throw new Error('Inicia sesión para guardar la configuración.');
      var clean = String(businessName || '').trim().slice(0, 60);
      var data = { v: 1, businessName: clean, updatedAt: new Date().toISOString() };
      await F.fs.setDoc(F.fs.doc(db, 'users', user.uid, 'settings', 'profile'), data);
      return data;
    },
    saveAlertSettings: async function (cfg) {
      if (!user || !db) throw new Error('Inicia sesión para guardar tus alertas.');
      var thr = parseFloat(cfg && cfg.gapThresholdPct);
      if (!isFinite(thr) || thr < 0 || thr > 1000) thr = 20;
      var data = {
        v: 1,
        gapEnabled: !!(cfg && cfg.gapEnabled),
        gapThresholdPct: Math.round(thr * 100) / 100,
        rateEnabled: !!(cfg && cfg.rateEnabled),
        updatedAt: new Date().toISOString()
      };
      if (cfg && typeof cfg.bcvAboveBs === 'number' && cfg.bcvAboveBs >= 0 && isFinite(cfg.bcvAboveBs)) {
        data.bcvAboveBs = Math.round(cfg.bcvAboveBs * 100) / 100;
      } else {
        data.bcvAboveBs = null;
      }
      if (cfg && typeof cfg.lastSeenBcvUsd === 'number' && cfg.lastSeenBcvUsd >= 0 && isFinite(cfg.lastSeenBcvUsd)) {
        data.lastSeenBcvUsd = Math.round(cfg.lastSeenBcvUsd * 100) / 100;
      } else {
        data.lastSeenBcvUsd = null;
      }
      if (cfg && cfg.lastSeenBcvDate) {
        data.lastSeenBcvDate = String(cfg.lastSeenBcvDate).slice(0, 20);
      } else {
        data.lastSeenBcvDate = null;
      }
      await F.fs.setDoc(F.fs.doc(db, 'users', user.uid, 'settings', 'alerts'), data);
      return data;
    },
    applyRevaluationUpdates: async function (updates) {
      if (!user || !db) throw new Error('Inicia sesión primero.');
      if (!isProUser()) throw new Error('Activa Pro para revalorizar todo tu catálogo.');
      var now = new Date().toISOString();
      var list = Array.isArray(updates) ? updates : [];
      for (var i = 0; i < list.length; i += 400) {
        var batch = F.fs.writeBatch(db);
        list.slice(i, i + 400).forEach(function (u) {
          if (!u || !u.id || !(u.customRateValue > 0)) return;
          batch.update(F.fs.doc(db, 'users', user.uid, 'products', u.id), {
            customRateValue: Math.round(u.customRateValue * 100) / 100,
            updatedAt: now
          });
        });
        await batch.commit();
      }
      return list.length;
    },
    importProductsBatch: async function (items) {
      if (!user || !db) throw new Error('Inicia sesión primero.');
      if (!isProUser()) throw new Error('Activa Pro para importar catálogos por Excel o CSV.');
      var list = Array.isArray(items) ? items : [];
      if (!list.length) return 0;
      var now = new Date().toISOString();
      for (var i = 0; i < list.length; i += 400) {
        var batch = F.fs.writeBatch(db);
        list.slice(i, i + 400).forEach(function (p) {
          var ref = newDocRef('products');
          var docData = {
            v: 1,
            id: ref.id,
            name: String(p.name).slice(0, 120),
            costUsd: Number(p.costUsd),
            marginPercent: Number(p.marginPercent),
            fixedExpenseBs: Number(p.fixedExpenseBs || 0),
            commissionPlatform: Number(p.commissionPlatform || 0),
            commissionPaymentMethod: Number(p.commissionPaymentMethod || 0),
            commissionOther: Number(p.commissionOther || 0),
            roundStep: Math.trunc(p.roundStep != null ? p.roundStep : 10),
            rateSourceName: p.rateSourceName || 'bcvUsd',
            marginMode: p.marginMode === 'onSale' ? 'onSale' : 'onCost',
            createdAt: now,
            updatedAt: now
          };
          if (p.category) docData.category = String(p.category).slice(0, 80);
          if (p.rateSourceName === 'custom' && p.customRateValue > 0) docData.customRateValue = Number(p.customRateValue);
          batch.set(ref, docData);
        });
        await batch.commit();
      }
      return list.length;
    },
    getIdToken: async function (forceRefresh) {
      if (!user) return null;
      return user.getIdToken(!!forceRefresh);
    },
    applyActivatedSubscription: function (subDoc) {
      if (!subDoc || typeof subDoc !== 'object') return;
      subCurrent = Object.assign({}, subDoc);
      subPending = null;
      scheduleExpiryTimer();
      renderAuthUI();
      notifyProUI();
    }
  };

  wire();
  setAuthMode('login');
  closeAuth();
  closeShareModal();
  initFirebase();
  notifyProUI();
})();
