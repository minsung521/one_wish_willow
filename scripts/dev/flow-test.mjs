// Browser checks for the social feed (MIN-122) and the review page (MIN-183),
// at 390×844 (touch) and 1280×800, against the local server (server.mjs) and a
// local Postgres it refills with test wishes. Saves screenshots to OUT.
//
//   node scripts/dev/flow-test.mjs http://localhost:8080 scripts/dev/checks
//   (env: DATABASE_URL on localhost, ADMIN_TEST_PASSWORD; FONT_DIR optional:
//    Google Fonts files saved locally, for machines that can't reach them)
//
// The page's SOCIAL_ENABLED switch is turned on only inside these browsers, by
// rewriting js/config.js on its way in; the file itself stays off.

import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:8080';
const OUT = process.argv[3] || 'scripts/dev/checks';
const { DATABASE_URL, ADMIN_TEST_PASSWORD, FONT_DIR } = process.env;
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
const LONG = '매일 아침 가족이 모두 건강하게 웃으며 일어나기를. I wish my little brother gets into the art school he dreams of, and that Mom finally takes a real vacation.';
const MIXED = [
  LONG.slice(0, 140),
  '세계 평화 🌍 and a quiet house',
  'line one\nline two\n\nline four',
  '<img src=x onerror="window.__xss=1"> <b>not bold</b>',
  'To see the ocean with my dad one more time.',
  '다시 피아노를 칠 수 있게 해주세요.',
];

async function seed(approved) {
  await db.query('truncate wishes restart identity');
  const texts = [];
  for (let i = 0; i < 26; i++) texts.push(i < MIXED.length ? MIXED[i] : `TEST approved wish #${i + 1} — test data`);
  for (let i = 0; i < 26; i++) {
    const t = texts[i];
    const on = i < approved;
    await db.query(
      `insert into wishes (wish_text, char_length, client_id, moderation_status, approved_at, reviewed_at)
       values ($1, $2, $3, $4, $5, $5)`,
      [t, Array.from(t).length, randomUUID(), on ? 'approved' : 'pending', on ? new Date() : null],
    );
  }
  // pending ones the review page will work on
  for (const t of ['TEST pending: call me 010-1234-5678', 'TEST pending: visit www.example.com', 'TEST pending: 우리 강아지가 오래 살기를']) {
    await db.query('insert into wishes (wish_text, char_length, client_id) values ($1, $2, $3)', [t, Array.from(t).length, randomUUID()]);
  }
}

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 };

async function context(device, { social = true, record = null } = {}) {
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
    const text = await res.text();
    r.fulfill({ response: res, body: social ? text.replace('SOCIAL_ENABLED = false', 'SOCIAL_ENABLED = true') : text });
  });
  if (record) {
    await ctx.addInitScript((rec) => {
      if (!localStorage.getItem('one-wish-willow')) localStorage.setItem('one-wish-willow', JSON.stringify(rec));
    }, record);
  }
  return ctx;
}

const broken = () => ({ state: 'broken', seed: 4242, sign: 1, at: Date.now() - 90_000 });
const wished = () => ({ state: 'wished', seed: 4242, sign: 1, at: Date.now() - 90_000, wishedAt: Date.now() - 60_000 });

async function toWishScreen(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.wish.field-on', { timeout: 20000 });
  await page.waitForTimeout(1900); // the field and the link finish fading in
}

const feedOpen = (page) => page.evaluate(() => document.getElementById('social').open);
const feedCount = (page) => page.locator('#social-list > li').count();
async function waitFeed(page) {
  await page.waitForFunction(() => document.getElementById('social').open
    && !document.getElementById('social-list').hasAttribute('aria-busy'), null, { timeout: 15000 });
  await page.waitForTimeout(950); // let the wishes finish fading in
}
async function tap(page, sel, device) {
  if (device.hasTouch) await page.tap(sel);
  else await page.click(sel);
}

