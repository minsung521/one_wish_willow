// Before/after captures for the likes feed at 390×844 (touch): the same test
// wishes and the same shuffle on two builds, so the screenshots and the
// number of wishes on the first screen can be compared side by side.
//
//   node scripts/dev/likes-compare.mjs <out> before=http://localhost:8083 after=http://localhost:8080
//   (env: DATABASE_URL on localhost; FONT_DIR optional, as in flow-test.mjs)

import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { chromium } from 'playwright';

const OUT = process.argv[2] || 'scripts/dev/checks/likes/compare';
const builds = process.argv.slice(3).map((a) => a.split('='));
const { DATABASE_URL, FONT_DIR } = process.env;
if (!DATABASE_URL || !/@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL)) {
  console.error('Refusing: DATABASE_URL must be a local Postgres.');
  process.exit(2);
}
await mkdir(OUT, { recursive: true });
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

export const LONG = '매일 아침 가족이 모두 건강하게 웃으며 일어나기를. I wish my little brother gets into the art school he dreams of, and that Mom finally takes a real vacation.'.slice(0, 140);
export const LINES = 'line one\nline two\n\nline four\nline five\nline six';
const TEXTS = [
  'To see the ocean with my dad one more time.',
  '다시 피아노를 칠 수 있게 해주세요.',
  'That my cat lives forever.',
  'To finally finish the novel I started ten years ago.',
  '우리 강아지가 오래 살기를',
  '세계 평화 🌍 and a quiet house',
  'I wish my little brother gets into the art school he dreams of.',
  'To pass the bar exam on my second try, and to stop being so scared of failing.',
];
const ME = randomUUID();
let mine = 0;

async function seed(myStatus) {
  await db.query('truncate likes, wishes, social_interest restart identity cascade');
  const add = async (text, client, status) => Number((await db.query(
    `insert into wishes (wish_text, char_length, client_id, moderation_status, approved_at, reviewed_at)
     values ($1, $2, $3, $4, $5, $5) returning id`,
    [text, Array.from(text).length, client, status, status === 'approved' ? new Date('2026-09-30') : null],
  )).rows[0].id);
  const ids = [];
  for (let i = 0; i < 28; i++) ids.push(await add(TEXTS[i % TEXTS.length], randomUUID(), 'approved'));
  ids.push(await add(LINES, randomUUID(), 'approved'));
  ids.push(await add(LONG, randomUUID(), 'approved'));
  for (let i = 0; i < 6; i++) {
    for (let k = 0; k < (i + 1) * 2; k++) await db.query('insert into likes (wish_id, client_id, ip_hash) values ($1, $2, $3)', [ids[3 + i * 4], randomUUID(), 'test']);
  }
  mine = await add('I wish I could hear my grandmother laugh once more, and tell her everything that happened since she left.', ME, myStatus);
  for (let k = 0; k < 12; k++) await db.query('insert into likes (wish_id, client_id, ip_hash) values ($1, $2, $3)', [mine, randomUUID(), 'test']);
}

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
async function open(base) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.route(/posthog\.com/, (r) => r.abort());
  if (FONT_DIR) {
    const files = new Set(await readdir(FONT_DIR));
    await ctx.route(/fonts\.googleapis\.com/, async (r) => r.fulfill({ contentType: 'text/css', body: await readFile(join(FONT_DIR, 'site.css'), 'utf8') }));
    await ctx.route(/fonts\.gstatic\.com/, async (r) => {
      const name = new URL(r.request().url()).pathname.slice(1).replace(/\//g, '_');
      if (!files.has(name)) return r.abort();
      r.fulfill({ contentType: 'font/woff2', body: await readFile(join(FONT_DIR, name)) });
    });
  }
  await ctx.route('**/js/config.js', async (r) => {
    const res = await r.fetch();
    r.fulfill({ response: res, body: (await res.text()).replace('LIKES_ENABLED = false', 'LIKES_ENABLED = true') });
  });
  await ctx.addInitScript((client) => {
    // the same shuffle on both builds
    let a = 20261001;
    Math.random = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    if (!localStorage.getItem('oww_client_id')) {
      localStorage.setItem('oww_client_id', client);
      localStorage.setItem('oww_last_likes', '9');
      localStorage.setItem('one-wish-willow', JSON.stringify({ state: 'wished', seed: 4242, sign: 1, at: Date.now() - 9e4, wishedAt: Date.now() - 6e4 }));
    }
  }, ME);
  const page = await ctx.newPage();
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#likes-toast.on', { timeout: 20000 });
  await page.waitForTimeout(1200);
  return { ctx, page };
}
async function feed(page) {
  await page.tap('#others-btn');
  await page.waitForFunction(() => document.querySelectorAll('#social-list > li').length > 0 && document.querySelector('.my-wish'), null, { timeout: 15000 });
  await page.waitForTimeout(1100);
  await page.evaluate(() => { document.getElementById('social').scrollTop = 0; });
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.jpg`), type: 'jpeg', quality: 80 });

const results = {};
for (const [tag, base] of builds) {
  await seed('approved');
  let { ctx, page } = await open(base);
  await shot(page, `${tag}-toast`);
  await feed(page);
  results[tag] = await page.evaluate(() => {
    const H = innerHeight;
    const items = [...document.querySelectorAll('#social-list > li')].map((li) => li.getBoundingClientRect());
    const card = document.querySelector('.my-wish').getBoundingClientRect();
    const seen = items.filter((r) => r.top < H);
    return {
      started: seen.filter((r) => r.top < H).length,
      whole: seen.filter((r) => r.bottom <= H).length,
      card: Math.round(card.height),
      row: Math.round(seen.reduce((s, r) => s + r.height, 0) / (seen.length || 1)),
    };
  });
  await shot(page, `${tag}-feed`);
  // the long wishes
  for (const [name, start] of [['long', '매일 아침'], ['lines', 'line one']]) {
    await page.evaluate((st) => {
      const p = [...document.querySelectorAll('#social-list > li p')].find((x) => x.textContent.startsWith(st));
      if (p) p.closest('li').scrollIntoView({ block: 'center' });
    }, start);
    await page.waitForTimeout(300);
    await shot(page, `${tag}-${name}`);
    const opened = await page.evaluate((st) => {
      const p = [...document.querySelectorAll('#social-list > li p')].find((x) => x.textContent.startsWith(st));
      if (!p || !p.classList.contains('can-open')) return false;
      p.click();
      p.closest('li').scrollIntoView({ block: 'center' });
      return true;
    }, start);
    if (opened) {
      await page.waitForTimeout(300);
      await shot(page, `${tag}-${name}-open`);
    }
  }
  // the email, sent
  await page.evaluate(() => { document.getElementById('social').scrollTop = 0; });
  if (await page.$('.my-wish-ask')) await page.tap('.my-wish-ask');
  const input = (await page.$('.my-wish-input')) ? '.my-wish-input' : '.my-wish .interest-input';
  await page.fill(input, 'compare@example.com');
  await page.tap((await page.$('.my-wish-submit')) ? '.my-wish-submit' : '.my-wish .interest-submit');
  await page.waitForSelector('.my-wish-done:not([hidden])');
  await page.evaluate(() => { document.activeElement.blur(); document.getElementById('social').scrollTop = 0; });
  await page.waitForTimeout(400);
  await shot(page, `${tag}-email-done`);
  await ctx.close();

  await seed('pending');
  ({ ctx, page } = await open(base));
  await feed(page);
  await shot(page, `${tag}-pending`);
  await ctx.close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
await db.end();
