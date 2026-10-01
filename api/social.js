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
// the same wishes come in the order the visitor picked (MIN-196), see sorted():
// GET /api/social?client_id=<uuid>&sort=popular|latest|random&seed=<int>&at=<ms>&offset=<n>
//   -> { mode: 'mix', sort, wishes: [{ id, text, likes, liked }], next: offset | null }
// A missing or unknown sort is popular, so a page cached from before MIN-196
// (which sends no sort) still works; `mode` stays 'mix' for the same reason.
// Without client_id, or with the switch off, it answers exactly as before.
import { neon } from '@neondatabase/serverless';
import { clientIdOf, displayLikes, likesEnabled, toCount } from './_lib/likes.js';

const PAGE = 20;
const SORTS = new Set(['popular', 'latest', 'random']);
const MAX_OFFSET = 100000;

export async function GET(request) {
  if (process.env.SOCIAL_ENABLED !== 'true') return reply(404, { status: 'closed' });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return reply(503, { status: 'unavailable' });
  const params = new URL(request.url).searchParams;
  if (likesEnabled() && params.has('client_id')) return sorted(databaseUrl, params);
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
 * The feed with likes, in the order picked on the page (MIN-196). Approved
 * wishes only, never a private one (MIN-194, filtered in both queries) and
 * never the visitor's own.
 *   popular: most likes shown first (real + seed_likes), ties shuffled by seed
 *   latest:  newest first
 *   random:  shuffled by seed
 * The page keeps `seed` and `at` (the time likes are ranked as of) for one
 * opening of the feed, or one choice of order, and pages with `offset`, so
 * the order holds still while it scrolls even as likes come in; the page also
 * drops any id it has already shown. The whole order is worked out per
 * request: wishes are approved by hand, so there are hundreds, not millions.
 */
async function sorted(databaseUrl, params) {
  const clientId = clientIdOf(params.get('client_id'));
  const sort = SORTS.has(params.get('sort')) ? params.get('sort') : 'popular';
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
         and w.is_private = false
         and w.client_id <> ${clientId}::uuid
       group by w.id`;
    const all = rows.map((r) => ({
      id: Number(r.id),
      rank: displayLikes(toCount(r.ranked), r.seed_likes),
      likes: displayLikes(toCount(r.actual), r.seed_likes),
      liked: r.liked === true,
      shuffle: mix(seed, Number(r.id)),
    }));
    const byShuffle = (a, b) => a.shuffle - b.shuffle || b.id - a.id;
    const order = all.sort(
      sort === 'latest' ? (a, b) => b.id - a.id
        : sort === 'random' ? byShuffle
          : (a, b) => b.rank - a.rank || byShuffle(a, b),
    );
    const page = order.slice(offset, offset + PAGE);
    const texts = new Map();
    if (page.length) {
      const found = await sql`select id, wish_text from wishes
        where id = any(${page.map((p) => p.id)}::bigint[])
          and moderation_status = 'approved' and approved_at is not null
          and is_private = false`;
      for (const r of found) texts.set(Number(r.id), r.wish_text);
    }
    return reply(200, {
      mode: 'mix',
      sort,
      wishes: page.filter((p) => texts.has(p.id)).map((p) => ({
        id: p.id, text: texts.get(p.id), likes: p.likes, liked: p.liked,
      })),
      next: offset + PAGE < order.length ? offset + PAGE : null,
    });
  } catch (err) {
    console.error('social_list_failed', err?.code || err?.name || 'unknown');
    return reply(503, { status: 'unavailable' });
  }
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
