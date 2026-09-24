# Trackers Hub — Cross-Device Sync

Your three trackers now sync across every device in real time. This is the
one-time setup: about 10 minutes, all free tier.

---

## What you're building

```
  Phone ─┐
 Laptop ─┼─→  Supabase (Postgres + realtime)  ─→  every other device, ~1s later
  iPad ─┘
```

Every tracker keeps using `localStorage` exactly as before, so the apps stay
fast and work offline. A layer underneath watches every write and mirrors it
to the cloud, and pushes remote changes back down over a websocket.

---

## Step 1 · Create the Supabase project

1. Go to [supabase.com](https://supabase.com) → sign up → **New project**.
2. Name it anything. Pick the region closest to you. Save the database password
   somewhere (you won't need it for this, but you'll want it later).
3. Wait ~2 minutes for it to finish provisioning.

## Step 2 · Create the table

1. In your project, open **SQL Editor** → **New query**.
2. Paste the entire contents of `supabase-schema.sql` and click **Run**.
3. You should see *Success. No rows returned.*

This creates the `sync_kv` table, locks it down with Row Level Security, and
turns on realtime.

## Step 3 · Fill in `sync-config.js`

1. In Supabase, go to **Project Settings → Data API**.
2. Copy the **Project URL** and the **anon / public** key.
3. Open `sync-config.js` and paste them in:

```js
supabaseUrl:     'https://abcdefghijklm.supabase.co',
supabaseAnonKey: 'eyJhbGciOi...',
```

Both are safe to publish — the anon key grants nothing on its own.

## Step 4 · Turn off email confirmation *(recommended)*

**Authentication → Sign In / Providers → Email** → turn **Confirm email** off.

Otherwise you'll have to click a confirmation link before your account works.

## Step 5 · Make your pairing code

1. Open `pair.html` in a browser.
2. Enter an email you control and a **strong** password → **Create account**.
3. Copy the pairing code it gives you.

> The code contains your password. Treat it like one — don't post it publicly.

## Step 6 · Pair each device

On every device, open any tracker, click the **sync dot** in the corner, and
paste the code. Once per device, forever.

The first device to pair uploads your existing data. Any later device that
already has its own data will ask how to reconcile — pick **Merge** unless you
have a specific reason not to; it never deletes anything.

---

## Putting it online

The apps are plain static files, so any static host works:

**Netlify (easiest):** drag this folder onto [app.netlify.com/drop](https://app.netlify.com/drop).

**Vercel:** `npx vercel --prod` from this folder.

**GitHub Pages:** push the folder to a repo → Settings → Pages → deploy from
branch root.

All three give you HTTPS, which you need — the browser blocks some APIs on
plain HTTP.

> Set the repo to **private** or keep the URL unlisted if you use the optional
> `pairingCode` in `sync-config.js` (see below). Without it, the site is safe to
> be public: visitors see empty trackers and can't reach your data.

---

## How it works

### The trick that made this safe

The three apps contain **223 separate `localStorage` calls** across ~57,000
lines. Rewriting them all would have been slow and risky, so instead
`sync-engine.js` patches `Storage.prototype.setItem/removeItem/clear` once, in
`<head>`, before any app code runs.

The native write always runs first and its result is returned untouched — the
app can't tell the difference. The patch just notes *which key changed* and
queues it for upload. Reads are never intercepted at all, so they stay
synchronous and native.

**Not one line of your tracker logic changed.** The only edits to the app files
are two `<script>` tags each, plus two lines in `Procrastination-Hub.html` that
expose which section you're viewing so a remote update can redraw it in place.

### Conflict resolution

Newest edit wins, per key, using the **database's** clock (not the device's, so
a phone with the wrong time can't clobber good data).

Two protections on top:

- A local edit you've made but that hasn't uploaded yet is never overwritten by
  an incoming remote value. Your in-flight change always wins.
- Deletes propagate as tombstones, so deleting something on your phone doesn't
  see it resurrected by your laptop.

The one real limitation: because a whole key is the unit, if you edit the *same
tracker* on two devices while **both are offline**, the one that reconnects
second wins entirely for that key. Online, this never comes up — changes land
in about a second.

### Re-rendering

When a remote change arrives, the engine calls that app's own render function
(`render()`, `syncHubData()`, `v8Render()`, `navigateTo()` …). It never reloads
the page, and it holds off while you're typing or a dialog is open, so a sync
can't wipe a half-written journal entry.

---

## What syncs and what doesn't

**Syncs** — all of your actual data: study todos, timers, attendance, marks,
exams, SRS cards, session history, the procrastination library, tasks, budget,
lock state, zen garden days, journal entries, milestones, settings.

**Stays on each device** — things that describe *that screen*, not your data:

| Key | Why |
|---|---|
| `theme`, `fontSize`, `viewMode` | Phone and desktop want different ones |
| `collapsedSections_v5`, `sectionLayout_v1`, `v8_nav_prefs` | Per-screen layout |
| `v8_last_tab`, `phub_last_location` | "Where I was" is per device |
| `accessibilitySettings_v5`, `hapticsEnabled` | Device capability |
| `hub-idx-*` | Search index, rebuilt locally every visit |

To change this, edit `LOCAL_ONLY_EXACT` in `sync-engine.js` or add
`localOnlyKeys` in `sync-config.js`.

---

## The sync dot

A single small dot in the bottom-left corner (top-left on mobile). No text —
the colour is the whole status. Hover it for the details, click it to force a
sync.

| Dot | Means |
|---|---|
| 🟢 Green | Synced — connected and up to date |
| 🟡 Amber, pulsing | Connecting or uploading |
| 🔴 Red | Offline — changes are queued, nothing is lost |
| ⚪ Grey | Not paired yet (or `sync-config.js` isn't filled in) — click to set up |

The tooltip also shows how many changes are still waiting to upload.

Hide the dot with `hideIndicator: true` in `sync-config.js`.

---

## Console commands

```js
TrackersSync.status()          // current state
TrackersSync.forceSync()       // pull + push right now
TrackersSync.syncedKeys()      // what's syncing
TrackersSync.localOnlyKeys()   // what's staying local
TrackersSync.unpair()          // sign this device out (keeps local data)
TrackersSync.showPairing()     // reopen the pairing prompt
```

Set `debug: true` in `sync-config.js` for a live log.

---

## Troubleshooting

**Chip stuck on "Sync off"** — `supabaseUrl` / `supabaseAnonKey` are empty in
`sync-config.js`.

**"relation sync_kv does not exist"** — Step 2 didn't run. Re-run
`supabase-schema.sql`.

**Sign-in fails with correct details** — email confirmation is still on (Step 4),
or the account was never created (use `pair.html`).

**Changes upload but don't appear on the other device** — realtime isn't on for
the table. Re-run the last block of `supabase-schema.sql`, or enable it under
**Database → Replication**.

**Nothing syncs at all** — open the console. If you see a CSP or network error
for `cdn.jsdelivr.net`, your host blocks it; download `supabase-js` locally and
point `sdkUrl` at your copy.

---

## Turning it off

Delete the two `<script>` tags from the app's `<head>`. Everything reverts to
pure local storage with your data intact — sync is strictly additive.

Original untouched copies of all five files are in `.backup-presync/`.
