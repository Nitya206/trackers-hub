-- ===========================================================================
-- TRACKERS HUB · push notification schema
-- Run once in Supabase → SQL Editor → New query → Run. Safe to re-run.
-- Requires the sync schema (supabase-schema.sql) to have been run first.
-- ===========================================================================

-- ── 1. Which devices can be pushed to ──────────────────────────────────────
-- One row per installed device. A phone and a laptop are separate rows, so a
-- notification reaches whichever devices you've enabled it on.
create table if not exists public.push_subscriptions (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  endpoint   text        not null,
  p256dh     text        not null,
  auth       text        not null,
  device     text,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  primary key (user_id, endpoint)
);

-- ── 2. What to send, and when ──────────────────────────────────────────────
-- The APPS decide what deserves a notification and write rows here; the server
-- only delivers them. That keeps the attendance maths, streak logic and skip
-- calculator in the one place that already implements them correctly, instead
-- of duplicating all of it server-side where it would drift out of sync.
--
-- `key` is a stable identifier the app reuses (e.g. 'digest:2026-09-09',
-- 'exam:5001:d3', 'timer:current'). Re-planning upserts on it, so opening the
-- app fifty times a day refreshes the plan instead of creating fifty pushes.
create table if not exists public.scheduled_pushes (
  id         bigint generated always as identity primary key,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  key        text        not null,
  send_at    timestamptz not null,
  title      text        not null,
  body       text,
  url        text,
  tag        text,
  sent_at    timestamptz,
  attempts   int         not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, key)
);

-- The dispatcher's hot path: "what is due and not yet sent?"
create index if not exists scheduled_pushes_due_idx
  on public.scheduled_pushes (send_at)
  where sent_at is null;

-- ── 3. Row Level Security ──────────────────────────────────────────────────
-- Same rule as sync_kv: you can only ever see or touch your own rows. The
-- dispatcher runs with the service-role key, which bypasses RLS by design.
alter table public.push_subscriptions enable row level security;
alter table public.scheduled_pushes   enable row level security;

drop policy if exists "own subs"   on public.push_subscriptions;
drop policy if exists "own pushes" on public.scheduled_pushes;

create policy "own subs" on public.push_subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own pushes" on public.scheduled_pushes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── 4. Housekeeping ────────────────────────────────────────────────────────
-- Delivered notifications older than a week are of no further use.
create or replace function public.purge_old_pushes()
returns void language sql as $$
  delete from public.scheduled_pushes
   where sent_at is not null and sent_at < now() - interval '7 days';
$$;

-- ── Make the API notice the new tables immediately ────────────────────────
-- Supabase's REST layer caches the schema. Without this nudge the tables can
-- exist while the app is still told "relation does not exist" for a while.
notify pgrst, 'reload schema';

-- ===========================================================================
-- 5. THE SCHEDULER
-- ---------------------------------------------------------------------------
-- pg_cron ticks every minute and asks the Edge Function to deliver whatever
-- is due. Enable both extensions first:
--   Dashboard → Database → Extensions → enable `pg_cron` and `pg_net`.
--
-- Then replace the two placeholders below and run this block.
--   <PROJECT_REF>  your project ref, e.g. srxi...  (from your Supabase URL)
--   <SERVICE_ROLE_KEY>  Project Settings → API → service_role  (SECRET — this
--                       one is NOT safe to publish; it only ever lives here)
-- ===========================================================================

-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
--
-- select cron.schedule(
--   'trackers-push-dispatch',
--   '* * * * *',
--   $$
--     select net.http_post(
--       url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/push-dispatch',
--       headers := '{"Content-Type":"application/json","Authorization":"Bearer <SERVICE_ROLE_KEY>"}'::jsonb,
--       body    := '{}'::jsonb
--     );
--   $$
-- );
--
-- select cron.schedule(
--   'trackers-push-purge',
--   '17 4 * * *',
--   $$ select public.purge_old_pushes(); $$
-- );

-- To inspect or remove later:
--   select * from cron.job;
--   select cron.unschedule('trackers-push-dispatch');
