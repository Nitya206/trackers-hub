/**
 * hub-nav.js  ·  TRACKERS HUB — Unified Navigation Layer
 * Features:
 * • App Switcher pill  — jump between all 4 apps + hub
 * • Global Search pill — ⌘K spotlight across all apps
 */
(function () {
  'use strict';

  /* ─────────────────────────────────────────
     APP REGISTRY
  ───────────────────────────────────────── */
  const APPS = [
    {
      id: 'hub',
      file: 'index.html',
      label: 'Trackers Hub',
      short: 'HUB',
      icon: '⬡',
      color: '#e2e8f0',
      rgb: '226,232,240',
    },
    {
      id: 'study',
      file: 'Study-Schedule-Pro.html',
      label: 'Study Schedule',
      short: 'STUDY',
      icon: '📚',
      color: '#4f8ef7',
      rgb: '79,142,247',
    },
    {
      id: 'proc',
      file: 'Procrastination-Hub.html',
      label: 'Procrastination Tracker',
      short: 'PROC',
      icon: '⚡',
      color: '#00d9f5',
      rgb: '0,217,245',
    },
    {
      id: 'zen',
      file: 'zen-garden-tracker.html',
      label: 'Zen Garden',
      short: 'ZEN',
      icon: '🌿',
      color: '#4ade80',
      rgb: '74,222,128',
    },
    {
      id: 'orv',
      file: 'ORV-Tracker.html',
      label: 'ORV — Omniscient',
      short: 'ORV',
      icon: '✦',
      color: '#f5b800',
      rgb: '245,184,0',
    },
  ];

  /* ─────────────────────────────────────────
     DETECT CURRENT APP
  ───────────────────────────────────────── */
  function detectApp() {
    const f = decodeURIComponent(location.pathname.split('/').pop() || '');
    if (/Procrastination/i.test(f)) return 'proc';
    if (/Study/i.test(f)) return 'study';
    if (/zen/i.test(f)) return 'zen';
    // FIXED: Removed |Tracker to prevent 'index.html' from triggering as ORV
    if (/ORV/i.test(f)) return 'orv';
    if (/Hub/i.test(f)) return 'hub';
    return 'hub';
  }

  const currentId = detectApp();
  const currentApp = APPS.find((a) => a.id === currentId) || APPS[0];

  /* ─────────────────────────────────────────
     SECTION INDEXER  (localStorage)
  ───────────────────────────────────────── */
  /**
   * Given a DOM element, extract the navigation action it performs when clicked.
   * Returns { func: 'navigateTo', arg: 'library' } or null.
   *
   * Handles patterns across all tracker apps:
   *  • onclick="scrollToSection('scheduleSection')"  — Study-Schedule-Pro
   *  • data-section="library" + window.navigateTo   — Procrastination-Hub
   *  • onclick="M('novel')"                         — ORV-Tracker tabs
   */
  function getNavAction(el) {
    // Explicit onclick with a single-argument nav call
    const onclick = el.getAttribute('onclick') || '';
    const m = onclick.match(/^(\w+)\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (m) {
      const navFuncs = ['scrollToSection','navigateTo','showSection','showView',
                        'showTab','switchTab','switchTo','M','goTo'];
      if (navFuncs.includes(m[1])) return { func: m[1], arg: m[2] };
    }

    // data-section attribute + a known SPA nav function on window
    const sec = el.getAttribute('data-section');
    if (sec) {
      for (const fn of ['navigateTo','scrollToSection','showSection','showView']) {
        if (typeof window[fn] === 'function') return { func: fn, arg: sec };
      }
    }

    // data-tab / data-view
    const tab = el.getAttribute('data-tab') || el.getAttribute('data-view');
    if (tab) {
      for (const fn of ['switchTab','showTab','showView','navigateTo']) {
        if (typeof window[fn] === 'function') return { func: fn, arg: tab };
      }
    }

    return null;
  }

  /* ─────────────────────────────────────────
     PER-APP STATIC NAV MANIFESTS
     These define exactly what shows in search for each app.
     Each entry: { label, navFunc, navArg }
     navFunc/navArg are used to call window[navFunc](navArg) on navigation.

     MANIFEST_VERSION: bump this number whenever manifests change so stale
     localStorage caches are automatically cleared on next visit.
  ───────────────────────────────────────── */
  const MANIFEST_VERSION = 3; // ← bump to bust old cached indices

  const APP_NAV_MANIFEST = {
    proc: [
      { label: '📊 Dashboard',    navFunc: 'navigateTo', navArg: 'dashboard'   },
      { label: '📚 Library',      navFunc: 'navigateTo', navArg: 'library'     },
      { label: '🌀 Mood Queue',   navFunc: 'navigateTo', navArg: 'moodqueue'   },
      { label: '✅ Tasks',        navFunc: 'navigateTo', navArg: 'tasks'       },
      { label: '🗺️ Overview',    navFunc: 'navigateTo', navArg: 'overview'    },
      { label: '⚰️ Graveyard',   navFunc: 'navigateTo', navArg: 'graveyard'   },
      { label: '📋 Session Log',  navFunc: 'navigateTo', navArg: 'sessionlog'  },
      { label: '⚙️ Settings',    navFunc: 'navigateTo', navArg: 'settings'    },
    ],
    orv: [
      { label: '📕 Novel Mode',        navFunc: 'M', navArg: 'novel'  },
      { label: '📺 Manhwa Mode',        navFunc: 'M', navArg: 'manhwa' },
      { label: '📖 Session 1 — Intro (Ch 1–15)',    navFunc: 'E', navArg: '0' },
      { label: '📖 Session 2 — Geumho Station',     navFunc: 'E', navArg: '1' },
      { label: '📖 Session 3 — Dark Keeper',        navFunc: 'E', navArg: '2' },
      { label: '📖 Session 4 — Green Zone',         navFunc: 'E', navArg: '3' },
      { label: '📖 Session 5 — Theatre Dungeon',    navFunc: 'E', navArg: '4' },
      { label: '📖 Session 6 — War of Kings P1',    navFunc: 'E', navArg: '5' },
    ],
    zen: [
      { label: '🌿 Growth Calendar',    navFunc: null, navArg: null },
      { label: '📝 Reflections',        navFunc: null, navArg: null },
      { label: '📅 This Week\'s Rhythm', navFunc: null, navArg: null },
      { label: '🏆 Milestones',         navFunc: null, navArg: null },
      { label: '💡 Today\'s Wisdom',    navFunc: null, navArg: null },
    ],
    study: [
      // Fallback entries for when Study hasn't been visited yet
      { label: '🏠 Dashboard',    navFunc: 'scrollToSection', navArg: 'currentBlockBar' },
      { label: '📅 Schedule',     navFunc: 'scrollToSection', navArg: 'scheduleSection'  },
      { label: '✅ Todos',        navFunc: 'scrollToSection', navArg: 'todosSection'     },
      { label: '⏱️ Timer',       navFunc: 'scrollToSection', navArg: 'lobdellSection'   },
      { label: '📋 Attendance',   navFunc: 'scrollToSection', navArg: 'attendanceSection'},
      { label: '📊 Analytics',    navFunc: 'scrollToSection', navArg: 'analyticsSection' },
      { label: '⚙️ Settings',    navFunc: 'scrollToSection', navArg: 'settingsSection'  },
    ],
  };

  function buildSectionIndex() {
    const appManifest = APP_NAV_MANIFEST[currentId];

    // ── Apps with a static manifest: return curated list immediately ──
    if (appManifest && appManifest.length > 0) {
      const sections = appManifest.map((entry, i) => {
        const id = 'hn-manifest-' + i;
        const navAction = entry.navFunc ? { func: entry.navFunc, arg: entry.navArg } : null;
        return { label: entry.label, id, navAction };
      });

      // For ORV: also index session cards using the SESSIONS/A data arrays
      if (currentId === 'orv') {
        const sessions = window.SESSIONS;
        const arcs = window.A;
        if (Array.isArray(sessions) && Array.isArray(arcs)) {
          sessions.forEach((sess, si) => {
            // Build label from arc names referenced by this session
            const sessArcs = sess.arcIds.map(id => arcs.find(x => x.id === id)).filter(Boolean);
            if (!sessArcs.length) return;
            // Use arc label (e.g. "Arc 10 Part 2") + arc name (e.g. "Dark Castle")
            const arcLabel = sessArcs[0].al;
            const arcName = sessArcs[0].a;
            const label = arcLabel === arcName ? arcName : arcLabel + ' — ' + arcName;
            const chRange = sessArcs[0].n; // e.g. "Ch 162–169"
            const fullLabel = '📖 ' + label + (chRange ? ' (' + chRange + ')' : '');
            // Find the card element with onclick="E(si)"
            const card = document.querySelector(`.cd[onclick="E(${si})"]`);
            const id = card ? (card.id || (card.id = 'hn-orv-card-' + si)) : 'hn-orv-card-' + si;
            sections.push({ label: fullLabel, id, navAction: { func: 'E', arg: String(si) } });
          });
        } else {
          // Fallback: scrape cards from DOM
          document.querySelectorAll('.cd').forEach((el, i) => {
            const onclick = el.getAttribute('onclick') || '';
            const eMatch = onclick.match(/^E\((\d+)\)/);
            const navAction = eMatch ? { func: 'E', arg: eMatch[1] } : null;
            if (!el.id) el.id = 'hn-orv-card-' + i;
            // Get text from .ci (title) element inside card
            const titleEl = el.querySelector('.ci');
            const text = titleEl
              ? titleEl.textContent.trim().replace(/\s+/g, ' ').slice(0, 80)
              : '';
            if (!text || text.length < 2) return;
            sections.push({ label: '📖 ' + text, id: el.id, navAction });
          });
        }
      }

      return sections.slice(0, 200);
    }

    // ── Study Schedule: scrape nav buttons only (they have onclick=scrollToSection) ──
    if (currentId === 'study') {
      const seen = new Set();
      const sections = [];
      // Only pick up actual nav items in #bottomNav — not headings from main content
      const navItems = document.querySelectorAll('#bottomNav [onclick], #bottomNav [data-section]');
      navItems.forEach((el) => {
        // Prefer aria-label (full name like "Dashboard") over .nav-label (short like "Home")
        const ariaLabel = el.getAttribute('aria-label');
        const labelEl = el.querySelector('.nav-label') || el.querySelector('span:last-child');
        const text = ariaLabel
          ? ariaLabel.trim()
          : labelEl
            ? labelEl.textContent.trim()
            : el.textContent.trim().replace(/\s+/g, ' ');
        if (!text || text.length < 2 || seen.has(text)) return;
        seen.add(text);
        if (!el.id) el.id = 'hn-study-nav-' + seen.size;
        const navAction = getNavAction(el);
        sections.push({ label: text, id: el.id, navAction });
      });
      return sections.slice(0, 200);
    }

    // ── Fallback for any other app ──
    const seen = new Set();
    const sections = [];
    // Only pick elements that have explicit nav actions — skip generic headings
    const candidates = document.querySelectorAll('[data-section],[data-tab],[role="tab"],[data-view]');
    candidates.forEach((el) => {
      const navAction = getNavAction(el);
      if (!navAction) return; // skip anything without a clear nav action
      const labelEl = el.querySelector('.nav-label') || el.querySelector('span:last-child');
      const text = labelEl
        ? labelEl.textContent.trim()
        : (el.getAttribute('aria-label') || el.textContent.trim().replace(/\s+/g, ' '));
      if (!text || text.length < 2 || text.length > 80 || seen.has(text)) return;
      seen.add(text);
      if (!el.id) el.id = 'hn-fb-' + seen.size;
      sections.push({ label: text, id: el.id, navAction });
    });
    return sections.slice(0, 200);
  }

  function saveIndex() {
    try {
      const payload = { v: MANIFEST_VERSION, items: buildSectionIndex() };
      localStorage.setItem('hub-idx-' + currentId, JSON.stringify(payload));
    } catch (_) {}
  }

  /** Load proc library series from phub_library localStorage key */
  function loadProcLibrarySections(procApp) {
    const sections = [];
    try {
      const raw = localStorage.getItem('phub_library');
      if (!raw) return sections;
      const library = JSON.parse(raw);
      if (!Array.isArray(library)) return sections;

      // Type icons for media types
      const typeIcon = { anime: '📺', manga: '📚', manhwa: '🖼️', show: '🎬', movie: '🎥', novel: '📖' };

      library.forEach(function(item) {
        if (!item || !item.id || !item.title) return;
        const icon = typeIcon[item.type] || '📂';
        const status = item.status === 'completed' ? ' ✓' : item.status === 'watching' ? ' ▶' : '';
        sections.push({
          label: icon + ' ' + item.title + status,
          id: '',
          app: procApp,
          navAction: { func: 'navigateTo', arg: 'detail~' + item.id }
        });
      });
    } catch (_) {}
    return sections;
  }

  function loadAllIndices() {
    const out = [];
    APPS.forEach((app) => {
      if (app.id === 'hub') return;
      let hasValidIndex = false;
      try {
        const raw = localStorage.getItem('hub-idx-' + app.id);
        if (raw) {
          const stored = JSON.parse(raw);
          // Support both old format (plain array) and new versioned format ({ v, items })
          const version = stored.v || 0;
          const items   = Array.isArray(stored) ? stored : (stored.items || []);
          // Bust stale cache if version is outdated
          if (version >= MANIFEST_VERSION && Array.isArray(items) && items.length > 0) {
            items.forEach((s) => out.push({ ...s, app }));
            hasValidIndex = true;
          } else if (version < MANIFEST_VERSION) {
            // Remove stale entry so it gets rebuilt next time
            try { localStorage.removeItem('hub-idx-' + app.id); } catch (_) {}
          }
        }
      } catch (_) {}
      
      // Fallback: use the static manifest so unvisited apps are still searchable
      if (!hasValidIndex) {
        const manifest = APP_NAV_MANIFEST[app.id];
        if (manifest && manifest.length > 0) {
          manifest.forEach((entry) => {
            const navAction = entry.navFunc ? { func: entry.navFunc, arg: entry.navArg } : null;
            out.push({ label: entry.label, id: '', app, navAction });
          });
        } else {
          out.push({ label: app.label, id: '', app, navAction: null });
        }
      }

      // For proc: always inject library series on top of nav sections (dynamic, from localStorage)
      if (app.id === 'proc') {
        const seriesSections = loadProcLibrarySections(app);
        seriesSections.forEach((s) => out.push(s));
      }
    });
    return out;
  }

  /* ─────────────────────────────────────────
     CSS
  ───────────────────────────────────────── */
  const ACCENT = currentApp.color;
  const ACCENT_RGB = currentApp.rgb;

  const css = /* css */ `
  #hn-root *{box-sizing:border-box;margin:0;padding:0}
  #hn-root,#hn-search-overlay{font-family:'Space Grotesk','Inter',system-ui,sans-serif}

  /* ── ROOT ── */
  #hn-root{
    position:fixed;bottom:26px;right:26px;z-index:2147483640;
    display:flex;flex-direction:column;align-items:flex-end;gap:9px;
  }

  /* ── PILL ── */
  .hn-pill{
    display:flex;align-items:center;gap:8px;
    height:38px;padding:0 15px;border-radius:100px;
    border:1px solid rgba(255,255,255,.1);
    background:rgba(8,10,18,.88);
    backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);
    color:rgba(255,255,255,.65);font-size:12px;font-weight:500;letter-spacing:.04em;
    cursor:pointer;user-select:none;white-space:nowrap;
    box-shadow:0 4px 28px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.04);
    transition:transform .22s cubic-bezier(.34,1.56,.64,1),
               border-color .2s,box-shadow .2s,color .2s;
    position:relative;overflow:hidden;
    -webkit-tap-highlight-color:transparent;
    touch-action:manipulation;
  }
  .hn-pill::before{
    content:'';position:absolute;inset:0;border-radius:100px;
    background:radial-gradient(ellipse at 50% 120%,rgba(${ACCENT_RGB},.18),transparent 70%);
    opacity:0;transition:opacity .2s;
  }
  .hn-pill:hover{
    border-color:rgba(${ACCENT_RGB},.45);color:#fff;
    box-shadow:0 4px 28px rgba(0,0,0,.55),0 0 18px rgba(${ACCENT_RGB},.22),0 0 0 1px rgba(${ACCENT_RGB},.25);
    transform:translateY(-2px);
  }
  .hn-pill:hover::before{opacity:1;}
  .hn-pill:active{transform:translateY(0) scale(.97);}
  .hn-pill svg,.hn-pill-icon{width:14px;height:14px;flex-shrink:0;opacity:.8;}

  /* ── SWITCHER POPUP ── */
  .hn-sw-wrap{position:relative;}

  #hn-sw-popup{
    position:fixed;z-index:2147483641;
    min-width:210px;
    max-height: calc(100vh - 40px);
    overflow-y: auto;
    background:rgba(8,10,18,.94);
    border:1px solid rgba(255,255,255,.09);
    border-radius:18px;padding:8px;
    backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);
    box-shadow:0 24px 64px rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.04);
    opacity:0;transform:translateY(6px) scale(.97);pointer-events:none;
    transition:opacity .18s ease,transform .22s cubic-bezier(.34,1.56,.64,1);
    scrollbar-width: none;
  }
  #hn-sw-popup::-webkit-scrollbar { display: none; }
  #hn-sw-popup.hn-open{opacity:1;transform:translateY(0) scale(1);pointer-events:all;}

  /* ── PROC BOTTOM-NAV INJECTED ITEMS ── */
  .hn-bn-sep{
    width:1px;height:22px;
    background:rgba(100,160,255,0.18);
    margin:0 3px;flex-shrink:0;align-self:center;
  }
  .hn-bn-item{
    position:relative;
    width:42px;height:42px;
    border-radius:100px;
    display:flex;align-items:center;justify-content:center;
    cursor:pointer;
    transition:transform 240ms cubic-bezier(.34,1.56,.64,1),background 180ms ease;
    color:rgba(255,255,255,.5);
  }
  .hn-bn-item:hover{
    background:rgba(0,217,245,0.1);color:rgba(0,217,245,0.9);
    transform:scale(1.1);
  }
  .hn-bn-item:active{transform:scale(.93);}
  .hn-bn-item .hn-bn-wrap{
    position:absolute;inset:0;border-radius:inherit;
    overflow:hidden;display:flex;align-items:center;justify-content:center;
    pointer-events:none;
  }
  .hn-bn-tip{
    position:absolute;bottom:calc(100% + 8px);left:50%;
    transform:translateX(-50%);
    background:rgba(8,10,20,.92);border:1px solid rgba(255,255,255,.1);
    color:rgba(255,255,255,.8);font-size:10px;font-weight:500;letter-spacing:.04em;
    padding:4px 9px;border-radius:7px;white-space:nowrap;
    pointer-events:none;opacity:0;
    transition:opacity .15s ease,transform .15s ease;
    transform:translateX(-50%) translateY(4px);
    font-family:'Space Grotesk','Inter',sans-serif;
  }
  .hn-bn-item:hover .hn-bn-tip{opacity:1;transform:translateX(-50%) translateY(0);}

  /* ── SIDEBAR INJECTED ITEMS (Study / ORV) ── */
  .hn-sb-sep{
    height:1px;width:80%;
    background:linear-gradient(90deg,transparent,rgba(56,189,248,.12),rgba(212,168,67,.08),transparent);
    margin:10px auto 4px;flex-shrink:0;
  }
  .hn-sb-item{
    position:relative;
    width:40px;height:40px;
    border-radius:12px;
    display:flex;align-items:center;justify-content:center;
    cursor:pointer;
    transition:background .15s ease,color .15s ease,transform .2s cubic-bezier(.34,1.56,.64,1);
    color:rgba(255,255,255,.4);
    margin:0 auto;
  }
  .hn-sb-item:hover{
    background:rgba(${ACCENT_RGB},.12);color:rgba(${ACCENT_RGB},1);
    transform:scale(1.08);
  }
  .hn-sb-item:active{transform:scale(.93);}
  .hn-sb-tip{
  position:absolute;
  left:calc(100% + 10px);
  top:50%;
  transform:translateY(-50%) translateX(-4px);

  background:rgba(8,10,20,.92);
  border:1px solid rgba(255,255,255,.1);
  color:rgba(255,255,255,.8);

  font-size:10px;              /* original size */
  font-weight:500;
  letter-spacing:.04em;

  padding:4px 9px;             /* original padding */
  border-radius:7px;

  white-space:nowrap;
  pointer-events:none;
  opacity:0;

  transition:opacity .15s ease,transform .15s ease;
  font-family:'Space Grotesk','Inter',sans-serif;
  z-index:9999;
}
  .hn-sb-item:hover .hn-sb-tip{
  opacity:1;
  transform:translateY(-50%) translateX(0);
}

  .hn-sw-divider{height:1px;background:rgba(255,255,255,.06);margin:5px 4px;}
  .hn-sw-section-label{
    font-size:9px;letter-spacing:.18em;color:rgba(255,255,255,.25);
    text-transform:uppercase;font-family:'JetBrains Mono',monospace;
    padding:4px 12px 2px;
  }

  .hn-app-row{
    display:flex;align-items:center;gap:11px;
    padding:9px 12px;border-radius:12px;
    cursor:pointer;text-decoration:none;
    color:rgba(255,255,255,.75);
    transition:background .12s,color .12s;
  }
  .hn-app-row:hover{background:rgba(255,255,255,.06);color:#fff;}
  .hn-app-row.hn-current{background:rgba(255,255,255,.04);cursor:default;pointer-events:none;}
  .hn-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
  .hn-app-name{flex:1;font-size:12.5px;font-weight:500;}
  .hn-app-tag{
    font-size:9px;letter-spacing:.14em;font-family:'JetBrains Mono',monospace;
    padding:2px 7px;border-radius:5px;
    background:rgba(255,255,255,.06);color:rgba(255,255,255,.35);
  }
  .hn-current .hn-app-tag{background:rgba(${ACCENT_RGB},.12);color:${ACCENT};}

  /* ── SEARCH OVERLAY ── */
  #hn-search-overlay{
    position:fixed;inset:0;z-index:2147483645;
    background:rgba(6,8,15,.82);
    backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);
    display:flex;align-items:flex-start;justify-content:center;
    padding:9vh 20px 28px;
    opacity:0;pointer-events:none;
    transition:opacity .18s ease;
  }
  #hn-search-overlay.hn-open{opacity:1;pointer-events:all;}

  #hn-search-box{
    width:100%;max-width:640px;
    background:rgba(12,14,24,.96);
    border:1px solid rgba(255,255,255,.1);border-radius:22px;overflow:hidden;
    box-shadow:0 40px 100px rgba(0,0,0,.75),0 0 0 1px rgba(255,255,255,.04);
    transform:translateY(-12px) scale(.98);
    transition:transform .24s cubic-bezier(.34,1.56,.64,1);
  }
  #hn-search-overlay.hn-open #hn-search-box{transform:translateY(0) scale(1);}

  #hn-s-inputrow{
    display:flex;align-items:center;gap:10px;
    padding:10px 16px;
    border-bottom:1px solid rgba(255,255,255,.07);
  }
  #hn-s-inputrow svg{color:rgba(255,255,255,.3);flex-shrink:0;}
  #hn-s-input{
    flex:1;background:none;border:none;outline:none;
    color:#fff;font-size:16px;
    font-family:'Space Grotesk','Inter',system-ui,sans-serif;
    font-weight:400;
    caret-color:${ACCENT};
  }
  #hn-s-input::placeholder{color:rgba(255,255,255,.22);}
  #hn-s-esc{
    font-size:9.5px;letter-spacing:.1em;font-family:'JetBrains Mono',monospace;
    color:rgba(255,255,255,.2);
    border:1px solid rgba(255,255,255,.1);border-radius:6px;
    padding:4px 9px;flex-shrink:0;
  }

  #hn-s-results{
    max-height:300px;overflow-y:auto;padding:7px;
  }
  #hn-s-results::-webkit-scrollbar{width:3px;}
  #hn-s-results::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:2px;}

  .hn-r-group-label{
    font-size:9px;letter-spacing:.2em;text-transform:uppercase;
    font-family:'JetBrains Mono',monospace;
    color:rgba(255,255,255,.22);
    padding:8px 12px 4px;
  }

  .hn-result{
    display:flex;align-items:center;gap:11px;
    padding:10px 13px;border-radius:11px;
    cursor:pointer;text-decoration:none;
    transition:background .1s;
  }
  .hn-result:hover,.hn-result.hn-focused{background:rgba(255,255,255,.06);}
  .hn-r-dot{width:5px;height:5px;border-radius:50%;flex-shrink:0;}
  .hn-r-label{flex:1;font-size:13px;color:rgba(255,255,255,.8);font-weight:400;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .hn-r-app{
    font-size:9px;letter-spacing:.14em;text-transform:uppercase;
    font-family:'JetBrains Mono',monospace;opacity:.4;flex-shrink:0;
  }

  .hn-s-empty{
    text-align:center;padding:36px 20px;
    color:rgba(255,255,255,.22);font-size:13px;line-height:1.7;
  }
  .hn-s-empty strong{display:block;margin-bottom:6px;font-size:15px;color:rgba(255,255,255,.4);}

  #hn-s-footer{
    padding:9px 20px;border-top:1px solid rgba(255,255,255,.05);
    display:flex;gap:18px;
  }
  .hn-s-hint{
    font-size:10px;letter-spacing:.06em;color:rgba(255,255,255,.18);
    font-family:'JetBrains Mono',monospace;
    display:flex;align-items:center;gap:5px;
  }
  .hn-s-hint kbd{
    font-family:inherit;font-size:9px;
    background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);
    border-radius:4px;padding:2px 5px;
  }

  /* ── TOUCH / MOBILE ── */
  .hn-result{-webkit-tap-highlight-color:transparent;touch-action:manipulation;}
  .hn-app-row{-webkit-tap-highlight-color:transparent;touch-action:manipulation;min-height:44px;}
  .hn-result{min-height:44px;}

  @media(max-width:1023px){
    /* Mobile: hide the floating root entirely — pills are injected into the nav bar */
    #hn-root{ display:none !important; }
    /* Search overlay still needs to work */
    #hn-search-overlay{ padding:5vh 12px 20px; }
    #hn-search-box{ border-radius:16px; }
    #hn-s-input{ font-size:16px; }
    #hn-s-results{ max-height:55vh; }
    .hn-result{ min-height:48px; }
    .hn-app-row{ min-height:48px; }
    #hn-s-footer{ display:none; }
    #hn-sw-popup{ min-width:200px; border-radius:14px; }
  }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  /* ─────────────────────────────────────────
     BUILD ROOT ELEMENT
  ───────────────────────────────────────── */
  const root = document.createElement('div');
  root.id = 'hn-root';

  /* ── SWITCHER ── */
  const swWrap = document.createElement('div');
  swWrap.className = 'hn-sw-wrap';

  const swPopup = document.createElement('div');
  swPopup.id = 'hn-sw-popup';

  // Hub row
  const hubRow = document.createElement('a');
  hubRow.className = 'hn-app-row' + (currentId === 'hub' ? ' hn-current' : '');
  hubRow.href = 'index.html';
  hubRow.innerHTML = `
    <span class="hn-dot" style="background:#e2e8f0;box-shadow:0 0 7px rgba(226,232,240,.6)"></span>
    <span class="hn-app-name">Trackers Hub</span>
    <span class="hn-app-tag">${currentId === 'hub' ? 'HERE' : 'HOME'}</span>
  `;
  swPopup.appendChild(hubRow);

  // Divider
  const div0 = document.createElement('div');
  div0.className = 'hn-sw-divider';
  swPopup.appendChild(div0);

  // App rows
  APPS.filter((a) => a.id !== 'hub').forEach((app) => {
    const isCur = app.id === currentId;
    const row = document.createElement('a');
    row.className = 'hn-app-row' + (isCur ? ' hn-current' : '');
    row.href = isCur ? '#' : app.file;
    row.innerHTML = `
      <span class="hn-dot" style="background:${app.color};box-shadow:0 0 7px rgba(${app.rgb},.55)${isCur ? '' : ';opacity:.55'}"></span>
      <span class="hn-app-name">${app.label}</span>
      <span class="hn-app-tag">${isCur ? 'HERE' : app.short}</span>
    `;
    if (!isCur) row.addEventListener('click', () => { location.href = app.file; });
    swPopup.appendChild(row);
  });

  // Switcher pill
  const swPill = document.createElement('div');
  swPill.className = 'hn-pill';
  swPill.innerHTML = `
    <svg class="hn-pill-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.4">
      <path d="M8 1L14 4.5V11.5L8 15L2 11.5V4.5L8 1Z"/>
    </svg>
    <span>Switch App</span>
  `;

  // Move popup to body so it works from any trigger position
  document.body.appendChild(swPopup);

  let swOpen = false;
  function toggleSwitcher(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    swOpen = !swOpen;
    if (swOpen) {
      const isMobile = window.innerWidth <= 1023;
      if (isMobile) {
        // Open popup above the nav bar, centered on screen
        swPopup.style.left = '50%';
        swPopup.style.right = 'auto';
        swPopup.style.transform = 'translateX(-50%)';
        swPopup.style.bottom = '80px';
        swPopup.style.top = 'auto';
        swPopup.style.minWidth = '220px';
        swPopup.style.maxWidth = 'calc(100vw - 20px)';
      } else {
        swPopup.style.transform = '';
        // Position popup relative to the trigger element
        const trigger = e && e.currentTarget ? e.currentTarget : swPill;
        const r = trigger.getBoundingClientRect();
        const popupW = 220;
        const isLeftSide = r.left < window.innerWidth / 2;

        if (isLeftSide) {
          // Sidebar trigger — open to the RIGHT of the item
          swPopup.style.left = (r.right + 12) + 'px';
          swPopup.style.right = 'auto';
          
          // Handle vertical overflow: flip upwards if in bottom half of screen
          if (r.top > window.innerHeight / 2) {
            swPopup.style.bottom = (window.innerHeight - r.bottom) + 'px';
            swPopup.style.top = 'auto';
          } else {
            swPopup.style.top = Math.max(10, r.top - 20) + 'px';
            swPopup.style.bottom = 'auto';
          }
        } else {
          // Bottom-right trigger — open ABOVE centered
          let left = r.left + r.width / 2 - popupW / 2;
          left = Math.max(10, Math.min(left, window.innerWidth - popupW - 10));
          swPopup.style.left = left + 'px';
          swPopup.style.bottom = (window.innerHeight - r.top + 10) + 'px';
          swPopup.style.right = 'auto';
          swPopup.style.top = 'auto';
        }
      }
    }
    swPopup.classList.toggle('hn-open', swOpen);
  }
  document.addEventListener('click', () => {
    swOpen = false;
    swPopup.classList.remove('hn-open');
  });
  swPopup.addEventListener('click', (e) => e.stopPropagation());

  swPill.addEventListener('click', toggleSwitcher);
  swWrap.appendChild(swPill);

  /* ── SEARCH PILL ── */
  const searchPill = document.createElement('div');
  searchPill.className = 'hn-pill';
  searchPill.innerHTML = `
    <svg class="hn-pill-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.5">
      <circle cx="6.5" cy="6.5" r="4.5"/>
      <path d="M10 10.5L14 14.5" stroke-linecap="round"/>
    </svg>
    <span>Search</span>
    <span style="font-size:10px;opacity:.35;font-family:'JetBrains Mono',monospace;margin-left:2px;">⌘K</span>
  `;

  /* ── SEARCH OVERLAY ── */
  const overlay = document.createElement('div');
  overlay.id = 'hn-search-overlay';
  overlay.innerHTML = `
    <div id="hn-search-box">
      <div id="hn-s-inputrow">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10.5L14 14.5" stroke-linecap="round"/>
        </svg>
        <input id="hn-s-input" type="text" placeholder="Search across all trackers…" autocomplete="off" spellcheck="false">
        <span id="hn-s-esc">ESC</span>
      </div>
      <div id="hn-s-results"></div>
      <div id="hn-s-footer">
        <span class="hn-s-hint"><kbd>↑↓</kbd> navigate</span>
        <span class="hn-s-hint"><kbd>↵</kbd> jump</span>
        <span class="hn-s-hint"><kbd>ESC</kbd> close</span>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const sInput = overlay.querySelector('#hn-s-input');
  const sResults = overlay.querySelector('#hn-s-results');
  let allSections = [];
  let focusIdx = -1;

  function renderResults(q) {
    q = q.toLowerCase().trim();
    // pool is guaranteed to have content due to our fallback logic in loadAllIndices
    const pool = allSections;

    if (!pool.length) {
      sResults.innerHTML = `<div class="hn-s-empty">
        <strong>Index is building</strong>
        Visit each app once and the index populates automatically.
      </div>`;
      return;
    }

    const filtered = q
      ? pool.filter((s) => s.label.toLowerCase().includes(q) || s.app.short.toLowerCase().includes(q))
      : pool.slice(0, 24);

    if (!filtered.length) {
      sResults.innerHTML = `<div class="hn-s-empty">No results for <strong style="color:rgba(255,255,255,.6)">"${q}"</strong></div>`;
      return;
    }

    // Group by app
    const grouped = {};
    filtered.slice(0, 40).forEach((s) => {
      if (!grouped[s.app.id]) grouped[s.app.id] = [];
      grouped[s.app.id].push(s);
    });

    let html = '';
    let globalIdx = 0;
    Object.entries(grouped).forEach(([appId, items]) => {
      const app = APPS.find((a) => a.id === appId);
      html += `<div class="hn-r-group-label" style="color:${app.color}88">${app.label}</div>`;
      items.forEach((s) => {
        // Build href: use hn-call scheme when a navAction exists, plain hash otherwise
        const na = s.navAction;
        const hrefTarget = na
          ? `${s.app.file}#hn-call~${na.func}~${encodeURIComponent(na.arg)}`
          : `${s.app.file}${s.id ? '#' + s.id : ''}`;
        // Encode navAction as a data attr so the click handler can use it directly
        const naAttr = na
          ? `data-navcall="${na.func}~${encodeURIComponent(na.arg)}" data-appid="${s.app.id}"`
          : `data-appid="${s.app.id}"`;
        html += `<div class="hn-result" data-href="${hrefTarget}" ${naAttr} data-idx="${globalIdx++}">
          <span class="hn-r-dot" style="background:${s.app.color}"></span>
          <span class="hn-r-label">${s.label}</span>
          <span class="hn-r-app" style="color:${s.app.color}">${s.app.short}</span>
        </div>`;
      });
    });
    sResults.innerHTML = html;
    sResults.querySelectorAll('.hn-result').forEach((r) => {
      r.addEventListener('click', () => activateResult(r));
    });
  }

  function openSearch() {
    allSections = loadAllIndices();
    focusIdx = -1;
    sInput.value = '';
    overlay.classList.add('hn-open');
    setTimeout(() => sInput.focus(), 40);
    renderResults('');
  }

  function closeSearch() {
    overlay.classList.remove('hn-open');
    focusIdx = -1;
  }

  /**
   * Execute the navigation action stored on a result element.
   *
   * Same-app  + navAction  → call the function directly (navigateTo / scrollToSection / M …)
   * Same-app  + no action  → scrollIntoView on the indexed element
   * Cross-app + navAction  → navigate to file.html#hn-call~func~arg (decoded on load)
   * Cross-app + no action  → navigate to file.html#hn-id (existing behaviour)
   */
  function activateResult(r) {
    closeSearch();
    const href      = r.dataset.href;       // full href (may include #hn-call~ or #hn-id)
    const navcall   = r.dataset.navcall;    // "func~encodedArg" or undefined
    const appId     = r.dataset.appid;

    if (appId === currentId) {
      // ── SAME APP ─────────────────────────────────────────────────────
      if (navcall) {
        // Call the app's own navigation function directly
        const tildeIdx = navcall.indexOf('~');
        const func     = navcall.slice(0, tildeIdx);
        const arg      = decodeURIComponent(navcall.slice(tildeIdx + 1));
        // Handle compound arg: "detail~seriesId" → navigateTo('detail', 'seriesId')
        if (arg.includes('~')) {
          const argParts = arg.split('~');
          const fn = window[func];
          if (typeof fn === 'function') { fn(argParts[0], argParts[1]); return; }
        }
        const fn       = window[func];
        if (typeof fn === 'function') { fn(isNaN(arg) ? arg : Number(arg)); return; }
      }
      // Fallback: scroll to the indexed element (also handles Study Schedule via scrollToIndexedElement)
      const hash = href.includes('#') ? href.split('#')[1] : '';
      if (hash && !hash.startsWith('hn-call~')) scrollToIndexedElement(hash);
    } else {
      // ── CROSS-APP ────────────────────────────────────────────────────
      // href already encodes #hn-call~func~arg or #hn-id — just navigate
      location.href = href;
    }
  }

  /**
   * Resolve an indexed element (hn-* ID) to the real scroll target.
   * Nav items with onclick="scrollToSection('someId')" are indexed by hub-nav,
   * but their onclick points to the actual section container — extract that.
   */
  function scrollToIndexedElement(id) {
    const el = document.getElementById(id);
    if (!el) return;

    // Element has onclick="scrollToSection('someId')" — use that target
    const onclick = el.getAttribute('onclick') || '';
    const match   = onclick.match(/scrollToSection\(['"]([^'"]+)['"]\)/);
    if (match) {
      const sec = document.getElementById(match[1]);
      if (sec) { sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    }

    // data-section → try common suffix patterns for the real container
    const sec = el.getAttribute('data-section');
    if (sec) {
      for (const suffix of ['Section', 'Bar', 'Content', '']) {
        const sectionEl = document.getElementById(sec + suffix);
        if (sectionEl && sectionEl !== el) {
          sectionEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); return;
        }
      }
    }

    // Fallback: scroll to the element itself
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  sInput.addEventListener('input', () => { focusIdx = -1; renderResults(sInput.value); });

  sInput.addEventListener('keydown', (e) => {
    const items = [...sResults.querySelectorAll('.hn-result')];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusIdx = Math.min(focusIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('hn-focused', i === focusIdx));
      items[focusIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusIdx = Math.max(focusIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle('hn-focused', i === focusIdx));
      items[focusIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      const f = items[focusIdx];
      if (f) activateResult(f);
    } else if (e.key === 'Escape') {
      closeSearch();
    }
  });

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSearch(); });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openSearch(); }
    if (e.key === 'Escape' && overlay.classList.contains('hn-open')) closeSearch();
  });

  searchPill.addEventListener('click', openSearch);

  // Always populate root with the floating pills — mount functions decide whether to show it
  root.appendChild(swWrap);
  root.appendChild(searchPill);

  /* ─────────────────────────────────────────
     HELPER: make a nav-injected icon button
  ───────────────────────────────────────── */
  function makeNavBtn(cls, tipClass, tipText, svgPath, clickFn) {
    const btn = document.createElement('div');
    btn.className = cls;
    const tip = document.createElement('div');
tip.className = tipClass;
tip.textContent = tipText;

// 🔥 move tooltip outside (fix clipping)
document.body.appendChild(tip);

const wrap = document.createElement('div');
wrap.className = cls === 'hn-bn-item' ? 'hn-bn-wrap' : 'hn-sb-wrap-inner';
wrap.innerHTML = svgPath;

btn.appendChild(wrap);

// 🔥 custom hover positioning
btn.addEventListener('mouseenter', () => {
  const rect = btn.getBoundingClientRect();
  tip.style.left = rect.right + 8 + 'px';
  tip.style.top = rect.top + rect.height / 2 + 'px';
  tip.style.transform = 'translateY(-50%)';
  tip.style.opacity = '1';
});

btn.addEventListener('mouseleave', () => {
  tip.style.opacity = '0';
});

btn.addEventListener('click', clickFn);

return btn;
  }

  const SW_SVG = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 1L14 4.5V11.5L8 15L2 11.5V4.5L8 1Z"/></svg>`;
  const SR_SVG = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10.5L14 14.5" stroke-linecap="round"/></svg>`;

  /* ─────────────────────────────────────────
     ASSEMBLE + MOUNT  (per-app strategy)
  ───────────────────────────────────────── */

  function mountInBottomNav(navEl) {
    if (!navEl || navEl.querySelector('.hn-injected')) return;
    root.style.display = 'none';
    document.body.appendChild(root);

    // Always inject — Proc items are icon-only (42×42) so they fit on mobile too
    const makeItem = (svg, label, clickFn) => {
      const el = document.createElement('div');
      el.className = 'bn-item hn-injected';
      el.innerHTML = `<div class="bn-tip">${label}</div><div class="bn-icon-wrap">${svg}</div>`;
      el.onclick = (e) => { e.stopPropagation(); clickFn(e); };
      return el;
    };
    const sep = document.createElement('div');
    sep.className = 'hn-bn-sep';
    navEl.appendChild(sep);
    navEl.appendChild(makeItem(SW_SVG, 'Switch App', toggleSwitcher));
    navEl.appendChild(makeItem(SR_SVG, 'Search ⌘K', openSearch));
  }

  function mountInStudyNav(navEl) {
    document.body.appendChild(root);
    root.style.display = 'none';

    // Always inject — labels hidden on mobile via CSS so items stay compact
    const makeItem = (emoji, label, clickFn) => {
      const a = document.createElement('a');
      a.className = 'nav-item hn-injected';
      a.style.cursor = 'pointer';
      a.setAttribute('role', 'button');
      a.setAttribute('aria-label', label);
      const iconSpan = document.createElement('span');
      iconSpan.className = 'nav-icon';
      iconSpan.textContent = emoji;
      const labelSpan = document.createElement('span');
      labelSpan.className = 'nav-label';
      labelSpan.textContent = label;
      a.appendChild(iconSpan);
      a.appendChild(labelSpan);
      a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); clickFn(e); });
      return a;
    };

    if (window.innerWidth >= 1024) {
      // Desktop sidebar: add separator before items
      const sep = document.createElement('div');
      sep.style.cssText = 'height:1px;width:60%;margin:2px auto 4px;background:rgba(91,141,239,0.12);flex-shrink:0;';
      navEl.appendChild(sep);
    }
    navEl.appendChild(makeItem('⬡', 'Apps', toggleSwitcher));
    navEl.appendChild(makeItem('🔍', 'Search', openSearch));
  }

  function showMobileNavOverlay() { /* no-op — kept for safety */ }

  function mountInSidebar(sidebarEl) {
    // Study / ORV: inject two icon buttons at bottom of sidebar
    root.style.display = 'none';
    document.body.appendChild(root);

    // For ORV: .sidebar > .hdr contains all content; inject after .fw-quote if present
    const hdr = sidebarEl.querySelector('.hdr');
    const target = hdr || sidebarEl;

    const sep = document.createElement('div');
    sep.className = 'hn-sb-sep';
    target.appendChild(sep);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:center;padding:4px 0 8px;';

    const swBtn = makeNavBtn('hn-sb-item', 'hn-sb-tip', 'Switch App', SW_SVG, toggleSwitcher);
    const srBtn = makeNavBtn('hn-sb-item', 'hn-sb-tip', 'Search ⌘K', SR_SVG, openSearch);
    btnRow.appendChild(swBtn);
    btnRow.appendChild(srBtn);
    target.appendChild(btnRow);
  }

  /* ── ZEN GARDEN SIDEBAR INTEGRATION ── */
  function mountInZenPanel(panelEl) {
    root.style.display = 'none'; 
    document.body.appendChild(root);

    const navCard = document.createElement('div');
    navCard.className = 'card';
    navCard.innerHTML = `
      <div class="card-title">System Navigation</div>
      <div style="display: flex; flex-direction: column; gap: 10px;">
        <button id="zen-sw-btn" style="background: var(--surface2); color: var(--text-dim); border: 1px solid var(--border); width: 100%; padding: 12px; border-radius: 10px; font-family: 'DM Sans', sans-serif; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; transition: all 0.2s;">
          <span style="font-size: 16px; opacity: 0.7;">⬡</span> Switch App
        </button>
        <button id="zen-sr-btn" style="background: var(--surface2); color: var(--text-dim); border: 1px solid var(--border); width: 100%; padding: 12px; border-radius: 10px; font-family: 'DM Sans', sans-serif; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; transition: all 0.2s;">
          <span style="font-size: 16px; opacity: 0.7;">🔍</span> Search Hub <span style="font-size: 9px; opacity: 0.3; margin-left: auto; letter-spacing: 0.1em;">⌘K</span>
        </button>
      </div>
    `;

    const btns = navCard.querySelectorAll('button');
    btns.forEach(b => {
      b.onmouseover = () => { 
        b.style.borderColor = 'var(--accent-dim)'; b.style.color = 'var(--text)'; b.style.background = 'rgba(124, 184, 124, 0.05)'; 
      };
      b.onmouseout = () => { 
        b.style.borderColor = 'var(--border)'; b.style.color = 'var(--text-dim)'; b.style.background = 'var(--surface2)'; 
      };
    });

    if (panelEl.children.length >= 1) { panelEl.insertBefore(navCard, panelEl.children[1]); } 
    else { panelEl.appendChild(navCard); }

    document.getElementById('zen-sw-btn').onclick = (e) => { e.stopPropagation(); toggleSwitcher(e); };
    document.getElementById('zen-sr-btn').onclick = openSearch;
  }

  /* ── TRACKER HUB INTEGRATION (Search Pill) ── */
  function mountInHubHeader() {
    const header = document.querySelector('header');
    if (!header) return;
    root.style.display = 'none'; 
    document.body.appendChild(root);

    const searchWrapper = document.createElement('div');
    searchWrapper.style.cssText = 'margin-top: 4px; animation: up 0.9s 0.4s cubic-bezier(.16,1,.3,1) both; display: flex; justify-content: center;';
    const pill = document.createElement('div');
    pill.className = 'date-pill'; 
    pill.style.cssText = 'cursor:pointer; transition:all 0.3s ease; border:1px solid rgba(255,255,255,0.1); display:flex; align-items:center; gap:8px; padding:8px 20px;';
    pill.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.6;"><circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10.5L14 14.5" stroke-linecap="round"/></svg>
      <span style="color:var(--muted2); font-size:11px; font-family:'JetBrains Mono',monospace; letter-spacing:0.1em; text-transform:uppercase;">Quick Search</span>
      <span style="color:rgba(255,255,255,0.1);">·</span>
      <kbd style="font-family:'JetBrains Mono',monospace; font-size:9px; opacity:0.3;">⌘K</kbd>
    `;

    pill.onmouseover = () => { pill.style.borderColor = 'rgba(255,255,255,0.25)'; pill.style.background = 'rgba(255,255,255,0.08)'; pill.style.transform = 'translateY(-1px)'; };
    pill.onmouseout = () => { pill.style.borderColor = 'rgba(255,255,255,0.14)'; pill.style.background = 'rgba(255,255,255,0.04)'; pill.style.transform = 'translateY(0)'; };
    pill.onclick = (e) => { e.stopPropagation(); openSearch(); };
    searchWrapper.appendChild(pill);
    header.appendChild(searchWrapper);
  }

  // Final Router Logic
  function tryMount() {
    root.style.display = 'flex'; 

    if (currentId === 'hub') { 
      mountInHubHeader(); 
      return; 
    }

    if (currentId === 'proc') {
      const ensureProcNav = () => {
        const nav = document.getElementById('bottom-nav');
        if (nav) mountInBottomNav(nav);
      };
      ensureProcNav();
      setInterval(ensureProcNav, 1000);
      return;
    }

    if (currentId === 'study') {
      const nav = document.getElementById('bottomNav');
      if (nav) { mountInStudyNav(nav); return; }
    }

    if (currentId === 'orv') {
      const sidebar = document.querySelector('.sidebar');
      if (sidebar) { mountInSidebar(sidebar); return; }
    }

    if (currentId === 'zen') {
      const panel = document.querySelector('.side-panel');
      if (panel) { mountInZenPanel(panel); return; }
    }
    
    // Fallback: show floating pills
    root.style.display = 'flex';
    document.body.appendChild(root);
  }

  // Nav may be dynamically rendered, so wait a tick
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(tryMount, 200));
  } else {
    setTimeout(tryMount, 200);
  }

  /* ─────────────────────────────────────────
     AUTO-INDEX THIS APP (after paint)
  ───────────────────────────────────────── */
  if (currentId !== 'hub') {
    // ── NAVIGATION: fire early so it feels instant, not like a "robot click" ──
    // Apps finish their own DOMContentLoaded init in <100ms; 200ms is safe for all.
    // A retry at 600ms catches any app that needs extra setup time.
    (function executeHashNav() {
      const hash = location.hash;
      if (!hash) return;

      function tryNav(attempt) {
        if (hash.startsWith('#hn-call~')) {
          // SPA navigation: "#hn-call~navigateTo~library" → window.navigateTo('library')
          const rest     = hash.slice('#hn-call~'.length);
          const tildeIdx = rest.indexOf('~');
          const func     = rest.slice(0, tildeIdx);
          const arg      = decodeURIComponent(rest.slice(tildeIdx + 1));
          const fn       = window[func];
          if (typeof fn === 'function') {
            // Handle compound arg: "detail~seriesId" → fn('detail', 'seriesId')
            if (arg.includes('~')) {
              const argParts = arg.split('~');
              fn(argParts[0], argParts[1]);
            } else {
              fn(isNaN(arg) ? arg : Number(arg));
            }
            history.replaceState(null, '', location.pathname); // clean hash so refresh won't re-fire
          } else if (attempt < 3) {
            // Function not ready yet — retry (handles slow-init apps)
            setTimeout(() => tryNav(attempt + 1), attempt === 1 ? 400 : 600);
          }
        } else if (hash.startsWith('#hn-')) {
          // Scroll-based: "#hn-schedule" → resolve to real section element
          scrollToIndexedElement(hash.slice(1));
        }
      }

      setTimeout(() => tryNav(1), 200); // first attempt: feels near-instant
    })();

    // ── INDEX BUILDING: separate, runs later so it never blocks navigation ──
    setTimeout(() => saveIndex(), 1200);
  }

})();
