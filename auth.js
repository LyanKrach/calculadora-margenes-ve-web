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
  var authMode = 'login'; // 'login' | 'register'
  var histItems = [];
  var prodItems = [];

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
    return {
      name: (d.name != null ? d.name : d.nombre || '').toString().trim(),
      costUsd: d.costUsd || 0,
      marginPercent: (d.marginPercent != null) ? d.marginPercent : (d.margenSugerido || 0),
      fixedExpenseBs: d.fixedExpenseBs || d.gastoFijo || 0,
      commissionPlatform: comP,
      commissionPaymentMethod: comPa,
      commissionOther: comO,
      roundStep: (d.roundStep != null) ? d.roundStep : 10,
      rateSourceName: d.rateSourceName || 'bcvUsd',
      marginMode: d.marginMode || 'onSale',
      customRateValue: (typeof d.customRateValue === 'number') ? d.customRateValue : null,
      createdAt: isoDate(d.createdAt),
      updatedAt: isoDate(d.updatedAt)
    };
  }

  /* ===== Config y arranque ===== */
  function configLista() {
    var c = window.FIREBASE_CONFIG || {};
    var keys = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
    for (var i = 0; i < keys.length; i++) {
      var v = c[keys[i]];
      if (!v || typeof v !== 'string' || v.indexOf('TU_') === 0) return false;
    }
    return true;
  }
  function setFirebaseState(state) {
    var notice = $('fbNotice');
    if (notice) notice.hidden = (state !== 'noconfig' && state !== 'error');
    if (notice && state === 'error') notice.textContent = '⚠ No se pudo cargar Firebase (¿sin internet?). La calculadora sigue funcionando como invitada.';
  }

  async function initFirebase() {
    if (!configLista()) { setFirebaseState('noconfig'); return; }
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
      subscribeHistory();
      subscribeProducts();
    } else {
      if (btnEntrar) btnEntrar.hidden = false;
      if (chip) chip.hidden = true;
      document.querySelectorAll('[data-needs-login]').forEach(function (el) { el.hidden = false; });
      var pb2 = $('prodBox'); if (pb2) pb2.hidden = true;
      var hb2 = $('histBox'); if (hb2) hb2.hidden = true;
      if (unsubHist) { unsubHist(); unsubHist = null; }
      if (unsubProd) { unsubProd(); unsubProd = null; }
      histItems = []; prodItems = [];
      renderHistory(); renderProducts();
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
      marginMode: 'onSale', // la fórmula de esta web es margen sobre la venta
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
    var q = F.fs.query(
      F.fs.collection(db, 'users', user.uid, 'history'),
      F.fs.orderBy('timestamp', 'desc'),
      F.fs.limit(50)
    );
    unsubHist = F.fs.onSnapshot(q, function (snap) {
      histItems = [];
      snap.forEach(function (d) { histItems.push({ id: d.id, data: d.data() }); });
      renderHistory();
    }, function (e) { console.error(e); toast('No se pudo leer tu historial'); });
  }
  function renderHistory() {
    var b = $('badgeHist');
    if (b) {
      b.textContent = histItems.length;
      b.hidden = histItems.length === 0;
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
      html += '<div class="item-row">'
        + '<div class="item-meta"><b>' + esc(d.title || 'Producto') + '</b>'
        + '<span>' + esc(fecha) + ' · Tasa Bs ' + fmtBs.format(d.rateValue || 0) + '</span></div>'
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
  function maybeBackfillProduct(docSnap) {
    var d = docSnap.data();
    var legacy = !d.id || d.nombre != null || d.margenSugerido != null ||
      (d.createdAt && d.createdAt.toDate) || (d.updatedAt && d.updatedAt.toDate);
    if (!legacy || backfilledProds[docSnap.id]) return;
    backfilledProds[docSnap.id] = true;
    var n = normalizeProduct(d);
    var full = {
      v: 1, id: docSnap.id, name: n.name, costUsd: n.costUsd,
      marginPercent: n.marginPercent, fixedExpenseBs: n.fixedExpenseBs,
      commissionPlatform: n.commissionPlatform,
      commissionPaymentMethod: n.commissionPaymentMethod,
      commissionOther: n.commissionOther,
      roundStep: n.roundStep, rateSourceName: n.rateSourceName,
      marginMode: 'onSale',
      createdAt: n.createdAt || new Date().toISOString(),
      updatedAt: n.updatedAt || new Date().toISOString()
    };
    if (n.customRateValue != null) full.customRateValue = n.customRateValue;
    F.fs.setDoc(docSnap.ref, full, { merge: true }).catch(function (e) { console.error(e); });
  }
  function subscribeProducts() {
    if (unsubProd) { unsubProd(); unsubProd = null; }
    if (!user || !db) return;
    var q = F.fs.query(
      F.fs.collection(db, 'users', user.uid, 'products'),
      F.fs.orderBy('updatedAt', 'desc'),
      F.fs.limit(100)
    );
    unsubProd = F.fs.onSnapshot(q, function (snap) {
      prodItems = [];
      snap.forEach(function (d) {
        prodItems.push({ id: d.id, data: d.data() });
        maybeBackfillProduct(d);
      });
      renderProducts();
    }, function (e) { console.error(e); toast('No se pudieron leer tus productos'); });
  }
  function renderProducts() {
    var b = $('badgeProd');
    if (b) {
      b.textContent = prodItems.length;
      b.hidden = prodItems.length === 0;
    }
    var list = $('prodList');
    if (!list) return;
    var empty = $('prodEmpty');
    if (empty) empty.style.display = prodItems.length ? 'none' : '';
    var html = '';
    prodItems.forEach(function (it) {
      var d = normalizeProduct(it.data);
      html += '<div class="item-row">'
        + '<div class="item-meta"><b>' + esc(d.name || 'Producto') + '</b>'
        + '<span>Costo $' + fmtBs.format(d.costUsd || 0) + ' · Margen ' + fmtBs.format(d.marginPercent || 0) + '%</span></div>'
        + '<div class="item-actions"><button type="button" class="btn-mini" data-load-prod="' + it.id + '">Cargar</button>'
        + '<button type="button" class="btn-mini" data-edit-prod="' + it.id + '">Editar</button>'
        + '<button type="button" class="btn-mini danger" data-del-prod="' + it.id + '">✕</button></div></div>';
    });
    list.innerHTML = html;
  }
  function findProd(id) {
    for (var i = 0; i < prodItems.length; i++) { if (prodItems[i].id === id) return prodItems[i]; }
    return null;
  }
  function loadProduct(id) {
    var it = findProd(id);
    if (!it) return;
    var d = normalizeProduct(it.data);
    setInput('producto', d.name || '');
    setInput('costoUsd', d.costUsd || 0);
    setInput('margen', d.marginPercent || 0);
    setInput('comProveedor', fracToPct(d.commissionPlatform));
    setInput('comPasarela', fracToPct(d.commissionPaymentMethod));
    setInput('comOtra', fracToPct(d.commissionOther));
    setInput('gastoFijo', d.fixedExpenseBs || 0);
    var r = $('redondeo');
    if (r && d.roundStep && r.querySelector('option[value="' + d.roundStep + '"]')) {
      r.value = String(d.roundStep);
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
    $('prodCosto').value = d.costUsd || 0;
    $('prodMargen').value = d.marginPercent || 0;
    $('prodComP').value = fracToPct(d.commissionPlatform);
    $('prodComPa').value = fracToPct(d.commissionPaymentMethod);
    $('prodComO').value = fracToPct(d.commissionOther);
    $('prodGasto').value = d.fixedExpenseBs || 0;
    $('prodEditId').value = id;
    var btn = $('btnProdGuardar'); if (btn) btn.textContent = 'Guardar cambios';
    var cancel = $('btnProdCancelar'); if (cancel) cancel.hidden = false;
    $('prodNombre').focus();
  }
  function resetProdForm() {
    var form = $('prodForm');
    if (form) form.reset();
    $('prodEditId').value = '';
    var btn = $('btnProdGuardar'); if (btn) btn.textContent = 'Agregar producto';
    var cancel = $('btnProdCancelar'); if (cancel) cancel.hidden = true;
  }
  async function saveProduct(ev) {
    if (ev) ev.preventDefault();
    if (!user) { toast('Inicia sesión para guardar productos'); return; }
    var nombre = ($('prodNombre').value || '').trim();
    if (!nombre) { toast('Ponle un nombre al producto'); $('prodNombre').focus(); return; }
    // La app descarta productos con costo <= 0.
    if (numVal('prodCosto', 0) <= 0) { toast('El costo debe ser mayor que 0'); $('prodCosto').focus(); return; }
    var now = new Date().toISOString();
    var editId = $('prodEditId').value;
    var stored = editId ? normalizeProduct((findProd(editId) || { data: {} }).data) : null;
    // Al editar se conservan la fuente de tasa, el redondeo y la tasa
    // personalizada que ya tenía el producto; al crear se usan los valores
    // actuales de la calculadora como predeterminados.
    var rateName = (stored && stored.rateSourceName) || currentRateSourceName();
    var data = {
      v: 1,
      name: nombre,
      costUsd: numVal('prodCosto', 0),
      marginPercent: numVal('prodMargen', 20),
      fixedExpenseBs: numVal('prodGasto', 0),
      commissionPlatform: pctToFrac(numVal('prodComP', 0)),
      commissionPaymentMethod: pctToFrac(numVal('prodComPa', 0)),
      commissionOther: pctToFrac(numVal('prodComO', 0)),
      roundStep: (stored && stored.roundStep) || currentRoundStep(),
      rateSourceName: rateName,
      marginMode: 'onSale', // la fórmula de esta web es margen sobre la venta
      updatedAt: now
    };
    if (rateName === 'custom') {
      var cr = (stored && stored.customRateValue) || numVal('tasa', 0);
      if (cr > 0) data.customRateValue = cr;
    }
    try {
      if (editId) {
        data.id = editId;
        data.createdAt = (stored && stored.createdAt) || now;
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
      toast('No se pudo guardar el producto');
    }
  }
  async function deleteProduct(id) {
    if (!user) return;
    if (!window.confirm('¿Eliminar este producto?')) return;
    try { await F.fs.deleteDoc(F.fs.doc(db, 'users', user.uid, 'products', id)); }
    catch (e) { toast('No se pudo eliminar el producto'); }
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
      if (e.key === 'Escape') closeAuth();
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
    var prodList = $('prodList');
    if (prodList) prodList.addEventListener('click', function (e) {
      var t = e.target;
      if (!t.getAttribute) return;
      var loadId = t.getAttribute('data-load-prod');
      var editId = t.getAttribute('data-edit-prod');
      var delId = t.getAttribute('data-del-prod');
      if (loadId) loadProduct(loadId);
      else if (editId) editProduct(editId);
      else if (delId) deleteProduct(delId);
    });
  }

  wire();
  setAuthMode('login');
  closeAuth();
  initFirebase();
})();
