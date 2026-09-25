// POST /api/wish: keeps one wish, privately.
//
// This is the only place the wish text is ever sent. It is written to the
// `wishes` table and nowhere else: the request body is never logged, and a
// failure logs only an error code, never an error message (a JSON or Postgres
// message can quote the input it choked on).
//
// Limits: one wish per client_id, ever (the same rule as the page), and at
// most 20 an hour per ip_hash, loose enough for a school or a café sharing
// one address. Both answer 429 {"status":"rate_limited"}.

import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const MAX_WISH = 140; // the input's maxlength, counted the same way (UTF-16 units)
const MAX_BODY = 8192; // a full wish and its metadata is well under 1 KB
const IP_PER_HOUR = 20;
const LOCK_NS = 7319; // advisory-lock namespace for "one wish per client_id"
const INT_MAX = 2147483647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICES = new Set(['mobile', 'tablet', 'desktop']);

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
    const w = readWish(body, request.headers);
    if (!w) return reply(400, 'invalid');

    const { DATABASE_URL, IP_HASH_SECRET } = process.env;
    if (!DATABASE_URL || !IP_HASH_SECRET) {
      console.error('wish_store_failed', 'missing_env');
      return reply(500, 'error');
    }
    w.ip_hash = ipHash(request.headers, IP_HASH_SECRET);

    const sql = neon(DATABASE_URL);
    // The lock makes "one per client_id" hold even for two requests at once;
    // the insert only happens when neither limit is reached.
    const [, rows] = await sql.transaction([
      sql`select pg_advisory_xact_lock(${LOCK_NS}::int, hashtext(${w.client_id}::text))`,
      sql`insert into wishes
            (wish_text, char_length, locale, tz_offset, country, device_type, referrer,
             utm_source, snap_to_submit_ms, client_id, app_version, ip_hash)
          select ${w.wish_text}::text, ${w.char_length}::int, ${w.locale}::text, ${w.tz_offset}::int,
                 ${w.country}::text, ${w.device_type}::text, ${w.referrer}::text, ${w.utm_source}::text,
                 ${w.snap_to_submit_ms}::int, ${w.client_id}::uuid, ${w.app_version}::text, ${w.ip_hash}::text
          where not exists (select 1 from wishes where client_id = ${w.client_id}::uuid)
            and (select count(*) from wishes
                  where ip_hash = ${w.ip_hash}::text
                    and created_at > now() - interval '1 hour') < ${IP_PER_HOUR}::int
          returning id`,
    ]);
    return rows.length ? reply(201, 'ok') : reply(429, 'rate_limited');
  } catch (err) {
    console.error('wish_store_failed', errorCode(err));
    return reply(500, 'error');
  }
}

function reply(status, s) {
  return Response.json({ status: s }, { status, headers: { 'cache-control': 'no-store' } });
}

/** The row to insert, or null when the request is malformed. */
function readWish(b, headers) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  if (typeof b.wish_text !== 'string' || typeof b.client_id !== 'string') return null;
  const text = clean(b.wish_text);
  if (!text || text.length > MAX_WISH || !UUID.test(b.client_id)) return null;
  return {
    wish_text: text,
    char_length: Array.from(text).length,
    locale: str(b.locale, 35),
    tz_offset: int(b.tz_offset, -900, 900),
    country: country(headers.get('x-vercel-ip-country')),
    device_type: DEVICES.has(b.device_type) ? b.device_type : null,
    referrer: origin(b.referrer),
    utm_source: str(b.utm_source, 200),
    snap_to_submit_ms: int(b.snap_to_submit_ms, 0, INT_MAX),
    client_id: b.client_id.toLowerCase(),
    app_version: str(b.app_version, 64),
    ip_hash: null,
  };
}

// Postgres text can't hold NUL or lone surrogates; drop them rather than fail.
function clean(s) {
  const t = s.replace(/\u0000/g, '').trim();
  return typeof t.toWellFormed === 'function' ? t.toWellFormed() : t;
}

function str(v, max) {
  if (typeof v !== 'string') return null;
  const t = clean(v);
  return t && t.length <= max ? t : null;
}

function int(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max ? v : null;
}

function country(v) {
  return typeof v === 'string' && /^[A-Z]{2}$/.test(v) ? v : null;
}

/** Only the origin of a referrer is kept: its path can carry personal data. */
function origin(v) {
  if (typeof v !== 'string' || v.length > 200) return null;
  try {
    const u = new URL(v);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
    return u.host ? `${u.protocol}//${u.host}` : null;
  } catch {
    return null;
  }
}

/**
 * SHA-256 of the IP, a secret and today's UTC date. The same address hashes
 * differently every day, so it can't be followed from one day to the next,
 * and the raw IP is never stored.
 */
function ipHash(headers, secret) {
  const ip = (headers.get('x-forwarded-for') || '').split(',')[0].trim();
  if (!ip) return null;
  const day = new Date().toISOString().slice(0, 10);
  return createHash('sha256').update(ip + secret + day).digest('hex');
}

/** A Postgres SQLSTATE or the error's class name, never its message. */
function errorCode(err) {
  if (err && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return err.code;
  return (err && typeof err.name === 'string' && err.name) || 'unknown';
}
