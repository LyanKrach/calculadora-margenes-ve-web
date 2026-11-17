/* MargenCalcu · instalación de la app web (PWA) desde un panel lateral.
   - Chrome/Edge/Android: usa beforeinstallprompt.
   - iPhone/iPad y navegadores sin prompt: muestra los pasos manuales dentro del panel.
   - No bloquea nada si el navegador no soporta instalación. */
(function () {
  var topBtn = document.getElementById('btnInstallAppTop');
  var sidebarInstall = document.getElementById('btnInstallSidebar');
  var footerLink = document.getElementById('linkInstallApp');
  var panel = document.getElementById('installPanel');
  var backdrop = document.getElementById('installPanelBackdrop');
  var closeBtn = document.getElementById('btnCloseInstallPanel');
  var cta = document.getElementById('btnInstallAppPanel');
  var helpBox = document.getElementById('installHelpBox');
  var helpSteps = document.getElementById('installHelpSteps');
  var hint = document.getElementById('installPanelHint');
  var deferredPrompt = null;
  var lastTrigger = null;

  function isStandalone() {
    try {
      return (
        window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true
      );
    } catch (e) {
      return false;
    }
  }

  function isIOS() {
    var ua = window.navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (ua.indexOf('Mac') > -1 && 'ontouchend' in document);
  }

  function manualSteps() {
    if (isIOS()) {
      return (
        '<li>Abre esta página en <b>Safari</b>.</li>' +
        '<li>Toca el botón <b>Compartir</b> (el cuadro con la flecha).</li>' +
        '<li>Elige <b>“Añadir a pantalla de inicio”</b> y confirma.</li>'
      );
    }
    return (
      '<li>Abre el menú del navegador (⋮ o similar).</li>' +
      '<li>Busca <b>“Instalar aplicación”</b> o <b>“Añadir a pantalla de inicio”</b>.</li>' +
      '<li>Confirma la instalación. Se abrirá como app independiente.</li>'
    );
  }

  function showHelp() {
    if (helpSteps) helpSteps.innerHTML = manualSteps();
    if (helpBox) helpBox.hidden = false;
    if (hint) {
      hint.textContent = isIOS()
        ? 'En iPhone o iPad la instalación se hace desde Safari con Compartir.'
        : 'Si tu navegador no muestra el instalador, usa el menú con estos pasos.';
    }
  }

  function hideHelp() {
    if (helpBox) helpBox.hidden = true;
    if (hint) {
      hint.textContent = deferredPrompt
        ? 'Tu navegador permite instalarla con un toque.'
        : 'Si tu navegador no muestra el instalador, aquí tienes los pasos manuales.';
    }
  }

  function openPanel(trigger) {
    if (!panel) return;
    lastTrigger = trigger || topBtn;
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    if (backdrop) backdrop.classList.add('open');
    document.body.classList.add('install-panel-open');
    try {
      window.dispatchEvent(new CustomEvent('mc:panel-open', { detail: 'install' }));
    } catch (e) {}
    if (deferredPrompt) hideHelp();
    else showHelp();
    setTimeout(function () {
      if (closeBtn) closeBtn.focus();
    }, 60);
  }

  function closePanel() {
    if (!panel) return;
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    if (backdrop) backdrop.classList.remove('open');
    document.body.classList.remove('install-panel-open');
    if (lastTrigger && !lastTrigger.hidden) lastTrigger.focus();
    lastTrigger = null;
  }

  function askInstall() {
    if (isStandalone()) return;
    if (deferredPrompt) {
      var promptEvent = deferredPrompt;
      deferredPrompt = null;
      promptEvent.prompt();
      Promise.resolve(promptEvent.userChoice)
        .then(function (choice) {
          if (choice && choice.outcome === 'accepted') {
            closePanel();
          } else {
            showHelp();
          }
        })
        .catch(function () {
          showHelp();
        });
      return;
    }
    showHelp();
  }

  function syncInstallTriggers() {
    var installed = isStandalone();
    if (topBtn) topBtn.hidden = installed;
    if (sidebarInstall) sidebarInstall.hidden = installed;
    if (footerLink) footerLink.hidden = installed;
    if (installed && panel && panel.classList.contains('open')) closePanel();
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    if (panel && panel.classList.contains('open')) hideHelp();
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    closePanel();
    syncInstallTriggers();
  });

  if (topBtn) topBtn.addEventListener('click', function () { openPanel(topBtn); });
  if (footerLink) {
    footerLink.addEventListener('click', function (event) {
      event.preventDefault();
      openPanel(footerLink);
    });
  }
  if (cta) cta.addEventListener('click', askInstall);
  if (closeBtn) closeBtn.addEventListener('click', closePanel);
  if (backdrop) backdrop.addEventListener('click', closePanel);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && panel && panel.classList.contains('open')) closePanel();
  });

  window.addEventListener('mc:panel-open', function (event) {
    if (!event || event.detail !== 'install') closePanel();
  });

  syncInstallTriggers();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }
})();
