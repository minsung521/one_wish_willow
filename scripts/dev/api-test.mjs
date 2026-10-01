// Checks the public feed and the admin API end to end against the local
// server (server.mjs) and a local Postgres. It empties and refills `wishes`,
// so it refuses any DATABASE_URL that isn't on localhost.
//
//   node scripts/dev/api-test.mjs http://localhost:8080
//   (env: DATABASE_URL, ADMIN_TEST_PASSWORD, ADMIN_SESSION_SECRET, ADMIN_PASSWORD_HASH)

import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';

const BASE = process.argv[2] || 'http://localhost:8080';
const { DATABASE_URL, ADMIN_TEST_PASSWORD } = process.env;
if (!DATABASE_URL || !/@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL)) {
  console.error('Refusing: DATABASE_URL must be a local Postgres.');
  process.exit(2);
}
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

let failed = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const ORIGIN = BASE;
async function call(method, path, { body, cookie, origin = ORIGIN, type = 'application/json', xff } = {}) {
  const headers = {};
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = type;
  if (xff) headers['x-forwarded-for'] = xff;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
}

async function seed() {
  await db.query('truncate wishes restart identity');
  const texts = [
    'I wish my grandmother could see me graduate. 할머니가 졸업식에 오셨으면 좋겠어요.',
    '<img src=x onerror=alert(1)> <b>not bold</b>',
    'line one\nline two\n\nline four',
    '가'.repeat(70) + 'A'.repeat(70),
    '세계 평화 🌍 and a quiet house',
  ];
  for (let i = 0; i < 30; i++) {
    const t = i < texts.length ? texts[i] : `TEST wish #${i + 1} — pending test data`;
    await db.query(
      'insert into wishes (wish_text, char_length, client_id) values ($1, $2, $3)',
      [t, Array.from(t).length, randomUUID()],
    );
  }
}

await seed();

// ---------------------------------------------------------------- no session
check('public GET, 0 approved: empty list, next null',
  await call('GET', '/api/social').then((r) => r.status === 200 && r.json.wishes.length === 0 && r.json.next === null));
check('admin GET session without cookie: 401', (await call('GET', '/api/admin/session')).status === 401);
{
  const r = await call('GET', '/api/admin/wishes?status=pending');
  check('admin list without cookie: 401, no data', r.status === 401 && !('wishes' in (r.json || {})));
}
check('admin PATCH without cookie: 401',
  (await call('PATCH', '/api/admin/wishes', { body: { id: 1, from: 'pending', status: 'approved' } })).status === 401);
check('admin PATCH from another origin: 403',
  (await call('PATCH', '/api/admin/wishes', { body: { id: 1, from: 'pending', status: 'approved' }, origin: 'https://evil.example' })).status === 403);
check('admin PATCH with no Origin and no Sec-Fetch-Site: 403',
  (await call('PATCH', '/api/admin/wishes', { body: { id: 1, from: 'pending', status: 'approved' }, origin: null })).status === 403);
{
  const { rows } = await db.query("select count(*)::int n from wishes where moderation_status <> 'pending'");
  check('nothing changed by the refused requests', rows[0].n === 0);
}

// ---------------------------------------------------------------- login
check('login from another origin: 403',
  (await call('POST', '/api/admin/session', { body: { password: ADMIN_TEST_PASSWORD }, origin: 'https://evil.example' })).status === 403);
check('login as a form post (text/plain): 400',
  (await call('POST', '/api/admin/session', { body: { password: ADMIN_TEST_PASSWORD }, type: 'text/plain' })).status === 400);
check('login with a wrong password: 401',
  (await call('POST', '/api/admin/session', { body: { password: 'nope-nope-nope-nope' }, xff: '203.0.113.9' })).status === 401);

