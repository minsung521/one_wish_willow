// Renders the link-preview image and the PNG icons from the site itself.
//
//   og.png                1200×630: the first screen (the box under its light)
//                         with one line of copy, for og:image / twitter:image
//   favicon-32.png        32×32, from favicon.svg
//   apple-touch-icon.png  180×180, from favicon.svg, full-bleed (iOS rounds it)
//
// Run from anywhere; the files are written to the repository root:
//
//   npm --prefix scripts/og install
//   npx --prefix scripts/og playwright install chromium   # if no Chromium yet
//   node scripts/og/render.mjs
//
// Nothing here is deployed (/scripts is in .vercelignore).

import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const OG = { width: 1200, height: 630 };
// The page is laid out on a large desktop screen and captured scaled down to
// 1200×630. At a 1200×630 viewport the box alone is ~620 px wide, the whole
// centre square; at this size it clamps to its largest and ends up ~470 px, so
// it and the copy sit well inside the centre 630×630 that KakaoTalk may crop to.
const LAYOUT_W = 1680;
const SCALE = OG.width / LAYOUT_W;
// The box sways and, from 3.5 s, hops every 4.5 s. At 7 s the stage light has
// all but finished fading up and the box is between hops.
const SETTLE_MS = 7000;

const HEADLINE = 'You only get one wish.';
const NOTE = 'Unofficial fan-made';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
};

/** A bare static server for the repository, on a free port. */
function serve() {
  const server = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = normalize(join(ROOT, path.endsWith('/') ? path + 'index.html' : path));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

async function renderOg(browser, origin) {
  const context = await browser.newContext({
    viewport: { width: LAYOUT_W, height: Math.round(OG.height / SCALE) },
    deviceScaleFactor: SCALE,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // no analytics, no wish API: this is not a visit
  await page.route(/posthog\.com/, (r) => r.abort());
  await page.route('**/api/**', (r) => r.abort());
  // Google Fonts are fetched from Node rather than by the browser, so a proxy
  // the bundled Chromium doesn't trust can't leave the card in fallback type.
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (r) => r.fulfill({ response: await r.fetch() }));

  // the page's timers and frames run on a clock stepped from here
  await page.clock.install();
  await page.goto(origin + '/');
  await page.waitForSelector('#gate.boxmode', { state: 'attached', timeout: 30000 });
  await page.clock.runFor(SETTLE_MS);
  if (errors.length) throw new Error('page error: ' + errors.join('; '));

  await page.addStyleTag({
    content: `
      .gate-title, .gate-go, .hint, .credit, .share { visibility: hidden !important; }
      #og-copy {
        position: fixed; left: 0; right: 0; z-index: 39;
        text-align: center; pointer-events: none;
      }
      #og-copy .line {
        margin: 0;
        font-family: "Lilita One"; font-size: 76px; line-height: 1;
        letter-spacing: 0.01em; color: #dcd9c8;
        text-shadow: 0 3px 0 rgba(0, 0, 0, 0.5);
        white-space: nowrap;
      }
      #og-note {
        position: fixed; left: 0; right: 0; z-index: 39; margin: 0;
        text-align: center; pointer-events: none;
        font-family: "Nunito"; font-weight: 700; font-size: 19px;
        letter-spacing: 0.22em; text-indent: 0.22em; text-transform: uppercase;
        color: rgba(220, 217, 200, 0.5);
      }
    `,
  });
  await page.evaluate(({ headline, note }) => {
    const box = document.getElementById('gate').getBoundingClientRect();
    const copy = document.createElement('div');
    copy.id = 'og-copy';
    copy.innerHTML = '<p class="line"></p>';
    copy.firstChild.textContent = headline;
    const small = document.createElement('p');
    small.id = 'og-note';
    small.textContent = note;
    document.body.append(copy, small);
    // the line above the box, the note below it, as the title and the prompt sit
    copy.style.top = Math.round(box.top - 40 - copy.offsetHeight) + 'px';
    small.style.top = Math.round(box.bottom + 44) + 'px';
  }, { headline: HEADLINE, note: NOTE });
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() => [document.fonts.check('76px "Lilita One"'), document.fonts.check('700 19px "Nunito"')]);
  if (!fonts.every(Boolean)) throw new Error('the card fonts did not load');
  // one more frame so the stage is drawn after the style change
  await page.clock.runFor(50);

  // everything that must survive a square crop, in output pixels: the two
  // lines of text, and the gate button, which frames the box with a margin
  const rects = await page.evaluate((scale) => {
    const r = (b) => ({ x0: b.left * scale, x1: b.right * scale, y0: b.top * scale, y1: b.bottom * scale });
    const text = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return r(range.getBoundingClientRect());
    };
    return {
      line: text(document.querySelector('#og-copy .line')),
      note: text(document.getElementById('og-note')),
      box: r(document.getElementById('gate').getBoundingClientRect()),
    };
  }, SCALE);

  const png = await page.screenshot({ type: 'png' });
  await writeFile(join(ROOT, 'og.png'), png);
  await context.close();
  return { bytes: png.length, rects };
}

async function renderIcons(browser) {
  const svg = await readFile(join(ROOT, 'favicon.svg'), 'utf8');
  const src = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const icons = [
    // keeps the SVG's rounded, transparent corners
    { file: 'favicon-32.png', size: 32, bg: 'transparent' },
    // iOS masks the corners itself and fills transparency with black, so the
    // corners get the icon's own background
    { file: 'apple-touch-icon.png', size: 180, bg: '#070605' },
  ];
  for (const { file, size, bg } of icons) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0;background:${bg}}img{display:block;width:${size}px;height:${size}px}</style><img src="${src}">`);
    await page.waitForFunction(() => document.querySelector('img').complete);
    await writeFile(join(ROOT, file), await page.screenshot({ type: 'png', omitBackground: bg === 'transparent' }));
    await page.close();
  }
}

const server = await serve();
const origin = `http://127.0.0.1:${server.address().port}`;
// SwiftShader: the same software WebGL on every machine, GPU or not
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const { bytes, rects } = await renderOg(browser, origin);
  await renderIcons(browser);
  const sq = { x0: (OG.width - OG.height) / 2, x1: (OG.width + OG.height) / 2 };
  const fmt = (r) => `x ${Math.round(r.x0)}–${Math.round(r.x1)}, y ${Math.round(r.y0)}–${Math.round(r.y1)}`;
  console.log(`og.png ${OG.width}×${OG.height}, ${(bytes / 1024).toFixed(0)} KB`);
  for (const [name, r] of Object.entries(rects)) {
    const inside = r.x0 >= sq.x0 && r.x1 <= sq.x1 && r.y0 >= 0 && r.y1 <= OG.height;
    console.log(`  ${name.padEnd(4)} ${fmt(r)}  ${inside ? 'inside' : 'OUTSIDE'} the centre square (x ${sq.x0}–${sq.x1})`);
  }
  console.log('favicon-32.png, apple-touch-icon.png');
} finally {
  await browser.close();
  server.close();
}
