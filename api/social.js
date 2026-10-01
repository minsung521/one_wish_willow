// GET /api/social?before=<id>: the public feed (MIN-122).
//
// Only wishes the maker approved one by one (MIN-123/MIN-183) are readable:
// moderation_status = 'approved' and approved_at set, newest approval target
// first, 20 at a time. Pending, rejected and hidden wishes never leave here, and neither does a
// wish its maker kept private (is_private, MIN-194), approved or not: that is
// filtered in the query, never by the client.
// The server gate SOCIAL_ENABLED defaults closed, independently of the page's
// own switch. Nothing but an error code is ever logged.
//
// With likes (MIN-160: LIKES_ENABLED=true here, and the page sends client_id)
// the same approved wishes come in a mixed order instead, see mixed() below:
// GET /api/social?client_id=<uuid>&seed=<int>&at=<ms>&offset=<n>
//   -> { mode: 'mix', wishes: [{ id, text, likes, liked, slot }], next: offset | null }
// Without client_id, or with the switch off, it answers exactly as before.
import { neon } from '@neondatabase/serverless';
import { clientIdOf, displayLikes, likesEnabled, toCount } from './_lib/likes.js';

const PAGE = 20;
const SLOTS = ['like', 'random', 'latest'];
const MAX_OFFSET = 100000;

export async function GET(request) {
  if (process.env.SOCIAL_ENABLED !== 'true') return reply(404, { status: 'closed' });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return reply(503, { status: 'unavailable' });
  const params = new URL(request.url).searchParams;
  if (likesEnabled() && params.has('client_id')) return mixed(databaseUrl, params);
  const raw = params.get('before');
  if (raw !== null && (!/^[1-9]\d{0,14}$/.test(raw) || !Number.isSafeInteger(Number(raw)))) {
    return reply(400, { status: 'invalid' });
  }
  try {
    const sql = neon(databaseUrl);
    const before = raw === null ? Number.MAX_SAFE_INTEGER : Number(raw);
    const rows = await sql`select id, wish_text from wishes
      where moderation_status = 'approved' and approved_at is not null
        and is_private = false and id < ${before}
      order by id desc limit ${PAGE + 1}`;
    const page = rows.slice(0, PAGE);
    return reply(200, {
      wishes: page.map((row) => ({ id: Number(row.id), text: row.wish_text })),
      next: rows.length > PAGE ? Number(page[page.length - 1].id) : null,
    });
  } catch (err) {
    console.error('social_list_failed', err?.code || err?.name || 'unknown');
    return reply(503, { status: 'unavailable' });
  }
}

/**
 * The feed with likes. Approved wishes only, never the visitor's own. Three
 * orders of the same wishes (most liked, a shuffle, newest) are drawn from in
 * turn, like -> random -> latest -> like..., each taking its next wish not
 * already drawn, and every wish says which of them it came from (`slot`).
 *
 * The page keeps `seed` (the shuffle) and `at` (the time likes are ranked as
 * of) for one opening of the feed and pages with `offset`, so the order holds
 * still while it scrolls even as likes come in; the page also drops any id it
 * has already shown. The whole order is worked out per request: wishes are
 * approved by hand, one by one, so there are hundreds, not millions.
 */
async function mixed(databaseUrl, params) {
  const clientId = clientIdOf(params.get('client_id'));
  const seed = intParam(params.get('seed'), 0, 2147483647, 0);
  const at = intParam(params.get('at'), 0, Number.MAX_SAFE_INTEGER, Date.now());
  const offset = intParam(params.get('offset'), 0, MAX_OFFSET, 0);
  if (!clientId || seed === null || at === null || offset === null) return reply(400, { status: 'invalid' });
  try {
    const sql = neon(databaseUrl);
    const rows = await sql`select w.id, w.seed_likes,
          count(l.wish_id) as actual,
          count(l.wish_id) filter (where l.created_at <= to_timestamp(${at / 1000}::double precision)) as ranked,
          coalesce(bool_or(l.client_id = ${clientId}::uuid), false) as liked
        from wishes w left join likes l on l.wish_id = w.id
       where w.moderation_status = 'approved' and w.approved_at is not null
         and w.client_id <> ${clientId}::uuid
       group by w.id`;
    const all = rows.map((r) => ({
      id: Number(r.id),
      rank: displayLikes(toCount(r.ranked), r.seed_likes),
      likes: displayLikes(toCount(r.actual), r.seed_likes),
      liked: r.liked === true,
      shuffle: mix(seed, Number(r.id)),
    }));
    const order = interleave({
      like: [...all].sort((a, b) => b.rank - a.rank || b.id - a.id),
      random: [...all].sort((a, b) => a.shuffle - b.shuffle || b.id - a.id),
      latest: [...all].sort((a, b) => b.id - a.id),
    });
    const page = order.slice(offset, offset + PAGE);
    const texts = new Map();
    if (page.length) {
      const found = await sql`select id, wish_text from wishes
        where id = any(${page.map((p) => p.item.id)}::bigint[])
          and moderation_status = 'approved' and approved_at is not null`;
      for (const r of found) texts.set(Number(r.id), r.wish_text);
    }
    return reply(200, {
      mode: 'mix',
      wishes: page.filter((p) => texts.has(p.item.id)).map(({ item, slot }) => ({
        id: item.id, text: texts.get(item.id), likes: item.likes, liked: item.liked, slot,
      })),
      next: offset + PAGE < order.length ? offset + PAGE : null,
    });
  } catch (err) {
    console.error('social_list_failed', err?.code || err?.name || 'unknown');
    return reply(503, { status: 'unavailable' });
  }
}

/** like -> random -> latest in turn, each giving its next wish not yet drawn. */
function interleave(pools) {
  const used = new Set();
  const next = Object.fromEntries(SLOTS.map((s) => [s, 0]));
  const total = pools.latest.length;
  const out = [];
  while (out.length < total) {
    for (const slot of SLOTS) {
      const pool = pools[slot];
      while (next[slot] < pool.length && used.has(pool[next[slot]].id)) next[slot]++;
      if (next[slot] >= pool.length) continue;
      const item = pool[next[slot]++];
      used.add(item.id);
      out.push({ item, slot });
    }
  }
  return out;
}

/** A 32-bit hash of (seed, id): the shuffle, the same for one seed every time. */
function mix(seed, id) {
  let h = (seed ^ Math.imul(id | 0, 0x9e3779b1) ^ Math.floor(id / 0x100000000)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** An integer query parameter in [min, max], the fallback when absent, or null when malformed. */
function intParam(raw, min, max, fallback) {
  if (raw === null) return fallback;
  if (!/^\d{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

function reply(status, body) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
