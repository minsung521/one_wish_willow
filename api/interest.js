// POST /api/interest: keeps an email from "See others' wishes" (MIN-158).
//
// There is nothing to see yet: the button measures demand, and this keeps the
// address of whoever asks to be told when it opens. It goes to its own table,
// never to `wishes`, and one row per client_id: asking again only replaces the
// address and the time. The body is never logged; a failure logs only an
// error code.

import { neon } from '@neondatabase/serverless';

const MAX_BODY = 1024;
const MAX_EMAIL = 254;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// the same check as the page (js/interest.js): something@something.tld, no spaces
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/;

export async function POST(request) {
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return reply(400, 'invalid');
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, 'invalid');
    }
    const row = readInterest(body);
    if (!row) return reply(400, 'invalid');

    const { DATABASE_URL } = process.env;
    if (!DATABASE_URL) {
      console.error('interest_store_failed', 'missing_env');
      return reply(500, 'error');
    }
    const sql = neon(DATABASE_URL);
    await sql`insert into social_interest (email, client_id, consented_at)
              values (${row.email}::text, ${row.client_id}::uuid, now())
              on conflict (client_id) do update
                set email = excluded.email, consented_at = excluded.consented_at`;
    return reply(201, 'ok');
  } catch (err) {
    console.error('interest_store_failed', errorCode(err));
    return reply(500, 'error');
  }
}

function reply(status, s) {
  return Response.json({ status: s }, { status, headers: { 'cache-control': 'no-store' } });
}

/** The row to upsert, or null when the request is malformed. */
function readInterest(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  if (typeof b.email !== 'string' || typeof b.client_id !== 'string') return null;
  const email = b.email.trim().toLowerCase();
  if (email.length > MAX_EMAIL || !EMAIL.test(email) || !UUID.test(b.client_id)) return null;
  return { email, client_id: b.client_id.toLowerCase() };
}

/** A Postgres SQLSTATE or the error's class name, never its message. */
function errorCode(err) {
  if (err && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return err.code;
  return (err && typeof err.name === 'string' && err.name) || 'unknown';
}
