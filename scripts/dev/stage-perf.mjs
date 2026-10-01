// MIN-195: how long a tap on "See others' wishes" takes to show the feed, how
// long a frame takes on the still screens, and which frames draw the 3D scene,
// on two builds side by side at 390×844 (touch). The APIs are answered here,
// so no database is needed; likes are measured off and on (js/config.js is
// rewritten in the browser).
//
//   npx http-server <main checkout> -p 8091 -c-1 & npx http-server . -p 8092 -c-1 &
//   node scripts/dev/stage-perf.mjs before=http://localhost:8091 after=http://localhost:8092
//   (env: N=3 runs per case)
//
// Headless Chromium draws WebGL on the CPU (SwiftShader), so the 3D frame
// costs far more here than on a phone; the before/after gap is what counts.

import { chromium } from 'playwright';

const builds = process.argv.slice(2).map((a) => a.split('='));
const N = Number(process.env.N || 3);
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

const TEXTS = ['To see the ocean with my dad one more time.', '다시 피아노를 칠 수 있게 해주세요.', 'That my cat lives forever.', 'To finally finish the novel I started ten years ago.'];
const wishes = (likes) => Array.from({ length: 20 }, (_, i) => ({ id: 100 - i, text: TEXTS[i % TEXTS.length], ...(likes ? { likes: i, liked: false } : {}) }));
const broken = () => ({ v: 2, state: 'broken', seed: 4242, sign: 1, at: Date.now() - 90_000 });
const wished = () => ({ v: 2, state: 'wished', seed: 4242, sign: 1, at: Date.now() - 90_000, wishedAt: Date.now() - 60_000 });

