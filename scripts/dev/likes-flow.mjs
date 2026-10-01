// Browser checks for likes (MIN-160), at 390×844 (touch) and 1280×800, against
// the local server (server.mjs, with LIKES_ENABLED=true) and a local Postgres
// it refills with test wishes. Saves screenshots to OUT.
//
//   node scripts/dev/likes-flow.mjs http://localhost:8080 scripts/dev/checks/likes [http://localhost:8082]
//   (env: DATABASE_URL on localhost; FONT_DIR optional, as in flow-test.mjs.
//    The optional third address serves the main branch, for the switch-off
//    comparison: the feed and the revisit screen must read the same there.)
//
// The page's LIKES_ENABLED switch is turned on only inside these browsers, by
// rewriting js/config.js on its way in; the file itself stays off. PostHog's
// SDK is blocked, so every track() stays in the snippet's queue
// (window.posthog), where the events and their properties are read back.

import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:8080';
const OUT = process.argv[3] || 'scripts/dev/checks/likes';
const MAIN = process.argv[4] || null;
const { DATABASE_URL, FONT_DIR } = process.env;
if (!DATABASE_URL || !/@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL)) {
  console.error('Refusing: DATABASE_URL must be a local Postgres.');
  process.exit(2);
}
await mkdir(OUT, { recursive: true });
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

let failed = 0;
let total = 0;
function check(name, ok, detail = '') {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.jpg`), type: 'jpeg', quality: 80 });

// ---------------------------------------------------------------- test data
const TEXTS = [
  '매일 아침 가족이 모두 건강하게 웃으며 일어나기를.',
  'To see the ocean with my dad one more time.',
  '다시 피아노를 칠 수 있게 해주세요.',
  'I wish my little brother gets into the art school he dreams of.',
  '세계 평화 🌍 and a quiet house',
  'That my cat lives forever.',
  'To finally finish the novel I started ten years ago.',
  '우리 강아지가 오래 살기를',
];
const ME = randomUUID();
let ids = {};

async function seed({ myStatus = 'approved', myLikes = 0 } = {}) {
  await db.query('truncate likes, wishes, social_interest restart identity cascade');
  const add = async (text, client, status) => {
    const { rows } = await db.query(
      `insert into wishes (wish_text, char_length, client_id, moderation_status, approved_at, reviewed_at)
       values ($1, $2, $3, $4, $5, $5) returning id`,
      [text, Array.from(text).length, client, status, status === 'approved' ? new Date() : null],
    );
    return Number(rows[0].id);
  };
  ids = { approved: [] };
  for (let i = 0; i < 30; i++) ids.approved.push(await add(i < TEXTS.length ? TEXTS[i] : `TEST approved wish #${i + 1}`, randomUUID(), 'approved'));
  ids.pending = await add('TEST someone else, pending', randomUUID(), 'pending');
  if (myStatus) ids.mine = await add('I wish I could hear my grandmother laugh once more.', ME, myStatus);
  // a spread of likes, so the most-liked order isn't the newest
  for (let i = 0; i < 6; i++) await addLikes(ids.approved[5 + i * 3], (i + 1) * 2);
  if (myStatus && myLikes) await addLikes(ids.mine, myLikes);
}
async function addLikes(wishId, n) {
  for (let k = 0; k < n; k++) await db.query('insert into likes (wish_id, client_id, ip_hash) values ($1, $2, $3)', [wishId, randomUUID(), 'test']);
}
const likeRows = async (wishId, client = ME) =>
  (await db.query('select count(*)::int n from likes where wish_id = $1 and client_id = $2', [wishId, client])).rows[0].n;

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 };

