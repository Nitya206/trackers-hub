/**
 * push-client.js · TRACKERS HUB — notifications
 * ============================================================================
 * Two jobs:
 *
 *  1. SUBSCRIBE this device for push (permission → subscription → Supabase).
 *
 *  2. PLAN what deserves a notification, and write those rows to Supabase so
 *     the server can deliver them while your phone is locked.
 *
 * Why the planning happens here and not on the server: your apps already
 * implement the attendance maths, the streak rules and the skip calculator.
 * Re-implementing all of that in a Deno function would mean two copies of the
 * same logic drifting apart. So the client — which has the real data in
 * localStorage — decides, and the server just delivers on time.
 *
 * Every notification carries a stable `key`. Re-planning upserts on it, so
 * opening the app fifty times refreshes the plan rather than queuing fifty
 * copies of the same reminder.
 *
 * iOS: push only works when the site is added to the Home Screen. In a Safari
 * tab the permission prompt may appear but nothing will ever be delivered.
 */
(function () {
  'use strict';

  if (window.__TRACKERS_PUSH__) return;

  var CFG        = window.TRACKERS_SYNC_CONFIG || {};
  var VAPID      = CFG.vapidPublicKey || '';
  var PREFS_KEY  = 'push_prefs_v1';     // device-local: permission is per device
  var PLAN_DAYS   = 7;   // dated one-offs (exams) — safe to book well ahead
  // Recurring daily reminders get a SHORT horizon on purpose. The plan is
  // rebuilt every time you open any tracker, so a long horizon just means
  // queuing five identical "3 overdue" messages for days you'll never see
  // them in that form. Short horizon = always current, never nagging.
  var RECUR_DAYS  = 3;

  /* ── preferences (never synced — each device opts in separately) ──────── */
  var DEFAULTS = {
    enabled:        false,
    digest:         true,   // one morning roll-up
    digestHour:     8,
    attendance:     true,   // subjects below goal
    zenStreak:      true,   // evening nudge if today isn't marked
    zenHour:        21,
    exams:          true,   // 7 / 3 / 1 days out
    gate:           true,   // procrastination unlock earned
    timers:         true,   // "x minutes left" while a timer runs
    rituals:        true,   // a reminder as each Rituals window opens
    windows:        true,   // todos & sessions planned for a window, as it opens
    budget:         true,   // evening money check-in, plus 80% / 100% of the month
    budgetHour:     21
  };
  function prefs() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); }
    catch (_) { return Object.assign({}, DEFAULTS); }
  }
  function setPrefs(p) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(Object.assign(prefs(), p))); } catch (_) {}
  }

  function log()  { if (CFG.debug) console.log.apply(console, ['%c[push]', 'color:#f5b800;font-weight:600'].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, ['%c[push]', 'color:#f5b800;font-weight:600'].concat([].slice.call(arguments))); }

  /* ── small helpers ────────────────────────────────────────────────────── */
  function LS(k, fallback) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
    catch (_) { return fallback; }
  }
  function localDate(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function atHour(daysAhead, hour) {
    var d = new Date();
    d.setDate(d.getDate() + daysAhead);
    d.setHours(hour, 0, 0, 0);
    return d;
  }
  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }
  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function urlB64ToUint8Array(b64) {
    var pad = '='.repeat((4 - (b64.length % 4)) % 4);
    var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  /** The sync layer already holds an authenticated Supabase client — reuse it. */
  function sync() { return window.__TRACKERS_SYNC__; }
  function client() {
    var s = sync();
    return (s && s._internal && s._internal.client) || null;
  }
  function userId() {
    var s = sync();
    return (s && s._internal && s._internal.userId) || null;
  }

  /* ══════════════════════════════════════════════════════════════════
     SUBSCRIPTION
  ══════════════════════════════════════════════════════════════════ */
  async function enable() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      throw new Error('This browser cannot receive push notifications.');
    }
    if (!VAPID) throw new Error('vapidPublicKey is missing from sync-config.js');
    if (isIOS() && !isStandalone()) {
      throw new Error('On iPhone you must first add this site to your Home Screen — Safari tabs never receive notifications.');
    }
    if (!client() || !userId()) {
      throw new Error('Pair this device for sync first — notifications are delivered to your synced account.');
    }

    var perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notification permission was ' + perm + '.');

    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(VAPID)
      });
    }
    await saveSubscription(sub);
    setPrefs({ enabled: true });
    log('enabled');
    await plan();                       // schedule immediately, don't wait for a reload
    return true;
  }

  async function saveSubscription(sub) {
    var j = sub.toJSON();
    var r = await client().from('push_subscriptions').upsert({
      user_id:    userId(),
      endpoint:   j.endpoint,
      p256dh:     j.keys.p256dh,
      auth:       j.keys.auth,
      device:     localStorage.getItem('__sync_device_v1') || null,
      user_agent: navigator.userAgent.slice(0, 300)
    }, { onConflict: 'user_id,endpoint' });
    if (r.error) {
      // By far the most common first-run failure: the schema was never run.
      // A raw "relation does not exist" tells you nothing actionable.
      if (/does not exist|schema cache|relation/i.test(r.error.message || '')) {
        throw new Error('The push tables are missing. Run supabase-push-schema.sql in the Supabase SQL editor (setup step 1), then try again.');
      }
      throw r.error;
    }
  }

  async function disable() {
    setPrefs({ enabled: false });
    try {
      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (sub) {
        if (client() && userId()) {
          await client().from('push_subscriptions')
            .delete().eq('user_id', userId()).eq('endpoint', sub.endpoint);
        }
        await sub.unsubscribe();
      }
      // Drop anything still queued for this account.
      if (client() && userId()) {
        await client().from('scheduled_pushes').delete().eq('user_id', userId()).is('sent_at', null);
      }
    } catch (e) { warn('disable failed', e); }
    log('disabled');
  }

  /** Fires a notification immediately, to prove the pipeline works. */
  async function test() {
    var c = client();
    if (!c) throw new Error('Not connected to Supabase.');
    var sess = await c.auth.getSession();
    var token = sess.data.session && sess.data.session.access_token;
    if (!token) throw new Error('No auth session.');
    var res = await fetch((CFG.supabaseUrl || '').replace(/\/+$/, '') + '/functions/v1/push-dispatch', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: true })
    });
    var out = await res.json().catch(function () { return {}; });
    if (res.status === 404) {
      throw new Error('The push-dispatch function is not deployed yet. Run: npx supabase functions deploy push-dispatch (setup step 3).');
    }
    if (res.status === 500 && /VAPID/i.test(out.error || '')) {
      throw new Error('The function is deployed but its VAPID secrets are missing (setup step 2).');
    }
    if (!res.ok) throw new Error((out.error || ('Function returned ' + res.status)) + (out.detail ? ' — ' + out.detail : ''));
    if (!out.sent) throw new Error('No devices are subscribed on this account yet — turn the toggle above on first.');
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════
     THE PLANNER
     Reads the same localStorage the apps use, and works out what is
     worth interrupting you for over the next few days.
  ══════════════════════════════════════════════════════════════════ */

  /** Everything due today, rolled into one message rather than five. */
  function planDigest(rows, p) {
    if (!p.digest) return;

    for (var day = 0; day < RECUR_DAYS; day++) {
      var when = atHour(day, p.digestHour);
      if (when <= new Date()) continue;              // today's slot already passed
      var dayKey = localDate(when);
      var bits = [];

      // todos due that day
      var todos = (LS('todosState_v4', {}) || {}).todos || [];
      var due = todos.filter(function (t) { return t && !t.ritual && !t.completed && t.dueDate === dayKey; });
      var overdue = todos.filter(function (t) {
        return t && !t.ritual && !t.completed && !t.notDone && t.dueDate && t.dueDate < dayKey;   // ✕ = decided, not overdue
      });
      if (due.length)     bits.push(due.length + ' todo' + (due.length === 1 ? '' : 's') + ' due');
      if (overdue.length) bits.push(overdue.length + ' overdue');

      // nearest exam
      if (p.exams) {
        var exams = LS('exams_v1', []) || [];
        var soonest = null;
        exams.forEach(function (e) {
          if (!e || !e.date) return;
          var days = Math.ceil((new Date(e.date + 'T00:00:00') - when) / 86400000);
          if (days >= 0 && (soonest === null || days < soonest.days)) soonest = { days: days, e: e };
        });
        if (soonest && soonest.days <= 14) {
          bits.push((soonest.e.subject || 'Exam') + ' ' + (soonest.e.name || '') +
                    (soonest.days === 0 ? ' today' : soonest.days === 1 ? ' tomorrow' : ' in ' + soonest.days + 'd'));
        }
      }

      // SRS cards ready for review
      var srs = LS('studypro_v7_srs', {}) || {};
      var dueCards = 0;
      Object.keys(srs).forEach(function (subj) {
        var deck = srs[subj] || {};
        Object.keys(deck).forEach(function (id) {
          var c = deck[id];
          if (c && c.due && new Date(c.due) <= when) dueCards++;
        });
      });
      if (dueCards) bits.push(dueCards + ' cards to review');

      // what you told the procrastination hub you'd do
      var sched = LS('phub_schedule', {}) || {};
      var todaysPlan = sched[dayKey] || [];
      if (todaysPlan.length) bits.push(todaysPlan.length + ' scheduled');

      if (!bits.length) continue;                    // nothing to say — stay quiet
      // Beyond tomorrow, "N overdue" on its own is just nagging about
      // something already reported. Only interrupt if there's something new.
      var onlyOverdue = bits.length === 1 && /overdue/.test(bits[0]);
      if (onlyOverdue && day > 1) continue;

      rows.push({
        key: 'digest:' + dayKey,
        send_at: when.toISOString(),
        title: day === 0 ? 'Today'
             : day === 1 ? 'Tomorrow'
             : when.toLocaleDateString(undefined, { weekday: 'long' }),
        body: bits.join(' · '),
        url: './Study-Schedule-Pro.html',
        tag: 'digest'
      });
    }
  }

  /**
   * Attendance is the one thing here you cannot fix retroactively — a missed
   * class is gone. So subjects below their goal get their own notification
   * rather than being buried in the digest.
   */
  function planAttendance(rows, p) {
    if (!p.attendance) return;
    var att = LS('attendanceState_v1', {}) || {};
    var subjects = (att.subjects || []).filter(function (s) { return s && !s.archived; });
    var risky = [];

    subjects.forEach(function (s) {
      var present = parseInt(s.currentPresent != null ? s.currentPresent : s.present || 0) || 0;
      var held    = parseInt(s.currentTotal   != null ? s.currentTotal   : s.total   || 0) || 0;
      if (held < 3) return;                                 // too early to judge
      var duty = (s.history || []).filter(function (h) { return h && h.type === 'duty'; }).length;
      var pct  = ((present + duty) / held) * 100;
      var goal = parseFloat(s.goal) || 75;
      if (pct < goal) risky.push({ name: s.name, pct: pct, goal: goal });
    });

    if (!risky.length) return;
    risky.sort(function (a, b) { return a.pct - b.pct; });

    var worst = risky[0];
    var body = worst.name + ' at ' + worst.pct.toFixed(1) + '% (goal ' + worst.goal + '%)';
    if (risky.length > 1) body += ' · ' + (risky.length - 1) + ' more below target';

    // Morning, an hour after the digest, so the two don't arrive together.
    var when = atHour(0, Math.min(23, p.digestHour + 1));
    if (when <= new Date()) when = atHour(1, Math.min(23, p.digestHour + 1));

    rows.push({
      key: 'attendance:' + localDate(when),
      send_at: when.toISOString(),
      title: 'Attendance below target',
      body: body,
      url: './Study-Schedule-Pro.html',
      tag: 'attendance'
    });
  }

  /** A streak tracker lives or dies on the evening nudge. */
  function planZen(rows, p) {
    if (!p.zenStreak) return;
    var zen = LS('zen_garden_data', { days: {} }) || { days: {} };

    for (var day = 0; day < RECUR_DAYS; day++) {
      var when = atHour(day, p.zenHour);
      if (when <= new Date()) continue;
      var key = localDate(when);
      // Already marked (or deliberately skipped) — say nothing.
      if ((zen.days || {})[key] || (zen.skipped || {})[key]) continue;

      // count the streak this would protect
      var streak = 0, cur = new Date(when);
      cur.setDate(cur.getDate() - 1);
      while ((zen.days || {})[localDate(cur)]) { streak++; cur.setDate(cur.getDate() - 1); }

      rows.push({
        key: 'zen:' + key,
        send_at: when.toISOString(),
        title: 'Garden not tended today',
        // Only today's streak length is knowable. For later days the count
        // depends on what you do between now and then, so don't invent one.
        body: day > 0
          ? 'Keep your streak going before midnight.'
          : streak > 0
            ? 'Your ' + streak + '-day streak ends at midnight.'
            : 'Mark today to start a streak.',
        url: './zen-garden-tracker.html',
        tag: 'zen'
      });
    }
  }

  /** Budget: an evening check-in to log the day's spending, and a heads-up at
   *  80% and 100% of the month's money (once each per month). */
  function planBudget(rows, p) {
    if (!p.budget) return;
    var b = LS('budget_v1', null);
    if (!b || !b.months) return;
    var today = localDate(), ym = today.slice(0, 7);
    var spentToday = (b.expenses || []).filter(function (e) { return e.date === today; })
      .reduce(function (s, e) { return s + (+e.amt || 0); }, 0);
    var rs = function (n) { return '₹' + Math.round(n).toLocaleString('en-IN'); };

    for (var day = 0; day < RECUR_DAYS; day++) {
      var when = atHour(day, p.budgetHour);
      if (when <= new Date()) continue;
      rows.push({
        key: 'budget:checkin:' + localDate(when),
        send_at: when.toISOString(),
        title: 'Money check-in',
        body: day > 0 ? 'Log what you spent today before bed.'
          : spentToday ? rs(spentToday) + ' logged today. Anything else?'
          : 'Nothing logged today. Did you spend anything?',
        url: './Shopping-List.html#log',
        tag: 'budget'
      });
    }

    var m = b.months[ym];
    if (!m || !m.income) return;
    var pct = m.savePct != null ? m.savePct : (b.savePct || 0);
    var extra = (b.incomes || []).filter(function (x) { return !x.toSavings && (x.date || '').slice(0, 7) === ym; })
      .reduce(function (s, x) { return s + x.amt; }, 0);
    var spendable = m.income - Math.round(m.income * pct / 100) + (m.topUp || 0) + extra;
    var used = (b.expenses || []).filter(function (e) { return (e.date || '').slice(0, 7) === ym; })
      .reduce(function (s, e) { return s + (+e.amt || 0); }, 0)
      + (b.owed || []).filter(function (o) { return !o.paid; }).reduce(function (s, o) { return s + o.amt; }, 0);
    if (spendable <= 0) return;
    // Skipped once the Budget app has already shown the same alert this month
    var seen = (b.alerted || {})[ym] || {};
    var soon = new Date(Date.now() + 60000).toISOString();
    if (used >= spendable && !seen.m100) {
      rows.push({ key: 'budget:100:' + ym, send_at: soon, title: 'Month budget used up',
                  body: "You've spent all of this month's money.", url: './Shopping-List.html', tag: 'budget-alert' });
    } else if (used >= spendable * 0.8 && used < spendable && !seen.m80) {
      rows.push({ key: 'budget:80:' + ym, send_at: soon, title: '80% of the month spent',
                  body: rs(spendable - used) + ' left for the rest of the month.', url: './Shopping-List.html', tag: 'budget-alert' });
    }
  }

  /** Exams get their own countdown at 7 / 3 / 1 days out. */
  function planExams(rows, p) {
    if (!p.exams) return;
    var exams = LS('exams_v1', []) || [];
    exams.forEach(function (e) {
      if (!e || !e.date || e.rating || e.archived) return;     // already sat and rated — nothing to remind about
      [7, 3, 1].forEach(function (lead) {
        var examAt = new Date(e.date + 'T00:00:00');
        var when = new Date(examAt);
        when.setDate(when.getDate() - lead);
        when.setHours(Math.min(23, p.digestHour + 1), 30, 0, 0);
        if (when <= new Date()) return;
        if ((when - new Date()) > PLAN_DAYS * 86400000) return;
        rows.push({
          key: 'exam:' + (e.id || e.name) + ':' + lead,
          send_at: when.toISOString(),
          title: (e.subject || 'Exam') + ' · ' + (e.name || 'exam') + ' in ' + lead + ' day' + (lead === 1 ? '' : 's'),
          body: lead === 1 ? 'Last chance to revise.' : 'Time to start revising.',
          url: './Study-Schedule-Pro.html',
          tag: 'exam'
        });
      });
    });
  }

  /**
   * A reward, not a nag. The procrastination hub unlocks budget once you've
   * studied enough; telling you the moment it happens is the whole point.
   */
  function planGate(rows, p) {
    if (!p.gate) return;
    var CYCLE = 3.5 * 3600;                       // must match STUDY_SECS_CYCLE in Procrastination-Hub.html
    var data  = LS('todosState_v4', {}) || {};
    var ts    = data.todayStats || {};
    if (ts.date && ts.date !== new Date().toDateString()) return;
    var studied = parseFloat(ts.studied) || 0;
    var into    = studied % CYCLE;
    var left    = CYCLE - into;
    if (left <= 0 || left > 3600) return;         // only when it's genuinely close
    var when = new Date(Date.now() + left * 1000);
    rows.push({
      key: 'gate:' + localDate() + ':' + Math.floor(studied / CYCLE),
      send_at: when.toISOString(),
      title: 'Break unlocked',
      body: 'You hit another 3h 30m of study — 1 more hour of budget is available.',
      url: './Procrastination-Hub.html',
      tag: 'gate'
    });
  }

  /**
   * Timers are the odd one out. iOS freezes a backgrounded web app, so an
   * in-page countdown can never fire once you leave — the push has to be
   * booked with the server the moment the timer starts.
   */
  /**
   * Rituals: one reminder at each time you gave a ritual ("Face cream · 22:00").
   * Rituals due at the same minute share one notification. A slot you've
   * already ticked or skipped is dropped — ticking re-plans via the sync
   * events below, so a done ritual never pings you. Rules mirror
   * rituals-tracker.html: due on chosen weekdays, or every N days from start.
   */
  function planRituals(rows, p) {
    if (!p.rituals) return;
    var R = LS('rituals_v1', null);
    if (!R || !Array.isArray(R.routines) || !R.routines.length) return;
    var log = R.log || {};
    function parseD(s) { var q = s.split('-'); return new Date(+q[0], +q[1] - 1, +q[2], 12); }
    function due(r, d) {
      if (r.paused || (r.created && d < r.created)) return false;
      var sc = r.schedule || {};
      if (sc.type === 'every') {
        var n = Math.round((parseD(d) - parseD(sc.start || r.created || d)) / 86400000);
        return n >= 0 && n % Math.max(1, sc.every || 1) === 0;
      }
      return (sc.days || []).indexOf(parseD(d).getDay()) !== -1;
    }
    // Rituals are scheduled in day windows ("early morning"), and remind as the
    // window opens. Ranges live in R.parts; these match the tracker's defaults.
    // A bare 'HH:MM' is older data the tracker hasn't upgraded yet.
    var PARTS = { dawn: ['Early morning', 360, 480], morning: ['Morning', 480, 720], afternoon: ['Afternoon', 720, 1020],
                  evening: ['Evening', 1020, 1260], night: ['Night', 1260, 1440] };
    function win(t) {
      if (/^\d{1,2}:\d{2}$/.test(t)) { var q = t.split(':'); return { id: t, name: t, from: +q[0] * 60 + +q[1] }; }
      var d = PARTS[t]; if (!d) return null;
      var o = (R.parts || {})[t] || {};
      return { id: t, name: d[0], from: o.from != null ? o.from : d[1], to: o.to != null ? o.to : d[2] };
    }
    function hm(m) { var h = Math.floor(m / 60) % 12 || 12, mm = m % 60; return h + (mm ? ':' + String(mm).padStart(2, '0') : '') + (m % 1440 < 720 ? ' am' : ' pm'); }
    var now = new Date();
    for (var day = 0; day < RECUR_DAYS; day++) {
      var base = new Date(); base.setDate(base.getDate() + day);
      var dk = localDate(base), byWin = {};
      R.routines.forEach(function (r) {
        if (!due(r, dk)) return;
        (r.times || []).forEach(function (t, i) {
          var e = (log[dk] || {})[r.id + '|' + i];
          if (e && (e.s === 'done' || e.s === 'skip' || e.s === 'miss')) return;   // answered: ✓, skip or ✕
          var w = win(t); if (!w) return;
          (byWin[w.id] = byWin[w.id] || { w: w, list: [] }).list.push(r);
        });
      });
      Object.keys(byWin).forEach(function (id) {
        var w = byWin[id].w, list = byWin[id].list;
        var when = new Date(base); when.setHours(Math.floor(w.from / 60), w.from % 60, 0, 0);
        if (when <= now) return;
        var names = list.map(function (r) { return (r.emoji ? r.emoji + ' ' : '') + r.name; }).join(' · ');
        rows.push({
          key: 'ritual:' + dk + 'T' + id,
          send_at: when.toISOString(),
          title: w.to != null ? w.name + ' rituals' : names,
          body: w.to != null ? names + ' — before ' + hm(w.to) : (list.length > 1 ? list.length + ' rituals due at ' + id : 'Your ' + id + ' ritual'),
          url: './rituals-tracker.html',
          tag: 'ritual-' + id
        });
      });
    }
  }

  /**
   * Study todos and Procrastination sessions planned for a window ("Evening")
   * get one reminder as that window opens, listing what's in it. Ranges come
   * from Rituals (rituals_v1.parts) — the same ones day-parts.js shows.
   */
  var WIN_DEF = { dawn: ['Early morning', '🌅', 360, 480], morning: ['Morning', '☀️', 480, 720],
                  afternoon: ['Afternoon', '🌤️', 720, 1020], evening: ['Evening', '🌆', 1020, 1260],
                  night: ['Night', '🌙', 1260, 1440] };
  function planWindows(rows, p) {
    if (!p.windows) return;
    var parts = (LS('rituals_v1', {}) || {}).parts || {};
    function win(id) {
      var d = WIN_DEF[id]; if (!d) return null;
      var o = parts[id] || {};
      var from = o.from != null ? o.from : d[2], to = o.to != null ? o.to : d[3];
      if (to <= from) to += 1440;
      return { id: id, name: d[0], icon: d[1], from: from, to: to };
    }
    function hm(m) { m = m % 1440; var h = Math.floor(m / 60) % 12 || 12, mm = m % 60; return h + (mm ? ':' + String(mm).padStart(2, '0') : '') + (m < 720 ? ' am' : ' pm'); }
    var todos = (LS('todosState_v4', {}) || {}).todos || [];
    var sched = LS('phub_schedule', {}) || {};
    var now = new Date();

    for (var day = 0; day < RECUR_DAYS; day++) {
      var base = new Date(); base.setDate(base.getDate() + day);
      var dk = localDate(base), byWin = {};
      function put(id, text, app) {
        var w = win(id); if (!w) return;
        var g = byWin[id] || (byWin[id] = { w: w, items: [], apps: {} });
        g.items.push(text); g.apps[app] = true;
      }
      todos.forEach(function (t) { if (t && !t.ritual && !t.completed && !t.archived && t.dueDate === dk && t.dueWindow && !(t.notDone && t.notDoneDate === dk)) put(t.dueWindow, '📚 ' + t.task, 'study'); });   // ✕ that day = no reminder
      (sched[dk] || []).forEach(function (e) { if (e && e.win) put(e.win, '🎬 ' + e.title + (e.eps ? ' ' + e.eps : ''), 'proc'); });

      // A todo with an exact time gets its own reminder when that time comes
      todos.forEach(function (t) {
        if (!t || t.completed || t.archived || t.dueDate !== dk || !/^\d{1,2}:\d{2}$/.test(t.dueTime || '')) return;
        if (t.notDone && t.notDoneDate === dk) return;                 // ✕ that day = no reminder
        var q = t.dueTime.split(':'), at = new Date(base);
        at.setHours(+q[0], +q[1], 0, 0);
        if (at <= now) return;
        var h12 = (+q[0] % 12) || 12, ap = +q[0] < 12 ? 'am' : 'pm';
        rows.push({
          key: 'todo-time:' + t.id + ':' + dk,
          send_at: at.toISOString(),
          title: '⏰ ' + (t.task || 'Task') + ' — due now',
          body: (t.subject && t.subject !== 'Other' ? t.subject + ' · ' : '') + 'Due at ' + h12 + ':' + q[1] + ' ' + ap,
          url: './Study-Schedule-Pro.html',
          tag: 'todo-time-' + t.id
        });
      });

      Object.keys(byWin).forEach(function (id) {
        var g = byWin[id], w = g.w;
        var when = new Date(base); when.setHours(Math.floor(w.from / 60), w.from % 60, 0, 0);
        if (when <= now) return;
        var only = Object.keys(g.apps);
        rows.push({
          key: 'window:' + dk + 'T' + id,
          send_at: when.toISOString(),
          title: w.icon + ' ' + w.name + ' plan',
          body: g.items.slice(0, 4).join(' · ') + (g.items.length > 4 ? ' +' + (g.items.length - 4) + ' more' : '') + ' — before ' + hm(w.to),
          url: only.length === 1 ? (only[0] === 'study' ? './Study-Schedule-Pro.html' : './Procrastination-Hub.html') : './index.html',
          tag: 'window-' + id
        });
      });
    }
  }

  function planTimer(rows, p) {
    if (!p.timers) return;
    var t = LS('activeTimer', null);
    if (!t || t.isPaused || !t.startTimestamp) return;
    var targetMins = parseFloat(t.targetMinutes || t.durationMinutes || 0);
    if (!targetMins) return;

    var endsAt  = t.startTimestamp + targetMins * 60000;
    var warnAt  = endsAt - 5 * 60000;
    var now     = Date.now();

    if (warnAt > now) {
      rows.push({
        key: 'timer:warn', send_at: new Date(warnAt).toISOString(),
        title: '5 minutes left', body: 'Your study timer is almost done.',
        url: './Study-Schedule-Pro.html', tag: 'timer'
      });
    }
    if (endsAt > now) {
      rows.push({
        key: 'timer:end', send_at: new Date(endsAt).toISOString(),
        title: 'Timer finished', body: targetMins + ' minutes done.',
        url: './Study-Schedule-Pro.html', tag: 'timer'
      });
    }
  }

  /* ── build the plan and hand it to the server ─────────────────────────── */
  var planning = false;
  async function plan() {
    var p = prefs();
    if (!p.enabled) return;
    var c = client(), uid = userId();
    if (!c || !uid) return;
    if (planning) return;
    planning = true;

    try {
      var rows = [];
      planDigest(rows, p);
      planAttendance(rows, p);
      planZen(rows, p);
      planExams(rows, p);
      planGate(rows, p);
      planTimer(rows, p);
      planRituals(rows, p);
      planWindows(rows, p);
      planBudget(rows, p);

      // Clear anything still pending that this plan no longer wants — a todo
      // you finished shouldn't still produce a reminder tonight.
      var keep = rows.map(function (r) { return r.key; });
      var del = c.from('scheduled_pushes').delete().eq('user_id', uid).is('sent_at', null);
      if (keep.length) del = del.not('key', 'in', '(' + keep.map(function (k) { return '"' + k + '"'; }).join(',') + ')');
      await del;

      if (rows.length) {
        var payload = rows.map(function (r) { return Object.assign({ user_id: uid }, r); });
        var res = await c.from('scheduled_pushes').upsert(payload, { onConflict: 'user_id,key' });
        if (res.error) throw res.error;
      }
      log('planned', rows.length, 'notification(s)');
      return rows;
    } catch (e) {
      if (/does not exist|schema cache|relation/i.test((e && e.message) || '')) {
        warn('planning skipped — push tables not created yet (run supabase-push-schema.sql)');
      } else {
        warn('planning failed', e);
      }
    } finally {
      planning = false;
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     WIRING
  ══════════════════════════════════════════════════════════════════ */
  // Re-plan when synced data changes, so a todo ticked off on the laptop stops
  // the phone reminding you about it. Debounced — data can change in bursts.
  var replanTimer = null;
  function schedulePlan() {
    if (replanTimer) clearTimeout(replanTimer);
    replanTimer = setTimeout(function () { replanTimer = null; plan(); }, 4000);
  }
  window.addEventListener('trackers-sync', function (e) {
    var t = e.detail && e.detail.type;
    if (t === 'push' || t === 'remote' || t === 'pull') schedulePlan();
  });

  navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'resubscribe') enable().catch(function () {});
  });

  // First plan once sync is actually connected — through the same debounce as
  // the sync events, so startup's first pull and this coalesce into ONE plan
  // (it used to run twice), a few seconds in, after the page has settled.
  var waited = 0;
  var boot = setInterval(function () {
    waited += 1000;
    if (userId() && prefs().enabled) { clearInterval(boot); schedulePlan(); }
    else if (waited > 30000) clearInterval(boot);
  }, 1000);

  /**
   * Probes each part of the setup so the sheet can show a checklist instead of
   * making you infer the problem from whichever error surfaced first.
   */
  async function diagnose() {
    var out = {
      tables: 'unknown', functionDeployed: 'unknown',
      subscribed: false, permission: api.permission(),
      standalone: isStandalone(), synced: !!userId(), vapid: !!VAPID
    };

    var reg = navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null;
    out.serviceWorker = !!reg;
    var sub = reg ? await reg.pushManager.getSubscription() : null;
    out.subscribed = !!sub;

    var c = client();
    if (c && userId()) {
      var r = await c.from('push_subscriptions').select('endpoint').limit(1);
      out.tables = r.error
        ? (/does not exist|schema cache|relation/i.test(r.error.message || '') ? 'missing' : 'error')
        : 'ok';
      if (out.tables === 'ok') {
        var mine = await c.from('push_subscriptions').select('endpoint')
                          .eq('user_id', userId());
        out.devicesRegistered = (mine.data || []).length;
      }
    }

    try {
      var sess = c ? await c.auth.getSession() : null;
      var tok = sess && sess.data.session && sess.data.session.access_token;
      if (tok) {
        var res = await fetch((CFG.supabaseUrl || '').replace(/\/+$/, '') + '/functions/v1/push-dispatch', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
          body: '{}'                       // empty body = dispatch, sends nothing if nothing is due
        });
        out.functionDeployed = res.status === 404 ? 'missing' : (res.ok ? 'ok' : 'error ' + res.status);
      }
    } catch (e) { out.functionDeployed = 'unreachable'; }

    return out;
  }

  var api = {
    enable: enable, disable: disable, test: test, plan: plan, diagnose: diagnose,
    prefs: prefs, setPrefs: function (p) { setPrefs(p); schedulePlan(); },
    isStandalone: isStandalone, isIOS: isIOS,
    permission: function () { return (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported'; },
    status: async function () {
      var reg = navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null;
      var sub = reg ? await reg.pushManager.getSubscription() : null;
      return {
        enabled: prefs().enabled,
        permission: api.permission(),
        subscribed: !!sub,
        standalone: isStandalone(),
        ios: isIOS(),
        syncedAccount: !!userId(),
        vapidConfigured: !!VAPID
      };
    }
  };
  window.__TRACKERS_PUSH__ = api;
  window.TrackersPush = api;

  /* ══════════════════════════════════════════════════════════════════
     UI · a bell beside the sync dot, and a settings sheet
     Permission must be requested from a real user gesture, so there has
     to be something to tap — this is it.
  ══════════════════════════════════════════════════════════════════ */
  var CSS = '\
.tpush-bell{position:fixed;left:8px;z-index:2147483000;width:9px;height:9px;padding:6px;\
border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;\
background:rgba(6,8,15,.72);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);\
box-shadow:0 0 0 1px rgba(255,255,255,.07),0 2px 10px rgba(0,0,0,.45);\
bottom:calc(112px + env(safe-area-inset-bottom,0px));font-size:10px;line-height:1;\
-webkit-tap-highlight-color:transparent;user-select:none;opacity:.75;transition:opacity .2s}\
.tpush-bell:hover{opacity:1}\
.tpush-navbell{display:flex;align-items:center;justify-content:center}\
.tpush-hubbell{display:inline-flex;align-items:center;justify-content:center;\
margin-left:4px;cursor:pointer;font-size:11px;opacity:.55;padding:3px;order:2;\
transition:opacity .2s,transform .2s}\
.tpush-hubbell:hover{opacity:1;transform:scale(1.15)}\
@media(min-width:769px){.tpush-bell{bottom:46px;left:14px}}\
.tpush-sheet{position:fixed;inset:0;z-index:2147483646;background:rgba(6,8,15,.86);\
-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);display:flex;align-items:center;\
justify-content:center;padding:20px;font-family:"Space Grotesk","DM Sans",system-ui,sans-serif}\
.tpush-card{width:100%;max-width:420px;background:#12141c;border:1px solid rgba(255,255,255,.1);\
border-radius:18px;padding:22px;color:#e8eef8;max-height:86vh;overflow-y:auto}\
.tpush-h{font-size:16px;font-weight:600;margin:0 0 4px}\
.tpush-sub{font-size:12px;color:rgba(232,238,248,.55);line-height:1.6;margin-bottom:16px}\
.tpush-row{display:flex;align-items:center;justify-content:space-between;gap:12px;\
padding:10px 0;border-top:1px solid rgba(255,255,255,.06);font-size:13px}\
.tpush-row small{display:block;color:rgba(232,238,248,.4);font-size:11px;margin-top:2px}\
.tpush-sw{width:38px;height:22px;border-radius:100px;background:rgba(255,255,255,.12);\
position:relative;flex-shrink:0;cursor:pointer;transition:background .2s;border:none}\
.tpush-sw::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;\
border-radius:50%;background:#fff;transition:transform .2s}\
.tpush-sw[data-on="1"]{background:#4ade80}\
.tpush-sw[data-on="1"]::after{transform:translateX(16px)}\
.tpush-btn{width:100%;padding:11px;border-radius:10px;border:1px solid rgba(255,255,255,.13);\
background:rgba(255,255,255,.05);color:#e8eef8;font-size:13px;font-weight:500;cursor:pointer;\
font-family:inherit;margin-top:8px}\
.tpush-btn.primary{background:#4f8ef7;border-color:#4f8ef7;color:#fff}\
.tpush-msg{font-size:12px;line-height:1.6;margin-top:12px;padding:10px;border-radius:9px;display:none}\
.tpush-msg.show{display:block}\
.tpush-msg.ok{background:rgba(74,222,128,.1);color:#4ade80}\
.tpush-msg.bad{background:rgba(255,107,138,.1);color:#ff6b8a}\
.tpush-num{width:52px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);\
border-radius:7px;color:#fff;padding:5px 7px;font-size:12px;font-family:inherit;text-align:center}';

  function style() {
    if (document.getElementById('tpush-style')) return;
    var el = document.createElement('style');
    el.id = 'tpush-style'; el.textContent = CSS;
    (document.head || document.documentElement).appendChild(el);
  }

  var TOGGLES = [
    ['digest',     'Morning digest',      'Todos due, nearest exam, cards to review — one message'],
    ['attendance', 'Attendance warnings', 'When a subject drops below its goal'],
    ['exams',      'Exam countdown',      '7, 3 and 1 day before'],
    ['zenStreak',  'Zen streak',          'Evening nudge if the day is unmarked'],
    ['gate',       'Break unlocked',      'When you earn procrastination budget'],
    ['timers',     'Timer alerts',        '5 minutes before a timer ends, and when it does'],
    ['rituals',    'Ritual reminders',    'As each Rituals window opens — skipped once ticked'],
    ['windows',    'Planned times',       'Todos and sessions you put in a window (as it opens) or at an exact time (when it is due)'],
    ['budget',     'Money check-in',      'An evening nudge to log spending, and alerts at 80% and 100% of the month']
  ];

  async function sheet() {
    style();
    var st = await api.status();
    var p  = prefs();
    var el = document.createElement('div');
    el.className = 'tpush-sheet';

    var blocked = '';
    if (st.ios && !st.standalone) {
      blocked = 'On iPhone, notifications only work once this site is on your Home Screen. Tap Share → <b>Add to Home Screen</b>, open it from there, then come back.';
    } else if (!st.vapidConfigured) {
      blocked = 'vapidPublicKey is missing from sync-config.js.';
    } else if (!st.syncedAccount) {
      blocked = 'Pair this device for sync first — notifications go to your synced account.';
    } else if (st.permission === 'denied') {
      blocked = 'Notifications are blocked for this site in your browser settings. You will need to allow them there first.';
    }

    el.innerHTML =
      '<div class="tpush-card">' +
        '<p class="tpush-h">Notifications</p>' +
        '<p class="tpush-sub">' +
          (blocked ? blocked
                   : 'Delivered even when the app is closed. Choose what is worth interrupting you for.') +
        '</p>' +
        (blocked ? '' :
          '<div class="tpush-row"><div><b>Enabled on this device</b>' +
          '<small>Each device is turned on separately</small></div>' +
          '<button class="tpush-sw" data-k="enabled" data-on="' + (p.enabled ? 1 : 0) + '"></button></div>' +
          TOGGLES.map(function (t) {
            return '<div class="tpush-row"><div>' + t[1] + '<small>' + t[2] + '</small></div>' +
                   '<button class="tpush-sw" data-k="' + t[0] + '" data-on="' + (p[t[0]] ? 1 : 0) + '"></button></div>';
          }).join('') +
          '<div class="tpush-row"><div>Times<small>Digest hour · zen hour · money check-in hour</small></div><div>' +
          '<input class="tpush-num" id="tpush-dh" type="number" min="0" max="23" value="' + p.digestHour + '"> ' +
          '<input class="tpush-num" id="tpush-zh" type="number" min="0" max="23" value="' + p.zenHour + '"> ' +
          '<input class="tpush-num" id="tpush-bh" type="number" min="0" max="23" value="' + p.budgetHour + '"></div></div>' +
          '<button class="tpush-btn primary" id="tpush-test">Send a test notification</button>' +
          '<button class="tpush-btn" id="tpush-check">Check setup</button>') +
        '<button class="tpush-btn" id="tpush-close">Close</button>' +
        '<div class="tpush-msg" id="tpush-msg"></div>' +
      '</div>';

    document.body.appendChild(el);
    var msg = el.querySelector('#tpush-msg');
    function say(kind, text) { msg.className = 'tpush-msg show ' + kind; msg.innerHTML = text; }

    el.addEventListener('click', function (e) { if (e.target === el) el.remove(); });
    el.querySelector('#tpush-close').onclick = function () { el.remove(); };

    el.querySelectorAll('.tpush-sw').forEach(function (sw) {
      sw.onclick = async function () {
        var k = sw.dataset.k, on = sw.dataset.on !== '1';
        if (k === 'enabled') {
          try {
            if (on) { say('ok', 'Asking for permission…'); await enable(); say('ok', 'Notifications are on.'); }
            else    { await disable(); say('ok', 'Notifications are off.'); }
          } catch (err) { say('bad', err.message); return; }
        } else {
          api.setPrefs(JSON.parse('{"' + k + '":' + on + '}'));
        }
        sw.dataset.on = on ? '1' : '0';
      };
    });

    var dh = el.querySelector('#tpush-dh'), zh = el.querySelector('#tpush-zh');
    if (dh) dh.onchange = function () { api.setPrefs({ digestHour: Math.max(0, Math.min(23, +dh.value || 8)) }); };
    if (zh) zh.onchange = function () { api.setPrefs({ zenHour:    Math.max(0, Math.min(23, +zh.value || 21)) }); };
    var bh = el.querySelector('#tpush-bh');
    if (bh) bh.onchange = function () { api.setPrefs({ budgetHour: Math.max(0, Math.min(23, +bh.value || 21)) }); };

    var cb = el.querySelector('#tpush-check');
    if (cb) cb.onclick = async function () {
      cb.disabled = true; say('ok', 'Checking…');
      try {
        var d = await diagnose();
        var mark = function (ok) { return ok ? '✅' : '❌'; };
        // Both of these can only be checked once signed in (diagnose() needs an
        // authenticated client to reach them) — showing them as failures on top
        // of "Signed in to sync" made a single logged-out device look like it
        // had three separate broken things, when there's really just one.
        var needsSync = function (label) { return '⏳ ' + label + ' — checked once you\'re signed in to sync'; };
        var lines = [
          mark(d.vapid)                     + ' VAPID key in sync-config.js',
          mark(d.synced)                    + ' Signed in to sync',
          mark(d.standalone)                + ' Opened from Home Screen',
          mark(d.permission === 'granted')  + ' Notification permission (' + d.permission + ')',
          mark(d.serviceWorker)             + ' Service worker',
          !d.synced ? needsSync('Database tables')
            : mark(d.tables === 'ok')           + ' Database tables' + (d.tables === 'missing' ? ' — run supabase-push-schema.sql (step 1)' : ''),
          !d.synced ? needsSync('push-dispatch function')
            : mark(d.functionDeployed === 'ok') + ' push-dispatch function' + (d.functionDeployed === 'missing' ? ' — deploy it (step 3)' : ''),
          mark(d.subscribed)                + ' This device subscribed' +
            (d.devicesRegistered != null ? ' (' + d.devicesRegistered + ' on account)' : '')
        ];
        var bad = lines.filter(function (l) { return l.indexOf('❌') === 0; });
        say(bad.length ? 'bad' : 'ok', lines.join('<br>'));
      } catch (err) { say('bad', err.message); }
      cb.disabled = false;
    };

    var tb = el.querySelector('#tpush-test');
    if (tb) tb.onclick = async function () {
      tb.disabled = true; say('ok', 'Sending…');
      try { var r = await test(); say('ok', 'Sent to ' + r.sent + ' device' + (r.sent === 1 ? '' : 's') + '. It should appear in a second.'); }
      catch (err) { say('bad', err.message); }
      tb.disabled = false;
    };
  }

  /** Same hosts the sync dot uses: nav pill on Study/Proc, footer on the Hub. */
  function findNav() {
    return document.getElementById('v8Nav')
        || document.getElementById('bottom-nav')
        || document.querySelector('.hub-footer')
        || null;
  }

  var bell = null;
  function mountBell() {
    if (CFG.hideIndicator || !document.body) return;
    style();

    // Page supplies its own button (Zen) — nothing to add.
    if (document.querySelector('[data-tpush-baked]')) {
      if (bell) { try { bell.remove(); } catch (_) {} bell = null; }
      return;
    }

    var nav = findNav();

    if (nav) {
      // Already sitting in the current nav — nothing to do.
      if (bell && bell.classList.contains('tpush-navbell') && nav.contains(bell)) return;
      if (bell) { try { bell.remove(); } catch (_) {} }

      if (nav.classList && nav.classList.contains('hub-footer')) {
        bell = document.createElement('span');
        bell.className = 'tpush-hubbell';
        bell.textContent = '🔔';
        bell.title = 'Notification settings';
      } else if (nav.id === 'v8Nav') {
        bell = document.createElement('button');
        bell.type = 'button';
        bell.className = 'v8-nav-item tpush-navbell';
        bell.innerHTML = '<span class="v8-nav-icon">🔔</span>';
      } else {
        bell = document.createElement('div');
        bell.className = 'bn-item tpush-navbell';
        bell.innerHTML = '<div class="bn-tip">Alerts</div><div class="bn-icon-wrap">🔔</div>';
      }
      bell.setAttribute('role', 'button');
      bell.setAttribute('aria-label', 'Notification settings');
      bell.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); sheet(); });
      nav.appendChild(bell);
      return;
    }

    // No bottom pill here — keep the floating bell.
    if (bell && bell.classList.contains('tpush-bell')) return;
    if (bell) { try { bell.remove(); } catch (_) {} }
    bell = document.createElement('div');
    bell.className = 'tpush-bell';
    bell.textContent = '🔔';
    bell.title = 'Notification settings';
    bell.setAttribute('role', 'button');
    bell.setAttribute('aria-label', 'Notification settings');
    bell.onclick = sheet;
    document.body.appendChild(bell);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountBell);
  else mountBell();
  // The host navs are rebuilt on navigation, dropping our item with them.
  setInterval(mountBell, 1500);

  api.openSettings = sheet;
  log('ready');
})();