async function context({ likes, record }) {
  const ctx = await browser.newContext(MOBILE);
  await ctx.route(/posthog\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/, (r) => r.abort());
  await ctx.route('**/js/config.js', async (r) => {
    const res = await r.fetch();
    const text = (await res.text()).replace(/export const SOCIAL_ENABLED = (true|false);/, 'export const SOCIAL_ENABLED = true;')
      .replace(/export const LIKES_ENABLED = (true|false);/, `export const LIKES_ENABLED = ${likes};`);
    r.fulfill({ response: res, body: text });
  });
  await ctx.route('**/api/**', async (r) => {
    const u = new URL(r.request().url());
    let body = {};
    if (u.pathname === '/api/social') {
      body = likes && u.searchParams.has('client_id')
        ? { mode: 'mix', sort: u.searchParams.get('sort'), wishes: wishes(true), next: null }
        : { wishes: wishes(false), next: null };
    } else if (u.pathname === '/api/my-wish') body = { wish: null, email_submitted: false };
    await new Promise((res) => setTimeout(res, 120)); // a little network
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await ctx.addInitScript(({ rec }) => {
    if (rec && !localStorage.getItem('one-wish-willow')) localStorage.setItem('one-wish-willow', JSON.stringify(rec));
    // WebGL draw calls per animation frame, with the phase they were in
    window.__gl = { draws: 0, frames: [], on: false };
    for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!C) continue;
      for (const m of ['drawElements', 'drawArrays']) {
        const f = C.prototype[m];
        C.prototype[m] = function (...a) { window.__gl.draws++; return f.apply(this, a); };
      }
    }
    const tick = () => {
      const g = window.__gl;
      if (g.on) g.frames.push({ t: performance.now(), draws: g.draws, phase: window.__oww ? window.__oww.phase : null });
      g.draws = 0;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { rec: record });
  return ctx;
}

/** Frame intervals and the share of frames that drew the 3D scene, over `ms`. */
async function idle(page, ms = 3000) {
  await page.evaluate(() => { window.__gl.frames = []; window.__gl.on = true; });
  await page.waitForTimeout(ms);
  const f = await page.evaluate(() => { window.__gl.on = false; return window.__gl.frames; });
  const d = [];
  for (let i = 1; i < f.length; i++) d.push(f[i].t - f[i - 1].t);
  d.sort((a, b) => a - b);
  return {
    mean: d.reduce((a, b) => a + b, 0) / d.length,
    p90: d[Math.floor(d.length * 0.9)],
    drawn: Math.round((100 * f.filter((x) => x.draws > 0).length) / f.length),
  };
}

/** As likes-flow.mjs: the longest Event Timing entry for the tap, or tap → second frame after the feed opened. */
async function openTimed(page, sel, rate) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await page.evaluate(() => {
    window.__timing = { inp: 0, painted: 0, t0: 0 };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (['pointerdown', 'pointerup', 'click', 'touchend', 'mousedown', 'mouseup'].includes(e.name)) window.__timing.inp = Math.max(window.__timing.inp, e.duration);
    }).observe({ type: 'event', durationThreshold: 16 });
    const d = document.getElementById('social');
    document.addEventListener('pointerdown', (e) => { if (!window.__timing.t0) window.__timing.t0 = e.timeStamp; }, { capture: true, once: true });
    new MutationObserver((_, mo) => {
      if (!d.open) return;
      mo.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(() => { window.__timing.painted = performance.now() - window.__timing.t0; }));
    }).observe(d, { attributes: true, attributeFilter: ['open'] });
  });
  await page.tap(sel);
  await page.waitForFunction(() => window.__timing.painted > 0, null, { timeout: 15000 });
  await page.waitForTimeout(400); // let the Event Timing entries arrive
  const t = await page.evaluate(() => window.__timing);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.detach();
  return Math.round(Math.max(t.inp, t.painted));
}

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const frame = (x) => `${x.mean.toFixed(1)} ms (p90 ${x.p90.toFixed(1)}), 3D drawn on ${x.drawn}% of frames`;
let failed = false;
const check = (name, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

for (const likes of [false, true]) {
  for (const [name, base] of builds) {
    const tag = `${name}, likes ${likes ? 'on' : 'off'}`;
    const t = { wish1: [], wish4: [], revisit1: [], revisit4: [] };
    const errors = [];
    let wishIdle, feedIdle, revisitIdle, opened, after;
    // the wish screen (snapped, no wish yet), a draft in the field, then "See others' wishes"
    for (let i = 0; i < N; i++) {
      for (const rate of [1, 4]) {
        const ctx = await context({ likes, record: broken() });
        const page = await ctx.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.wish.field-on', { timeout: 30000 });
        await page.waitForTimeout(1900);
        await page.fill('#wish-input', 'a draft');
        await page.evaluate(() => document.activeElement && document.activeElement.blur());
        await page.waitForTimeout(800);
        if (rate === 1 && i === 0) wishIdle = await idle(page);
        t[`wish${rate}`].push(await openTimed(page, '#wish-others', rate));
        if (rate === 1 && i === 0) {
          await page.waitForFunction(() => document.querySelectorAll('#social-list > li').length > 0, null, { timeout: 15000 });
          feedIdle = await idle(page, 2000);
          opened = await page.evaluate(() => ({
            events: (Array.isArray(window.posthog) ? window.posthog : []).filter((c) => c[0] === 'capture' && c[1] === 'social_feed_opened').map((c) => c[2]),
            focus: document.activeElement && document.activeElement.id,
          }));
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
          after = await page.evaluate(() => ({ draft: document.getElementById('wish-input').value, open: document.getElementById('social').open, phase: window.__oww.phase }));
        }
        await ctx.close();
      }
    }
    // the revisit screen, 1.5 s after Share is up, then Share's "See others' wishes"
    for (let i = 0; i < N; i++) {
      for (const rate of [1, 4]) {
        const ctx = await context({ likes, record: wished() });
        const page = await ctx.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#share.on', { timeout: 30000 });
        await page.waitForTimeout(1500);
        if (rate === 1 && i === 0) revisitIdle = await idle(page);
        t[`revisit${rate}`].push(await openTimed(page, '#others-btn', rate));
        await ctx.close();
      }
    }
    console.log(`\n== ${tag}`);
    console.log(`wish screen → feed: CPU ×1 ${med(t.wish1)} ms ${JSON.stringify(t.wish1)}, CPU ×4 ${med(t.wish4)} ms ${JSON.stringify(t.wish4)}`);
    console.log(`revisit → feed:     CPU ×1 ${med(t.revisit1)} ms ${JSON.stringify(t.revisit1)}, CPU ×4 ${med(t.revisit4)} ms ${JSON.stringify(t.revisit4)}`);
    console.log(`frames, wish screen:      ${frame(wishIdle)}`);
    console.log(`frames, feed open:        ${frame(feedIdle)}`);
    console.log(`frames, revisit (+1.5 s): ${frame(revisitIdle)}`);
    const want = likes ? { screen: 'wish', entry: 'input_screen', has_my_wish: false, sort: 'popular' } : { screen: 'wish' };
    check(`[${tag}] social_feed_opened once, as before`, opened.events.length === 1 && JSON.stringify(opened.events[0]) === JSON.stringify(want), JSON.stringify(opened.events));
    check(`[${tag}] focus on Back once the feed is up`, opened.focus === 'social-back', opened.focus);
    check(`[${tag}] Escape: back on the wish screen, the draft kept`, !after.open && after.phase === 'wish' && after.draft === 'a draft');
    check(`[${tag}] no page errors`, errors.length === 0, errors.join(' | '));
  }
}

// a whole run, box to ending: which frames drew the 3D scene, by phase
for (const [name, base] of builds) {
  const ctx = await context({ likes: false, record: null });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__oww && window.__oww.phase === 'gate' && window.__oww.use3D, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.__gl.frames = []; window.__gl.on = true; });
  await page.tap('#gate');
  await page.waitForFunction(() => window.__oww.phase === 'intro', null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  // Space on the stage pulls it until it snaps
  await page.focus('#scene');
  await page.keyboard.down('Space');
  await page.waitForFunction(() => !['intro', 'idle'].includes(window.__oww.phase), null, { timeout: 60000 });
  await page.keyboard.up('Space');
  await page.waitForFunction(() => window.__oww.phase === 'wish', null, { timeout: 60000 });
  await page.waitForSelector('.wish.field-on', { timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.fill('#wish-input', 'a wish made in the test');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.waitForSelector('#wish-hold.ready', { timeout: 10000 });
  const hb = await page.locator('#wish-hold').boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => window.__oww.phase !== 'wish', null, { timeout: 15000 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__oww.phase === 'done', null, { timeout: 60000 });
  await page.waitForSelector('#share.on', { timeout: 30000 });
  await page.waitForTimeout(3000);
  const f = await page.evaluate(() => { window.__gl.on = false; return window.__gl.frames; });
  const by = {};
  for (const x of f) {
    by[x.phase] = by[x.phase] || { frames: 0, drawn: 0 };
    by[x.phase].frames++;
    if (x.draws > 0) by[x.phase].drawn++;
  }
  console.log(`\n== ${name}, a whole run: frames that drew the 3D scene, by phase`);
  console.log(Object.entries(by).map(([k, v]) => `${k} ${v.drawn}/${v.frames}`).join(', '));
  for (const p of ['gate', 'opening', 'intro', 'idle', 'broken', 'releasing']) {
    // a frame or two can fall between two app frames, or on the phase change
    if (by[p]) check(`[${name}] ${p}: the 3D scene drawn on (nearly) every frame`, by[p].drawn >= by[p].frames - 2, `${by[p].drawn}/${by[p].frames}`);
  }
  check(`[${name}] a whole run: no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}
await browser.close();
process.exitCode = failed ? 1 : 0;
