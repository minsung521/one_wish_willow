// ?qa=1: an on-device QA overlay. main.js imports this only when the URL has
// qa=1, so no other visit downloads it or runs any of it.
//
// Top left, above everything, and pointer-events: none except for its one
// button, so it never gets in the way of the stick:
//   fps    now (last 0.5 s) · 5 s average · 5 s low
//   grab   from grabbing the stick to the snap (the snap frame included):
//          average fps, low fps, frames over 50 ms. Kept after the snap.
//   scene  scene_ready load_ms · renderer · the DPR actually applied
//   audio  AudioContext state · navigator.audioSession type/state
//   vib    navigator.vibrate · in_app_browser
//
// Reset forgets this browser (the one-time record, the client id and
// PostHog's ids) and reloads ?qa=1, so every run starts on the first screen as
// a new visitor, and /api/wish takes the next wish too.

import { visit } from './visit.js';

const WINDOW_MS = 5000; // the rolling fps window
const NOW_MS = 500; // "now" is the average over this much
const LONG_MS = 50; // a long frame: main.js caps a frame's step here (MAX_FRAME_DT)
const PAINT_MS = 250; // how often the text is refreshed

// what Reset forgets: the one-time record (localStorage + cookie) and this visit's ids
const RECORD_KEY = 'one-wish-willow';
const LOCAL_KEYS = [RECORD_KEY, 'oww_client_id', 'oww_visited', 'oww_entry'];

const CSS = `
.qa {
  position: fixed;
  left: calc(env(safe-area-inset-left, 0px) + 6px);
  top: calc(env(safe-area-inset-top, 0px) + 6px);
  z-index: 1000;
  max-width: calc(100vw - 12px);
  padding: 5px 7px 6px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.55);
  color: #d8f5d0;
  font: 10px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  white-space: pre;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}
.qa pre { margin: 0; font: inherit; }
.qa button {
  margin-top: 5px;
  padding: 4px 12px;
  min-height: 28px;
  border: 1px solid rgba(216, 245, 208, 0.5);
  border-radius: 5px;
  background: rgba(40, 10, 10, 0.8);
  color: inherit;
  font: inherit;
  pointer-events: auto;
  cursor: pointer;
  touch-action: manipulation;
}
`;

function forget() {
  for (const k of LOCAL_KEYS) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
  expireCookie(RECORD_KEY);

  // PostHog: a new distinct id and device id, no super properties, no session
  try {
    const ph = window.posthog;
    if (ph && typeof ph.reset === 'function') ph.reset(true);
  } catch {
    /* ignore */
  }
  // and its stored copy, in case the SDK never loaded (blocked, offline)
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && /^ph_.*_posthog$/.test(k)) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
  try {
    for (const c of document.cookie.split('; ')) {
      const name = c.slice(0, c.indexOf('='));
      if (/^ph_.*_posthog$/.test(name)) expireCookie(name);
    }
  } catch {
    /* ignore */
  }
}

/** Expire a cookie on this host and on each parent domain it may have been set for. */
function expireCookie(name) {
  const parts = location.hostname.split('.');
  const domains = [''];
  for (let i = 0; i < parts.length - 1; i++) domains.push('; domain=.' + parts.slice(i).join('.'));
  for (const d of domains) {
    try {
      document.cookie = name + '=; max-age=0; path=/' + d + '; SameSite=Lax';
    } catch {
      /* ignore */
    }
  }
}

function reset() {
  forget();
  location.replace(location.pathname + '?qa=1');
}

const fmt = (v, digits = 0) => (v == null || !isFinite(v) ? '–' : v.toFixed(digits));

/** fps from frame intervals (ms). */
function stats(dts) {
  if (!dts.length) return null;
  let sum = 0;
  let max = 0;
  let long = 0;
  for (const d of dts) {
    sum += d;
    if (d > max) max = d;
    if (d > LONG_MS) long++;
  }
  return { avg: (1000 * dts.length) / sum, low: 1000 / max, long };
}

export function startQA() {
  const oww = window.__oww;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'qa';
  const text = document.createElement('pre');
  text.setAttribute('aria-hidden', 'true');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Reset';
  button.setAttribute('aria-label', 'QA: reset this browser and start again');
  button.addEventListener('click', reset);
  root.append(text, button);
  document.body.appendChild(root);

  const canVibrate = typeof navigator.vibrate === 'function';
  const frames = []; // [{ t, dt }] for the last WINDOW_MS
  // from grabbing the stick to the snap; a new grab starts it over
  const grab = { state: 'none', dts: [], t0: 0, ms: 0 };
  let wasGrabbing = false;
  let snapFrame = false;
  let last = 0;
  let painted = 0;

  // a hidden tab's gap is not a frame
  document.addEventListener('visibilitychange', () => {
    last = 0;
  });

  const paint = (now) => {
    let nowSum = 0;
    let nowN = 0;
    for (let i = frames.length - 1; i >= 0 && now - frames[i].t <= NOW_MS; i--) {
      nowSum += frames[i].dt;
      nowN++;
    }
    const win = stats(frames.map((f) => f.dt));
    const g = stats(grab.dts);

    let session = 'n/a';
    if ('audioSession' in navigator) {
      try {
        const s = navigator.audioSession;
        session = `${s.type}${s.state ? '/' + s.state : ''}`;
      } catch {
        session = 'error';
      }
    }
    const renderer = oww.renderer;
    const dpr = oww.dpr;

    const lines = [
      `fps   ${fmt(nowN ? (1000 * nowN) / nowSum : null)} · 5s avg ${fmt(win && win.avg, 1)} · low ${fmt(win && win.low)}`,
      grab.state === 'none'
        ? 'grab  –'
        : `grab  avg ${fmt(g && g.avg, 1)} · low ${fmt(g && g.low)} · >${LONG_MS}ms ${g ? g.long : 0}` +
          ` · ${grab.state} ${fmt(grab.ms / 1000, 1)}s`,
      `scene ${oww.readyMs == null ? '–' : oww.readyMs + 'ms'} · ${renderer || '…'} · dpr ${dpr == null ? '…' : +dpr.toFixed(2)}` +
        ` (dev ${+(window.devicePixelRatio || 1).toFixed(2)})`,
      `audio ${oww.audio} · session ${session}`,
      `vib   ${canVibrate ? 'yes' : 'no'} · iab ${visit.inAppBrowser}`,
    ];
    text.textContent = lines.join('\n');
  };

  const frame = (now) => {
    if (last) {
      const dt = now - last;
      frames.push({ t: now, dt });
      while (frames.length && now - frames[0].t > WINDOW_MS) frames.shift();
      if (grab.state === 'grabbing' || snapFrame) {
        grab.dts.push(dt);
        grab.ms = now - grab.t0;
      }
      // the frame after the snap carries the snap's own work; then hold still
      if (snapFrame) {
        snapFrame = false;
        grab.state = 'snapped';
      }
    }
    last = now;

    const phase = oww.phase;
    const grabbing = !!(oww.st && oww.st.grab);
    if (grabbing && !wasGrabbing) {
      grab.state = 'grabbing';
      grab.dts = [];
      grab.t0 = now;
      grab.ms = 0;
    } else if (grab.state === 'grabbing' && !grabbing) {
      // let go, or snapped: main.js ends the grab at the snap
      if (phase === 'intro' || phase === 'idle') grab.state = 'released';
      else snapFrame = true;
    }
    wasGrabbing = grabbing;

    if (now - painted >= PAINT_MS) {
      painted = now;
      paint(now);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
