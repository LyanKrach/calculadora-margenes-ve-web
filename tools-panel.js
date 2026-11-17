/* MargenCalcu · panel lateral de herramientas.
   Mueve la navegación del dashboard a un panel lateral accesible desde el encabezado.
   No cambia la lógica de pestañas: solo abre, cierra y devuelve el foco. */
(function () {
  var trigger = document.getElementById('btnToolsPanel');
  var panel = document.getElementById('toolsPanel');
  var backdrop = document.getElementById('toolsBackdrop');
  var closeBtn = document.getElementById('btnCloseToolsPanel');
  var nav = document.getElementById('toolsNav');
  var lastTrigger = null;

  if (!trigger || !panel) return;

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
    if (isOpen()) return;
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

  function closePanel() {
    if (!isOpen()) return;
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    if (backdrop) backdrop.classList.remove('open');
    document.body.classList.remove('tools-panel-open');
    if (lastTrigger && !lastTrigger.hidden) lastTrigger.focus();
    lastTrigger = null;
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
      if (tab) closePanel();
    });
  }

  panel.addEventListener('keydown', function (event) {
    if (event.key !== 'Tab') return;
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

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isOpen()) closePanel();
  });

  window.addEventListener('mc:panel-open', function (event) {
    if (!event || event.detail !== 'tools') closePanel();
  });
})();
