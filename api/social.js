// Only manually approved wishes are readable. Server gate defaults closed,
// independently of the frontend switch. MIN-123 owns approval and takedown.
import { neon } from '@neondatabase/serverless';

export async function GET(request) {
  if (process.env.SOCIAL_ENABLED !== 'true') return Response.json({ status: 'closed' }, { status: 404 });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return Response.json({ status: 'unavailable' }, { status: 503 });
  const raw = new URL(request.url).searchParams.get('before');
  if (raw !== null && (!/^[1-9]\d{0,14}$/.test(raw) || !Number.isSafeInteger(Number(raw)))) {
    return Response.json({ status: 'invalid' }, { status: 400 });
  }
  try {
    const sql = neon(databaseUrl);
    const before = raw === null ? Number.MAX_SAFE_INTEGER : Number(raw);
    const rows = await sql`select id, wish_text from wishes
      where approved_at is not null and id < ${before}
      order by id desc limit 21`;
    const page = rows.slice(0, 20);
    return Response.json({
      wishes: page.map((row) => ({ id: Number(row.id), text: row.wish_text })),
      next: rows.length > 20 ? Number(page[page.length - 1].id) : null,
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('social_list_failed', err?.code || err?.name || 'unknown');
    return Response.json({ status: 'unavailable' }, { status: 503 });
  }
}
