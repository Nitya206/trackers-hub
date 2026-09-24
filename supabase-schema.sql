-- ===========================================================================
-- TRACKERS HUB · Supabase schema
-- Run this once in Supabase → SQL Editor → New query → Run.
-- Safe to re-run: every statement is idempotent.
-- ===========================================================================

-- One row per (user, localStorage key). `v` holds the raw stored string;
-- NULL means the key was deleted (a tombstone), which is how a deletion on
-- one device propagates to the others instead of silently reappearing.
create table if not exists public.sync_kv (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  k          text        not null,
  v          text,
  device     text,
  updated_at timestamptz not null default now(),
  primary key (user_id, k)
);

create index if not exists sync_kv_user_updated_idx
  on public.sync_kv (user_id, updated_at desc);

-- ── Row Level Security ─────────────────────────────────────────────────────
-- Without this, the public anon key would let anyone read everything.
-- With it, a request can only ever touch rows belonging to the signed-in user.
alter table public.sync_kv enable row level security;

drop policy if exists "own rows read"   on public.sync_kv;
drop policy if exists "own rows write"  on public.sync_kv;
drop policy if exists "own rows update" on public.sync_kv;
drop policy if exists "own rows delete" on public.sync_kv;

create policy "own rows read"   on public.sync_kv for select using (auth.uid() = user_id);
create policy "own rows write"  on public.sync_kv for insert with check (auth.uid() = user_id);
create policy "own rows update" on public.sync_kv for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows delete" on public.sync_kv for delete using (auth.uid() = user_id);

-- ── Keep updated_at honest ─────────────────────────────────────────────────
-- Conflict resolution is "newest edit wins", so the timestamp must come from
-- the database, not from a client whose clock might be wrong.
create or replace function public.sync_kv_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists sync_kv_touch_trg on public.sync_kv;
create trigger sync_kv_touch_trg
  before insert or update on public.sync_kv
  for each row execute function public.sync_kv_touch();

-- ── Realtime ───────────────────────────────────────────────────────────────
-- This is what makes changes appear on your other devices within ~1 second.
-- REPLICA IDENTITY FULL ensures DELETE events still carry the key.
alter table public.sync_kv replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.sync_kv;
exception
  when duplicate_object then null;   -- already added
end $$;
