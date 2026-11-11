import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function extractHtmlIds(html) {
  const ids = [];
  const counts = {};
  const re = /\bid\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    ids.push(m[1]);
    counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  return { ids, counts };
}

function makeMockElement(id, tag = 'div', value = '') {
  const classes = new Set();
  const listeners = {};
  const children = [];
  const el = {
    id,
    tagName: tag.toUpperCase(),
    value: String(value),
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    checked: false,
    style: {},
    dataset: {},
    attributes: {},
    children,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (x, force) => {
        if (force === undefined) classes.has(x) ? classes.delete(x) : classes.add(x);
        else force ? classes.add(x) : classes.delete(x);
      },
      contains: (x) => classes.has(x),
    },
    set className(v) {
      classes.clear();
      String(v || '').split(/\s+/).filter(Boolean).forEach((x) => classes.add(x));
    },
    get className() {
      return [...classes].join(' ');
    },
    addEventListener(ev, fn) {
      (listeners[ev] = listeners[ev] || []).push(fn);
    },
    dispatchEvent(ev) {
      const eventObj = Object.assign({ preventDefault() {}, target: el }, ev);
      (listeners[eventObj.type] || []).forEach((fn) => fn(eventObj));
    },
    click() { el.dispatchEvent({ type: 'click', target: el }); },
    setAttribute(k, v) { el.attributes[k] = String(v); },
    getAttribute(k) { return el.attributes[k] ?? null; },
    closest(sel) {
      if (sel === '[data-mode]' && 'data-mode' in el.attributes) return el;
      if (sel === '[data-tab]' && 'data-tab' in el.attributes) return el;
      if (sel === '[data-rate]' && 'data-rate' in el.attributes) return el;
      if (sel === '[data-go-pro]' && 'data-go-pro' in el.attributes) return el;
      if (sel === '[data-pay-plan]' && 'data-pay-plan' in el.attributes) return el;
      if (sel === '[data-pay-method]' && 'data-pay-method' in el.attributes) return el;
      if (sel === '[data-choose-plan]' && 'data-choose-plan' in el.attributes) return el;
      if (sel === '[data-rep-period]' && 'data-rep-period' in el.attributes) return el;
      if (sel === '[data-admin-act]' && 'data-admin-act' in el.attributes) return el;
      if (sel === '[data-admin-deact]' && 'data-admin-deact' in el.attributes) return el;
      return null;
    },
    focus() {},
    scrollIntoView() {},
    appendChild(ch) { children.push(ch); return ch; },
    removeChild(ch) {
      const idx = children.indexOf(ch);
      if (idx >= 0) children.splice(idx, 1);
      return ch;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return el;
}

function createHarness(authMockState = null) {
  const html = read('index.html');
  const { ids } = extractHtmlIds(html);
  const byId = new Map();
  for (const id of ids) {
    byId.set(id, makeMockElement(id));
  }
  byId.get('producto').value = 'Recarga / producto digital';
  byId.get('costoUsd').value = '10';
  byId.get('tasa').value = '901.62';
  byId.get('margen').value = '20';
  byId.get('margenRange').value = '20';
  byId.get('comProveedor').value = '2';
  byId.get('comPasarela').value = '5';
  byId.get('comOtra').value = '0';
  byId.get('gastoFijo').value = '0';
  byId.get('redondeo').value = '10';
  byId.get('precioActual').value = '';
  byId.get('alertGapPct').value = '20';

  const modeBtns = [byId.get('btnModeCost'), byId.get('btnModeSale')];
  modeBtns[0].setAttribute('data-mode', 'onCost');
  modeBtns[0].classList.add('active');
  modeBtns[1].setAttribute('data-mode', 'onSale');

  const rateCards = ['bcv', 'binance', 'euro', 'custom'].map((k) => {
    const el = makeMockElement('rc-' + k, 'button');
    el.setAttribute('data-rate', k);
    return el;
  });
  rateCards[0].classList.add('active');

  const dashTabs = ['calc', 'prod', 'hist', 'tasas', 'lote', 'guia', 'pro'].map((k) => {
    const el = makeMockElement('dt-' + k, 'button');
    el.setAttribute('data-tab', k);
    return el;
  });
  const dashViews = ['calc', 'prod', 'hist', 'tasas', 'lote', 'guia', 'pro'].map((k) => byId.get('tabView-' + k));
  const payPlanBtns = ['monthly', 'quarterly', 'semiannual', 'annual'].map((k) => {
    const el = makeMockElement('pp-' + k, 'button');
    el.setAttribute('data-pay-plan', k);
    return el;
  });
  const payMethodBtns = ['pago_movil', 'usdt'].map((k) => {
    const el = makeMockElement('pm-' + k, 'button');
    el.setAttribute('data-pay-method', k);
    return el;
  });
  const repPeriodBtns = ['day', 'week', 'month', 'product'].map((k) => {
    const el = makeMockElement('rp-' + k, 'button');
    el.setAttribute('data-rep-period', k);
    return el;
  });

  const store = {};
  const storage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const docListeners = {};
  const doc = {
    body: makeMockElement('body', 'body'),
    activeElement: null,
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => makeMockElement('dyn-' + tag, tag),
    addEventListener: (ev, fn) => { (docListeners[ev] = docListeners[ev] || []).push(fn); },
    dispatchClick(target) {
      const ev = { type: 'click', target, preventDefault() {} };
      (docListeners.click || []).forEach((fn) => fn(ev));
    },
    querySelector: (sel) => {
      if (sel === '.rate-card.active') return rateCards.find((x) => x.classList.contains('active')) || rateCards[0];
      if (sel === '.mode-btn.active') return modeBtns.find((x) => x.classList.contains('active')) || modeBtns[0];
      if (sel === '#desktopGuideSlot') return byId.get('desktopGuideSlot');
      if (sel === '#mobileGuideSlot') return byId.get('mobileGuideSlot');
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === '.rate-card') return rateCards;
      if (sel === '.mode-btn') return modeBtns;
      if (sel === '.dash-tab') return dashTabs;
      if (sel === '.dash-view') return dashViews;
      if (sel === '[data-pay-plan]') return payPlanBtns;
      if (sel === '[data-pay-method]') return payMethodBtns;
      if (sel === '[data-rep-period]') return repPeriodBtns;
      return [];
    },
  };

  let curAuth = authMockState || {
    firebaseOn: true,
    user: null,
    isPro: false,
    subState: { isPro: false, status: 'free', daysLeft: 0 },
    subCurrent: null,
    subPending: null,
    prodItems: [],
    histItems: [],
    profileSettings: { businessName: '' },
    alertSettings: {},
  };

  const sandbox = {
    console,
    Math,
    Number,
    String,
    Array,
    Object,
    Date,
    JSON,
    Intl,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    Blob: class {},
    Uint8Array,
    TextEncoder,
    TextDecoder,
    setTimeout: () => 1,
    clearTimeout: () => {},
    matchMedia: () => ({ matches: false }),
    localStorage: storage,
    navigator: { clipboard: { writeText: async () => {} } },
    location: { hash: '' },
    innerWidth: 1200,
    addEventListener: () => {},
    scrollTo: () => {},
    fetch: async (url, init) => sandbox.__fetchImpl(url, init),
    __fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    AbortController: globalThis.AbortController,
    document: doc,
    __submittedPayments: [],
    __margenesAuthBridge: {
      getState: () => curAuth,
      setState(next) { curAuth = next; },
      openAuth() {},
      getIdToken: async () => (curAuth.user ? 'fake-jwt-token' : null),
      applyActivatedSubscription(subDoc) {
        curAuth = Object.assign({}, curAuth, {
          isPro: true,
          subCurrent: subDoc,
          subPending: null,
          subState: sandbox.ProCore.subscriptionState(subDoc),
        });
        sandbox.ProUI.onStateChange(curAuth);
      },
      getShareSelection: () => ({ selectedCats: {}, includeUncat: true, overrideRate: '' }),
      async submitPendingPayment(p) { sandbox.__submittedPayments.push(p); },
      async saveProfileSettings(n) { curAuth.profileSettings = { businessName: n }; },
      async saveAlertSettings(c) { curAuth.alertSettings = c; },
      async applyRevaluationUpdates() {},
      async importProductsBatch(arr) { return arr.length; },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  for (const file of ['pro-config.js', 'pro-core.js', 'pro-files.js', 'app.js', 'pro-ui.js']) {
    vm.runInContext(read(file), sandbox, { filename: file });
  }
  return { sandbox, byId, html, doc, modeBtns, setAuthState(next) { curAuth = next; sandbox.ProUI.onStateChange(next); } };
}

test('index.html sin IDs duplicados y todos los IDs de pro-ui.js/app.js existen', () => {
  const html = read('index.html');
  const { ids, counts } = extractHtmlIds(html);
  const dups = Object.entries(counts).filter(([, n]) => n > 1);
  assert.deepEqual(dups, [], 'IDs duplicados en index.html: ' + JSON.stringify(dups));

  const idSet = new Set(ids);
  const proUi = read('pro-ui.js');
  const dynamicIds = new Set(['btnProLoginNow', 'btnDismissAlert']);
  const missing = [];
  const re = /\$\(\s*'([^']+)'\s*\)/g;
  let m;
  while ((m = re.exec(proUi))) {
    if (!dynamicIds.has(m[1]) && !idSet.has(m[1])) missing.push(m[1]);
  }
  assert.deepEqual(missing, [], 'IDs faltantes en index.html usados por pro-ui.js: ' + missing.join(', '));

  // También verifica IDs referenciados por app.js y auth.js
  for (const [fname, reStr] of [
    ['app.js', /\$\(\s*'([^']+)'\s*\)/g],
    ['auth.js', /\bel\(\s*'([^']+)'\s*\)/g],
  ]) {
    const src = read(fname);
    const missFile = [];
    let k;
    while ((k = reStr.exec(src))) {
      if (!dynamicIds.has(k[1]) && !idSet.has(k[1])) missFile.push(k[1]);
    }
    assert.deepEqual(missFile, [], `IDs faltantes en index.html usados por ${fname}: ` + missFile.join(', '));
  }
});

test('sin textos rotos (Promedio ???, placeholders caducados o Crom Studio)', () => {
  for (const f of ['index.html', 'app.js', 'auth.js', 'pro-core.js', 'pro-ui.js', 'terminos.html', 'privacidad.html']) {
    const content = read(f);
    assert.ok(!/Promedio\s*\?\?\?|\?\?\?/.test(content), `${f} contiene ???`);
    assert.ok(!/cromstudio/i.test(content), `${f} menciona cromstudio`);
    assert.ok(!/Mañana \(11 nov\)/i.test(content), `${f} conserva texto estático viejo`);
  }
});

test('páginas Términos y Privacidad existen con contenido mínimo requerido', () => {
  const html = read('index.html');
  assert.ok(html.includes('href="terminos.html"'), 'Falta enlace a terminos.html en footer');
  assert.ok(html.includes('href="privacidad.html"'), 'Falta enlace a privacidad.html en footer');

  const term = read('terminos.html');
  assert.ok(/no son reembolsables/i.test(term));
  assert.ok(/salvo/i.test(term));
  assert.ok(/1,99/.test(term) && /15/.test(term));

  const priv = read('privacidad.html');
  assert.ok(/correo/i.test(priv) && /productos/i.test(priv) && /historial/i.test(priv));
});

test('PASO 0: Markup (onCost) y Margen s/venta (onSale) cuadran al centavo con $10 @ 901,62', () => {
  const { sandbox, byId } = createHarness();
  const mMarkup = sandbox.computeSaleMetrics({
    costUsd: 10, rate: 901.62, marginPercent: 20, comFraction: 0.07,
    fixedExpenseBs: 0, roundStep: 10, mode: 'onCost'
  });
  assert.equal(mMarkup.precioExacto.toFixed(2), '11633.81');
  assert.equal(mMarkup.precioFinal, 11640);
  assert.equal(mMarkup.gananciaBs.toFixed(2), '1809.00');

  assert.equal(byId.get('precioExacto').textContent, 'Bs 11.633,81');
  assert.equal(byId.get('gananciaBs').textContent, 'Bs 1.809,00');
  assert.ok(byId.get('step3f').textContent.includes('1 + 0,2'), 'Paso 3 Markup debe multiplicar (1+margen): ' + byId.get('step3f').textContent);
  assert.ok(byId.get('step4f').textContent.includes('÷ (1 − 0,07)'), 'Paso 4 Markup debe dividir entre (1-com): ' + byId.get('step4f').textContent);
  assert.equal(byId.get('step4r').textContent, 'Bs 11.633,81');
  assert.ok(byId.get('step5r').textContent.includes('Ganancia: Bs 1.809,00'), 'Paso 5 Markup debe coincidir al centavo: ' + byId.get('step5r').textContent);

  // Cambiar a Margen sobre venta (onSale)
  byId.get('btnModeSale').click();
  const mSale = sandbox.computeSaleMetrics({
    costUsd: 10, rate: 901.62, marginPercent: 20, comFraction: 0.07,
    fixedExpenseBs: 0, roundStep: 10, mode: 'onSale'
  });
  assert.equal(mSale.precioExacto.toFixed(2), '12350.96');
  assert.equal(mSale.precioFinal, 12360);
  assert.equal(mSale.gananciaBs.toFixed(2), '2478.60');

  assert.equal(byId.get('precioExacto').textContent, 'Bs 12.350,96');
  assert.equal(byId.get('gananciaBs').textContent, 'Bs 2.478,60');
  assert.ok(byId.get('step3r').textContent.includes('0,73'), 'Paso 3 s/venta debe ser 0,73');
  assert.equal(byId.get('step4r').textContent, 'Bs 12.350,96');
  assert.ok(byId.get('step5r').textContent.includes('Ganancia: Bs 2.478,60'), 'Paso 5 s/venta debe coincidir al centavo: ' + byId.get('step5r').textContent);

  const tabla = byId.get('tablaBody').innerHTML;
  assert.ok(tabla.includes('<tr'), '#tablaBody no debe estar vacío');
  assert.ok(tabla.includes('20%') && tabla.includes('current'), 'Debe destacar la fila del 20%');
});

test('vigencia de tasas idéntica entre tarjetas de calculadora y pestaña Tasas y Brecha', () => {
  const { byId } = createHarness();
  assert.equal(byId.get('rateSrc-bcv').textContent, byId.get('tasasFecha-bcv').textContent);
  assert.equal(byId.get('rateSrc-euro').textContent, byId.get('tasasFecha-euro').textContent);
  assert.ok(!/\?\?\?/.test(byId.get('rateSrc-bcv').textContent));
});

test('Planes Pro: precios USD/Bs (4 planes), pago Pabilo/manual, Panel Admin y bloqueo Gratis vs Pro', async () => {
  const { byId, sandbox, setAuthState } = createHarness();
  assert.equal(byId.get('planMonthlyUsd').textContent, '$1,99');
  assert.equal(byId.get('planQuarterlyUsd').textContent, '$4,99');
  assert.equal(byId.get('planSemiannualUsd').textContent, '$7,99');
  assert.equal(byId.get('planAnnualUsd').textContent, '$15,99');
  assert.equal(byId.get('planQuarterlySavings').textContent, 'Ahorra 16%');
  assert.equal(byId.get('planSemiannualSavings').textContent, 'Ahorra 33%');
  assert.equal(byId.get('planAnnualSavings').textContent, 'Ahorra 33%');
  assert.ok(byId.get('planMonthlyBs').textContent.includes('Bs 1.794,22'));
  assert.ok(byId.get('planQuarterlyBs').textContent.includes('Bs 4.499,08'));
  assert.ok(byId.get('planSemiannualBs').textContent.includes('Bs 7.203,94'));
  assert.ok(byId.get('planAnnualBs').textContent.includes('Bs 14.416,90'));
  assert.equal(byId.get('adminPanelSection').hidden, true);
  assert.ok(byId.get('payInstructions').innerHTML.includes('Valor por configurar'));
  assert.ok(!/041[246]|042[46]/.test(byId.get('payInstructions').innerHTML));

  // Usuario Gratis: funciones Pro muestran proGateModal, Panel Admin oculto y secciones Pro quedan bloqueadas
  setAuthState({
    firebaseOn: true,
    user: { uid: 'u1', email: 'vendedor@ejemplo.com', displayName: 'Vendedor' },
    isPro: false,
    subState: { isPro: false, status: 'free', daysLeft: 0 },
    subCurrent: null,
    subPending: null,
    prodItems: Array.from({ length: 10 }, (_, i) => ({
      id: 'p' + i,
      data: { name: 'Prod ' + i, category: 'Cat', costUsd: 5, marginPercent: 20, marginMode: 'onCost', commissionPlatform: 0, commissionPaymentMethod: 0, commissionOther: 0, fixedExpenseBs: 0, rateSourceName: 'bcvUsd', roundStep: 10 }
    })),
    histItems: [],
    profileSettings: { businessName: '' },
    alertSettings: {},
  });
  assert.equal(byId.get('adminPanelSection').hidden, true);
  assert.equal(sandbox.ProCore.canAddProduct(10, false), false);
  assert.equal(byId.get('reportsProLock').hidden, false);
  assert.equal(byId.get('reportsProBody').hidden, true);
  byId.get('proGateModal').hidden = true;
  byId.get('btnRevalueCatalog').click();
  assert.equal(byId.get('proGateModal').hidden, false, 'Gratis al tocar Revalorizar debe abrir proGateModal');
  byId.get('btnCloseGateModal').click();
  assert.equal(byId.get('proGateModal').hidden, true);

  // Respaldo manual cuando se solicita manualmente
  byId.get('payReference').value = 'REF998877';
  await byId.get('btnSubmitManualFallback').click();
  assert.equal(sandbox.__submittedPayments.length, 1);
  assert.equal(sandbox.__submittedPayments[0].reference, 'REF998877');
  assert.equal(sandbox.__submittedPayments[0].plan, 'annual');
  assert.equal(sandbox.__submittedPayments[0].method, 'pago_movil');

  // Flujo automático Pabilo: generar orden (tasa congelada) -> abono parcial -> completar pago y activar Pro al instante
  const flush = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
  const futureActivatedEnd = new Date(Date.now() + 365 * 86400000).toISOString();
  let verifyStep = 0;
  sandbox.__fetchImpl = async (url, init) => {
    if (String(url).includes('checkout')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          order: {
            id: 'ord_web_1',
            plan: 'annual',
            method: 'pago_movil',
            currency: 'BS',
            expectedAmountUsd: 15.99,
            expectedAmountBs: 14416.9,
            expectedTotal: 14416.9,
            paidAmount: 0,
            remainingAmount: 14416.9,
            rateBs: 901.62,
            expiresAt: new Date(Date.now() + 1800000).toISOString(),
          },
          paymentConfig: {
            pago_movil: { banco: 'BDV', telefono: '', cedulaRif: '', titular: '', autoVerify: true },
            usdt: { red: 'Binance Pay', binanceId: '', direccion: '', autoVerify: false },
          },
        }),
      };
    }
    if (String(url).includes('verify')) {
      verifyStep++;
      if (verifyStep === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: false,
            code: 'PARTIAL_PAYMENT',
            paidAmount: 10000,
            remainingAmount: 4416.9,
            expiresAt: new Date(Date.now() + 1800000).toISOString(),
            message: 'Recibimos Bs 10000.00. Faltan Bs 4416.90.',
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          code: 'ACTIVATED',
          status: 'paid',
          subscription: {
            v: 1,
            plan: 'annual',
            status: 'active',
            provider: 'pabilo_bdv',
            startDate: new Date().toISOString(),
            endDate: futureActivatedEnd,
          },
        }),
      };
    }
    if (String(url).includes('adminmanagepro')) {
      const reqBody = JSON.parse((init && init.body) || '{}');
      if (reqBody.action === 'overview') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            stats: { totalUsers: 2, activePro: 1, pendingManual: 0 },
            users: [
              { uid: 'adm1', email: 'layankrach@gmail.com', displayName: 'Layan', isOwner: true, isPro: true, status: 'active', plan: 'annual', daysLeft: 3650, endDate: futureActivatedEnd },
              { uid: 'c1', email: 'amigo@gmail.com', displayName: 'Amigo', isOwner: false, isPro: false, status: 'free', daysLeft: 0, endDate: null },
            ],
          }),
        };
      }
      if (reqBody.action === 'activate') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            code: 'PRO_ACTIVATED',
            user: { uid: 'c1', email: reqBody.email, displayName: 'Amigo', isOwner: false, isPro: true, status: 'active', plan: reqBody.plan || 'monthly', daysLeft: reqBody.days || 30, endDate: futureActivatedEnd },
            message: 'Pro activado para ' + reqBody.email,
          }),
        };
      }
      if (reqBody.action === 'deactivate') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            code: 'PRO_DEACTIVATED',
            user: { uid: 'c1', email: reqBody.email, displayName: 'Amigo', isOwner: false, isPro: false, status: 'canceled', plan: 'monthly', daysLeft: 0 },
            message: 'Suscripción Pro desactivada para ' + reqBody.email,
          }),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  byId.get('btnCreateOrder').click();
  await flush();
  assert.equal(byId.get('payOrderBox').hidden, false);
  assert.ok(byId.get('payOrderBox').innerHTML.includes('ord_web_1'));
  assert.ok(byId.get('payOrderBox').innerHTML.includes('14.416,90'));

  byId.get('payReference').value = '00112233';
  byId.get('btnSubmitPayment').click();
  await flush();
  assert.equal(byId.get('payStatusBanner').hidden, false);
  assert.ok(byId.get('payStatusBanner').innerHTML.includes('Pago parcial acreditado'));
  assert.ok(byId.get('payOrderBox').innerHTML.includes('4.416,90'));

  byId.get('payReference').value = '44556677';
  byId.get('btnSubmitPayment').click();
  await flush();
  assert.equal(sandbox.__margenesAuthBridge.getState().isPro, true);
  assert.equal(byId.get('reportsProLock').hidden, true);
  assert.ok(byId.get('payStatusBanner').innerHTML.includes('Suscripción Pro activada'));

  // Administrador autorizado ve #adminPanelSection y puede regalar/activar y desactivar Pro
  setAuthState({
    firebaseOn: true,
    user: { uid: 'adm1', email: 'layankrach@gmail.com', displayName: 'Layan', emailVerified: true },
    isPro: true,
    subState: { isPro: true, status: 'pro', plan: 'annual', daysLeft: 3650, startDate: new Date().toISOString(), endDate: futureActivatedEnd },
    subCurrent: { plan: 'annual', status: 'active', provider: 'admin_owner', endDate: futureActivatedEnd },
    subPending: null,
    prodItems: [],
    histItems: [],
    profileSettings: { businessName: '' },
    alertSettings: {},
  });
  assert.equal(byId.get('adminPanelSection').hidden, false);
  byId.get('btnAdminRefresh').click();
  await flush();
  assert.ok(byId.get('adminUsersList').innerHTML.includes('amigo@gmail.com'));
  byId.get('adminSearchEmail').value = 'amigo@gmail.com';
  byId.get('adminPlanSelect').value = 'monthly';
  byId.get('adminCustomDays').value = '30';
  byId.get('btnAdminActivate').click();
  await flush();
  assert.equal(byId.get('adminLookupPreview').hidden, false);
  assert.ok(byId.get('adminLookupPreview').innerHTML.includes('PRO'));
  byId.get('btnAdminDeactivate').click();
  await flush();
  assert.ok(byId.get('adminNoticeBox').textContent.includes('desactivada'));

  // Usuario Pro activo: desbloquea reportes, alertas, lote y revalorización
  const futureEnd = new Date(Date.now() + 20 * 86400000).toISOString();
  setAuthState({
    firebaseOn: true,
    user: { uid: 'u1', email: 'vendedor@ejemplo.com', displayName: 'Vendedor' },
    isPro: true,
    subState: { isPro: true, status: 'pro', plan: 'annual', daysLeft: 20, startDate: new Date().toISOString(), endDate: futureEnd },
    subCurrent: { plan: 'annual', status: 'active', endDate: futureEnd },
    subPending: null,
    prodItems: [
      { id: 'p1', data: { name: '100 Diamantes', category: 'Free Fire', costUsd: 1, marginPercent: 30, marginMode: 'onCost', commissionPlatform: 0, commissionPaymentMethod: 0, commissionOther: 0, fixedExpenseBs: 0, rateSourceName: 'bcvUsd', roundStep: 10 } }
    ],
    histItems: [
      { id: 'h1', data: { title: '100 Diamantes', costUsd: 1, rateValue: 901.62, finalPriceBs: 1180, gananciaBs: 278.38, timestamp: new Date().toISOString() } }
    ],
    profileSettings: { businessName: 'Tienda Prueba' },
    alertSettings: { gapEnabled: true, gapThresholdPct: 15 },
  });
  assert.equal(byId.get('reportsProLock').hidden, true);
  assert.equal(byId.get('reportsProBody').hidden, false);
  assert.ok(byId.get('btnHeaderPro').textContent.includes('Pro'));
  assert.ok(byId.get('reportTableBody').innerHTML.includes('278,38'));

  // Revalorización Pro
  await byId.get('btnRevalueCatalog').click();
  assert.ok(byId.get('revalTableBody').innerHTML.includes('100 Diamantes'));
  // Calculadora por lote Pro
  byId.get('loteRate').value = '901.62';
  byId.get('loteMargen').value = '20';
  byId.get('loteComTotal').value = '7';
  byId.get('loteGasto').value = '0';
  byId.get('loteRound').value = '10';
  byId.get('loteMode').value = 'onCost';
  byId.get('loteInput').value = 'Prueba 10';
  byId.get('btnCalcLote').click();
  assert.ok(byId.get('loteTableBody').innerHTML.includes('11.640'));
});
