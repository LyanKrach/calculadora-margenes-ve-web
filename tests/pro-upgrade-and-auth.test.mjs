import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function makeElement(tag, id, attrs = {}) {
  const listeners = new Map();
  const classes = new Set();
  const el = {
    tagName: tag.toUpperCase(),
    id: id || '',
    attrs: { ...attrs },
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    _innerHTML: '',
    children: [],
    parentNode: null,
    style: {},
    classList: {
      add: (...cs) => cs.forEach(c => classes.add(c)),
      remove: (...cs) => cs.forEach(c => classes.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (classes.has(c)) { classes.delete(c); return false; }
          classes.add(c); return true;
        }
        if (force) classes.add(c); else classes.delete(c);
        return !!force;
      },
      contains: c => classes.has(c),
    },
    getAttribute: k => (k in el.attrs ? el.attrs[k] : null),
    setAttribute: (k, v) => { el.attrs[k] = String(v); },
    addEventListener: (ev, fn) => {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
    },
    click: () => {
      const fns = listeners.get('click') || [];
      return Promise.all(fns.map(fn => fn({ currentTarget: el, target: el, preventDefault() {} })));
    },
    focus: () => {},
    appendChild: c => { c.parentNode = el; el.children.push(c); return c; },
    removeChild: c => { el.children = el.children.filter(x => x !== c); return c; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._innerHTML,
    set: v => { el._innerHTML = String(v == null ? '' : v); },
  });
  return el;
}

function makeProUIHarness({ initialSubCurrent = null, verifyDelayMs = 0 } = {}) {
  const byId = new Map();
  const allEls = [];
  const reg = (el) => {
    allEls.push(el);
    if (el.id) byId.set(el.id, el);
    return el;
  };

  for (const id of [
    'toast', 'proGateModal', 'proGateMsg', 'payFlowArea', 'payMaxPlanNotice',
    'payTotalSummary', 'payAutoBadge', 'payInstructions', 'payReference',
    'btnCreateOrder', 'btnSubmitPayment', 'btnSubmitManualFallback',
    'payStatusBanner', 'activeOrderCard', 'proStatusPill', 'proSupportCard',
    'proStatusBanner', 'proAdminCard', 'adminUsersList',
  ]) {
    reg(makeElement(id === 'payReference' ? 'input' : 'div', id));
  }

  for (const pid of ['monthly', 'quarterly', 'semiannual', 'annual']) {
    reg(makeElement('article', '', { 'data-plan-card': pid }));
    reg(makeElement('div', 'planUpgradeNote-' + pid));
    reg(makeElement('button', '', { 'data-choose-plan': pid }));
    reg(makeElement('button', '', { 'data-pay-plan': pid }));
  }
  for (const mid of ['pago_movil', 'usdt']) {
    reg(makeElement('button', '', { 'data-pay-method': mid }));
  }

  const domListeners = [];
  const doc = {
    body: reg(makeElement('body', '')),
    createElement: tag => reg(makeElement(tag, '')),
    getElementById: id => byId.get(id) || null,
    querySelector: sel => {
      const m = sel.match(/^\[([a-z-]+)="([^"]+)"\]$/i);
      if (m) return allEls.find(e => e.getAttribute(m[1]) === m[2]) || null;
      return null;
    },
    querySelectorAll: sel => {
      const m = sel.match(/^\[([a-z-]+)\]$/i);
      if (m) return allEls.filter(e => e.getAttribute(m[1]) != null);
      const m2 = sel.match(/^\[([a-z-]+)="([^"]+)"\]$/i);
      if (m2) return allEls.filter(e => e.getAttribute(m2[1]) === m2[2]);
      return [];
    },
    addEventListener: (ev, fn) => { domListeners.push({ ev, fn }); },
  };

  const storage = new Map();
  let currentSub = initialSubCurrent;
  let verifyResolve = null;
  const fetchCalls = [];
  const unrefSetTimeout = (fn, ms) => {
    const t = setTimeout(fn, ms);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };

  const sandbox = {
    document: doc,
    location: { search: '', pathname: '/', origin: 'https://margencalcu.online', href: 'https://margencalcu.online/' },
    history: { replaceState() {} },
    scrollTo: () => {},
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k),
    },
    getRatesSnapshot: () => ({ bcvUsd: 901.62, bcvPrevUsd: 900, binanceUsdt: 1050, euroBcv: 980, custom: 0, bcvDate: '2026-11-11' }),
    PRO_PAYMENT_CONFIG: {
      pago_movil: { enabled: true, autoVerify: true, bank: 'BDV', bankCode: '0102', dni: '31955598', phone: '04220336568' },
      usdt: { enabled: true, autoVerify: true, binanceId: '916942742' },
      support: { whatsapp: '+584161740312', email: 'soporterefillstore@gmail.com' },
    },
    fetch: async (url) => {
      fetchCalls.push(String(url));
      if (String(url).includes('getpropaymentconfig')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, methods: { pago_movil: { autoVerify: true }, usdt: { autoVerify: true } } }) };
      }
      if (String(url).includes('createprocheckout')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            order: {
              id: 'ord-test-1',
              plan: 'monthly',
              method: 'pago_movil',
              amountUsd: 1.99,
              amountBs: 1794.22,
              rateBs: 901.62,
              expiresAt: '2026-11-11T17:00:00Z',
            },
          }),
        };
      }
      if (String(url).includes('verifypropayment')) {
        if (verifyDelayMs > 0) {
          await new Promise(resolve => { verifyResolve = resolve; });
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            code: 'ACTIVATED',
            status: 'paid',
            subscription: { v: 1, plan: 'monthly', status: 'active', provider: 'pabilo_bdv', startDate: '2026-11-11T16:00:00Z', endDate: '2026-12-11T16:00:00Z' },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    __margenesAuthBridge: {
      getState: () => {
        const subState = sandbox.ProCore.subscriptionState(currentSub, new Date('2026-11-11T16:00:00Z'));
        return {
          firebaseOn: true,
          user: { uid: 'u1', email: 'cliente@gmail.com', displayName: 'Cliente' },
          isPro: subState.isPro,
          subState,
          subCurrent: currentSub,
          subPending: null,
          prodItems: [],
          histItems: [],
          profileSettings: { businessName: 'Mi Negocio' },
          alertSettings: {},
        };
      },
      getIdToken: async () => 'fake-token',
      applyActivatedSubscription: (sub) => { currentSub = sub; },
      openAuth: () => {},
      submitPendingPayment: async () => {},
    },
    console,
    setTimeout: unrefSetTimeout,
    clearTimeout,
    Intl,
    Date,
    Math,
    JSON,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    AbortController,
    Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(rootDir, 'pro-core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(rootDir, 'pro-files.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(rootDir, 'pro-ui.js'), 'utf8'), ctx);
  for (const { ev, fn } of domListeners) {
    if (ev === 'DOMContentLoaded') fn();
  }
  ctx.ProUI.onStateChange(sandbox.__margenesAuthBridge.getState());
  return {
    ctx,
    byId,
    doc,
    fetchCalls,
    setSub: (s) => {
      currentSub = s;
      ctx.ProUI.onStateChange(sandbox.__margenesAuthBridge.getState());
    },
    releaseVerify: () => { if (verifyResolve) verifyResolve(); },
  };
}