const login = await call('POST', '/api/admin/session', { body: { password: ADMIN_TEST_PASSWORD } });
const setCookie = login.headers.get('set-cookie') || '';
check('login: 200', login.status === 200 && login.json.authenticated === true);
check('cookie is __Host-, HttpOnly, Secure, SameSite=Strict, Path=/',
  /^__Host-oww_admin=/.test(setCookie) && /HttpOnly/.test(setCookie) && /Secure/.test(setCookie)
  && /SameSite=Strict/.test(setCookie) && /Path=\//.test(setCookie), setCookie.replace(/=[^;]+/, '=…'));
check('the password is not in the response', !JSON.stringify(login.json).includes(ADMIN_TEST_PASSWORD));
const cookie = setCookie.split(';')[0];
check('GET session with the cookie: 200', (await call('GET', '/api/admin/session', { cookie })).status === 200);

{
  const tampered = cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA');
  check('tampered cookie: 401', (await call('GET', '/api/admin/wishes', { cookie: tampered })).status === 401);
  // a correctly signed but expired session
  const key = createHmac('sha256', process.env.ADMIN_SESSION_SECRET)
    .update('oww-admin-session\0' + process.env.ADMIN_PASSWORD_HASH).digest();
  const payload = `v1.${Math.floor(Date.now() / 1000) - 10}.AAAAAAAAAAAAAAAAAAAAAA`;
  const sig = createHmac('sha256', key).update(payload).digest('base64url');
  check('expired (but signed) session: 401',
    (await call('GET', '/api/admin/wishes', { cookie: `__Host-oww_admin=${payload}.${sig}` })).status === 401);
}

// ---------------------------------------------------------------- list
{
  const r = await call('GET', '/api/admin/wishes?status=pending', { cookie });
  const w = r.json.wishes;
  check('pending list: 20, newest first, with text/created_at/status',
    r.status === 200 && w.length === 20 && w[0].id === 30 && w[0].status === 'pending'
    && typeof w[0].text === 'string' && !!w[0].created_at && r.json.next === 11);
  check('counts: 30 pending', r.json.counts.pending === 30 && r.json.counts.approved === 0);
  const r2 = await call('GET', `/api/admin/wishes?status=pending&before=${r.json.next}`, { cookie });
  check('pending list, page 2: 10, next null', r2.json.wishes.length === 10 && r2.json.next === null);
  check('HTML-like text comes back as plain text', r2.json.wishes.some((x) => x.text.startsWith('<img src=x')));
  check('bad status: 400', (await call('GET', '/api/admin/wishes?status=all', { cookie })).status === 400);
  check('bad cursor: 400', (await call('GET', '/api/admin/wishes?before=1e3', { cookie })).status === 400);
}

// ---------------------------------------------------------------- moderate
const patch = (id, from, status, opts = {}) => call('PATCH', '/api/admin/wishes', { cookie, body: { id, from, status }, ...opts });
const row = async (id) => (await db.query('select moderation_status s, reviewed_at r, approved_at a from wishes where id = $1', [id])).rows[0];

{
  const r = await patch(1, 'pending', 'approved');
  const d = await row(1);
  check('approve #1: 200, approved', r.status === 200 && r.json.wish.status === 'approved' && !!r.json.wish.approved_at);
  check('approve #1 in DB: approved_at and reviewed_at set', d.s === 'approved' && d.a && d.r);
  check('PATCH answer has no wish text', !('text' in r.json.wish));
  const feed = await call('GET', '/api/social');
  check('public GET shows #1 only', feed.json.wishes.length === 1 && feed.json.wishes[0].id === 1
    && Object.keys(feed.json.wishes[0]).sort().join() === 'id,text');
  const again = await patch(1, 'pending', 'approved');
  check('approve #1 again (double click): 200 unchanged', again.status === 200 && again.json.unchanged === true);
  const stale = await patch(1, 'pending', 'rejected');
  check('reject #1 from a stale "pending" view: 409 with current status',
    stale.status === 409 && stale.json.wish.status === 'approved');
  check('pending -> hidden: 400 invalid_transition', (await patch(2, 'pending', 'hidden')).json.status === 'invalid_transition');
  check('approved -> rejected: 400 invalid_transition', (await patch(1, 'approved', 'rejected')).json.status === 'invalid_transition');
  check('unknown id: 404', (await patch(9999, 'pending', 'approved')).status === 404);
  check('string id: 400', (await patch('1', 'pending', 'approved')).status === 400);

  const hide = await patch(1, 'approved', 'hidden');
  const d2 = await row(1);
  check('hide #1: 200, hidden, approved_at null', hide.status === 200 && hide.json.wish.status === 'hidden' && hide.json.wish.approved_at === null);
  check('hide #1 in DB: approved_at NULL, reviewed_at set', d2.s === 'hidden' && d2.a === null && d2.r);
  check('public GET no longer shows #1', (await call('GET', '/api/social')).json.wishes.length === 0);
  check('hidden -> approved (second look): 200', (await patch(1, 'hidden', 'approved')).status === 200);
  check('public GET shows #1 again', (await call('GET', '/api/social')).json.wishes.length === 1);
  const rej = await patch(2, 'pending', 'rejected');
  const d3 = await row(2);
  check('reject #2: 200, approved_at NULL, reviewed_at set', rej.status === 200 && d3.s === 'rejected' && d3.a === null && d3.r);
  check('public GET does not show rejected #2', !(await call('GET', '/api/social')).json.wishes.some((w) => w.id === 2));
}

// ---------------------------------------------------------------- races
{
  const rs = await Promise.all(Array.from({ length: 6 }, () => patch(3, 'pending', 'approved')));
  const changed = rs.filter((r) => r.status === 200 && !r.json.unchanged).length;
  const same = rs.filter((r) => r.status === 200 && r.json.unchanged).length;
  check('6 simultaneous approvals of #3: exactly 1 applies, 5 unchanged', changed === 1 && same === 5, `${changed}/${same}`);
  const [a, b] = await Promise.all([patch(4, 'pending', 'approved'), patch(4, 'pending', 'rejected')]);
  const codes = [a.status, b.status].sort().join();
  const d = await row(4);
  check('approve vs reject of #4 at once: one 200, one 409, DB consistent',
    codes === '200,409' && ((d.s === 'approved') === (d.a !== null)), `${codes} -> ${d.s}`);
}

// ---------------------------------------------------------------- pagination
{
  await db.query("update wishes set moderation_status = 'approved', approved_at = now(), reviewed_at = now() where id between 5 and 26");
  const { rows } = await db.query("select count(*)::int n from wishes where moderation_status = 'approved'");
  const p1 = await call('GET', '/api/social');
  const p2 = await call('GET', `/api/social?before=${p1.json.next}`);
  const all = [...p1.json.wishes, ...p2.json.wishes].map((w) => w.id);
  check(`public pages: 20 + ${rows[0].n - 20} of ${rows[0].n} approved, no repeats, next null at the end`,
    p1.json.wishes.length === 20 && p2.json.wishes.length === rows[0].n - 20 && p2.json.next === null
    && new Set(all).size === all.length);
  check('public GET bad cursor: 400', (await call('GET', '/api/social?before=abc')).status === 400);
}

// ---------------------------------------------------------------- private wishes (MIN-194)
{
  const post = (extra) => call('POST', '/api/wish', {
    xff: `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
    body: { wish_text: `private-test ${extra.tag}`, client_id: randomUUID(), ...extra.body },
  });
  const flag = async (tag) =>
    (await db.query('select id::int as id, is_private from wishes where wish_text = $1', [`private-test ${tag}`])).rows[0];
  const inFeed = async (id) => {
    let next = null;
    do {
      const r = await call('GET', `/api/social${next ? `?before=${next}` : ''}`);
      if (r.json.wishes.some((w) => w.id === id)) return true;
      next = r.json.next;
    } while (next);
    return false;
  };

  check('POST is_private=true: 201, stored true', (await post({ tag: 'T', body: { is_private: true } })).status === 201 && (await flag('T')).is_private === true);
  check('POST is_private=false: stored false', (await post({ tag: 'F', body: { is_private: false } })).status === 201 && (await flag('F')).is_private === false);
  check('POST without is_private (old client): stored false', (await post({ tag: 'M', body: {} })).status === 201 && (await flag('M')).is_private === false);
  for (const [tag, v] of [['S', 'true'], ['N', 1], ['X', 'yes'], ['Z', null], ['O', { a: 1 }]]) {
    const r = await post({ tag, body: { is_private: v } });
    check(`POST is_private=${JSON.stringify(v)}: 201, normalised to false`, r.status === 201 && (await flag(tag)).is_private === false);
  }

  const pub = await flag('F');
  const priv = await flag('T');
  check('public candidate, pending: not in feed', !(await inFeed(pub.id)));
  check('private, pending: not in feed', !(await inFeed(priv.id)));
  check('admin approves the public candidate: in feed', (await patch(pub.id, 'pending', 'approved')).status === 200 && await inFeed(pub.id));
  const ap = await patch(priv.id, 'pending', 'approved');
  check('admin approves the private wish: 200, status approved', ap.status === 200 && ap.json.wish.status === 'approved' && ap.json.wish.is_private === true);
  check('private + approved: NOT in public feed', !(await inFeed(priv.id)));
  check('admin list shows is_private',
    (await call('GET', '/api/admin/wishes?status=approved', { cookie })).json.wishes.some((w) => w.id === priv.id && w.is_private === true)
    && (await call('GET', '/api/admin/wishes?status=approved', { cookie })).json.wishes.some((w) => w.id === pub.id && w.is_private === false));
  check('hide the public one: gone from feed at once', (await patch(pub.id, 'approved', 'hidden')).status === 200 && !(await inFeed(pub.id)));
  check('rejected wishes stay out too', (await patch((await flag('M')).id, 'pending', 'rejected')).status === 200 && !(await inFeed((await flag('M')).id)));
  const { rows } = await db.query("select count(*)::int n from wishes where is_private and moderation_status = 'approved'");
  check('private approved wishes exist in DB but none leak', rows[0].n >= 1 && !(await call('GET', '/api/social')).json.wishes.some((w) => w.id === priv.id));
}

// ---------------------------------------------------------------- logout, rate limit
{
  const out = await call('DELETE', '/api/admin/session', { cookie });
  check('logout: 200, cookie cleared', out.status === 200 && /Max-Age=0/.test(out.headers.get('set-cookie') || ''));
  check('logout from another origin: 403', (await call('DELETE', '/api/admin/session', { origin: 'https://evil.example' })).status === 403);

  const ip = '198.51.100.77';
  const codes = [];
  for (let i = 0; i < 6; i++) {
    codes.push((await call('POST', '/api/admin/session', { body: { password: `wrong-${i}-wrong-wrong` }, xff: ip })).status);
  }
  const blocked = await call('POST', '/api/admin/session', { body: { password: ADMIN_TEST_PASSWORD }, xff: ip });
  check('5 wrong passwords, then 429 with Retry-After (even for the right one)',
    codes.slice(0, 5).every((c) => c === 401) && codes[5] === 429 && blocked.status === 429
    && Number(blocked.headers.get('retry-after')) > 0, codes.join(','));
  const other = await call('POST', '/api/admin/session', { body: { password: ADMIN_TEST_PASSWORD }, xff: '192.0.2.10' });
  check('another address can still log in', other.status === 200);
}

// ---------------------------------------------------------------- switches (in-process)
{
  const social = await import('../../api/social.js');
  const admin = await import('../../api/admin/wishes.js');
  const session = await import('../../api/admin/session.js');
  const keep = { ...process.env };
  process.env.SOCIAL_ENABLED = '';
  const off = await social.GET(new Request('http://localhost/api/social'));
  check('SOCIAL_ENABLED unset: public GET 404 closed', off.status === 404 && (await off.json()).status === 'closed');
  process.env.SOCIAL_ENABLED = 'false';
  check('SOCIAL_ENABLED=false: public GET 404', (await social.GET(new Request('http://localhost/api/social'))).status === 404);
  delete process.env.ADMIN_PASSWORD_HASH;
  check('no ADMIN_PASSWORD_HASH: admin list 404 closed',
    (await admin.GET(new Request('http://localhost/api/admin/wishes', { headers: { cookie } }))).status === 404);
  check('no ADMIN_PASSWORD_HASH: login 404 closed',
    (await session.POST(new Request('http://localhost/api/admin/session', {
      method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: '{"password":"x"}',
    }))).status === 404);
  process.env.ADMIN_PASSWORD_HASH = keep.ADMIN_PASSWORD_HASH;
  process.env.ADMIN_SESSION_SECRET = 'too-short';
  check('ADMIN_SESSION_SECRET under 32 characters: admin 404',
    (await session.GET(new Request('http://localhost/api/admin/session'))).status === 404);
  Object.assign(process.env, keep);
}

await db.end();
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
