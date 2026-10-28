// GET /api/cron/purge-interest: keeps MIN-158's promise, "Deleted after 6
// months." (MIN-168)
//
// Vercel Cron calls this once a day (vercel.json) and it deletes every
// social_interest row whose consent is older than 6 months. Each row runs on
// its own clock: asking again (the upsert in api/interest.js) resets
// consented_at, so the 6 months count from the last time someone left an
// address.
//
// Only Vercel Cron may call it. Vercel sends `Authorization: Bearer
// <CRON_SECRET>` when the project has a CRON_SECRET variable; without that
// variable the route answers 404, as if it weren't there, so a missing secret
// never leaves it open. The log carries the number of rows deleted, never an
// address.

import { timingSafeEqual } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const MIN_SECRET = 16;

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (typeof secret !== 'string' || secret.length < MIN_SECRET) return reply(404, 'not_found');
  if (!authorized(request.headers.get('authorization'), secret)) return reply(401, 'unauthorized');

  try {
    const { DATABASE_URL } = process.env;
    if (!DATABASE_URL) {
      console.error('interest_purge_failed', 'missing_env');
      return reply(500, 'error');
    }
    const sql = neon(DATABASE_URL);
    const rows = await sql`delete from social_interest
                           where consented_at < now() - interval '6 months'
                           returning 1`;
    console.log('interest_purged', rows.length);
    return reply(200, 'ok', { deleted: rows.length });
  } catch (err) {
    console.error('interest_purge_failed', errorCode(err));
    return reply(500, 'error');
  }
}

/** Whether the header is exactly `Bearer <secret>`, compared in constant time. */
function authorized(header, secret) {
  if (typeof header !== 'string') return false;
  const want = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

function reply(status, s, extra = {}) {
  return Response.json({ status: s, ...extra }, { status, headers: { 'cache-control': 'no-store' } });
}

/** A Postgres SQLSTATE or the error's class name, never its message. */
function errorCode(err) {
  if (err && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return err.code;
  return (err && typeof err.name === 'string' && err.name) || 'unknown';
}
