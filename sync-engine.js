/**
 * sync-engine.js · TRACKERS HUB — Cross-Device Sync Layer
 * ============================================================================
 * Makes every tracker app sync across every device, in real time, WITHOUT
 * touching a single one of the ~223 existing `localStorage` call sites.
 *
 * HOW IT WORKS
 * ------------
 * localStorage stays the local source of truth. Every app keeps reading and
 * writing it synchronously exactly as before — nothing about their logic
 * changes. This layer patches `Storage.prototype.setItem/removeItem/clear`
 * so that after each native write completes, the key is queued for upload.
 * Remote changes arrive over a Supabase realtime websocket, get written into
 * localStorage through the *native* (unpatched) setter, and then trigger the
 * host app's own re-render function.
 *
 * That means:
 *   • Reads stay synchronous and native — zero behaviour change, zero risk.
 *   • Offline still works. Everything queues and flushes on reconnect.
 *   • If Supabase is unreachable or unconfigured, the apps behave EXACTLY
 *     as they did before this file existed. Sync is strictly additive.
 *
 * LOAD ORDER: must be in <head>, before the app's own inline <script>, so the
 * write interception is installed before any app code runs.
 *
 * See SYNC-SETUP.md for the one-time Supabase setup.
 */
(function () {
  'use strict';

  if (window.__TRACKERS_SYNC__) return;             // never double-install

  /* ══════════════════════════════════════════════════════════════════
     0 · CAPTURE NATIVE STORAGE METHODS
     Done first, before anything can patch or shadow them.
  ══════════════════════════════════════════════════════════════════ */
  var SP           = Storage.prototype;
  var nativeSet    = SP.setItem;
  var nativeGet    = SP.getItem;
  var nativeRemove = SP.removeItem;
  var nativeClear  = SP.clear;
  var nativeKey    = SP.key;

  function rawGet(k)    { try { return nativeGet.call(localStorage, k); }     catch (_) { return null; } }
  function rawSet(k, v) { try { nativeSet.call(localStorage, k, v); return true; } catch (_) { return false; } }
  function rawDel(k)    { try { nativeRemove.call(localStorage, k); }         catch (_) {} }
  function rawKeys() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = nativeKey.call(localStorage, i);
        if (k !== null) out.push(k);
      }
    } catch (_) {}
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════
     1 · CONFIG
  ══════════════════════════════════════════════════════════════════ */
  var CFG = window.TRACKERS_SYNC_CONFIG || {};
  var SUPABASE_URL = (CFG.supabaseUrl || '').replace(/\/+$/, '');
  var SUPABASE_KEY = CFG.supabaseAnonKey || '';
  var TABLE        = CFG.table || 'sync_kv';
  var DEBOUNCE_MS  = CFG.debounceMs != null ? CFG.debounceMs : 600;
  var SDK_URL      = CFG.sdkUrl || 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
  var DEBUG        = !!CFG.debug;

  // Internal keys — these live only on this device and are NEVER synced.
  var CRED_KEY   = '__sync_cred_v1';    // the pairing code for this device
  var META_KEY   = '__sync_meta_v1';    // per-key last-known-remote timestamps
  var DEVICE_KEY = '__sync_device_v1';  // this device's random id
  var PAIRED_KEY = '__sync_paired_v1';  // when this device last paired (ms)
  var CTL_LOGOUT = '__sync_ctl_logout'; // server row: "log out every device except mine"

  /**
   * Keys that stay device-local by design.
   *
   * Everything else — all tracker DATA — syncs. These are excluded because
   * they describe *this screen*, not your data: syncing a phone's font size
   * or collapsed-panel state onto a desktop makes both worse, and the search
   * index (`hub-idx-*`) is rebuilt locally on every visit anyway.
   *
   * Edit this list freely; it is the single place that governs what is local.
   */
  var LOCAL_ONLY_EXACT = [
    CRED_KEY, META_KEY, DEVICE_KEY, PAIRED_KEY,
    'theme',                   // light/dark, per device
    'fontSize',                // per device
    'viewMode',                // per device
    'hapticsEnabled',          // phone-only concept
    'accessibilitySettings_v5',// per device
    'collapsedSections_v5',    // per-screen UI state
    'sectionLayout_v1',        // per-screen UI state
    'v8_nav_prefs',            // per-screen nav layout
    'v8_last_tab',             // "where I was" — per device
    'v8_last_sub_plan', 'v8_last_sub_review', 'v8_last_sub_more', 'v8_last_sub_',
    'phub_last_location',      // "where I was" — per device
    'phub_kb_hint_shown',      // one-time UI hint, per device
    'exam_view_v1',            // Exams list layout (sort + strips/boxes) — a phone and a laptop can differ
    'todo_kind_v1'             // which todo tab (Study / Other / All) this device is on
  ];
  var LOCAL_ONLY_PREFIX = ['hub-idx-', '__sync_'];

  if (Array.isArray(CFG.localOnlyKeys))    LOCAL_ONLY_EXACT  = LOCAL_ONLY_EXACT.concat(CFG.localOnlyKeys);
  if (Array.isArray(CFG.localOnlyPrefixes)) LOCAL_ONLY_PREFIX = LOCAL_ONLY_PREFIX.concat(CFG.localOnlyPrefixes);

  function isSyncable(k) {
    if (typeof k !== 'string' || !k) return false;
    if (LOCAL_ONLY_EXACT.indexOf(k) !== -1) return false;
    for (var i = 0; i < LOCAL_ONLY_PREFIX.length; i++) {
      if (k.indexOf(LOCAL_ONLY_PREFIX[i]) === 0) return false;
    }
    return true;
  }

  function log() {
    if (!DEBUG) return;
    var a = ['%c[sync]', 'color:#4ade80;font-weight:600'];
    console.log.apply(console, a.concat([].slice.call(arguments)));
  }
  function warn() {
    var a = ['%c[sync]', 'color:#f5b800;font-weight:600'];
    console.warn.apply(console, a.concat([].slice.call(arguments)));
  }

  /* ══════════════════════════════════════════════════════════════════
     2 · STATE
  ══════════════════════════════════════════════════════════════════ */
  var state = {
    status: 'init',   // init|unconfigured|unpaired|connecting|online|offline|error
    detail: '',
    client: null,
    userId: null,
    channel: null,
    dirty: Object.create(null),   // key -> true, awaiting upload
    pendingKeys: Object.create(null), // key -> true, changed remotely, not yet re-rendered
    applying: false,              // true while writing remote data locally
    pushTimer: null,
    lastPushAt: 0,
    lastPullAt: 0,
    booted: false,
    queueCount: 0,
    bootOnly: Object.create(null),    // key -> true, dirty only from the app's own startup saves
    bootCreated: Object.create(null), // key -> true, didn't exist until the app created it on startup
    replaced: Object.create(null),    // key -> { old, at }: the copy the last remote update overwrote
    reconciled: false                 // no uploads until the first compare with the server is done
  };

  /* Who wrote it — the user, or the app on its own?
     Apps re-save their state as they open, before sync has connected, from
     whatever copy this device last had (and create starter data on a fresh
     device). Counting that as a fresh edit let "unsent local edits win"
     upload a stale copy over newer data from another device: a todo added on
     the laptop vanished when the phone opened; removed content came back.
     A write with no tap/click/keypress before it can't be the user's edit. */
  var lastInputAt = 0;
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (t) {
    window.addEventListener(t, function () { lastInputAt = Date.now(); }, true);
  });

  var deviceId = rawGet(DEVICE_KEY);
  if (!deviceId) {
    deviceId = 'dev_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    rawSet(DEVICE_KEY, deviceId);
  }

  function loadMeta() {
    try { return JSON.parse(rawGet(META_KEY) || '{}') || {}; } catch (_) { return {}; }
  }
  function saveMeta(m) {
    try { rawSet(META_KEY, JSON.stringify(m)); } catch (_) {}
  }
  var meta = loadMeta();   // { key: remoteUpdatedAtMs }

  /* ══════════════════════════════════════════════════════════════════
     3 · WRITE INTERCEPTION  ← installed synchronously, right now
     The native write always runs first and its result is preserved, so app
     behaviour (including quota errors) is bit-for-bit unchanged.
  ══════════════════════════════════════════════════════════════════ */
  SP.setItem = function (k, v) {
    var watch = this === window.localStorage && !state.applying && isSyncable(k);
    var prev = watch ? rawGet(k) : null;
    // A save that leaves the value exactly as it was is not an edit.
    var same = watch && prev === String(v);
    // An app that kept an old copy in memory writing it straight back over an
    // update that just arrived — with no input from you since — is not an
    // edit either. Keep the update and have the page reload it instead.
    var rep = watch && !same && state.replaced[k];
    if (rep && String(v) === rep.old && lastInputAt < rep.at) {
      warn('blocked stale write-back of', k);
      state.pendingKeys[k] = true;
      scheduleRerender();
      return;
    }
    var r = nativeSet.apply(this, arguments);
    if (watch && !same) { delete state.replaced[k]; markDirty(k, prev === null); }
    return r;
  };
  SP.removeItem = function (k) {
    var watch = this === window.localStorage && !state.applying && isSyncable(k);
    var existed = watch && rawGet(k) !== null;
    var r = nativeRemove.apply(this, arguments);
    if (watch && existed) markDirty(k);
    return r;
  };
  SP.clear = function () {
    var before = (this === window.localStorage && !state.applying) ? rawKeys() : null;
    var r = nativeClear.apply(this, arguments);
    if (before) before.forEach(function (k) { if (isSyncable(k)) markDirty(k); });
    return r;
  };

  function markDirty(k, created) {
    if (!state.reconciled && !lastInputAt) {
      // The app saving on its own before the first sync: provisional.
      if (!state.dirty[k]) {
        state.bootOnly[k] = true;
        if (created) state.bootCreated[k] = true;
      }
    } else {
      delete state.bootOnly[k]; delete state.bootCreated[k];
    }
    state.dirty[k] = true;
    state.queueCount = Object.keys(state.dirty).length;
    emit('change');
    schedulePush();
  }

  function schedulePush() {
    if (state.pushTimer) clearTimeout(state.pushTimer);
    state.pushTimer = setTimeout(function () {
      state.pushTimer = null;
      push();
    }, DEBOUNCE_MS);
  }

  /* ══════════════════════════════════════════════════════════════════
     4 · EVENTS + STATUS
  ══════════════════════════════════════════════════════════════════ */
  var listeners = [];
  function emit(type, payload) {
    listeners.forEach(function (fn) { try { fn(type, payload, api.status()); } catch (_) {} });
    try {
      window.dispatchEvent(new CustomEvent('trackers-sync', {
        detail: { type: type, payload: payload, status: api.status() }
      }));
    } catch (_) {}
  }
  function setStatus(s, detail) {
    state.status = s;
    state.detail = detail || '';
    log('status →', s, detail || '');
    emit('status');
  }

  /* ══════════════════════════════════════════════════════════════════
     5 · APPLYING REMOTE DATA
     Writes go through the NATIVE setter with `applying` set, so they are not
     mistaken for local edits and echoed straight back to the server.
  ══════════════════════════════════════════════════════════════════ */
  function applyRemote(k, v, tsMs) {
    if (!isSyncable(k)) return false;
    // A key the user has edited locally but we haven't uploaded yet wins —
    // their in-flight change must not be clobbered by an older server row.
    if (state.dirty[k]) { log('skip remote (locally dirty):', k); return false; }

    var cur = rawGet(k);
    var next = (v === null || v === undefined) ? null : String(v);
    if (cur === next) { meta[k] = tsMs; return false; }

    state.applying = true;
    try {
      if (next === null) rawDel(k); else rawSet(k, next);
    } finally {
      state.applying = false;
    }
    if (cur !== null) state.replaced[k] = { old: cur, at: Date.now() };
    meta[k] = tsMs;
    state.pendingKeys[k] = true;

    // Let same-page listeners react. Native `storage` events only fire in
    // OTHER tabs, so apps in THIS tab would otherwise never hear about it.
    try {
      window.dispatchEvent(new StorageEvent('storage', {
        key: k, newValue: next, oldValue: cur,
        storageArea: window.localStorage, url: location.href
      }));
    } catch (_) {}

    return true;
  }

  /* ══════════════════════════════════════════════════════════════════
     6 · RE-RENDER BRIDGE
     Each app is told to redraw itself using its own public entry points.
     Debounced, and deliberately conservative: we never reload the page out
     from under a running timer or an open modal.
  ══════════════════════════════════════════════════════════════════ */
  var rerenderTimer = null;
  function scheduleRerender() {
    if (rerenderTimer) clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(function () {
      rerenderTimer = null;
      doRerender();
    }, 180);
  }

  function busy() {
    // Don't redraw while the user is mid-interaction — it would steal focus,
    // close their dialog, or wipe half-typed text.
    if (document.querySelector('.day-popup-backdrop')) return true;
    if (window.__mediaTimerRunning) return true;
    var ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return true;
    if (ae && ae.isContentEditable) return true;
    return false;
  }

  function doRerender() {
    if (busy()) { scheduleRerender(); return; }   // try again shortly
    var changed = Object.keys(state.pendingKeys);
    state.pendingKeys = Object.create(null);
    // Nothing actually arrived from another device — don't redraw. The first
    // sync after every page load used to redraw unconditionally, which in the
    // Procrastination Hub means re-navigating to the page you're already on.
    if (!changed.length) return;

    // An app that caches state in memory (rather than reading localStorage on
    // every render) has to re-hydrate before it redraws, and only it knows how.
    // It gets the list of keys that actually changed so it can reload just those.
    var custom = window.TRACKERS_SYNC_RERENDER;
    if (typeof custom === 'function') {
      try { custom(changed); emit('rerender', { keys: changed }); return; }
      catch (e) { warn('custom rerender failed', e); }
    }
    var ran = false;
    function tryCall(fn, args) {
      if (typeof window[fn] !== 'function') return;
      try { window[fn].apply(window, args || []); ran = true; } catch (e) { warn(fn + '() failed', e); }
    }

    // Zen Garden — single global render()
    tryCall('render');
    // Trackers Hub — recomputes every card from localStorage
    tryCall('syncHubData');
    // Study Schedule Pro
    tryCall('v8Render');
    tryCall('renderSchedule');
    tryCall('renderTodos');
    tryCall('v7Refresh');
    // Procrastination Hub — redraw the section the user is actually on
    if (typeof window.navigateTo === 'function' && window.__syncProcSection) {
      try { window.navigateTo(window.__syncProcSection(), window.__syncProcDetail && window.__syncProcDetail(), true); ran = true; }
      catch (e) { warn('proc rerender failed', e); }
    } else {
      tryCall('renderDashboard');
    }

    if (ran) emit('rerender');
    else log('no rerender hook found on this page');
  }

  /* ══════════════════════════════════════════════════════════════════
     7 · SUPABASE TRANSPORT
  ══════════════════════════════════════════════════════════════════ */

  /**
   * The pairing code IS the credential.
   *
   * It decodes to a real Supabase email+password, so the data sits behind
   * Row Level Security rather than behind a client-side check anyone could
   * bypass by opening devtools. One paste per device, real protection.
   */
  function decodeCode(code) {
    try {
      var json = atob(String(code).trim().replace(/\s+/g, ''));
      var o = JSON.parse(json);
      if (o && o.e && o.p) return { email: o.e, password: o.p };
    } catch (_) {}
    return null;
  }
  function encodeCode(email, password) {
    return btoa(JSON.stringify({ e: email, p: password }));
  }

  function getStoredCode() { return rawGet(CRED_KEY) || CFG.pairingCode || ''; }

  async function connect() {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      setStatus('unconfigured', 'Set supabaseUrl + supabaseAnonKey in sync-config.js');
      return;
    }
    var code = getStoredCode();
    if (!code) { setStatus('unpaired', 'This device is not paired yet'); return; }
    var cred = decodeCode(code);
    if (!cred) { setStatus('error', 'Pairing code is malformed'); return; }

    setStatus('connecting');
    var createClient;
    try {
      var mod = await import(/* webpackIgnore: true */ SDK_URL);
      createClient = mod.createClient;
    } catch (e) {
      setStatus('offline', 'Could not load the Supabase library');
      warn('SDK load failed', e);
      retryLater();
      return;
    }

    try {
      state.client = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: 'sb-trackers-auth' }
      });

      // The client keeps its session in localStorage, so reuse it rather than
      // signing in from scratch on every open — that was a full extra round
      // trip before the first pull, felt most on a phone cold-starting the
      // installed app. getSession() refreshes an expired token by itself; the
      // password is only the fallback (first run, or a revoked session).
      var sess = null;
      if (!state.forcePassword) {
        try { sess = (await state.client.auth.getSession()).data.session; } catch (_) {}
        if (sess && !(sess.user && String(sess.user.email || '').toLowerCase() === String(cred.email).toLowerCase())) sess = null;
      }
      if (sess) {
        state.userId = sess.user.id;
        state.usedStoredSession = true;
        // supabase-js 2.45 only hands the user's token to realtime on SIGNED_IN
        // or TOKEN_REFRESHED — a resumed session is neither, and realtime would
        // stay on the anon key, where row-level security hides every change.
        try { state.client.realtime.setAuth(sess.access_token); } catch (_) {}
        log('resumed session', state.userId);
      } else {
        var res = await state.client.auth.signInWithPassword({
          email: cred.email, password: cred.password
        });
        if (res.error) throw res.error;
        state.userId = res.data.user.id;
        state.usedStoredSession = false;
        log('signed in', state.userId);
      }

      if (!rawGet(PAIRED_KEY)) markPaired();
      await initialSync();
      if (state.kicked) return;
      subscribeRealtime();
      setStatus('online');
      state.booted = true;
    } catch (e) {
      warn('connect failed', e);
      // A stored session that turned out bad (e.g. revoked) must not be
      // retried forever — fall back to a real sign-in next attempt.
      if (state.usedStoredSession) state.forcePassword = true;
      setStatus('offline', (e && e.message) || 'Connection failed');
      retryLater();
    }
  }

  var retryDelay = 4000;
  var retryTimer = null;
  function retryLater() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      retryDelay = Math.min(retryDelay * 1.6, 60000);
      connect();
    }, retryDelay);
  }

  /* ── Initial reconcile ───────────────────────────────────────────── */
  async function initialSync() {
    var r = await state.client.from(TABLE).select('k,v,updated_at');
    if (r.error) throw r.error;
    if ((r.data || []).some(checkKick)) return;

    var remote = Object.create(null);
    (r.data || []).forEach(function (row) {
      remote[row.k] = { v: row.v, t: new Date(row.updated_at).getTime() };
    });

    var localKeys = rawKeys().filter(isSyncable);
    // Starter data the app created on this very load isn't "your data on this
    // device" — a fresh phone meeting a full cloud should just download.
    var hasLocal  = localKeys.some(function (k) { return !state.bootCreated[k]; });
    var hasRemote = Object.keys(remote).length > 0;

    // A device with real local data meeting a cloud that also has data is the
    // one case we must not silently guess at — it risks destroying months of
    // tracking. Ask, once, and remember the answer.
    var firstReconcile = !rawGet(META_KEY);
    if (firstReconcile && hasLocal && hasRemote) {
      var choice = await askReconcile(localKeys.length, Object.keys(remote).length);
      if (choice === 'upload')      { finishReconcile(); await uploadAll(localKeys); return; }
      if (choice === 'download')    { finishReconcile(); downloadAll(remote, localKeys); return; }
      // 'merge' falls through to the newest-wins path below
    }

    // Newest-per-key wins. A key we have never seen from the server before is
    // treated as a local edit and uploaded, so a fresh cloud gets seeded.
    var toPush = [];
    localKeys.forEach(function (k) {
      var rem = remote[k];
      var known = meta[k];
      // Our only "edit" is the app saving on its own at startup, and the
      // server has something newer — or the app just created this key from
      // scratch (starter data) while the cloud already has the real thing.
      // The server wins. On the very first sync of a device that already had
      // real data, the reconcile prompt above has decided instead.
      if (rem && state.bootOnly[k] &&
          (known == null ? (state.bootCreated[k] || !firstReconcile) : rem.t > known)) {
        delete state.dirty[k]; delete state.bootOnly[k];
        applyRemote(k, rem.v, rem.t);
        log('startup save superseded by the server copy:', k);
        return;
      }
      if (!rem)                       { toPush.push(k); return; }  // not in cloud yet
      if (known == null)              { toPush.push(k); return; }  // never reconciled → keep local
      if (rem.t > known)              { applyRemote(k, rem.v, rem.t); return; }
      if (rawGet(k) !== rem.v)        { toPush.push(k); }
    });
    Object.keys(remote).forEach(function (k) {
      if (localKeys.indexOf(k) === -1 && remote[k].v !== null) {
        applyRemote(k, remote[k].v, remote[k].t);
      }
    });

    saveMeta(meta);
    state.lastPullAt = Date.now();
    finishReconcile();
    if (toPush.length) { toPush.forEach(function (k) { state.dirty[k] = true; }); await push(); }
    scheduleRerender();
    emit('pull', { count: Object.keys(remote).length });
  }

  // From here on every write is a real edit, and uploads may flow.
  function finishReconcile() {
    state.bootOnly = Object.create(null);
    state.bootCreated = Object.create(null);
    state.reconciled = true;
  }

  async function uploadAll(localKeys) {
    localKeys.forEach(function (k) { state.dirty[k] = true; });
    await push();
    scheduleRerender();
  }

  function downloadAll(remote, localKeys) {
    // Drop local keys the cloud doesn't have, then take every cloud value.
    localKeys.forEach(function (k) {
      if (!(k in remote)) { state.applying = true; try { rawDel(k); } finally { state.applying = false; } state.pendingKeys[k] = true; }
    });
    Object.keys(remote).forEach(function (k) { applyRemote(k, remote[k].v, remote[k].t); });
    saveMeta(meta);
    scheduleRerender();
  }

  /* ── Upload ──────────────────────────────────────────────────────── */
  var pushing = false;
  async function push() {
    if (pushing) { schedulePush(); return; }
    if (!state.client || !state.userId) return;
    // Before the first compare, a pending key may be a stale startup save that
    // the server is about to supersede — initialSync pushes what's really new.
    if (!state.reconciled) return;
    var keys = Object.keys(state.dirty);
    if (!keys.length) return;

    pushing = true;
    var batch = keys.slice(0, 200);
    var rows = batch.map(function (k) {
      return { user_id: state.userId, k: k, v: rawGet(k), device: deviceId, updated_at: new Date().toISOString() };
    });

    try {
      var r = await state.client.from(TABLE).upsert(rows, { onConflict: 'user_id,k' }).select('k,updated_at');
      if (r.error) throw r.error;
      (r.data || []).forEach(function (row) { meta[row.k] = new Date(row.updated_at).getTime(); });
      batch.forEach(function (k) { delete state.dirty[k]; });
      saveMeta(meta);
      state.lastPushAt = Date.now();
      state.queueCount = Object.keys(state.dirty).length;
      if (state.status !== 'online') setStatus('online');
      emit('push', { count: batch.length });
      log('pushed', batch.length, 'key(s)');
      if (Object.keys(state.dirty).length) schedulePush();   // more waiting
    } catch (e) {
      warn('push failed', e);
      setStatus('offline', (e && e.message) || 'Upload failed');
      schedulePush();
    } finally {
      pushing = false;
    }
  }

  /* ── Realtime ────────────────────────────────────────────────────── */
  /* ── Remote log-out ─────────────────────────────────────────────────
     "Log out other devices" revokes their sessions, but an access token
     keeps working for up to an hour. So the sender also writes a signal row,
     and every open device that sees it logs itself out right away. A device
     that paired after the signal was sent ignores it. */
  function markPaired() { rawSet(PAIRED_KEY, String(Date.now())); }

  function checkKick(row) {
    if (!row || row.k !== CTL_LOGOUT || !row.v) return false;
    var sig;
    try { sig = JSON.parse(row.v); } catch (_) { return false; }
    if (!sig || sig.from === deviceId) return false;
    if (!(sig.at > (+rawGet(PAIRED_KEY) || 0))) return false;
    if (state.kicked) return true;
    state.kicked = true;
    kickedOut();
    return true;
  }

  async function kickedOut() {
    try { if (window.TrackersPush && window.TrackersPush.prefs().enabled) await window.TrackersPush.disable(); } catch (_) {}
    await api.unpair();
    state.kicked = false;
    document.querySelectorAll('.tsync-overlay').forEach(function (el) { el.remove(); });
    overlay(
      '<div class="tsync-title">Logged out</div>' +
      '<div class="tsync-body">Another of your devices logged this one out of sync. Your data is still here. ' +
        'It stops syncing and notifications are off until you pair again.</div>' +
      '<div class="tsync-btns">' +
        '<button class="tsync-btn tsync-primary" id="tsync-kick-pair">Pair again</button>' +
        '<button class="tsync-btn" id="tsync-kick-ok">OK</button>' +
      '</div>',
      function (root) {
        root.querySelector('#tsync-kick-pair').addEventListener('click', function () { root.remove(); promptPairing(); });
        root.querySelector('#tsync-kick-ok').addEventListener('click', function () { root.remove(); });
      }
    );
  }

  function subscribeRealtime() {
    if (state.channel) { try { state.client.removeChannel(state.channel); } catch (_) {} }
    state.channel = state.client
      .channel('sync_kv_' + state.userId)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: TABLE, filter: 'user_id=eq.' + state.userId },
        function (payload) {
          var row = payload.new || payload.old;
          if (!row || !row.k) return;
          if (checkKick(row)) return;
          if (row.device === deviceId) return;              // our own echo
          var applied;
          if (payload.eventType === 'DELETE') applied = applyRemote(row.k, null, Date.now());
          else applied = applyRemote(row.k, row.v, new Date(row.updated_at).getTime());
          if (applied) {
            saveMeta(meta);
            log('applied remote change:', row.k);
            scheduleRerender();
            emit('remote', { key: row.k });
          }
        })
      .subscribe(function (st) {
        log('realtime:', st);
        if (st === 'SUBSCRIBED') setStatus('online');
        else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') { setStatus('offline', 'Realtime dropped'); retryLater(); }
      });
  }

  /* ── Safety nets ─────────────────────────────────────────────────── */
  // Realtime can silently miss messages after a laptop sleeps, so re-pull on
  // wake/refocus and flush anything the tab never got a chance to upload.
  window.addEventListener('online', function () { retryDelay = 4000; if (state.client) { pullOnce(); push(); } else connect(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.client) { pullOnce(); push(); }
  });
  window.addEventListener('pagehide', function () { if (Object.keys(state.dirty).length) push(); });

  async function pullOnce() {
    if (!state.client || !state.userId) return;
    try {
      var since = new Date(Math.max(0, state.lastPullAt - 60000)).toISOString();
      var r = await state.client.from(TABLE).select('k,v,updated_at').gt('updated_at', since);
      if (r.error) throw r.error;
      var n = 0;
      if ((r.data || []).some(checkKick)) return;
      (r.data || []).forEach(function (row) {
        if (applyRemote(row.k, row.v, new Date(row.updated_at).getTime())) n++;
      });
      state.lastPullAt = Date.now();
      if (n) { saveMeta(meta); scheduleRerender(); log('catch-up pull applied', n); }
      if (state.status !== 'online') setStatus('online');
    } catch (e) { warn('pull failed', e); }
  }

  /* ══════════════════════════════════════════════════════════════════
     8 · PAIRING + RECONCILE UI
  ══════════════════════════════════════════════════════════════════ */
  function overlay(html, onMount) {
    var el = document.createElement('div');
    el.className = 'tsync-overlay';
    el.innerHTML =
      '<div class="tsync-card">' + html + '</div>';
    (document.body || document.documentElement).appendChild(el);
    if (onMount) onMount(el);
    return el;
  }

  function askReconcile(localCount, remoteCount) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (done) return; done = true; try { el.remove(); } catch (_) {} resolve(v); }
      var el = overlay(
        '<div class="tsync-title">This device already has data</div>' +
        '<div class="tsync-body">' +
          'This device has <b>' + localCount + '</b> saved item' + (localCount === 1 ? '' : 's') +
          ', and the cloud has <b>' + remoteCount + '</b>. Choose once — the answer is remembered.' +
        '</div>' +
        '<div class="tsync-btns">' +
          '<button class="tsync-btn tsync-primary" data-a="merge">Merge — keep the newest of each</button>' +
          '<button class="tsync-btn" data-a="upload">Use this device — overwrite the cloud</button>' +
          '<button class="tsync-btn" data-a="download">Use the cloud — overwrite this device</button>' +
        '</div>' +
        '<div class="tsync-note">Merge is safest. It never deletes anything; for any single item that differs, the more recent edit wins.</div>',
        function (root) {
          root.querySelectorAll('[data-a]').forEach(function (b) {
            b.addEventListener('click', function () { finish(b.dataset.a); });
          });
        }
      );
    });
  }

  function promptPairing() {
    if (document.querySelector('.tsync-overlay')) return;
    overlay(
      '<div class="tsync-title">Pair this device</div>' +
      '<div class="tsync-body">Paste your pairing code to sync this device with your other devices.</div>' +
      '<input class="tsync-input" id="tsync-code" placeholder="Paste pairing code…" autocomplete="off" spellcheck="false">' +
      '<div class="tsync-err" id="tsync-err"></div>' +
      '<div class="tsync-btns">' +
        '<button class="tsync-btn tsync-primary" id="tsync-go">Pair device</button>' +
        '<button class="tsync-btn" id="tsync-skip">Not now — stay offline</button>' +
      '</div>' +
      '<div class="tsync-note">Your data stays on this device either way. Pairing just keeps it in step with your other devices.</div>',
      function (root) {
        var input = root.querySelector('#tsync-code');
        var err   = root.querySelector('#tsync-err');
        setTimeout(function () { input.focus(); }, 60);
        function go() {
          var code = input.value.trim();
          if (!decodeCode(code)) { err.textContent = 'That code is not valid. Copy it again from your first device.'; return; }
          rawSet(CRED_KEY, code);
          markPaired();
          root.remove();
          connect();
        }
        root.querySelector('#tsync-go').addEventListener('click', go);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
        root.querySelector('#tsync-skip').addEventListener('click', function () { root.remove(); });
      }
    );
  }

  /* ══════════════════════════════════════════════════════════════════
     9 · STATUS INDICATOR
  ══════════════════════════════════════════════════════════════════ */
  var STYLE = '\
.tsync-overlay{position:fixed;inset:0;z-index:2147483646;background:rgba(6,8,15,.86);\
-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);display:flex;align-items:center;justify-content:center;padding:24px;\
font-family:"Space Grotesk","DM Sans",system-ui,sans-serif}\
.tsync-card{width:100%;max-width:460px;background:#12141c;border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:26px 26px 22px;\
box-shadow:0 30px 90px rgba(0,0,0,.6);color:#e8eef8}\
.tsync-title{font-size:17px;font-weight:600;margin-bottom:8px}\
.tsync-body{font-size:13px;line-height:1.6;color:rgba(232,238,248,.62);margin-bottom:16px}\
.tsync-body b{color:#e8eef8}\
.tsync-input{width:100%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:10px;\
padding:11px 13px;color:#fff;font-size:13px;font-family:ui-monospace,"JetBrains Mono",monospace;outline:none;margin-bottom:6px}\
.tsync-input:focus{border-color:#4f8ef7}\
.tsync-err{color:#ff6b8a;font-size:11.5px;min-height:16px;margin-bottom:8px}\
.tsync-btns{display:flex;flex-direction:column;gap:8px}\
.tsync-btn{width:100%;padding:11px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.13);\
background:rgba(255,255,255,.04);color:#e8eef8;font-size:13px;font-weight:500;cursor:pointer;\
font-family:inherit;transition:background .15s,border-color .15s;text-align:center}\
.tsync-btn:hover{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.25)}\
.tsync-primary{background:#4f8ef7;border-color:#4f8ef7;color:#fff}\
.tsync-primary:hover{background:#3d7ce8;border-color:#3d7ce8}\
.tsync-danger{color:#ff6b8a;border-color:rgba(255,107,138,.3);background:rgba(255,107,138,.06)}\
.tsync-danger:hover{background:rgba(255,107,138,.12);border-color:rgba(255,107,138,.5)}\
.tsync-note{font-size:11px;color:rgba(232,238,248,.35);line-height:1.55;margin-top:14px}\
/* Status indicator: a bare dot, no pill, no text. Colour carries the state;\
   hover for the full status. Padding is on the element so it stays easy to\
   hit on touch without making the dot itself bigger. */\
.tsync-chip{position:fixed;left:14px;bottom:14px;z-index:2147483000;\
display:flex;align-items:center;justify-content:center;\
width:9px;height:9px;padding:8px;box-sizing:content-box;\
cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;\
background:none;border:none}\
.tsync-dot{width:9px;height:9px;border-radius:50%;background:#4a5568;flex-shrink:0;\
transition:background .3s,box-shadow .3s,opacity .3s;opacity:.85}\
.tsync-chip:hover .tsync-dot{opacity:1;transform:scale(1.1)}\
[data-tsync][data-s="online"] .tsync-dot{background:#4ade80;box-shadow:0 0 10px #4ade80}\
[data-tsync][data-s="connecting"] .tsync-dot{background:#f5b800;box-shadow:0 0 10px #f5b800;animation:tsyncPulse 1.2s ease infinite}\
[data-tsync][data-s="offline"] .tsync-dot,[data-tsync][data-s="error"] .tsync-dot{background:#ff6b8a;box-shadow:0 0 10px #ff6b8a}\
[data-tsync][data-s="unpaired"] .tsync-dot,[data-tsync][data-s="unconfigured"] .tsync-dot{background:#718096;opacity:.55}\
@keyframes tsyncPulse{0%,100%{opacity:1}50%{opacity:.3}}\
/* On phones the top-left corner belongs to the apps (hero text, tab strips,\
   sci-fi corner brackets), so the dot stays bottom-left but lifts clear of\
   the floating bottom nav instead. Every corner has *some* content behind it\
   at some scroll position, so it also gets a small dark bezel — that way it\
   reads as a deliberate badge rather than a smudge over the text. */\
@media(max-width:768px){\
.tsync-chip{top:auto;left:8px;bottom:calc(74px + env(safe-area-inset-bottom,0px));\
padding:6px;border-radius:50%;background:rgba(6,8,15,.72);\
-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);\
box-shadow:0 0 0 1px rgba(255,255,255,.07),0 2px 10px rgba(0,0,0,.45)}\
.tsync-dot{width:8px;height:8px}}\
/* Mounted inside an app\'s own bottom nav pill: no positioning of its own,\
   it just sits in the row like any other nav item. */\
.tsync-navdot{display:flex;align-items:center;justify-content:center}\
.tsync-hubdot{display:inline-flex;align-items:center;justify-content:center;\
margin-left:8px;cursor:pointer;padding:3px;order:1}\
.tsync-hubdot .tsync-dot{width:8px;height:8px}\
.tsync-hubdot:hover .tsync-dot{transform:scale(1.4)}\
.tsync-navdot .tsync-dot{width:9px;height:9px}\
@media print{.tsync-chip{display:none}}';

  function injectStyle() {
    if (document.getElementById('tsync-style')) return;
    var s = document.createElement('style');
    s.id = 'tsync-style';
    s.textContent = STYLE;
    (document.head || document.documentElement).appendChild(s);
  }

  var chip = null;
  var LABEL = {
    init: 'Sync…', unconfigured: 'Sync off', unpaired: 'Pair device',
    connecting: 'Syncing…', online: 'Synced', offline: 'Offline', error: 'Sync error'
  };

  /**
   * Where this dot belongs, per app:
   *   Study / Proc — their bottom nav pill
   *   Hub          — the footer that already shows the three tracker dots
   *   Zen          — nothing suitable, so it floats
   */
  function findNav() {
    return document.getElementById('v8Nav')
        || document.getElementById('bottom-nav')
        || document.querySelector('.hub-footer')
        || null;
  }

  function onClickDot() {
    if (state.status === 'unpaired' || state.status === 'unconfigured') { promptPairing(); return; }
    showSyncStatus();
  }

  // Clicking the dot while paired used to just force a silent sync with no
  // feedback — this shows what's going on instead, and is the only way to
  // log this device out (unpair) from the UI.
  function showSyncStatus() {
    if (document.querySelector('.tsync-overlay')) return;
    var q = Object.keys(state.dirty).length;
    var when = state.lastPushAt || state.lastPullAt;
    var whenText = when ? new Date(when).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }) : null;
    overlay(
      '<div class="tsync-title">Sync status</div>' +
      '<div class="tsync-body"><b>' + (LABEL[state.status] || state.status) + '</b>' + (q ? ' · ' + q + ' pending' : '') +
        (whenText ? '<br>Last synced ' + whenText : '') +
        (state.detail ? '<br>' + state.detail : '') +
      '</div>' +
      '<div class="tsync-btns">' +
        '<button class="tsync-btn tsync-primary" id="tsync-now">Sync now</button>' +
        '<button class="tsync-btn" id="tsync-logout-others">Log out other devices</button>' +
        '<button class="tsync-btn tsync-danger" id="tsync-logout">Log out — stop syncing this device</button>' +
        '<button class="tsync-btn" id="tsync-close">Close</button>' +
      '</div>' +
      '<div class="tsync-note">Logging out keeps everything already on this device — it just stops sending or receiving updates, and turns off push notifications here too (they\'re delivered through this same account). Pairing again turns both back on. "Log out other devices" leaves this one signed in and syncing, but every other device paired with this same code will need to pair again.</div>',
      function (root) {
        root.querySelector('#tsync-now').addEventListener('click', function () { root.remove(); api.forceSync(); });
        root.querySelector('#tsync-close').addEventListener('click', function () { root.remove(); });
        root.querySelector('#tsync-logout-others').addEventListener('click', async function () {
          if (!confirm('Log out every other device paired with this account?\n\nThis device stays signed in and syncing. Every other device that\'s open right now is logged out immediately. Closed ones are logged out the next time they open. Each will need to pair again.')) return;
          var btn = this, original = btn.textContent;
          btn.disabled = true; btn.textContent = 'Logging out other devices…';
          try {
            var instant = await api.signOutOthers();
            btn.textContent = instant ? 'Done — other devices logged out' : 'Done — others drop off within an hour';
          } catch (e) {
            btn.disabled = false; btn.textContent = original;
            alert('Could not log out other devices: ' + ((e && e.message) || e));
          }
        });
        root.querySelector('#tsync-logout').addEventListener('click', async function () {
          if (!confirm('Log out this device from sync?\n\nYour data stays right here. It stops syncing, and turns off push notifications on this device too, since they\'re delivered through the same account — pair again any time to turn both back on.')) return;
          root.remove();
          // Notifications are tied to this same account (see push-client.js) — clear that
          // subscription first, while still signed in, so nothing is left half-configured.
          try { if (window.TrackersPush && window.TrackersPush.prefs().enabled) await window.TrackersPush.disable(); } catch (_) {}
          await api.unpair();
        });
      }
    );
  }

  /**
   * Build a dot that looks native to whichever nav it's going into, so it
   * reads as part of the app rather than something bolted on.
   */
  function buildNavItem(nav) {
    var el;
    if (nav.classList && nav.classList.contains('hub-footer')) {
      // Match the footer's own dots rather than inventing a new shape.
      el = document.createElement('span');
      el.className = 'tsync-hubdot';
      el.innerHTML = '<span class="tsync-dot"></span>';
    } else if (nav.id === 'v8Nav') {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'v8-nav-item tsync-navdot';
      el.innerHTML = '<span class="v8-nav-icon tsync-dot"></span>';
    } else {
      el = document.createElement('div');
      el.className = 'bn-item tsync-navdot';
      el.innerHTML = '<div class="bn-tip">Sync</div><div class="bn-icon-wrap"><span class="tsync-dot"></span></div>';
    }
    el.setAttribute('data-tsync', '1');
    el.setAttribute('role', 'button');
    el.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); onClickDot(); });
    return el;
  }

  function renderChip() {
    if (CFG.hideIndicator) return;
    if (!document.body) return;

    // A page may declare its own indicator in its template (Zen does, because
    // it rebuilds its DOM on every render and anything injected is wiped).
    // When it does, just keep it painted — don't add a second one.
    var baked = document.querySelectorAll('[data-tsync-baked]');
    if (baked.length) {
      if (chip && !chip.hasAttribute('data-tsync-baked')) { try { chip.remove(); } catch (_) {} chip = null; }
      for (var i = 0; i < baked.length; i++) baked[i].dataset.s = state.status;
      return;
    }

    var nav = findNav();

    // Preferred home: inside the app's own nav pill. These navs get re-rendered
    // on navigation, so verify our item is still attached rather than assuming.
    if (nav) {
      if (chip && chip.classList.contains('tsync-navdot') && nav.contains(chip)) {
        // still in place
      } else {
        if (chip) { try { chip.remove(); } catch (_) {} }
        chip = buildNavItem(nav);
        nav.appendChild(chip);
      }
    } else {
      // No bottom pill (Zen, the Hub) — fall back to the floating dot.
      if (!chip || !chip.classList.contains('tsync-chip')) {
        if (chip) { try { chip.remove(); } catch (_) {} }
        chip = document.createElement('div');
        chip.className = 'tsync-chip';
        chip.setAttribute('data-tsync', '1');
        chip.innerHTML = '<span class="tsync-dot"></span>';
        chip.setAttribute('role', 'button');
        chip.addEventListener('click', onClickDot);
        document.body.appendChild(chip);
      }
    }
    chip.dataset.s = state.status;
    var q = state.queueCount;
    // The dot carries no text, so the status lives in the tooltip and the
    // accessible name — hover (or a screen reader) still gets the full story.
    var text = (LABEL[state.status] || state.status) + (q ? ' · ' + q + ' pending' : '');
    chip.title = (state.detail ? state.detail + ' — ' : '') + text +
                 (state.status === 'unpaired' || state.status === 'unconfigured'
                    ? ' · click to set up' : ' · click to sync now');
    chip.setAttribute('aria-label', 'Sync: ' + text);
  }

  /* ══════════════════════════════════════════════════════════════════
     10 · PUBLIC API
  ══════════════════════════════════════════════════════════════════ */
  var api = {
    status: function () {
      return {
        status: state.status, detail: state.detail, pending: Object.keys(state.dirty).length,
        userId: state.userId, deviceId: deviceId,
        lastPushAt: state.lastPushAt, lastPullAt: state.lastPullAt
      };
    },
    on: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
    forceSync: async function () { await pullOnce(); await push(); },
    pair: function (code) {
      if (!decodeCode(code)) throw new Error('Invalid pairing code');
      rawSet(CRED_KEY, code);
      markPaired();
      return connect();
    },
    unpair: async function () {
      rawDel(CRED_KEY); rawDel(META_KEY);
      if (state.channel) { try { state.client.removeChannel(state.channel); } catch (_) {} }
      if (state.client) {
        // scope:'local' — the default is 'global', which revokes the refresh
        // token for every session on the account, not just this device (this
        // pairing code is shared across every paired device on purpose).
        // Awaited so a quick re-pair right after can't race the sign-out and
        // get its own brand-new session invalidated along with it — that's
        // what produced "invalid token" right after pairing again.
        try { await state.client.auth.signOut({ scope: 'local' }); } catch (_) {}
      }
      state.client = null; state.userId = null; meta = {};
      setStatus('unpaired', 'Device unpaired');
    },
    /** scope:'others' — every session on the account except this one. Handy
     *  when the same pairing code has ended up on more devices than meant to. */
    signOutOthers: async function () {
      if (!state.client) throw new Error('Not connected.');
      var res = await state.client.auth.signOut({ scope: 'others' });
      if (res && res.error) throw res.error;
      // Returns false when the sessions are revoked but the live signal failed
      try {
        var sig = await state.client.from(TABLE).upsert([{
          user_id: state.userId, k: CTL_LOGOUT, device: deviceId, updated_at: new Date().toISOString(),
          v: JSON.stringify({ from: deviceId, at: Date.now() })
        }], { onConflict: 'user_id,k' });
        if (sig.error) throw sig.error;
        return true;
      } catch (e) { warn('log-out signal failed', e); return false; }
    },
    showPairing: promptPairing,
    /** Build a pairing code from the account you created in Supabase. */
    makeCode: encodeCode,
    /** Which keys are syncing right now — handy for debugging. */
    syncedKeys: function () { return rawKeys().filter(isSyncable).sort(); },
    localOnlyKeys: function () { return rawKeys().filter(function (k) { return !isSyncable(k); }).sort(); },
    config: CFG,
    _internal: state
  };
  window.__TRACKERS_SYNC__ = api;
  window.TrackersSync = api;

  /* ══════════════════════════════════════════════════════════════════
     11 · BOOT
  ══════════════════════════════════════════════════════════════════ */
  listeners.push(function () { renderChip(); });

  function boot() {
    injectStyle();
    renderChip();
    // Both host navs are rebuilt on navigation, which silently discards our
    // item. Cheap re-check keeps it present without fighting the app.
    setInterval(renderChip, 1500);
    connect();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  log('write interception installed');
})();