// ================================================================ 1. mobile: wish screen -> feed -> back
async function wishFlow(device, tag) {
  await seed(0);
  const ctx = await context(device, { record: broken() });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await toWishScreen(page);
  check(`[${tag}] wish screen shows "See others' wishes"`, await page.isVisible('#wish-others'));
  const draft = 'OWW_DRAFT 할머니와 바다를 보러 가고 싶어요\nand see the northern lights';
  await page.fill('#wish-input', draft);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.waitForTimeout(1300);
  await shot(page, `${tag}-01-wish-screen-draft`);

  // 0 approved: the empty state
  await tap(page, '#wish-others', device);
  await waitFeed(page);
  check(`[${tag}] feed opens from the wish screen`, await feedOpen(page));
  check(`[${tag}] 0 approved: empty message`, (await page.textContent('#social-status')).includes('No wishes to show yet'));
  check(`[${tag}] focus starts on Back`, await page.evaluate(() => document.activeElement.id === 'social-back'));
  await shot(page, `${tag}-02-feed-empty`);
  await tap(page, '#social-back', device);
  await page.waitForTimeout(300);
  check(`[${tag}] Back closes the feed`, !(await feedOpen(page)));
  check(`[${tag}] the draft is still in the field`, (await page.inputValue('#wish-input')) === draft);

  // 25 approved: two pages
  await seed(25);
  await tap(page, '#wish-others', device);
  await waitFeed(page);
  check(`[${tag}] first page: 20 wishes`, (await feedCount(page)) === 20);
  check(`[${tag}] the list is kept out of replays`, await page.evaluate(() => document.getElementById('social-list').classList.contains('ph-no-capture')));
  const overflow = await page.evaluate(() => document.getElementById('social').scrollWidth > document.getElementById('social').clientWidth);
  check(`[${tag}] no sideways scroll with the 140-character wish`, !overflow);
  await shot(page, `${tag}-03-feed-top`);
  await page.locator('#social-more').scrollIntoViewIfNeeded();
  await shot(page, `${tag}-04-feed-more-button`);
  await tap(page, '#social-more', device);
  await page.waitForFunction(() => document.querySelectorAll('#social-list > li').length > 20);
  await page.waitForTimeout(950);
  check(`[${tag}] See more: 25, then no more button`, (await feedCount(page)) === 25 && !(await page.isVisible('#social-more')));
  const html = await page.evaluate(() => ({
    img: document.querySelectorAll('#social-list img, #social-list b').length,
    xss: window.__xss === 1,
    text: [...document.querySelectorAll('#social-list p')].some((p) => p.textContent.startsWith('<img src=x')),
  }));
  check(`[${tag}] a wish with HTML is shown as text, not run`, html.img === 0 && !html.xss && html.text);
  const lines = await page.evaluate(() => {
    const p = [...document.querySelectorAll('#social-list p')].find((x) => x.textContent.startsWith('line one'));
    return p ? Math.round(p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight)) : 0;
  });
  check(`[${tag}] line breaks are kept`, lines >= 4, `${lines} lines`);
  await page.evaluate(() => { const d = document.getElementById('social'); d.scrollTop = d.scrollHeight; });
  await shot(page, `${tag}-05-feed-end`);

  // back with the keyboard's Escape
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(`[${tag}] Escape closes the feed`, !(await feedOpen(page)));
  check(`[${tag}] the draft survives a second visit`, (await page.inputValue('#wish-input')) === draft);
  check(`[${tag}] focus is back on "See others' wishes"`, await page.evaluate(() => document.activeElement.id === 'wish-others'));
  check(`[${tag}] no Share toast on the wish screen after the feed`, !(await page.evaluate(() => document.getElementById('share').classList.contains('on'))));
  await shot(page, `${tag}-06-back-to-wish`);

  // finish the wish: the ending, then the feed from Share's button
  await page.waitForSelector('#wish-hold.ready');
  const box = await page.locator('#wish-hold').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1900);
  await page.mouse.up();
  await page.waitForFunction(() => window.__oww && window.__oww.phase === 'done', null, { timeout: 20000 });
  const stored = await db.query("select count(*)::int n, bool_and(moderation_status = 'pending') p from wishes where wish_text like 'OWW_DRAFT%'");
  check(`[${tag}] the wish is stored, as pending`, stored.rows[0].n === 1 && stored.rows[0].p === true);
  check(`[${tag}] after the wish, the wish-screen link is gone`, !(await page.isVisible('#wish-others')));
  await page.waitForSelector('#share.on', { timeout: 20000 });
  await page.waitForTimeout(1300);
  await shot(page, `${tag}-07-ending-share`);
  await tap(page, '#others-btn', device);
  await waitFeed(page);
  check(`[${tag}] ending: "See others' wishes" opens the feed, not the email dialog`,
    (await feedOpen(page)) && !(await page.evaluate(() => document.getElementById('interest').open)));
  check(`[${tag}] ending: the just-made (pending) wish is not in the feed`,
    !(await page.evaluate(() => document.getElementById('social-list').textContent.includes('OWW_DRAFT'))));
  await tap(page, '#social-back', device);
  await page.waitForTimeout(300);
  check(`[${tag}] ending: Back returns, Share toast still up`, !(await feedOpen(page)) && await page.evaluate(() => document.getElementById('share').classList.contains('on')));

  // revisit
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#share.on', { timeout: 20000 });
  await page.waitForTimeout(1300);
  await shot(page, `${tag}-08-revisit`);
  await tap(page, '#others-btn', device);
  await waitFeed(page);
  check(`[${tag}] revisit: opens the feed`, (await feedOpen(page)) && (await feedCount(page)) === 20);
  await tap(page, '#social-back', device);
  await page.waitForTimeout(300);
  check(`[${tag}] revisit: Back returns to the revisit screen, no wish field`,
    !(await feedOpen(page)) && !(await page.isVisible('#wish-input')) && (await page.textContent('#ending-main')).includes('already'));

  const leaked = await page.evaluate(() => JSON.stringify(window.posthog || []).includes('OWW_DRAFT'));
  check(`[${tag}] the wish text never reached an analytics call`, !leaked);
  check(`[${tag}] no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ================================================================ 2. errors, retry, hide
async function errorFlow(device, tag) {
  await seed(25);
  const ctx = await context(device, { record: wished() });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#share.on', { timeout: 20000 });

  // the network drops
  await page.route('**/api/social*', (r) => r.abort('internetdisconnected'));
  await tap(page, '#others-btn', device);
  await waitFeed(page);
  check(`[${tag}] offline: error message and Try again`,
    (await page.textContent('#social-status')).includes("Couldn't load") && (await page.textContent('#social-more')) === 'Try again');
  await shot(page, `${tag}-09-feed-offline`);
  await page.unroute('**/api/social*');
  await tap(page, '#social-more', device);
  await waitFeed(page);
  check(`[${tag}] Try again loads the wishes`, (await feedCount(page)) === 20 && (await page.textContent('#social-status')) === '');

  // the second page fails, then succeeds
  await page.route('**/api/social?before=*', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"status":"unavailable"}' }));
  await tap(page, '#social-more', device);
  await page.waitForFunction(() => document.getElementById('social-more').textContent === 'Try again');
  check(`[${tag}] a failed second page keeps the first 20 and offers Try again`, (await feedCount(page)) === 20);
  await page.unroute('**/api/social?before=*');
  await tap(page, '#social-more', device);
  await page.waitForFunction(() => document.querySelectorAll('#social-list > li').length === 25);
  check(`[${tag}] Try again loads the rest`, true);

  // server switch off: answered like an error, with a retry
  await page.keyboard.press('Escape');
  await page.route('**/api/social*', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"status":"closed"}' }));
  await tap(page, '#others-btn', device);
  await waitFeed(page);
  check(`[${tag}] server switch off (404): error state, no wishes`, (await feedCount(page)) === 0 && (await page.textContent('#social-more')) === 'Try again');
  await page.unroute('**/api/social*');
  await page.keyboard.press('Escape');

  // an approved wish is hidden: gone on the next open
  const { rows } = await db.query("select id from wishes where wish_text like 'To see the ocean%'");
  const hiddenId = rows[0].id;
  await db.query("update wishes set moderation_status = 'hidden', approved_at = null, reviewed_at = now() where id = $1", [hiddenId]);
  await tap(page, '#others-btn', device);
  await waitFeed(page);
  await tap(page, '#social-more', device);
  await page.waitForFunction(() => !document.getElementById('social-list').hasAttribute('aria-busy') && document.getElementById('social-more').hidden);
  const shown = await page.evaluate(() => document.getElementById('social-list').textContent.includes('To see the ocean'));
  check(`[${tag}] a hidden wish is gone from the feed`, !shown && (await feedCount(page)) === 24);
  await ctx.close();
}

// ================================================================ 3. switch off: the email dialog stays
async function flagOffFlow(device, tag) {
  const ctx = await context(device, { social: false, record: wished() });
  const page = await ctx.newPage();
  let socialCalls = 0;
  page.on('request', (r) => { if (r.url().includes('/api/social')) socialCalls++; });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#share.on', { timeout: 20000 });
  await tap(page, '#others-btn', device);
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => ({ interest: document.getElementById('interest').open, social: document.getElementById('social').open }));
  check(`[${tag}] SOCIAL_ENABLED off: the email dialog opens, not the feed`, state.interest && !state.social && socialCalls === 0);
  await shot(page, `${tag}-10-flag-off-email`);
  await ctx.close();

  const ctx2 = await context(device, { social: false, record: broken() });
  const p2 = await ctx2.newPage();
  await toWishScreen(p2);
  check(`[${tag}] SOCIAL_ENABLED off: no link on the wish screen`, !(await p2.isVisible('#wish-others')));
  await ctx2.close();
}

// ================================================================ 4. keyboard on a desktop
async function keyboardFlow(tag) {
  await seed(25);
  const ctx = await context(DESKTOP, { record: broken() });
  const page = await ctx.newPage();
  await toWishScreen(page);
  await page.focus('#wish-input');
  await page.keyboard.type('OWW_KEYS a wish typed with keys');
  let hops = 0;
  while (hops++ < 10 && !(await page.evaluate(() => document.activeElement.id === 'wish-others'))) await page.keyboard.press('Tab');
  check(`[${tag}] Tab reaches "See others' wishes"`, await page.evaluate(() => document.activeElement.id === 'wish-others'));
  await page.keyboard.press('Enter');
  await waitFeed(page);
  check(`[${tag}] Enter opens the feed, focus on Back`, (await feedOpen(page)) && await page.evaluate(() => document.activeElement.id === 'social-back'));
  await page.keyboard.press('Tab');
  check(`[${tag}] Tab moves to See more (focus stays in the feed)`, await page.evaluate(() => document.activeElement.id === 'social-more'));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#social-list > li').length === 25);
  const focusIn = await page.evaluate(() => document.getElementById('social').contains(document.activeElement));
  check(`[${tag}] after the last page, focus stays inside the feed`, focusIn);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(`[${tag}] Escape: closed, focus back, draft kept`,
    !(await feedOpen(page)) && await page.evaluate(() => document.activeElement.id === 'wish-others')
    && (await page.inputValue('#wish-input')) === 'OWW_KEYS a wish typed with keys');
  await ctx.close();
}

// ================================================================ 5. the review page
async function adminFlow(device, tag) {
  await seed(3);
  const ctx = await context(device);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let patches = 0;
  page.on('request', (r) => { if (r.method() === 'PATCH') patches++; });
  const thirdParty = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (!['localhost', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(u.hostname)) thirdParty.push(u.hostname); });

  await page.goto(BASE + '/admin/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login:not([hidden])');
  check(`[${tag}] admin: not logged in -> login form, no list`, !(await page.isVisible('#review')));
  await shot(page, `${tag}-11-admin-login`);
  await page.fill('#password', 'wrong-password-123456');
  await page.click('#login-submit');
  await page.waitForFunction(() => document.getElementById('login-error').textContent.length > 0);
  check(`[${tag}] admin: wrong password -> message`, (await page.textContent('#login-error')).includes('맞지 않습니다'));
  await page.fill('#password', ADMIN_TEST_PASSWORD);
  await page.click('#login-submit');
  await page.waitForSelector('#review:not([hidden])');
  await page.waitForSelector('.card');
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie + location.href);
  check(`[${tag}] admin: password not in storage, JS-readable cookies or URL`, !storage.includes(ADMIN_TEST_PASSWORD) && !storage.includes('oww_admin'));
  const cards = await page.locator('.card').count();
  check(`[${tag}] admin: pending list shows the 26 pending, 20 on the first page`, cards === 20 && (await page.textContent('[data-count="pending"]')) === '26');
  const flags = await page.locator('.card .flags:not([hidden])').allTextContents();
  check(`[${tag}] admin: phone and link hints shown`, flags.some((f) => f.includes('전화번호')) && flags.some((f) => f.includes('링크')));
  await shot(page, `${tag}-12-admin-pending`);

  // approve the newest one (double tap: one request)
  const first = page.locator('.card').first();
  const id = Number(await first.getAttribute('data-id'));
  const approve = first.locator('button', { hasText: '승인' });
  await approve.dblclick();
  await page.waitForFunction((i) => !document.querySelector(`.card[data-id="${i}"]`), id);
  check(`[${tag}] admin: double tap on Approve sends one request`, patches === 1, `${patches}`);
  check(`[${tag}] admin: counts move (pending 25, approved 4)`,
    (await page.textContent('[data-count="pending"]')) === '25' && (await page.textContent('[data-count="approved"]')) === '4');
  let feed = await (await fetch(BASE + '/api/social')).json();
  check(`[${tag}] admin: approved wish appears in the public feed`, feed.wishes.some((w) => w.id === id));
  await shot(page, `${tag}-13-admin-approved-toast`);

  // reject the next one
  const second = page.locator('.card').first();
  const rid = Number(await second.getAttribute('data-id'));
  await second.locator('button', { hasText: '반려' }).click();
  await page.waitForFunction((i) => !document.querySelector(`.card[data-id="${i}"]`), rid);
  feed = await (await fetch(BASE + '/api/social')).json();
  check(`[${tag}] admin: rejected wish stays out of the feed`, !feed.wishes.some((w) => w.id === rid));

  // hide the approved one
  await page.click('#tabs button[data-status="approved"]');
  await page.waitForSelector(`.card[data-id="${id}"]`);
  await shot(page, `${tag}-14-admin-approved-tab`);
  await page.locator(`.card[data-id="${id}"] button`, { hasText: '숨김' }).click();
  await page.waitForFunction((i) => !document.querySelector(`.card[data-id="${i}"]`), id);
  feed = await (await fetch(BASE + '/api/social')).json();
  check(`[${tag}] admin: hidden wish is gone from the public feed at once`, !feed.wishes.some((w) => w.id === id));
  const row = (await db.query('select moderation_status s, approved_at a, reviewed_at r from wishes where id = $1', [id])).rows[0];
  check(`[${tag}] admin: DB after hide: hidden, approved_at NULL, reviewed_at set`, row.s === 'hidden' && row.a === null && row.r);

  // someone else got there first
  await page.click('#tabs button[data-status="pending"]');
  await page.waitForSelector('.card');
  const stale = page.locator('.card').first();
  const sid = Number(await stale.getAttribute('data-id'));
  await db.query("update wishes set moderation_status = 'rejected', reviewed_at = now() where id = $1", [sid]);
  await stale.locator('button', { hasText: '승인' }).click();
  await page.waitForFunction((i) => !document.querySelector(`.card[data-id="${i}"]`), sid);
  check(`[${tag}] admin: stale card -> says it was already handled`, (await page.textContent('#list-status')).includes('이미 다른 곳에서'));
  const srow = (await db.query('select moderation_status s from wishes where id = $1', [sid])).rows[0];
  check(`[${tag}] admin: stale approve did not override`, srow.s === 'rejected');

  // logout
  await page.click('#logout');
  await page.waitForSelector('#login:not([hidden])');
  const after = await page.evaluate(async () => (await fetch('/api/admin/wishes')).status);
  check(`[${tag}] admin: after logout the list API answers 401`, after === 401);
  check(`[${tag}] admin: no analytics or third-party requests`, thirdParty.length === 0, thirdParty.join(','));
  check(`[${tag}] admin: no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}

try {
  await wishFlow(MOBILE, 'm');
  await errorFlow(MOBILE, 'm');
  await flagOffFlow(MOBILE, 'm');
  await adminFlow(MOBILE, 'm');
  await wishFlow(DESKTOP, 'd');
  await keyboardFlow('d');
  await adminFlow(DESKTOP, 'd');
} finally {
  await browser.close();
  await db.end();
}
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
