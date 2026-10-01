// Checks the like API, the visitor's own wish and the sorted feed (MIN-160, MIN-196)
// against the local server (server.mjs) and a local Postgres. It empties and
// refills `wishes`, `likes` and `social_interest`, so it refuses any
// DATABASE_URL that isn't on localhost.
//
//   node scripts/dev/likes-test.mjs http://localhost:8080 [http://localhost:8081]
//   (the first server with LIKES_ENABLED=true; the optional second one without
//    it, to check the switch-off answers. env: DATABASE_URL)

import { randomUUID } from 'node:crypto';
import pg from 'pg';

const BASE = process.argv[2] || 'http://localhost:8080';
const OFF = process.argv[3] || null;
const { DATABASE_URL } = process.env;
if (!DATABASE_URL || !/@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL)) {
  console.error('Refusing: DATABASE_URL must be a local Postgres.');
  process.exit(2);
}
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

let failed = 0;
let total = 0;
function check(name, ok, detail = '') {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function call(method, path, { body, xff = '203.0.113.7', base = BASE } = {}) {
  const headers = { 'x-forwarded-for': xff };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
}
const like = (wish_id, client_id, action = 'like', xff) => call('POST', '/api/like', { body: { wish_id, client_id, action }, xff });
const mine = (client_id) => call('GET', `/api/my-wish?client_id=${client_id}`);

const ME = randomUUID();
const OTHER = randomUUID();
let ids = {};

async function seed() {
  await db.query('truncate likes, wishes, social_interest restart identity cascade');
  const add = async (text, client, status, isPrivate = false) => {
    const { rows } = await db.query(
      `insert into wishes (wish_text, char_length, client_id, moderation_status, approved_at, reviewed_at, is_private)
       values ($1, $2, $3, $4, $5, $5, $6) returning id`,
      [text, Array.from(text).length, client, status, status === 'approved' ? new Date() : null, isPrivate],
    );
    return Number(rows[0].id);
  };
  ids = { approved: [], pending: 0, rejected: 0, hidden: 0, mine: 0 };
  for (let i = 0; i < 45; i++) ids.approved.push(await add(`TEST approved #${i + 1}`, randomUUID(), 'approved'));
  ids.pending = await add('TEST pending', randomUUID(), 'pending');
  ids.rejected = await add('TEST rejected', randomUUID(), 'rejected');
  ids.hidden = await add('TEST hidden', randomUUID(), 'hidden');
  // MIN-194: approved by the maker, but kept private by the one who made it
  ids.privateApproved = await add('TEST approved but private', randomUUID(), 'approved', true);
  ids.mine = await add('TEST my own wish', ME, 'approved');
}

await seed();
const [A, B, C] = ids.approved;

// ---------------------------------------------------------------- like / unlike
{
  const r = await like(A, OTHER);
  check('like an approved wish: 200, liked, 1', r.status === 200 && r.json.liked === true && r.json.likes === 1, JSON.stringify(r.json));
  const again = await like(A, OTHER);
  check('like it again: still 1 (no duplicate)', again.status === 200 && again.json.liked === true && again.json.likes === 1);
  const { rows } = await db.query('select count(*)::int n from likes where wish_id = $1', [A]);
  check('one row in likes', rows[0].n === 1);
  const both = await Promise.all([like(B, OTHER), like(B, OTHER), like(B, OTHER)]);
  const { rows: rb } = await db.query('select count(*)::int n from likes where wish_id = $1', [B]);
  check('three simultaneous likes: one row', both.every((x) => x.status === 200) && rb[0].n === 1);
  const un = await like(A, OTHER, 'unlike');
  check('unlike: 200, not liked, 0', un.status === 200 && un.json.liked === false && un.json.likes === 0);
  const un2 = await like(A, OTHER, 'unlike');
  check('unlike again: still 0', un2.status === 200 && un2.json.likes === 0);
}

// ---------------------------------------------------------------- refused
check('own wish: 403 own_wish', await like(ids.mine, ME).then((r) => r.status === 403 && r.json.status === 'own_wish'));
check('pending wish: 404', (await like(ids.pending, OTHER)).status === 404);
check('rejected wish: 404', (await like(ids.rejected, OTHER)).status === 404);
check('hidden wish: 404', (await like(ids.hidden, OTHER)).status === 404);
check('no such wish: 404', (await like(999999, OTHER)).status === 404);
check('approved but private (MIN-194): 404 not_found, as unapproved',
  await like(ids.privateApproved, OTHER).then((r) => r.status === 404 && r.json.status === 'not_found'));
check('unliking a private wish: no count shown',
  await like(ids.privateApproved, OTHER, 'unlike').then((r) => r.status === 200 && r.json.liked === false && r.json.likes === null));
{
  const { rows } = await db.query('select count(*)::int n from likes where wish_id = any($1)', [[ids.mine, ids.pending, ids.rejected, ids.hidden, ids.privateApproved]]);
  check('no rows for refused likes', rows[0].n === 0);
}
check('bad client_id: 400', (await like(A, 'not-a-uuid')).status === 400);
check('bad wish_id: 400', (await like(-1, OTHER)).status === 400);
check('bad action: 400', (await call('POST', '/api/like', { body: { wish_id: A, client_id: OTHER, action: 'toggle' } })).status === 400);
check('not JSON: 400', (await fetch(BASE + '/api/like', { method: 'POST', body: '{' })).status === 400);

// ---------------------------------------------------------------- per-address cap
{
  const xff = '198.51.100.23';
  const answers = [];
  for (let i = 0; i < 6; i++) answers.push((await like(C, randomUUID(), 'like', xff)).status);
  check('6th like on one wish from one address: 429', answers.slice(0, 5).every((s) => s === 200) && answers[5] === 429, answers.join(','));
  check('another address can still like it', (await like(C, randomUUID(), 'like', '198.51.100.24')).status === 200);
  const { rows } = await db.query('select count(*)::int n, count(distinct ip_hash)::int h, bool_and(ip_hash ~ $2) hex from likes where wish_id = $1', [C, '^[0-9a-f]{64}$']);
  check('likes keep a hashed address, never the raw one', rows[0].n === 6 && rows[0].h === 2 && rows[0].hex === true);
}

// ---------------------------------------------------------------- seed_likes: one display rule
{
  await db.query('update wishes set seed_likes = 10 where id = $1', [B]);
  const r = await like(B, randomUUID());
  check('display = real + seed_likes (2 + 10)', r.json.likes === 12, JSON.stringify(r.json));
  await db.query('update wishes set seed_likes = 0 where id = $1', [B]);
}

// ---------------------------------------------------------------- my wish
{
  const none = await mine(randomUUID());
  check('my wish, none made: wish null', none.status === 200 && none.json.wish === null && none.json.email_submitted === false);
  check('my wish, bad id: 400', (await mine('nope')).status === 400);

  await db.query('update wishes set seed_likes = 4 where id = $1', [ids.mine]);
  for (let i = 0; i < 3; i++) await like(ids.mine, randomUUID());
  const r = await mine(ME);
  check('my wish, approved: text, status, likes = 3 + 4, like_count = 3',
    r.json.wish && r.json.wish.text === 'TEST my own wish' && r.json.wish.status === 'approved'
      && r.json.wish.likes === 7 && r.json.wish.like_count === 3, JSON.stringify(r.json));
  check('my wish: email not submitted yet', r.json.email_submitted === false);
  const e = await call('POST', '/api/interest', { body: { email: 'test@example.com', client_id: ME } });
  check('email via /api/interest: 201', e.status === 201);
  check('my wish: email submitted now', (await mine(ME)).json.email_submitted === true);

  // MIN-194: their own private wish, approved or not, reads as private with no count
  for (const status of ['approved', 'pending']) {
    await db.query(`update wishes set is_private = true, moderation_status = $2, approved_at = $3 where id = $1`,
      [ids.mine, status, status === 'approved' ? new Date() : null]);
    const p = await mine(ME);
    check(`my wish, private and ${status}: status private, no likes shown`,
      p.json.wish.status === 'private' && p.json.wish.likes === null && p.json.wish.like_count === null, JSON.stringify(p.json.wish));
  }
  await db.query('update wishes set is_private = false where id = $1', [ids.mine]);
  for (const status of ['pending', 'rejected', 'hidden']) {
    await db.query(`update wishes set moderation_status = $2, approved_at = null where id = $1`, [ids.mine, status]);
    const p = await mine(ME);
    const want = status === 'hidden' ? 'rejected' : status;
    check(`my wish, ${status}: status ${want}, no likes shown`, p.json.wish.status === want && p.json.wish.likes === null && p.json.wish.like_count === null);
  }
  await db.query(`update wishes set moderation_status = 'approved', approved_at = now(), seed_likes = 0 where id = $1`, [ids.mine]);
}

// ---------------------------------------------------------------- the sorted feed (MIN-196)
async function feedAll(client, seed, at, sort) {
  const out = [];
  let offset = 0;
  const q = sort === undefined ? '' : `&sort=${encodeURIComponent(sort)}`;
  for (let n = 0; n < 20 && offset !== null; n++) {
    const r = await call('GET', `/api/social?client_id=${client}&seed=${seed}&at=${at}&offset=${offset}${q}`);
    if (r.status !== 200) return { error: r.status };
    if (n === 0) out.sort = r.json.sort;
    out.push(...r.json.wishes);
    offset = r.json.next;
  }
  return { out, sort: out.sort };
}
const ids_ = (list) => list.map((w) => w.id);
const newestFirst = (list) => [...list].sort((a, b) => b - a);
{
  // no likes at all: Popular is still not just the newest first (ties are shuffled)
  await db.query('delete from likes');
  const now = Date.now();
  const zeroPop = await feedAll(ME, 4242, now, 'popular');
  const zeroLatest = await feedAll(ME, 4242, now, 'latest');
  check('popular with no likes anywhere: not the same as latest',
    JSON.stringify(ids_(zeroPop.out)) !== JSON.stringify(ids_(zeroLatest.out)) && zeroPop.out.every((w) => w.likes === 0));

  // likes spread so the most-liked order differs from the newest
  const fans = Array.from({ length: 8 }, () => randomUUID());
  const popular = ids.approved.slice(10, 18);
  for (let i = 0; i < popular.length; i++) {
    for (let k = 0; k <= i; k++) await like(popular[i], fans[k], 'like', `192.0.2.${k + 1}`);
  }
  await like(ids.approved[3], ME);
  const at = Date.now();
  const expectedSet = [...ids.approved].sort((a, b) => a - b).join();

  for (const sort of ['popular', 'latest', 'random']) {
    const { out, error } = await feedAll(ME, 12345, at, sort);
    check(`${sort}: answers, says its order`, !error && out.sort === sort, String(error || out.sort));
    const seen = ids_(out);
    check(`${sort}: every approved public wish but my own, once, across pages`,
      new Set(seen).size === seen.length && [...seen].sort((a, b) => a - b).join() === expectedSet);
    check(`${sort}: never my own, pending, rejected, hidden or private`,
      ![ids.mine, ids.pending, ids.rejected, ids.hidden, ids.privateApproved].some((id) => seen.includes(id)));
    check(`${sort}: each wish is { id, text, likes, liked } (no slot)`,
      out.every((w) => Object.keys(w).join() === 'id,text,likes,liked'));
    const again = await feedAll(ME, 12345, at, sort);
    check(`${sort}: same seed, same order page after page`, JSON.stringify(ids_(again.out)) === JSON.stringify(seen));
  }
  const pop = (await feedAll(ME, 12345, at, 'popular')).out;
  check('popular: most likes first, never rising', pop.every((w, k) => k === 0 || pop[k - 1].likes >= w.likes) && pop[0].id === popular[7] && pop[0].likes === 8);
  const ties = pop.filter((w) => w.likes === 0).map((w) => w.id);
  check('popular: ties are shuffled, not newest first', JSON.stringify(ties) !== JSON.stringify(newestFirst(ties)));
  const tiesOther = (await feedAll(ME, 999, at, 'popular')).out.filter((w) => w.likes === 0).map((w) => w.id);
  check('popular: another seed, another order among ties', JSON.stringify(ties) !== JSON.stringify(tiesOther));
  const lat = ids_((await feedAll(ME, 12345, at, 'latest')).out);
  check('latest: newest first', JSON.stringify(lat) === JSON.stringify(newestFirst(lat)));
  const rnd = ids_((await feedAll(ME, 12345, at, 'random')).out);
  const rnd2 = ids_((await feedAll(ME, 999, at, 'random')).out);
  check('random: neither newest first nor by likes; another seed, another order',
    JSON.stringify(rnd) !== JSON.stringify(lat) && JSON.stringify(rnd) !== JSON.stringify(ids_(pop)) && JSON.stringify(rnd) !== JSON.stringify(rnd2));

  // pages cached before MIN-196 send no sort; anything unknown is popular too
  const none = await feedAll(ME, 12345, at);
  check('no sort (an older page): popular', none.sort === 'popular' && JSON.stringify(ids_(none.out)) === JSON.stringify(ids_(pop)));
  const odd = await feedAll(ME, 12345, at, 'mixed');
  check('unknown sort: popular', odd.sort === 'popular' && JSON.stringify(ids_(odd.out)) === JSON.stringify(ids_(pop)));
  const oldPage = await call('GET', `/api/social?client_id=${ME}&seed=12345&at=${at}&offset=0`);
  check("older page's request: still mode 'mix', so it keeps its hearts", oldPage.status === 200 && oldPage.json.mode === 'mix');

  const mineLiked = pop.find((w) => w.id === ids.approved[3]);
  check('liked flag for the asking client', mineLiked && mineLiked.liked === true && pop.filter((w) => w.liked).length === 1);

  // likes arriving while it scrolls don't move the order (ranked as of `at`)
  const first = await call('GET', `/api/social?client_id=${ME}&sort=popular&seed=7&at=${at}&offset=0`);
  for (let k = 0; k < 9; k++) await like(ids.approved[40], randomUUID(), 'like', `192.0.2.${100 + k}`);
  const rest = await feedAll(ME, 7, at, 'popular');
  check('popular: likes after `at` leave the order as it was', JSON.stringify(ids_(rest.out).slice(0, 20)) === JSON.stringify(ids_(first.json.wishes)));
  const shown = rest.out.find((w) => w.id === ids.approved[40]);
  check('...while the count shown is current', shown && shown.likes === 9);

  check('bad seed: 400', (await call('GET', `/api/social?client_id=${ME}&seed=x`)).status === 400);
  check('bad client_id: 400', (await call('GET', '/api/social?client_id=nope')).status === 400);
  const old = await call('GET', '/api/social');
  check('without client_id: the old answer (newest first, before-cursor)',
    old.status === 200 && !('mode' in old.json) && old.json.wishes.length === 20
      && Object.keys(old.json.wishes[0]).join() === 'id,text' && typeof old.json.next === 'number');
}

// ---------------------------------------------------------------- switch off
if (OFF) {
  check('[off] like: 404 closed', (await call('POST', '/api/like', { body: { wish_id: A, client_id: OTHER, action: 'like' }, base: OFF })).status === 404);
  check('[off] my wish: 404 closed', (await call('GET', `/api/my-wish?client_id=${ME}`, { base: OFF })).status === 404);
  const r = await call('GET', `/api/social?client_id=${ME}&sort=latest&seed=1&offset=0`, { base: OFF });
  check('[off] feed with client_id: the old answer', r.status === 200 && !('mode' in r.json) && Object.keys(r.json.wishes[0]).join() === 'id,text');
}

await db.end();
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