async function context(device, { likes = true, record = null, client = ME, lastShown = null } = {}) {
  const ctx = await browser.newContext({ ...device, ignoreHTTPSErrors: true });
  await ctx.route(/posthog\.com/, (r) => r.abort());
  if (FONT_DIR) {
    const files = new Set(await readdir(FONT_DIR));
    await ctx.route(/fonts\.googleapis\.com/, async (r) =>
      r.fulfill({ contentType: 'text/css', body: await readFile(join(FONT_DIR, 'site.css'), 'utf8') }));
    await ctx.route(/fonts\.gstatic\.com/, async (r) => {
      const name = new URL(r.request().url()).pathname.slice(1).replace(/\//g, '_');
      if (!files.has(name)) return r.abort();
      r.fulfill({ contentType: 'font/woff2', body: await readFile(join(FONT_DIR, name)) });
    });
  }
  await ctx.route('**/js/config.js', async (r) => {
    const res = await r.fetch();
    let text = (await res.text()).replace('SOCIAL_ENABLED = false', 'SOCIAL_ENABLED = true');
    if (likes) text = text.replace('LIKES_ENABLED = false', 'LIKES_ENABLED = true');
    r.fulfill({ response: res, body: text });
  });
  await ctx.addInitScript(({ rec, client, last }) => {
    if (!localStorage.getItem('oww_client_id')) {
      localStorage.setItem('oww_client_id', client);
      if (last !== null) localStorage.setItem('oww_last_likes', String(last));
      if (rec) localStorage.setItem('one-wish-willow', JSON.stringify(rec));
    }
  }, { rec: record, client, last: lastShown });
  return ctx;
}

const broken = () => ({ state: 'broken', seed: 4242, sign: 1, at: Date.now() - 90_000 });
const wished = () => ({ state: 'wished', seed: 4242, sign: 1, at: Date.now() - 90_000, wishedAt: Date.now() - 60_000 });

async function tap(page, sel, device) {
  if (device.hasTouch) await page.tap(sel);
  else await page.click(sel);
}
const feedOpen = (page) => page.evaluate(() => document.getElementById('social').open);
async function waitFeed(page) {
  await page.waitForFunction(() => document.getElementById('social').open
    && !document.getElementById('social-list').hasAttribute('aria-busy')
    && document.querySelectorAll('#social-list > li').length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(1000);
}
/** Every track() call so far: [{ event, props }]. */
const events = (page) => page.evaluate(() => (Array.isArray(window.posthog) ? window.posthog : [])
  .filter((c) => c[0] === 'capture').map((c) => ({ event: c[1], props: c[2] || {} })));
const lastEvent = async (page, name) => (await events(page)).filter((e) => e.event === name).pop();
const visible = (page, sel) => page.isVisible(sel);
async function toRevisit(page, url = BASE + '/') {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#share.on', { timeout: 20000 });
  await page.waitForTimeout(1600);
}
const boxOf = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null;
}, sel);
const overlaps = (a, b) => !!(a && b && a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right);

