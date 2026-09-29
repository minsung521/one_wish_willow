// /api/admin/wishes: the maker's review queue (MIN-123/MIN-183). Every wish
// starts 'pending' and reaches the public feed (api/social.js) only when it is
// approved here, one by one. Needs the admin session (api/admin/session.js).
//
// GET ?status=pending|approved|rejected|hidden&before=<id>
//   -> 200 { wishes: [{ id, text, status, created_at, reviewed_at, approved_at }],
//            next: id | null, counts: { pending, approved, rejected, hidden } }
//   Newest first, 20 at a time; pass `next` back as `before` for more.
//
// PATCH { id, from, status }: move one wish from `from` to `status`.
//   pending            -> approved | rejected
//   approved           -> hidden          (takes it off the feed at once)
//   rejected | hidden  -> approved        (a second look)
//   -> 200 { wish }                          changed
//   -> 200 { wish, unchanged: true }         it already had that status (a double click)
//   -> 409 { status: 'conflict', wish }      someone else moved it first
//   -> 404 { status: 'not_found' }, 400 { status: 'invalid' | 'invalid_transition' }
//   `wish` here is { id, status, created_at, reviewed_at, approved_at }, without the text.
//
// Approving sets approved_at and reviewed_at to now(); rejecting or hiding sets
// reviewed_at to now() and approved_at to NULL (the table's constraint holds the
// two together). The change is one conditional UPDATE, so two clicks or two
// tabs can't both apply it.
//
// No session: 401 { status: 'unauthorized' }. PATCH from another origin: 403.
// Admin switched off: 404 { status: 'closed' }. Only error codes are logged.

import { neon } from '@neondatabase/serverless';
import { STATUSES, adminConfig, errorCode, readJson, readSession, reply, sameOrigin } from '../_lib/admin.js';

const PAGE = 20;
const MOVES = {
  approved: ['pending', 'rejected', 'hidden'],
  rejected: ['pending'],
  hidden: ['approved'],
};

function gate(request) {
  const config = adminConfig();
  if (!config) return reply(404, { status: 'closed' });
  if (!readSession(config, request)) return reply(401, { status: 'unauthorized' });
  if (!process.env.DATABASE_URL) return reply(503, { status: 'unavailable' });
  return null;
}

export async function GET(request) {
  const stop = gate(request);
  if (stop) return stop;
  const params = new URL(request.url).searchParams;
  const status = params.get('status') || 'pending';
  const raw = params.get('before');
  if (!STATUSES.includes(status)) return reply(400, { status: 'invalid' });
  if (raw !== null && !isId(raw)) return reply(400, { status: 'invalid' });
  try {
    const sql = neon(process.env.DATABASE_URL);
    const before = raw === null ? Number.MAX_SAFE_INTEGER : Number(raw);
    const [rows, totals] = await Promise.all([
      sql`select id, wish_text, moderation_status, created_at, reviewed_at, approved_at from wishes
          where moderation_status = ${status} and id < ${before}
          order by id desc limit ${PAGE + 1}`,
      sql`select moderation_status, count(*)::int as n from wishes group by moderation_status`,
    ]);
    const page = rows.slice(0, PAGE);
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const t of totals) if (t.moderation_status in counts) counts[t.moderation_status] = Number(t.n);
    return reply(200, {
      wishes: page.map((row) => ({ ...meta(row), text: row.wish_text })),
      next: rows.length > PAGE ? Number(page[page.length - 1].id) : null,
      counts,
    });
  } catch (err) {
    console.error('admin_list_failed', errorCode(err));
    return reply(503, { status: 'unavailable' });
  }
}

export async function PATCH(request) {
  try {
    if (!adminConfig()) return reply(404, { status: 'closed' });
    if (!sameOrigin(request)) return reply(403, { status: 'forbidden' });
    const stop = gate(request);
    if (stop) return stop;
    const body = await readJson(request);
    if (!body || !Number.isSafeInteger(body.id) || body.id < 1) return reply(400, { status: 'invalid' });
    const { id, from, status: to } = body;
    if (!STATUSES.includes(from) || !STATUSES.includes(to)) return reply(400, { status: 'invalid' });
    if (!(MOVES[to] || []).includes(from)) return reply(400, { status: 'invalid_transition' });

    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`update wishes
        set moderation_status = ${to}::text,
            reviewed_at = now(),
            approved_at = case when ${to}::text = 'approved' then now() else null end
        where id = ${id} and moderation_status = ${from}::text
        returning id, moderation_status, created_at, reviewed_at, approved_at`;
    if (rows.length) return reply(200, { wish: meta(rows[0]) });

    const now = await sql`select id, moderation_status, created_at, reviewed_at, approved_at
        from wishes where id = ${id}`;
    if (!now.length) return reply(404, { status: 'not_found' });
    const wish = meta(now[0]);
    if (wish.status === to) return reply(200, { wish, unchanged: true });
    return reply(409, { status: 'conflict', wish });
  } catch (err) {
    console.error('admin_moderate_failed', errorCode(err));
    return reply(503, { status: 'unavailable' });
  }
}

function isId(v) {
  return /^[1-9]\d{0,14}$/.test(v) && Number.isSafeInteger(Number(v));
}

function iso(v) {
  return v == null ? null : new Date(v).toISOString();
}

function meta(row) {
  return {
    id: Number(row.id),
    status: row.moderation_status,
    created_at: iso(row.created_at),
    reviewed_at: iso(row.reviewed_at),
    approved_at: iso(row.approved_at),
  };
}
