// Runs in <head> before first paint on every extension page: applies the last chosen theme / accent from a tiny localStorage mirror
// (written by lib/theme.js). Without a mirror the CSS follows prefers-color-scheme, so the first paint never shows the wrong theme.
(function () {
  try {
    var m = JSON.parse(localStorage.getItem('cmr.theme') || 'null'); if (!m) return;
    var t = m.t; var d = document.documentElement;
    if (t === 'time') { var h = new Date().getHours(); t = h >= 7 && h < 18 ? 'light' : 'dark'; }
    if (t === 'light' || t === 'dark') d.dataset.theme = t;
    if (m.a && m.a !== 'blue') d.dataset.accent = m.a;
  } catch (e) { /* storage unavailable: CSS defaults */ }
})();