// ================================================================ 1. approved wish with likes: toast, card, hearts
async function approvedFlow(device, tag) {
  await seed({ myStatus: 'approved', myLikes: 9 });
  const ctx = await context(device, { record: wished() });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // first look: a count, no increase (nothing stored yet)
  await toRevisit(page);
  await page.waitForSelector('#likes-toast.on', { timeout: 8000 });
  await page.waitForTimeout(1000);
  const line1 = (await page.textContent('#likes-toast-line')).trim();
  check(`[${tag}] revisit toast: "9 people wished for this too.", no increase on the first look`,
    line1 === '9 people wished for this too.', line1);
  check(`[${tag}] revisit toast: the button is there`, await visible(page, '#likes-toast-go'));
  const toast = await boxOf(page, '#likes-toast');
  const clear = !overlaps(toast, await boxOf(page, '#ending-main')) && !overlaps(toast, await boxOf(page, '#ending-sub'))
    && !overlaps(toast, await boxOf(page, '#share')) && !overlaps(toast, await boxOf(page, '#credit'));
  check(`[${tag}] revisit toast covers none of the revisit screen`, clear, JSON.stringify(toast));
  check(`[${tag}] the revisit lines are unchanged`,
    (await page.textContent('#ending-main')) === 'Your wish has already been made.'
      && (await page.textContent('#ending-sub')) === 'Only one wish per life per person. No multiple attempts.');
  let e = await lastEvent(page, 'revisit_toast_shown');
  check(`[${tag}] revisit_toast_shown: like_count 9, like_delta null`, e && e.props.like_count === 9 && e.props.like_delta === null && e.props.display_like_count === 9, JSON.stringify(e));
  check(`[${tag}] stored the count shown`, (await page.evaluate(() => localStorage.getItem('oww_last_likes'))) === '9');
  await page.waitForTimeout(9000); // Share's own timer runs out; the toast stays
  check(`[${tag}] the toast doesn't go away by itself`, await page.evaluate(() => document.getElementById('likes-toast').classList.contains('on')));

  // three more likes, then back: "+3 since your last visit"
  await addLikes(ids.mine, 3);
  await toRevisit(page);
  await page.waitForSelector('#likes-toast.on', { timeout: 8000 });
  await page.waitForTimeout(1000);
  const line2 = (await page.textContent('#likes-toast-line')).trim();
  check(`[${tag}] return visit: "12 people… (+3 since your last visit)"`, line2 === '12 people wished for this too. (+3 since your last visit)', line2);
  e = await lastEvent(page, 'revisit_toast_shown');
  check(`[${tag}] revisit_toast_shown: like_count 12, like_delta 3`, e && e.props.like_count === 12 && e.props.like_delta === 3);
  await shot(page, `${tag}-01-revisit-toast-likes`);

  // the toast's button: the feed, the card first with the same increase
  await tap(page, '#likes-toast-go', device);
  await waitFeed(page);
  e = await lastEvent(page, 'revisit_toast_clicked');
  check(`[${tag}] revisit_toast_clicked with like_count, like_delta`, e && e.props.like_count === 12 && e.props.like_delta === 3);
  e = await lastEvent(page, 'social_feed_opened');
  check(`[${tag}] social_feed_opened: entry revisit_toast, has_my_wish`, e && e.props.entry === 'revisit_toast' && e.props.has_my_wish === true && e.props.screen === 'revisit', JSON.stringify(e && e.props));
  await page.waitForSelector('.my-wish', { timeout: 8000 });
  const card = await page.evaluate(() => {
    const c = document.querySelector('#social-mine .my-wish');
    const first = document.querySelector('#social-list > li');
    return {
      text: c.querySelector('.my-wish-text').textContent,
      count: c.querySelector('.my-wish-count').textContent.trim(),
      heartButton: !!c.querySelector('button.social-like'),
      above: c.getBoundingClientRect().bottom <= first.getBoundingClientRect().top,
      masked: c.querySelector('.my-wish-text').classList.contains('ph-mask'),
      inList: [...document.querySelectorAll('#social-list p')].some((p) => p.textContent.includes('grandmother laugh')),
      cta: c.querySelector('.my-wish-ask') && c.querySelector('.my-wish-ask').textContent,
    };
  });
  check(`[${tag}] my wish card: at the top, the wish, the count with the increase`,
    card.above && card.text.includes('grandmother laugh') && card.count === '12 people wished for this too. (+3 since your last visit)', card.count);
  check(`[${tag}] my wish card: no heart to press, masked in replays`, !card.heartButton && card.masked);
  check(`[${tag}] my wish is not in the list`, !card.inList);
  e = await lastEvent(page, 'my_wish_viewed');
  check(`[${tag}] my_wish_viewed: approved, like_count 12, like_delta 3`, e && e.props.status === 'approved' && e.props.like_count === 12 && e.props.like_delta === 3 && e.props.display_like_count === 12);
  check(`[${tag}] email ask shown, email_cta_shown sent`,
    card.cta === "Want to know how many people wish for this too? We'll email you." && !!(await lastEvent(page, 'email_cta_shown')));
  await page.evaluate(() => { document.getElementById('social').scrollTop = 0; });
  await shot(page, `${tag}-02-feed-my-wish-approved`);

  // hearts: a mix of pools, each with a number
  const list = await page.evaluate(() => [...document.querySelectorAll('#social-list > li')].map((li) => ({
    text: li.querySelector('p').textContent,
    count: li.querySelector('.social-like-count') && li.querySelector('.social-like-count').textContent,
    label: li.querySelector('.social-like') && li.querySelector('.social-like').textContent.trim(),
  })));
  check(`[${tag}] every wish has a heart and a number only`, list.length === 20 && list.every((x) => /^\d+$/.test(x.count) && x.label === x.count));
  check(`[${tag}] the first wish is the most liked (12)`, list[0].count === '12', list[0].count);
  const ids1 = await page.evaluate(() => [...document.querySelectorAll('#social-list > li p')].map((p) => p.textContent));
  await page.locator('#social-more').scrollIntoViewIfNeeded();
  await tap(page, '#social-more', device);
  await page.waitForFunction(() => document.querySelectorAll('#social-list > li').length >= 30);
  const all = await page.evaluate(() => [...document.querySelectorAll('#social-list > li p')].map((p) => p.textContent));
  check(`[${tag}] two pages: all 30 others, none twice`, all.length === 30 && new Set(all).size === 30 && ids1.every((t, i) => all[i] === t));
  await page.evaluate(() => { document.getElementById('social').scrollTop = 0; });

  // like the second wish: count +1 at once, pressed, stored
  const target = '#social-list > li:nth-child(2) .social-like';
  const before = Number(await page.textContent(`${target} .social-like-count`));
  const wishId = (await db.query('select id from wishes where wish_text = $1', [all[1]])).rows[0].id;
  await page.locator(target).scrollIntoViewIfNeeded();
  await tap(page, target, device);
  check(`[${tag}] like: +1 at once, pressed`, Number(await page.textContent(`${target} .social-like-count`)) === before + 1
    && (await page.getAttribute(target, 'aria-pressed')) === 'true');
  check(`[${tag}] like: the little beat runs`, await page.evaluate((s) => document.querySelector(s).classList.contains('pop'), target));
  await page.waitForTimeout(250);
  await shot(page, `${tag}-03-feed-liked`);
  await page.waitForTimeout(600);
  check(`[${tag}] like: one row in likes`, (await likeRows(wishId)) === 1);
  e = await lastEvent(page, 'wish_liked');
  check(`[${tag}] wish_liked: wish_id, position 2, slot random`, e && e.props.wish_id === Number(wishId) && e.props.position === 2 && e.props.slot === 'random', JSON.stringify(e && e.props));

  // tap twice fast: back where it was, one request settles it
  await tap(page, target, device);
  await tap(page, target, device);
  await page.waitForTimeout(1200);
  check(`[${tag}] two quick taps: still liked, still one row`, (await page.getAttribute(target, 'aria-pressed')) === 'true' && (await likeRows(wishId)) === 1);

  // a failed request goes back
  await page.route('**/api/like', (r) => setTimeout(() => r.abort('internetdisconnected').catch(() => {}), 700));
  await tap(page, target, device);
  check(`[${tag}] offline unlike: shown at once…`, (await page.getAttribute(target, 'aria-pressed')) === 'false');
  await page.waitForFunction((s) => document.querySelector(s).getAttribute('aria-pressed') === 'true', target, { timeout: 5000 }).catch(() => {});
  check(`[${tag}] …then back to liked, count restored`, (await page.getAttribute(target, 'aria-pressed')) === 'true'
    && Number(await page.textContent(`${target} .social-like-count`)) === before + 1);
  await page.unroute('**/api/like');

  // after a reload the like is still there
  await page.keyboard.press('Escape');
  await toRevisit(page);
  await page.waitForSelector('#likes-toast.on', { timeout: 8000 });
  await tap(page, '#others-btn', device);
  await waitFeed(page);
  e = await lastEvent(page, 'social_feed_opened');
  check(`[${tag}] Share's button: entry revisit_button`, e && e.props.entry === 'revisit_button' && e.props.has_my_wish === true);
  let liked = await page.evaluate((t) => {
    const li = [...document.querySelectorAll('#social-list > li')].find((x) => x.querySelector('p').textContent === t);
    return li ? li.querySelector('.social-like').getAttribute('aria-pressed') : 'missing';
  }, all[1]);
  check(`[${tag}] after a reload: still liked`, liked === 'true', liked);
  check(`[${tag}] after a reload: the card shows no increase (nothing new)`,
    (await page.textContent('.my-wish-count')).trim() === '12 people wished for this too.');

  // unlike it, reload: off
  const sel = await page.evaluate((t) => {
    const lis = [...document.querySelectorAll('#social-list > li')];
    return `#social-list > li:nth-child(${lis.findIndex((x) => x.querySelector('p').textContent === t) + 1}) .social-like`;
  }, all[1]);
  await page.locator(sel).scrollIntoViewIfNeeded();
  await tap(page, sel, device);
  await page.waitForTimeout(800);
  check(`[${tag}] unlike: no row`, (await likeRows(wishId)) === 0);
  e = await lastEvent(page, 'wish_unliked');
  check(`[${tag}] wish_unliked: wish_id, position, slot`, e && e.props.wish_id === Number(wishId) && typeof e.props.position === 'number' && typeof e.props.slot === 'string');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#share.on', { timeout: 20000 });
  await tap(page, '#others-btn', device);
  await waitFeed(page);
  liked = await page.evaluate((t) => {
    const li = [...document.querySelectorAll('#social-list > li')].find((x) => x.querySelector('p').textContent === t);
    return li ? li.querySelector('.social-like').getAttribute('aria-pressed') : 'missing';
  }, all[1]);
  check(`[${tag}] after a reload: not liked`, liked === 'false', liked);

  // the email ask, inside the card
  await page.waitForSelector('.my-wish-ask');
  await tap(page, '.my-wish-ask', device);
  await page.waitForTimeout(500);
  check(`[${tag}] email: the field opens inside the card, no dialog`,
    await visible(page, '.my-wish .interest-input') && !(await page.evaluate(() => document.getElementById('interest').open)));
  check(`[${tag}] email: the 6-month notice is under the field`, (await page.textContent('.my-wish .interest-fine')) === 'Only for this. Deleted after 6 months.');
  await page.fill('.my-wish .interest-input', 'not an email');
  await tap(page, '.my-wish .interest-submit', device);
  check(`[${tag}] email: a bad address is refused`, (await page.textContent('.my-wish .interest-error')) === 'Please check your email address.');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.waitForTimeout(300);
  await shot(page, `${tag}-04-feed-email-open`);
  await page.fill('.my-wish .interest-input', 'OWW.Test@Example.com');
  await tap(page, '.my-wish .interest-submit', device);
  await page.waitForSelector('.my-wish-done:not([hidden])', { timeout: 8000 });
  const row = (await db.query('select email from social_interest where client_id = $1', [ME])).rows[0];
  check(`[${tag}] email: stored for this client_id, lower-cased`, row && row.email === 'oww.test@example.com');
  e = await lastEvent(page, 'email_submitted');
  check(`[${tag}] email_submitted: source feed_my_wish, no address`, e && e.props.source === 'feed_my_wish' && e.props.screen === 'revisit' && !JSON.stringify(e).includes('example.com'));
  await shot(page, `${tag}-05-feed-email-done`);
  await page.keyboard.press('Escape');
  await tap(page, '#others-btn', device).catch(() => {});
  await page.waitForTimeout(300);
  if (!(await feedOpen(page))) { await page.mouse.click(5, 5); await page.waitForTimeout(300); await tap(page, '#others-btn', device); }
  await waitFeed(page);
  await page.waitForSelector('.my-wish');
  check(`[${tag}] email in: the card no longer asks`, !(await page.$('.my-wish-ask')));
  await page.keyboard.press('Escape');

  // closing the toast
  await toRevisit(page);
  await page.waitForSelector('#likes-toast.on', { timeout: 8000 });
  await tap(page, '#likes-toast-close', device);
  await page.waitForTimeout(700);
  check(`[${tag}] × closes the toast`, !(await visible(page, '#likes-toast')));
  check(`[${tag}] Share still there after closing it`, await page.evaluate(() => document.getElementById('share').classList.contains('on')));

  const leaked = await page.evaluate(() => JSON.stringify(window.posthog || []).includes('grandmother'));
  check(`[${tag}] my wish's text never reached an analytics call`, !leaked);
  check(`[${tag}] no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ================================================================ 2. pending, and approved with no likes
async function quietFlow(device, tag) {
  await seed({ myStatus: 'pending' });
  const ctx = await context(device, { record: wished() });
  const page = await ctx.newPage();
  await toRevisit(page);
  await page.waitForSelector('#likes-toast.on', { timeout: 8000 });
  await page.waitForTimeout(1000);
  check(`[${tag}] pending: toast has only the button`, !(await visible(page, '#likes-toast-line')) && await visible(page, '#likes-toast-go'));
  let e = await lastEvent(page, 'revisit_toast_shown');
  check(`[${tag}] pending: revisit_toast_shown without a count`, e && e.props.like_count === null && e.props.like_delta === null);
  await shot(page, `${tag}-06-revisit-toast-bare`);
  await tap(page, '#likes-toast-go', device);
  await waitFeed(page);
  await page.waitForSelector('.my-wish');
  const card = await page.evaluate(() => ({
    priv: document.querySelector('.my-wish-private') && document.querySelector('.my-wish-private').textContent,
    count: !!document.querySelector('.my-wish-count'),
  }));
  check(`[${tag}] pending card: "Only you can see this for now.", no count`, card.priv === 'Only you can see this for now.' && !card.count);
  e = await lastEvent(page, 'my_wish_viewed');
  check(`[${tag}] my_wish_viewed: pending`, e && e.props.status === 'pending' && e.props.like_count === null);
  check(`[${tag}] pending: nothing stored for the increase`, (await page.evaluate(() => localStorage.getItem('oww_last_likes'))) === null);
  await page.evaluate(() => { document.getElementById('social').scrollTop = 0; });
  await shot(page, `${tag}-07-feed-my-wish-pending`);
  await ctx.close();

  await db.query("update wishes set moderation_status = 'approved', approved_at = now() where id = $1", [ids.mine]);
  const ctx2 = await context(device, { record: wished() });
  const page2 = await ctx2.newPage();
  await toRevisit(page2);
  await page2.waitForSelector('#likes-toast.on', { timeout: 8000 });
  check(`[${tag}] approved, 0 likes: toast has only the button`, !(await visible(page2, '#likes-toast-line')) && await visible(page2, '#likes-toast-go'));
  await ctx2.close();

  // no wish under this client_id (it was made in another browser): no toast at all
  const ctx3 = await context(device, { record: wished(), client: randomUUID() });
  const page3 = await ctx3.newPage();
  await toRevisit(page3);
  await page3.waitForTimeout(2500);
  check(`[${tag}] no wish found: no toast`, !(await visible(page3, '#likes-toast')));
  await ctx3.close();
}

// ================================================================ 3. from the wish screen, and the ending as it was
async function wishFlow(device, tag) {
  await seed({ myStatus: null });
  const ctx = await context(device, { record: broken() });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.wish.field-on', { timeout: 20000 });
  await page.waitForTimeout(1900);
  await tap(page, '#wish-others', device);
  await waitFeed(page);
  await page.waitForTimeout(500);
  let e = await lastEvent(page, 'social_feed_opened');
  check(`[${tag}] wish screen: entry input_screen, has_my_wish false`, e && e.props.entry === 'input_screen' && e.props.has_my_wish === false && e.props.screen === 'wish');
  check(`[${tag}] no wish yet: no card`, !(await visible(page, '#social-mine')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await page.fill('#wish-input', 'OWW_LIKES_TEST a wish made in the test');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.waitForSelector('#wish-hold.ready');
  const box = await page.locator('#wish-hold').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1900);
  await page.mouse.up();
  await page.waitForFunction(() => window.__oww && window.__oww.phase === 'done', null, { timeout: 20000 });
  await page.waitForSelector('#share.on', { timeout: 20000 });
  await page.waitForTimeout(1300);
  const ending = await page.evaluate(() => ({
    main: document.getElementById('ending-main').textContent,
    sub: document.getElementById('ending-sub').textContent,
    toast: !document.getElementById('likes-toast').hidden,
    share: document.getElementById('share-btn').textContent,
    others: document.getElementById('others-btn').textContent,
  }));
  check(`[${tag}] the ending is as it was: lines, Share, no likes toast`,
    ending.main === 'Wait up to 24 hours for your wish to come true.'
      && ending.sub === 'After granting your wish, the One Wish Willow™ loses its magical properties.'
      && !ending.toast && ending.share === 'Share' && ending.others === "See others' wishes", JSON.stringify(ending));
  await shot(page, `${tag}-08-ending-unchanged`);
  await tap(page, '#others-btn', device);
  await waitFeed(page);
  await page.waitForSelector('.my-wish', { timeout: 8000 });
  e = await lastEvent(page, 'social_feed_opened');
  check(`[${tag}] ending: entry final, my (pending) wish pinned`, e && e.props.entry === 'final' && e.props.has_my_wish === true
    && (await page.textContent('.my-wish-private')) === 'Only you can see this for now.');
  await ctx.close();
}

// ================================================================ 4. the switch off: as before
async function offFlow(device, tag) {
  await seed({ myStatus: 'approved', myLikes: 5 });
  const read = async (base, likes) => {
    const ctx = await context(device, { record: wished(), likes });
    const page = await ctx.newPage();
    const urls = [];
    page.on('request', (r) => { if (r.url().includes('/api/')) urls.push(new URL(r.url()).pathname + new URL(r.url()).search); });
    await toRevisit(page, base + '/');
    await page.waitForTimeout(2000);
    const revisit = await page.evaluate(() => [...document.querySelectorAll('body *')]
      .filter((el) => el.checkVisibility && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.children.length === 0 && el.textContent.trim())
      .map((el) => el.textContent.trim()));
    await tap(page, '#others-btn', device);
    await waitFeed(page);
    const feed = await page.evaluate(() => ({
      items: [...document.querySelectorAll('#social-list > li')].map((li) => li.textContent),
      mine: document.getElementById('social-mine') ? !document.getElementById('social-mine').hidden : false,
      hearts: document.querySelectorAll('.social-like').length,
    }));
    const opened = (await events(page)).filter((e) => e.event === 'social_feed_opened').pop();
    if (!likes) await shot(page, `${tag}-09-switch-off-feed`);
    await ctx.close();
    return { revisit, feed, opened, urls };
  };
  const off = await read(BASE, false);
  check(`[${tag}] switch off: no toast, no card, no hearts`, !off.revisit.some((t) => t.includes('wished for this too')) && !off.feed.mine && off.feed.hearts === 0);
  check(`[${tag}] switch off: only the old requests (no client_id, no my-wish)`,
    off.urls.every((u) => u.startsWith('/api/social') && !u.includes('client_id')), off.urls.join(' '));
  check(`[${tag}] switch off: social_feed_opened carries only screen`, off.opened && JSON.stringify(off.opened.props) === '{"screen":"revisit"}', JSON.stringify(off.opened && off.opened.props));
  check(`[${tag}] switch off: newest first, as before`, off.feed.items[0] === 'I wish I could hear my grandmother laugh once more.' && off.feed.items.length === 20);
  if (MAIN) {
    const main = await read(MAIN, false);
    check(`[${tag}] switch off: the revisit screen reads the same as main`, JSON.stringify(main.revisit) === JSON.stringify(off.revisit), `${main.revisit.length} vs ${off.revisit.length}`);
    check(`[${tag}] switch off: the feed reads the same as main`, JSON.stringify(main.feed) === JSON.stringify(off.feed));
    check(`[${tag}] switch off: the same requests as main`, JSON.stringify(main.urls) === JSON.stringify(off.urls));
    check(`[${tag}] switch off: the same feed event as main`, JSON.stringify(main.opened) === JSON.stringify(off.opened));
  }
}

for (const [device, tag] of [[MOBILE, 'm'], [DESKTOP, 'd']]) {
  console.log(`\n== ${tag === 'm' ? 'mobile 390×844, touch' : 'desktop 1280×800'}`);
  await approvedFlow(device, tag);
  await quietFlow(device, tag);
  await wishFlow(device, tag);
  await offFlow(device, tag);
}

await browser.close();
await db.end();
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
