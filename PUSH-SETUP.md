# Notifications — setup

About 15 minutes, one time. Do the sync setup (`SYNC-SETUP.md`) first — notifications
are delivered to your synced account.

> **Your VAPID private key is not in this repo on purpose.** It was given to you in
> chat. It lives only in Supabase's secret store. If it ever leaks, anyone could send
> notifications to your devices — regenerate it rather than reusing it.

---

## How it works

```
  your app  ──plans──▶  scheduled_pushes (Supabase)
                              │
                     pg_cron, every minute
                              ▼
                      push-dispatch function
                              │
                        Apple / Google
                              ▼
                    your phone, even locked
```

The **apps** decide what's worth a notification — they already know your attendance
percentages, streaks and exam dates. The **server** only delivers on time. That way
there's one copy of the logic, not two drifting apart.

Each notification has a stable id, so opening the app fifty times refreshes the plan
rather than queuing fifty reminders.

---

## Step 1 · Create the tables

Supabase → **SQL Editor** → New query → paste all of `supabase-push-schema.sql` → Run.

Leave the commented-out cron block at the bottom alone for now — that's step 4.

## Step 2 · Store the keys as secrets

Supabase → **Edge Functions** → **Secrets** (or Project Settings → Edge Functions).

Add three:

| Name | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | the public key (also in `sync-config.js`) |
| `VAPID_PRIVATE_KEY` | the private key from chat — **secret** |
| `VAPID_SUBJECT` | `mailto:your@email.com` |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically — don't add them.

## Step 3 · Deploy the function

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase functions deploy push-dispatch
```

Your project ref is the subdomain of your Supabase URL — in
`https://abcdefg.supabase.co` it's `abcdefg`.

## Step 4 · Turn on the scheduler

Supabase → **Database → Extensions** → enable **`pg_cron`** and **`pg_net`**.

Then open `supabase-push-schema.sql`, uncomment the block at the bottom, replace
`<PROJECT_REF>` and `<SERVICE_ROLE_KEY>` (Project Settings → API → `service_role` —
this one is secret), and run just that block.

Check it registered:

```sql
select jobname, schedule, active from cron.job;
```

## Step 5 · Install on your iPhone

**This is the part iOS refuses to skip.** Notifications never work in a Safari tab.

1. Open `trackers-hub.vercel.app` in **Safari** (not Chrome)
2. Share button → **Add to Home Screen**
3. Open it **from the home screen icon** from now on

## Step 6 · Switch them on

Tap the **🔔** near the sync dot → toggle **Enabled on this device** → allow when iOS
asks → **Send a test notification**.

A notification should arrive within a second or two. If it does, everything downstream
of it works.

Do this on each device you want notified — permission is per device.

---

## What you'll get

| Notification | When |
|---|---|
| **Morning digest** | 08:00 — todos due, nearest exam, cards to review, what you scheduled |
| **Attendance warning** | 09:00 — any subject below its goal, worst first |
| **Exam countdown** | 7, 3 and 1 day before, 09:30 |
| **Zen streak** | 21:00 — only if the day is still unmarked |
| **Break unlocked** | each time you complete another 3h 30m of study |
| **Timer** | 5 minutes before it ends, and when it does |

Roughly **2–3 a day**. That ceiling is deliberate: notification systems get muted when
they're noisy, and a muted system is worth nothing. Times and individual types are
adjustable in the 🔔 sheet.

Nothing fires when there's nothing to say — a day with no todos, no exam and the garden
already tended produces silence.

---

## Troubleshooting

**"Add this site to your Home Screen first"** — you're in a Safari tab. iOS genuinely
cannot deliver push there; step 5 is not optional.

**Test says "No devices are subscribed"** — the toggle didn't complete. Check iOS
Settings → Notifications → Trackers is allowed.

**Test works, scheduled ones never arrive** — the cron isn't running. Check
`select * from cron.job;` and Edge Functions → push-dispatch → Logs.

**"Database tables ❌" even though the tables exist in the SQL editor** — this is the
one that will waste your afternoon. Supabase's API layer (PostgREST) caches the list of
tables and does not always notice new ones. The database is fine; the API just hasn't
caught up. Run `notify pgrst, 'reload schema';` on its own and wait 30 seconds, or
restart the project from Settings → General. Verify the tables really do exist with:

```sql
select to_regclass('public.push_subscriptions'), to_regclass('public.scheduled_pushes');
```

Names printed = they exist, and the problem is the cache, not the schema.

**Nothing at all, no error** — Edge Functions → Logs. A missing `VAPID_PRIVATE_KEY`
shows up there immediately.

**They stopped after a while** — deleting the home screen icon or revoking permission
invalidates the subscription. The server drops dead subscriptions automatically; just
re-enable from the 🔔 sheet.

### Useful queries

```sql
-- what's queued
select key, send_at, title, sent_at from scheduled_pushes order by send_at limit 20;

-- which devices are registered
select device, created_at, last_ok_at from push_subscriptions;
```

---

## Turning it off

The 🔔 sheet's master toggle unsubscribes the device and clears its queue.

To remove it entirely: `select cron.unschedule('trackers-push-dispatch');` and drop the
two tables. The trackers themselves are unaffected — notifications are strictly additive.
