/* MargenCalcu · navegación de herramientas.
   - Escritorio ancho: barra lateral fija y siempre visible.
   - Tablet/móvil: menú desplegable desde el botón del encabezado.
   No cambia la lógica de pestañas: solo controla el panel y el foco. */
(function () {
  var trigger = document.getElementById('btnToolsPanel');
  var panel = document.getElementById('toolsPanel');
  var backdrop = document.getElementById('toolsBackdrop');
  var closeBtn = document.getElementById('btnCloseToolsPanel');
  var nav = document.getElementById('toolsNav');
  var installBtn = document.getElementById('btnInstallSidebar');
  var desktopMQ = window.matchMedia('(min-width: 1280px)');
  var lastTrigger = null;

  if (!trigger || !panel) return;

  function isDesktop() {
    return desktopMQ.matches;
  }

  function isOpen() {
    return panel.classList.contains('open');
  }

  function syncCurrentTab() {
    var tabs = panel.querySelectorAll('.dash-tab');
    Array.prototype.forEach.call(tabs, function (tab) {
      if (tab.classList.contains('active')) {
        tab.setAttribute('aria-current', 'page');
      } else {
        tab.removeAttribute('aria-current');
      }
    });
  }

  function focusableItems() {
    var nodes = panel.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    return Array.prototype.filter.call(nodes, function (el) {
      return el.offsetParent !== null || el === document.activeElement;
    });
  }

  function openPanel(source) {
    if (isDesktop() || isOpen()) return;
    lastTrigger = source || trigger;
    syncCurrentTab();
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    trigger.setAttribute('aria-expanded', 'true');
    if (backdrop) backdrop.classList.add('open');
    document.body.classList.add('tools-panel-open');
    try {
      window.dispatchEvent(new CustomEvent('mc:panel-open', { detail: 'tools' }));
    } catch (e) {}
    window.setTimeout(function () {
      if (closeBtn) closeBtn.focus();
    }, 60);
  }

  function closePanel(options) {
    if (!isOpen()) return;
    var silent = options && options.silent;
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    if (backdrop) backdrop.classList.remove('open');
    document.body.classList.remove('tools-panel-open');
    if (!silent && !isDesktop() && lastTrigger && !lastTrigger.hidden) lastTrigger.focus();
    lastTrigger = null;
  }

  function applyLayout() {
    if (isDesktop()) {
      if (isOpen()) closePanel({ silent: true });
      panel.removeAttribute('role');
      panel.removeAttribute('aria-modal');
      panel.removeAttribute('aria-hidden');
      document.body.classList.remove('tools-panel-open');
    } else {
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-hidden', isOpen() ? 'false' : 'true');
    }
    syncCurrentTab();
  }

  trigger.addEventListener('click', function () {
    if (isOpen()) {
      closePanel();
    } else {
      openPanel(trigger);
    }
  });

  if (closeBtn) closeBtn.addEventListener('click', closePanel);
  if (backdrop) backdrop.addEventListener('click', closePanel);

  if (nav) {
    nav.addEventListener('click', function (event) {
      var tab = event.target && event.target.closest ? event.target.closest('.dash-tab') : null;
      if (!tab) return;
      closePanel();
      window.setTimeout(syncCurrentTab, 0);
    });
    if (typeof window.MutationObserver === 'function') {
      new window.MutationObserver(syncCurrentTab).observe(nav, {
        attributes: true,
        subtree: true,
        attributeFilter: ['class']
      });
    }
  }

  panel.addEventListener('keydown', function (event) {
    if (event.key !== 'Tab' || isDesktop() || !isOpen()) return;
    var items = focusableItems();
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  if (installBtn) {
    installBtn.addEventListener('click', function () {
      closePanel({ silent: true });
      window.setTimeout(function () {
        var topBtn = document.getElementById('btnInstallAppTop');
        if (topBtn) topBtn.click();
      }, 0);
    });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !isDesktop() && isOpen()) closePanel();
  });

  window.addEventListener('mc:panel-open', function (event) {
    if (!event || event.detail !== 'tools') closePanel();
  });

  if (typeof desktopMQ.addEventListener === 'function') {
    desktopMQ.addEventListener('change', applyLayout);
  } else if (typeof desktopMQ.addListener === 'function') {
    desktopMQ.addListener(applyLayout);
  }
  window.addEventListener('resize', applyLayout);
  if (typeof window.ResizeObserver === 'function') {
    new window.ResizeObserver(applyLayout).observe(document.documentElement);
  }

  applyLayout();
})();
