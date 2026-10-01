// POST /api/like: like or unlike someone else's wish in the feed (MIN-160).
//
// Body: { wish_id, client_id, action: 'like' | 'unlike' }. The page sends the
// state it wants rather than "toggle", so a retried or doubled request can't
// flip it back.
//
//   200 { wish_id, liked, likes }   likes is what the wish shows (real + seed_likes)
//   400 { status: 'invalid' }       malformed
//   403 { status: 'own_wish' }      your own wish can't be liked
//   404 { status: 'not_found' }     no such wish, or not approved (the same answer for both)
//   404 { status: 'closed' }        the server switch LIKES_ENABLED is off
//   429 { status: 'rate_limited' }  too many likes from this address
//   500 { status: 'error' }
//
// One like per (wish_id, client_id): the table's unique key. Against a client
// that clears its storage for a fresh client_id, the same salted, daily IP
// hash as api/wish.js (MIN-121) caps likes per wish per address, and likes per
// address per hour, loose enough for a school or a café on one address. An
// advisory lock on the hash keeps both caps true for simultaneous requests.
// Unliking is never limited. Nothing but an error code is ever logged.

import { neon } from '@neondatabase/serverless';
import { clientIdOf, displayLikes, errorCode, ipHash, likesEnabled, reply, toCount, wishIdOf } from './_lib/likes.js';

const MAX_BODY = 512;
const PER_WISH_PER_IP = 5; // per day, since the hash changes daily
const IP_PER_HOUR = 120;
const LOCK_NS = 7320; // advisory-lock namespace for the per-address caps (api/wish.js uses 7319)

export async function POST(request) {
  if (!likesEnabled()) return reply(404, { status: 'closed' });
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return reply(400, { status: 'invalid' });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, { status: 'invalid' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { status: 'invalid' });
    const wishId = wishIdOf(body.wish_id);
    const clientId = clientIdOf(body.client_id);
    const action = body.action;
    if (!wishId || !clientId || (action !== 'like' && action !== 'unlike')) return reply(400, { status: 'invalid' });

    const { DATABASE_URL, IP_HASH_SECRET } = process.env;
    if (!DATABASE_URL || !IP_HASH_SECRET) {
      console.error('like_failed', 'missing_env');
      return reply(500, { status: 'error' });
    }
    const ip = ipHash(request.headers, IP_HASH_SECRET);
    const sql = neon(DATABASE_URL);

    const state = sql`select w.moderation_status = 'approved' and w.approved_at is not null as approved,
             w.client_id = ${clientId}::uuid as own, w.seed_likes,
             (select count(*) from likes l where l.wish_id = w.id) as actual,
             exists (select 1 from likes l where l.wish_id = w.id and l.client_id = ${clientId}::uuid) as liked
        from wishes w where w.id = ${wishId}::bigint`;

    let rows;
    if (action === 'like') {
      // Inserted only for an approved wish that isn't theirs, under both caps.
      // An existing like is left as it is (and answered as liked).
      [, , rows] = await sql.transaction([
        sql`select pg_advisory_xact_lock(${LOCK_NS}::int, hashtext(${ip}::text))`,
        sql`insert into likes (wish_id, client_id, ip_hash)
            select w.id, ${clientId}::uuid, ${ip}::text from wishes w
             where w.id = ${wishId}::bigint
               and w.moderation_status = 'approved' and w.approved_at is not null
               and w.client_id <> ${clientId}::uuid
               and (select count(*) from likes
                     where ip_hash = ${ip}::text and created_at > now() - interval '1 hour') < ${IP_PER_HOUR}::int
               and (select count(*) from likes
                     where wish_id = ${wishId}::bigint and ip_hash = ${ip}::text) < ${PER_WISH_PER_IP}::int
            on conflict (wish_id, client_id) do nothing`,
        state,
      ]);
    } else {
      [, rows] = await sql.transaction([
        sql`delete from likes where wish_id = ${wishId}::bigint and client_id = ${clientId}::uuid`,
        state,
      ]);
    }

    const w = rows[0];
    if (!w) return reply(404, { status: 'not_found' });
    if (action === 'like') {
      if (w.own) return reply(403, { status: 'own_wish' });
      if (!w.approved) return reply(404, { status: 'not_found' });
      if (!w.liked) return reply(429, { status: 'rate_limited' });
    } else if (!w.approved) {
      // the like is gone either way; a wish that left the feed shows no count
      return reply(200, { wish_id: wishId, liked: false, likes: null });
    }
    return reply(200, { wish_id: wishId, liked: w.liked, likes: displayLikes(toCount(w.actual), w.seed_likes) });
  } catch (err) {
    console.error('like_failed', errorCode(err));
    return reply(500, { status: 'error' });
  }
}
