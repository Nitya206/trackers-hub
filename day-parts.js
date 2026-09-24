/**
 * day-parts.js · TRACKERS HUB — shared time-of-day windows
 * ============================================================================
 * Rituals, Study todos and Procrastination sessions are all planned in the
 * same windows ("Early morning", "Evening"…) instead of exact clock times.
 * Rituals owns the ranges (Rituals → Rituals tab → Your day) and stores them
 * in rituals_v1.parts, which syncs; every other app reads them from here, so
 * changing "Early morning" to 6:30–7:30 once changes it everywhere.
 *
 * Any <select data-dayparts> on a page is filled with the windows
 * automatically, and refilled when the ranges change on another device.
 */
(function () {
  'use strict';
  if (window.DayParts) return;

  var DEF = [
    ['dawn',      'Early morning', '🌅', 360,  480],
    ['morning',   'Morning',       '☀️', 480,  720],
    ['afternoon', 'Afternoon',     '🌤️', 720,  1020],
    ['evening',   'Evening',       '🌆', 1020, 1260],
    ['night',     'Night',         '🌙', 1260, 1440]
  ];
  var IDS = DEF.map(function (d) { return d[0]; });

  function stored() {
    try { return (JSON.parse(localStorage.getItem('rituals_v1')) || {}).parts || {}; }
    catch (_) { return {}; }
  }

  function get(id, parts) {
    var at = IDS.indexOf(id); if (at === -1) return null;
    var d = DEF[at], o = (parts || stored())[id] || {};
    var from = o.from != null ? o.from : d[3], to = o.to != null ? o.to : d[4];
    if (to <= from) to += 1440;                       // e.g. Night 21:00 → 01:00
    return { id: id, name: d[1], icon: d[2], from: from, to: to };
  }
  function list() { var s = stored(); return IDS.map(function (id) { return get(id, s); }); }

  function norm(m) { return ((m % 1440) + 1440) % 1440; }
  function ap(m) { return norm(m) < 720 ? 'am' : 'pm'; }
  function clock(m) { m = norm(m); var h = Math.floor(m / 60) % 12 || 12, mm = m % 60; return h + (mm ? ':' + String(mm).padStart(2, '0') : ''); }
  function range(p) {
    if (typeof p === 'string') p = get(p);
    if (!p) return '';
    return ap(p.from) === ap(p.to) && p.to - p.from < 720
      ? clock(p.from) + '–' + clock(p.to) + ' ' + ap(p.to)
      : clock(p.from) + ' ' + ap(p.from) + ' – ' + clock(p.to) + ' ' + ap(p.to);
  }
  // "🌆 Evening" — or with its hours: "🌆 Evening · 5–9 pm"
  function label(id, withRange) {
    var p = get(id); if (!p) return '';
    return p.icon + ' ' + p.name + (withRange ? ' · ' + range(p) : '');
  }
  // Sort key: windows in day order, "any time" last.
  function rank(id) { var i = IDS.indexOf(id); return i === -1 ? 99 : i; }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  // withExact adds "⏰ Exact time…" — for forms that also take a precise clock time.
  function optionsHTML(selected, anyLabel, withExact) {
    return '<option value="">' + esc(anyLabel || 'Any time') + '</option>' +
      list().map(function (p) {
        return '<option value="' + p.id + '"' + (p.id === selected ? ' selected' : '') + '>' +
          p.icon + ' ' + p.name + ' · ' + range(p) + '</option>';
      }).join('') +
      (withExact ? '<option value="__exact"' + (selected === '__exact' ? ' selected' : '') + '>⏰ Exact time…</option>' : '');
  }

  function fill(root, onlyNew) {
    (root || document).querySelectorAll('select[data-dayparts]').forEach(function (sel) {
      if (onlyNew && sel.dataset.dpFilled) return;
      if (document.activeElement === sel) return;      // never rebuild an open picker
      sel.innerHTML = optionsHTML(sel.value, sel.getAttribute('data-dayparts-any'), sel.hasAttribute('data-dayparts-exact'));
      sel.dataset.dpFilled = '1';
    });
  }
  function start() {
    fill();
    // The apps build their popups on the fly; fill any new picker as it lands,
    // so no popup has to remember to call fill() itself.
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches('select[data-dayparts]')) fill(n.parentNode, true);
          else if (n.querySelector && n.querySelector('select[data-dayparts]')) fill(n, true);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  // Ranges edited on another device arrive through sync.
  window.addEventListener('trackers-sync', function (e) {
    var d = e.detail || {};
    if (d.type === 'remote' || d.type === 'pull') fill();
  });

  window.DayParts = { ids: IDS, list: list, get: get, range: range, label: label, rank: rank, optionsHTML: optionsHTML, fill: fill };
})();