test('auth.js, pro-ui.js y solo-archivo no contienen renderAuthUI ni Verificando con Pabilo', () => {
  for (const file of ['auth.js', 'pro-ui.js', 'calculadora-margenes-ve-solo-archivo.html']) {
    const content = fs.readFileSync(path.join(rootDir, file), 'utf8');
    assert.equal(content.includes('renderAuthUI'), false, file + ' no debe contener renderAuthUI');
    assert.equal(/Verificando con Pabilo/i.test(content), false, file + ' no debe contener "Verificando con Pabilo"');
  }
});

test('auth.js applyActivatedSubscription llama handleSubscriptionTransition sin ReferenceError', () => {
  const byId = new Map();
  const makeStubEl = () => ({
    hidden: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    value: '',
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    setAttribute() {},
    querySelectorAll: () => [],
  });
  const doc = {
    getElementById: id => byId.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => makeStubEl(),
  };
  let notified = 0;
  const unrefSetTimeout = (fn, ms) => {
    const t = setTimeout(fn, ms);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
  const sandbox = {
    document: doc,
    location: { search: '', origin: 'https://margencalcu.online', href: 'https://margencalcu.online/' },
    FIREBASE_CONFIG: { apiKey: 'TU_API_KEY' },
    ProUI: {
      onStateChange: () => { notified++; },
      onRatesUpdated: () => {},
      onProGate: () => {},
    },
    renderAll: () => {},
    console,
    setTimeout: unrefSetTimeout,
    clearTimeout,
    Intl,
    Date,
    JSON,
    Number,
    String,
    Array,
    Object,
    Math,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(rootDir, 'pro-core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(rootDir, 'auth.js'), 'utf8'), ctx);

  assert.ok(ctx.__margenesAuthBridge && typeof ctx.__margenesAuthBridge.applyActivatedSubscription === 'function');
  assert.doesNotThrow(() => {
    ctx.__margenesAuthBridge.applyActivatedSubscription({
      v: 1,
      plan: 'monthly',
      status: 'active',
      startDate: '2026-11-11T16:00:00Z',
      endDate: '2026-12-11T16:00:00Z',
    });
  });
  assert.equal(ctx.__margenesAuthBridge.getState().isPro, true);
  assert.equal(ctx.__margenesAuthBridge.getState().subState.plan, 'monthly');
  assert.ok(notified >= 1);
});

test('Verificando pago: botón y banner muestran "Verificando pago…" (no "Verificando con Pabilo")', async () => {
  const h = makeProUIHarness({ verifyDelayMs: 50 });
  const refEl = h.byId.get('payReference');
  refEl.value = '672806448860';
  const submitBtn = h.byId.get('btnSubmitPayment');
  const pendingClick = submitBtn.click();

  await new Promise(r => setTimeout(r, 15));
  assert.equal(submitBtn.textContent, 'Verificando pago…');
  assert.ok(h.byId.get('payStatusBanner').innerHTML.includes('Verificando pago…'));
  assert.equal(submitBtn.textContent.includes('Pabilo'), false);
  assert.equal(h.byId.get('payStatusBanner').innerHTML.includes('Pabilo'), false);

  h.releaseVerify();
  await pendingClick;
});

test('Plan activo mensual: bloquea Mensual, ajusta acumulación de días en superiores y bloquea pago en Anual', () => {
  const futureMonthlyEnd = new Date(Date.now() + 30 * 86400000).toISOString();
  const h = makeProUIHarness({
    initialSubCurrent: {
      v: 1,
      plan: 'monthly',
      status: 'active',
      startDate: new Date().toISOString(),
      endDate: futureMonthlyEnd,
    },
  });

  // Plan actual bloqueado y planes superiores habilitados con ajuste
  const monthlyChoose = h.doc.querySelector('[data-choose-plan="monthly"]');
  const quarterlyChoose = h.doc.querySelector('[data-choose-plan="quarterly"]');
  const semiannualChoose = h.doc.querySelector('[data-choose-plan="semiannual"]');
  const annualChoose = h.doc.querySelector('[data-choose-plan="annual"]');
  const monthlyCard = h.doc.querySelector('[data-plan-card="monthly"]');
  const monthlyPayBtn = h.doc.querySelector('[data-pay-plan="monthly"]');

  assert.equal(monthlyChoose.disabled, true);
  assert.equal(monthlyPayBtn.disabled, true);
  assert.equal(monthlyCard.classList.contains('plan-current'), true);
  assert.equal(monthlyChoose.textContent, '✓ Plan actual activo');

  assert.equal(quarterlyChoose.disabled, false);
  assert.equal(semiannualChoose.disabled, false);
  assert.equal(annualChoose.disabled, false);
  assert.ok(quarterlyChoose.textContent.includes('Mejorar a Trimestral'));

  assert.equal(h.byId.get('planUpgradeNote-monthly').hidden, false);
  assert.ok(h.byId.get('planUpgradeNote-monthly').innerHTML.includes('Plan actual activo'));
  assert.equal(h.byId.get('planUpgradeNote-quarterly').hidden, false);
  assert.ok(h.byId.get('planUpgradeNote-quarterly').innerHTML.includes('Ajuste de acumulación de días'));
  assert.ok(h.byId.get('planUpgradeNote-quarterly').innerHTML.includes('120 días en total'));
  assert.equal(h.byId.get('planUpgradeNote-semiannual').innerHTML.includes('210 días en total'), true);
  assert.equal(h.byId.get('planUpgradeNote-annual').innerHTML.includes('395 días en total'), true);

  assert.equal(h.byId.get('payFlowArea').hidden, false);
  assert.equal(h.byId.get('payMaxPlanNotice').hidden, true);
  assert.ok(h.byId.get('payTotalSummary').innerHTML.includes('días acumulados'));

  // Plan anual activo (máximo): oculta formulario de compra y muestra aviso
  h.setSub({
    v: 1,
    plan: 'annual',
    status: 'active',
    startDate: new Date().toISOString(),
    endDate: new Date(Date.now() + 365 * 86400000).toISOString(),
  });
  assert.equal(h.byId.get('payFlowArea').hidden, true);
  assert.equal(h.byId.get('payMaxPlanNotice').hidden, false);
  assert.ok(h.byId.get('payMaxPlanNotice').innerHTML.includes('plan máximo'));
  assert.equal(h.doc.querySelector('[data-choose-plan="monthly"]').disabled, true);
  assert.equal(h.doc.querySelector('[data-choose-plan="quarterly"]').disabled, true);
  assert.equal(h.doc.querySelector('[data-choose-plan="semiannual"]').disabled, true);
  assert.equal(h.doc.querySelector('[data-choose-plan="annual"]').disabled, true);
});
