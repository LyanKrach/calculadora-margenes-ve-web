/* MargenCalcu · instalación de la app web (PWA).
   - Chrome/Edge/Android: usa beforeinstallprompt.
   - iPhone/iPad y navegadores sin prompt: muestra instrucciones manuales.
   - No bloquea nada si el navegador no soporta instalación. */
(function () {
  var DISMISS_KEY = 'cmv_install_dismissed_at';
  var DISMISS_DAYS = 7;
  var deferredPrompt = null;
  var banner = document.getElementById('installApp');
  var bannerBtn = document.getElementById('btnInstallApp');
  var bannerHint = document.getElementById('installAppHint');
  var dismissBtn = document.getElementById('btnDismissInstall');
  var footerLink = document.getElementById('linkInstallApp');
  var helpModal = document.getElementById('installHelpModal');
  var helpClose = document.getElementById('btnCloseInstallHelp');
  var helpOk = document.getElementById('btnInstallHelpOk');
  var helpList = document.getElementById('installHelpSteps');

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

  function isMobile() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(window.navigator.userAgent || '');
  }

  function wasDismissedRecently() {
    try {
      var raw = window.localStorage.getItem(DISMISS_KEY);
      if (!raw) return false;
      var days = (Date.now() - parseInt(raw, 10)) / 86400000;
      return days >= 0 && days < DISMISS_DAYS;
    } catch (e) {
      return false;
    }
  }

  function rememberDismiss() {
    try {
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch (e) {}
  }

  function hideBanner() {
    if (banner) banner.hidden = true;
  }

  function showBanner() {
    if (!banner || isStandalone() || wasDismissedRecently()) return;
    if (bannerHint) {
      bannerHint.textContent = isIOS()
        ? 'En iPhone: toca Compartir y luego “Añadir a pantalla de inicio”.'
        : isMobile()
        ? 'Acceso rápido, pantalla completa y sin depender de la Play Store.'
        : 'Ábrela como app de escritorio, sin descargar instaladores.';
    }
    if (bannerBtn) {
      bannerBtn.textContent = isIOS() ? 'Cómo instalar' : '⬇ Instalar app';
    }
    banner.hidden = false;
  }

  function showHelp() {
    if (!helpModal) return;
    if (helpList) {
      helpList.innerHTML = isIOS()
        ? '<li>Abre esta página en <b>Safari</b>.</li>' +
          '<li>Toca el botón <b>Compartir</b> (el cuadro con la flecha).</li>' +
          '<li>Elige <b>“Añadir a pantalla de inicio”</b> y confirma.</li>'
        : '<li>Abre el menú del navegador (⋮ o similar).</li>' +
          '<li>Busca <b>“Instalar aplicación”</b> o <b>“Añadir a pantalla de inicio”</b>.</li>' +
          '<li>Confirma la instalación. Se abrirá como app independiente.</li>';
    }
    helpModal.hidden = false;
    if (helpClose) helpClose.focus();
  }

  function hideHelp() {
    if (helpModal) helpModal.hidden = true;
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
            hideBanner();
          } else {
            showBanner();
          }
        })
        .catch(function () {});
      return;
    }
    showHelp();
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    showBanner();
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    hideBanner();
    hideHelp();
    try {
      window.localStorage.removeItem(DISMISS_KEY);
    } catch (e) {}
  });

  if (bannerBtn) bannerBtn.addEventListener('click', askInstall);
  if (dismissBtn) {
    dismissBtn.addEventListener('click', function () {
      rememberDismiss();
      hideBanner();
    });
  }
  if (footerLink) {
    footerLink.addEventListener('click', function (event) {
      event.preventDefault();
      askInstall();
    });
  }
  if (helpClose) helpClose.addEventListener('click', hideHelp);
  if (helpOk) helpOk.addEventListener('click', hideHelp);
  if (helpModal) {
    helpModal.addEventListener('click', function (event) {
      if (event.target === helpModal) hideHelp();
    });
  }
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && helpModal && !helpModal.hidden) hideHelp();
  });

  if (isStandalone()) {
    hideBanner();
  } else {
    showBanner();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }
})();
