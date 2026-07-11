// ═══════════════════════════════════════════════════════════════
// boot.js — определяет актуальный адрес сервера ДО запуска script.js
// ═══════════════════════════════════════════════════════════════
//
// Termux при каждом перезапуске туннеля сам обновляет файл
// patches/current-server-url.txt в этом же GitHub-репозитории
// (см. patches/update-server-url.sh). Этот файл — открытый, не секрет,
// его может читать кто угодно (там только адрес сервера, не пароли).
//
// ⚠️ Замени ссылку ниже на свой репозиторий/ветку один раз:
window.SERVER_URL_LOOKUP = 'https://raw.githubusercontent.com/evestcod-lgtm/securechat/main/patches/current-server-url.txt';

(function boot() {
  var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  var mainScript = document.createElement('script');
  mainScript.src = 'script.js';

  function loadMain() {
    document.head.appendChild(mainScript);
  }

  if (!isNative) {
    // В браузере (не APK) адрес не нужен — same-origin, грузим сразу
    loadMain();
    return;
  }

  fetch(window.SERVER_URL_LOOKUP + '?t=' + Date.now())
    .then(function (resp) { return resp.ok ? resp.text() : ''; })
    .then(function (text) {
      var fresh = (text || '').trim();
      if (fresh && fresh.indexOf('http') === 0) {
        window.RESOLVED_SERVER_URL = fresh;
        localStorage.setItem('server_url', fresh);
      }
    })
    .catch(function () {
      // GitHub недоступен (нет интернета в этот момент) — не страшно,
      // script.js сам подставит адрес из localStorage (сохранённый в прошлый раз)
    })
    .finally(loadMain);
})();
