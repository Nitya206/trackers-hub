/**
 * zen-rules.js · TRACKERS HUB — what your Zen Garden habit does to your break time
 * ============================================================================
 * Read by the Procrastination Hub (the lock), the Trackers Hub (its card) and the
 * Zen Garden itself, so all three always agree on today's numbers.
 *
 * Three independent sources feed the same reward/penalty system, each worked out
 * from its own streak record — Zen/No PMO (zen_garden_data) and Sleep ≤7h
 * (zen_sleep_data) use identical rules:
 *
 *   Following it (tended days in a row, counting today):
 *     · every 3rd day   → +30 min of free time, that day
 *     · every 7th day   → +2 hr, split in two: +1 hr free time, +1 hr on the
 *                          first break you earn by studying
 *   Not following it (days in a row that were skipped or missed, up to yesterday):
 *     · every 3rd day   → −30 min of free time, that day
 *     · every 7th day   → −2 hr, split in two: free time cut by 1 hr (so gone), and
 *                          the first break you earn by studying cut by 1 hr too
 *
 * The 7th day beats the 3rd (day 21 is a 7th, not a 3rd). Each one lasts the day it
 * lands on — it isn't repeated daily. Following puts today at the top of the streak,
 * so a reward and a penalty from the SAME source can never fall on the same day
 * (they can still meet a part from a different source — see below).
 *
 * Rituals — judged once a week, Monday to Sunday, and applied on the Monday after:
 *     · more than 75% of that week's ritual slots ticked  → the 2 hr reward
 *                                                            (+1 hr free time, +1 hr first break)
 *     · less than 75%                                     → the 2 hr penalty (both cut by 1 hr)
 *     · exactly 75%, or a week with no rituals            → nothing
 *   Slots you skipped don't count either way; a slot left unmarked counts as not done.
 *
 * When more than one source has something to say on the same day (any mix of Zen,
 * Sleep and Rituals):
 *     · all rewards, no penalty  → only the biggest reward (they are not added together)
 *     · all penalties, no reward → only the biggest penalty
 *     · at least one reward AND one penalty → every part is added, so they can cancel
 *       or leave a remainder
 *
 * The penalty only starts counting from the day these rules were first switched on
 * (zen_rules_v1.since), so a gap in the past can't hit you the moment this ships.
 * There's an on/off switch in the Zen Garden.
 */
