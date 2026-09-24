/**
 * push-dispatch · TRACKERS HUB
 * ============================================================================
 * Delivers whatever is due in `scheduled_pushes`. Deliberately dumb: it does
 * no thinking about attendance percentages, streaks or exam dates. The apps
 * already implement all of that correctly, so they decide what deserves a
 * notification and write the rows; this only delivers them on time.
 *
 * Called once a minute by pg_cron (see supabase-push-schema.sql).
 *
 * Two ways in:
 *   • service-role key  → delivers everything due, for every user (the cron)
 *   • a normal user JWT → delivers only that user's rows, and accepts
 *                         {"test":true} to fire an immediate test notification.
 *                         This is what makes it debuggable from the browser.
 */
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY  = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT     = Deno.env.get('VAPID_SUBJECT') || 'mailto:trackers@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type',
    },
  });

interface Push {
  id: number; user_id: string; key: string; attempts: number;
  title: string; body: string | null; url: string | null; tag: string | null;
}

/** Send one notification to every device a user has registered. */
async function deliver(userId: string, payload: Record<string, unknown>) {
  const { data: subs, error } = await admin
    .from('push_subscriptions')
    .select('endpoint,p256dh,auth')
    .eq('user_id', userId);

  if (error) throw error;
  if (!subs?.length) return { sent: 0, removed: 0 };

  let sent = 0, removed = 0;

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60 },
      );
      sent++;
      await admin.from('push_subscriptions')
        .update({ last_ok_at: new Date().toISOString() })
        .eq('user_id', userId).eq('endpoint', s.endpoint);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // 404/410 mean the browser threw this subscription away (app deleted,
      // permission revoked). Keeping it would fail forever, so drop it.
      if (code === 404 || code === 410) {
        await admin.from('push_subscriptions')
          .delete().eq('user_id', userId).eq('endpoint', s.endpoint);
        removed++;
      } else {
        console.error('push failed', code, (e as Error).message);
      }
    }
  }));

  return { sent, removed };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });

  const auth = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!auth) return json({ error: 'missing Authorization' }, 401);

  const isCron = auth === SERVICE_ROLE_KEY;

  // A user token restricts everything below to that one user.
  let userId: string | null = null;
  if (!isCron) {
    const { data, error } = await admin.auth.getUser(auth);
    // The underlying reason (expired, malformed, wrong project…) used to be
    // swallowed here, leaving only "invalid token" to debug from — surfaced now.
    if (error || !data.user) return json({ error: 'invalid token', detail: error ? error.message : 'no user on token' }, 401);
    userId = data.user.id;
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  // ── Test path: prove the pipeline works without waiting for a schedule ──
  if (body.test && userId) {
    const r = await deliver(userId, {
      title: 'Trackers Hub',
      body: 'Push notifications are working 🎉',
      url: '/index.html',
      tag: 'test',
    });
    return json({ ok: true, mode: 'test', ...r });
  }

  // ── Normal path: everything due, oldest first ──
  let q = admin.from('scheduled_pushes')
    .select('id,user_id,key,attempts,title,body,url,tag')
    .is('sent_at', null)
    .lte('send_at', new Date().toISOString())
    .lt('attempts', 5)                       // give up on a row that keeps failing
    .order('send_at', { ascending: true })
    .limit(200);

  if (userId) q = q.eq('user_id', userId);

  const { data: due, error } = await q;
  if (error) return json({ error: error.message }, 500);
  if (!due?.length) return json({ ok: true, due: 0 });

  let sent = 0, removed = 0;
  for (const p of due as Push[]) {
    try {
      const r = await deliver(p.user_id, {
        title: p.title,
        body: p.body ?? '',
        url: p.url ?? '/index.html',
        tag: p.tag ?? p.key,
      });
      sent += r.sent; removed += r.removed;
      // Mark sent even when the user had zero devices — otherwise a stale row
      // would be retried every minute forever.
      await admin.from('scheduled_pushes')
        .update({ sent_at: new Date().toISOString() })
        .eq('id', p.id);
    } catch (e) {
      // Only DB-level failures reach here — individual device failures are
      // handled inside deliver(). Count the attempt so a permanently broken
      // row drops out after 5 tries instead of retrying every minute forever.
      console.error('dispatch failed for', p.key, (e as Error).message);
      await admin.from('scheduled_pushes')
        .update({ attempts: (p.attempts ?? 0) + 1 })
        .eq('id', p.id);
    }
  }

  return json({ ok: true, due: due.length, sent, removed });
});
