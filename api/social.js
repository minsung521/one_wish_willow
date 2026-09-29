// GET /api/social?before=<id>: the public feed (MIN-122).
//
// Only wishes the maker approved one by one (MIN-123/MIN-183) are readable:
// moderation_status = 'approved' and approved_at set, newest approval target
// first, 20 at a time. Pending, rejected and hidden wishes never leave here.
// The server gate SOCIAL_ENABLED defaults closed, independently of the page's
// own switch. Nothing but an error code is ever logged.
import { neon } from '@neondatabase/serverless';

const PAGE = 20;

export async function GET(request) {
  if (process.env.SOCIAL_ENABLED !== 'true') return reply(404, { status: 'closed' });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return reply(503, { status: 'unavailable' });
  const raw = new URL(request.url).searchParams.get('before');
  if (raw !== null && (!/^[1-9]\d{0,14}$/.test(raw) || !Number.isSafeInteger(Number(raw)))) {
    return reply(400, { status: 'invalid' });
  }
  try {
    const sql = neon(databaseUrl);
    const before = raw === null ? Number.MAX_SAFE_INTEGER : Number(raw);
    const rows = await sql`select id, wish_text from wishes
      where moderation_status = 'approved' and approved_at is not null and id < ${before}
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

function reply(status, body) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