(function () {
  'use strict';
  if (window.ZenRules) return;

  var ZEN_KEY = 'zen_garden_data';
  var SLEEP_KEY = 'zen_sleep_data';
  var RULES_KEY = 'zen_rules_v1';        // { since: 'YYYY-MM-DD', enabled: true }

  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2], 12); }
  function add(s, n) { var d = parse(s); d.setDate(d.getDate() + n); return ymd(d); }
  function today() { return ymd(new Date()); }

  function zen() {
    try { var d = JSON.parse(localStorage.getItem(ZEN_KEY)); if (d && d.days) return d; } catch (_) {}
    return null;
  }
  function sleep() {
    try { var d = JSON.parse(localStorage.getItem(SLEEP_KEY)); if (d && d.days) return d; } catch (_) {}
    return null;
  }

  function rules() {
    var r = {};
    try { r = JSON.parse(localStorage.getItem(RULES_KEY)) || {}; } catch (_) {}
    if (!r.since) {
      r.since = today();
      if (r.enabled == null) r.enabled = true;
      try { localStorage.setItem(RULES_KEY, JSON.stringify(r)); } catch (_) {}
    }
    return r;
  }
  function enabled() { return rules().enabled !== false; }
  function setEnabled(on) {
    var r = rules(); r.enabled = !!on;
    try { localStorage.setItem(RULES_KEY, JSON.stringify(r)); } catch (_) {}
  }

  // Consecutive tended days ending on `key` (0 if `key` itself wasn't tended)
  function streakOn(d, key) {
    var n = 0, cur = key;
    while (n < 1000 && d.days[cur]) { n++; cur = add(cur, -1); }
    return n;
  }
  // Consecutive days NOT tended, ending yesterday — only days on/after `floor` count
  function missRun(d, todayKey, floor) {
    var n = 0, cur = add(todayKey, -1);
    while (n < 1000 && cur >= floor && !d.days[cur]) { n++; cur = add(cur, -1); }
    return n;
  }

  function tier(n) { return n >= 3 && n % 7 === 0 ? 7 : (n >= 3 && n % 3 === 0 ? 3 : 0); }

  /* ── Rituals: one verdict per finished week ── */
  function ritualsData() {
    try { var d = JSON.parse(localStorage.getItem('rituals_v1')); return d && Array.isArray(d.routines) ? d : null; }
    catch (_) { return null; }
  }
  function ritualDue(r, date) {
    if (r.paused || (r.created && date < r.created)) return false;
    var sc = r.schedule || {};
    if (sc.type === 'every') {
      var n = Math.round((parse(date) - parse(sc.start || r.created || date)) / 86400000);
      return n >= 0 && n % Math.max(1, sc.every || 1) === 0;
    }
    return (sc.days || []).indexOf(parse(date).getDay()) !== -1;
  }
  function weekMonday(dateStr) { return add(dateStr, -((parse(dateStr).getDay() + 6) % 7)); }
  // done / counted for the 7 days from `monday` — skipped slots are left out, unmarked ones count against you
  function weekTally(R, monday) {
    var done = 0, counted = 0;
    for (var i = 0; i < 7; i++) {
      var day = add(monday, i), log = (R.log && R.log[day]) || {};
      R.routines.forEach(function (r) {
        if (!ritualDue(r, day)) return;
        var slots = (r.times && r.times.length) ? r.times.length : 1;
        for (var k = 0; k < slots; k++) {
          var e = log[r.id + '|' + k], st = e && e.s;
          if (st === 'skip') continue;
          counted++;
          if (st === 'done') done++;
        }
      });
    }
    return { done: done, counted: counted, pct: counted ? Math.round(done / counted * 100) : 0 };
  }
  // Integer maths so 75% is exactly 75%: 4·done vs 3·counted
  function weekVerdict(t) {
    if (!t.counted) return null;
    if (t.done * 4 > t.counted * 3) return 'reward';
    if (t.done * 4 < t.counted * 3) return 'penalty';
    return null;
  }

  var REWARD7 = { free: 60, next: 60 };

  /* ── the three sources, each as a "part" (or null) ── */
  function zenPart(r, key) {
    var d = zen(); if (!d) return null;
    var s = d.days[key] ? streakOn(d, key) : 0, t = tier(s);
    if (t) {
      return { src: 'zen', kind: 'reward', tier: t, days: s,
        freeDelta: t === 7 ? 60 : 30, nextDelta: t === 7 ? 60 : 0,
        label: t === 7 ? '🌿 ' + s + '-day Zen streak — +1h free time and +1h on your first earned break'
                       : '🌿 ' + s + '-day Zen streak — +30 min free time' };
    }
    var floor = d.startDate && d.startDate > r.since ? d.startDate : r.since;
    var m = missRun(d, key, floor);
    t = tier(m);
    if (t) {
      return { src: 'zen', kind: 'penalty', tier: t, days: m,
        freeDelta: t === 7 ? -60 : -30, nextDelta: t === 7 ? -60 : 0,
        label: t === 7 ? '🥀 ' + m + ' days without Zen — free time cut to 0 and your first earned break cut by 1h'
                       : '🥀 ' + m + ' days without Zen — free time cut by 30 min' };
    }
    return null;
  }
  // Same tier/amount rules as zenPart, off the Sleep ≤7h streak instead.
  function sleepPart(r, key) {
    var d = sleep(); if (!d) return null;
    var s = d.days[key] ? streakOn(d, key) : 0, t = tier(s);
    if (t) {
      return { src: 'sleep', kind: 'reward', tier: t, days: s,
        freeDelta: t === 7 ? 60 : 30, nextDelta: t === 7 ? 60 : 0,
        label: t === 7 ? '😴 ' + s + '-day Sleep streak — +1h free time and +1h on your first earned break'
                       : '😴 ' + s + '-day Sleep streak — +30 min free time' };
    }
    var floor = d.startDate && d.startDate > r.since ? d.startDate : r.since;
    var m = missRun(d, key, floor);
    t = tier(m);
    if (t) {
      return { src: 'sleep', kind: 'penalty', tier: t, days: m,
        freeDelta: t === 7 ? -60 : -30, nextDelta: t === 7 ? -60 : 0,
        label: t === 7 ? '😵 ' + m + ' days oversleeping — free time cut to 0 and your first earned break cut by 1h'
                       : '😵 ' + m + ' days oversleeping — free time cut by 30 min' };
    }
    return null;
  }
  function ritualPart(r, key) {
    if (parse(key).getDay() !== 1) return null;                        // the verdict lands on the Monday after the week
    var R = ritualsData(); if (!R) return null;
    var monday = add(key, -7);
    if (monday < r.since) return null;                                 // a week from before the rules existed doesn't count
    var t = weekTally(R, monday), v = weekVerdict(t);
    if (!v) return null;
    var sign = v === 'reward' ? 1 : -1;
    return { src: 'rituals', kind: v, tier: 7, days: 7, pct: t.pct, done: t.done, counted: t.counted,
      freeDelta: sign * REWARD7.free, nextDelta: sign * REWARD7.next,
      label: v === 'reward' ? '🧴 Rituals last week ' + t.pct + '% (' + t.done + '/' + t.counted + ') — +1h free time and +1h on your first earned break'
                            : '🥀 Rituals last week ' + t.pct + '% (' + t.done + '/' + t.counted + ') — free time cut to 0 and your first earned break cut by 1h' };
  }
  function total(p) { return p.freeDelta + p.nextDelta; }

  /** Today's effect on the break budget, in minutes — Zen and Rituals combined. */
  function adjustments() {
    var out = { enabled: true, freeDelta: 0, nextDelta: 0, kind: null, tier: 0, days: 0, label: '', parts: [], combined: null };
    var r = rules();
    if (r.enabled === false) { out.enabled = false; return out; }
    var key = today();
    var parts = [zenPart(r, key), sleepPart(r, key), ritualPart(r, key)].filter(Boolean);
    if (!parts.length) return out;

    var rewards = parts.filter(function (p) { return p.kind === 'reward'; });
    var penalties = parts.filter(function (p) { return p.kind === 'penalty'; });
    var used, note = '';
    if (rewards.length && penalties.length) {
      used = parts; note = 'A reward and a penalty on the same day — added together.';   // they can cancel out
    } else if (rewards.length > 1) {
      used = [rewards.reduce(function (a, b) { return total(b) > total(a) ? b : a; })];
      note = 'Two rewards on the same day — the bigger one applies, they are not added.';
    } else if (penalties.length > 1) {
      used = [penalties.reduce(function (a, b) { return total(b) < total(a) ? b : a; })];
      note = 'Two penalties on the same day — the bigger one applies.';
    } else {
      used = parts;
    }
    used.forEach(function (p) { out.freeDelta += p.freeDelta; out.nextDelta += p.nextDelta; });
    out.parts = parts.map(function (p) { return Object.assign({}, p, { applied: used.indexOf(p) !== -1 }); });
    var net = out.freeDelta + out.nextDelta;
    out.kind = net > 0 ? 'reward' : net < 0 ? 'penalty' : (out.freeDelta || out.nextDelta ? 'reward' : 'even');
    if (parts.length === 1) { out.tier = parts[0].tier; out.days = parts[0].days; }
    out.combined = parts.length > 1 ? note : null;
    // For one-line displays: the lines that apply, then how they were combined
    out.label = used.map(function (p) { return p.label; }).join('\n') + (out.combined ? '\n' + out.combined : '');
    return out;
  }

  /** Caps the break budgets are measured against today. base = the normal 60 min. */
  function freeCap(base) { return Math.max(0, base + adjustments().freeDelta); }
  function firstBreakCap(base) { return Math.max(0, base + adjustments().nextDelta); }

  // Streak/next-reward/next-penalty for one streak-based source (Zen or Sleep) —
  // shared so both read the same logic and can never drift apart.
  function streakStatus(d, key, r) {
    var out = { tendedToday: false, streak: 0, missRun: 0, next: null, warn: null };
    if (!d) return out;
    out.tendedToday = !!d.days[key];
    // Streak the way the tracker shows it: today counts if tended, otherwise it's yesterday's run
    out.streak = out.tendedToday ? streakOn(d, key) : streakOn(d, add(key, -1));
    var floor = d.startDate && d.startDate > r.since ? d.startDate : r.since;
    out.missRun = out.tendedToday ? 0 : missRun(d, key, floor);
    // Next reward: the first day count above the streak that's a 3rd or a 7th
    for (var n = out.streak + 1; n < out.streak + 30; n++) {
      if (tier(n)) { out.next = { at: n, tier: tier(n), inDays: n - out.streak }; break; }
    }
    // Next penalty if today (and the days after) go untended
    var run = out.tendedToday ? 0 : out.missRun;
    for (var k = 1; k < 30; k++) {
      var future = run + k;
      if (tier(future)) { out.warn = { at: future, tier: tier(future), inDays: k }; break; }
    }
    return out;
  }

  /** For the panels in the Zen Garden and Rituals: where you stand and what's next.
   *  Top-level fields stay Zen/No PMO, exactly as before — `sleep` carries the
   *  same shape for the Sleep ≤7h streak. */
  function status() {
    var key = today(), r = rules();
    var adj = adjustments();
    var zenSt = streakStatus(zen(), key, r);
    var out = { enabled: r.enabled !== false, adj: adj,
      streak: zenSt.streak, tendedToday: zenSt.tendedToday, missRun: zenSt.missRun, next: zenSt.next, warn: zenSt.warn,
      sleep: streakStatus(sleep(), key, r), rituals: ritualWeek() };
    return out;
  }

  /** This week's Rituals score so far, and what it will earn (or cost) on Monday. */
  function ritualWeek() {
    var R = ritualsData(), r = rules(), key = today();
    if (!R) return null;
    var monday = weekMonday(key), t = weekTally(R, monday);
    var need = Math.floor(t.counted * 3 / 4) + 1;                        // ticks needed for "more than 75%"
    var counts = monday >= r.since;                                       // this week is fully inside the rules
    var v = weekVerdict(t);                                               // what the week would earn if it ended right now
    var daysLeft = 6 - ((parse(key).getDay() + 6) % 7);                   // full days after today until Sunday
    return { monday: monday, done: t.done, counted: t.counted, pct: t.pct, need: need, toGo: Math.max(0, need - t.done),
             verdict: v, counts: counts, daysLeft: daysLeft, sinceMonday: r.since };
  }

  window.ZenRules = {
    adjustments: adjustments, status: status, freeCap: freeCap, firstBreakCap: firstBreakCap,
    enabled: enabled, setEnabled: setEnabled, tier: tier, ritualWeek: ritualWeek
  };
})();
