// GET /api/my-wish?client_id=<uuid>: the visitor's own wish (MIN-160), for the
// card at the top of the feed and the toast on the revisit screen.
//
//   200 { wish: null, email_submitted }   no wish under this client_id
//   200 { wish: { id, text, status, likes, like_count }, email_submitted }
//     status:     'approved' | 'pending' | 'rejected' (a hidden wish reads as rejected)
//                 | 'private' (kept private by its maker, MIN-194, whatever its review)
//     likes:      what the wish shows (real + seed_likes); null unless approved
//     like_count: the real likes alone, for analytics; null unless approved
//     email_submitted: an email for this client_id is in social_interest (MIN-158)
//   400 { status: 'invalid' }   404 { status: 'closed' }   503 { status: 'unavailable' }
//
// Only the holder of the client_id (a random UUID kept in their browser) can
// ask for it. Nothing but an error code is ever logged.

import { neon } from '@neondatabase/serverless';
import { clientIdOf, displayLikes, errorCode, likesEnabled, reply, toCount } from './_lib/likes.js';

export async function GET(request) {
  if (!likesEnabled()) return reply(404, { status: 'closed' });
  const clientId = clientIdOf(new URL(request.url).searchParams.get('client_id'));
  if (!clientId) return reply(400, { status: 'invalid' });
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) return reply(503, { status: 'unavailable' });
  try {
    const sql = neon(DATABASE_URL);
    const [wishes, emails] = await Promise.all([
      sql`select w.id, w.wish_text, w.moderation_status, w.approved_at, w.is_private, w.seed_likes,
                 (select count(*) from likes l where l.wish_id = w.id) as actual
            from wishes w where w.client_id = ${clientId}::uuid
            order by w.created_at desc limit 1`,
      sql`select 1 from social_interest where client_id = ${clientId}::uuid`,
    ]);
    const emailSubmitted = emails.length > 0;
    const w = wishes[0];
    if (!w) return reply(200, { wish: null, email_submitted: emailSubmitted });
    // a private wish is never on the feed, so it is never shown as approved
    const approved = w.moderation_status === 'approved' && w.approved_at !== null && w.is_private !== true;
    const status = w.is_private === true ? 'private'
      : approved ? 'approved' : w.moderation_status === 'pending' ? 'pending' : 'rejected';
    const actual = toCount(w.actual);
    return reply(200, {
      wish: {
        id: Number(w.id),
        text: w.wish_text,
        status,
        likes: approved ? displayLikes(actual, w.seed_likes) : null,
        like_count: approved ? actual : null,
      },
      email_submitted: emailSubmitted,
    });
  } catch (err) {
    console.error('my_wish_failed', errorCode(err));
    return reply(503, { status: 'unavailable' });
  }
}
