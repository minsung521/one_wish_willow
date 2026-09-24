// One Wish Willow — a single branch, a single break, a single wish.

import { mulberry32, makeNoise1D, clamp, lerp, smoothstep, easeInOut } from './util.js';
import {
  createTwig, shapeLocal, toWorld, frames, drawStem, drawLeaves, updateLeaves, kickLeaves, makeBreak,
} from './twig.js';
import { Piece, Chips } from './pieces.js';
import { Sound } from './audio.js';
import { buzz } from './haptics.js';
import { loadRecord, saveRecord } from './storage.js';
import { WishUI } from './wish.js';

const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const ctx = canvas.getContext('2d');
const fxCanvas = $('fx');
const ui = {
  title: $('title'),
  intro: $('intro'),
  tagline: $('tagline'),
  hint: $('hint'),
  credit: $('credit'),
  endMain: $('ending-main'),
  endSub: $('ending-sub'),
};

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const N = 120;
const THETA = -0.055;

// ------------------------------------------------------------------ state

let record = loadRecord();
const seed = record ? record.seed : (Math.random() * 0x7fffffff) | 0;
if (!record) {
  record = { v: 1, seed, state: 'fresh' };
  saveRecord(record);
}

const model = createTwig(seed);
const tremorNoise = makeNoise1D(mulberry32(seed + 7));
const sound = new Sound();

let W = 0, H = 0, dpr = 1;
let L = 600, r0 = 7, C = { x: 0, y: 0 }, floorY = 0, Dbreak = 180, Dmax = 110;
const tdx = Math.cos(THETA), tdy = Math.sin(THETA);
const ndx = -Math.sin(THETA), ndy = Math.cos(THETA);

let phase = 'intro'; // intro | idle | broken | wish | releasing | done | already
let time = 0;
let light = 0;
let lightTarget = 1;
let lightRate = 0.45;
let focus = 0;
let flash = 0, flashX = 0, flashY = 0;
let shake = 0, punch = 0;
let hitstop = 0;
let tSnap = -1;
let geo = null; // current world geometry of the intact branch
let pieces = [];
let piecesSaved = false;
const chips = new Chips();
const puffs = [];
let motes = [];
let glint = { u: -1, a: 0, next: 5.5 };
let hintTimer = 0;

const bend = {
  a: 0.5, aT: 0.5, d: 0, v: 0, hold: 0,
  grab: false, key: false, keyD: 0, keySign: 1, pointerId: null,
  sx: 0, sy: 0, px: 0, py: 0, off: 0,
  tension: 0, strain: 0, jolt: 0, dmg: 0, speed: 0, hover: false,
};

// Resistance curve: the branch gives easily at first, then less and less.
const GK = 2.4;
const GN = 1 - Math.exp(-GK);
const gcurve = (t) => (t <= 1 ? (1 - Math.exp(-GK * t)) / GN : 1 + 0.06 * (1 - Math.exp(-(t - 1) * 5)));
const ginv = (g) => (g >= 0.999 ? 1 : -Math.log(1 - g * GN) / GK);

// ------------------------------------------------------------------ layout

const bgCv = document.createElement('canvas');
const shadowCv = document.createElement('canvas');
const glowCv = document.createElement('canvas');
const SH = 1 / 6;
const GL = 1 / 8;

function layout() {
  W = window.innerWidth;
  H = window.innerHeight;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  fxCanvas.width = Math.round(W * dpr);
  fxCanvas.height = Math.round(H * dpr);

  const narrow = W < 640;
  L = narrow ? W * 0.88 : Math.min(W * 0.8, 780, H * 1.15);
  r0 = clamp(L * 0.015, 4.8, 11);
  C = { x: W / 2, y: H * (narrow ? 0.43 : 0.44) };
  floorY = C.y + clamp(Math.max(L * 0.3, H * 0.17), 110, 250);
  Dbreak = clamp(Math.min(W, H) * 0.3, 130, 230);
  Dmax = L * 0.19;

  shadowCv.width = Math.ceil(W * SH);
  shadowCv.height = Math.ceil(H * SH);
  glowCv.width = Math.ceil(W * GL);
  glowCv.height = Math.ceil(H * GL);
  paintBackground();
  seedMotes();

  if (pieces.length && pieces.every((p) => p.asleep) && record.pieces) restorePieces();
}

function paintBackground() {
  bgCv.width = canvas.width;
  bgCv.height = canvas.height;
  const b = bgCv.getContext('2d');
  b.setTransform(dpr, 0, 0, dpr, 0, 0);
  b.fillStyle = '#060504';
  b.fillRect(0, 0, W, H);

  const R = Math.max(W, H) * 0.8;
  const g = b.createRadialGradient(C.x, C.y - H * 0.05, 0, C.x, C.y, R);
  g.addColorStop(0, 'rgb(34,28,21)');
  g.addColorStop(0.22, 'rgb(22,18,14)');
  g.addColorStop(0.55, 'rgb(11,9,7)');
  g.addColorStop(1, 'rgb(5,4,3)');
  b.fillStyle = g;
  b.fillRect(0, 0, W, H);

  // a cone of light from somewhere above
  const topW = W * 0.035;
  const botW = L * 0.62;
  for (let k = 0; k < 6; k++) {
    const s = 1 + k * 0.1;
    b.beginPath();
    b.moveTo(C.x - topW * s, -10);
    b.lineTo(C.x + topW * s, -10);
    const bot = botW * s * (H / floorY);
    b.lineTo(C.x + bot, H);
    b.lineTo(C.x - bot, H);
    b.closePath();
    const f = clamp(floorY / H, 0.3, 0.98);
    const cg = b.createLinearGradient(0, 0, 0, H);
    cg.addColorStop(0, 'rgba(255,226,180,0)');
    cg.addColorStop(f * 0.5, 'rgba(255,226,180,0.008)');
    cg.addColorStop(f, 'rgba(255,226,180,0.014)');
    cg.addColorStop(Math.min(1, f + 0.12), 'rgba(255,226,180,0.004)');
    cg.addColorStop(1, 'rgba(255,226,180,0)');
    b.fillStyle = cg;
    b.fill();
  }

  // where the light lands
  b.save();
  b.translate(C.x, floorY + L * 0.015);
  b.scale(1, 0.13);
  const pool = b.createRadialGradient(0, 0, 0, 0, 0, L * 0.8);
  pool.addColorStop(0, 'rgba(92,74,52,0.5)');
  pool.addColorStop(0.45, 'rgba(60,48,34,0.26)');
  pool.addColorStop(1, 'rgba(40,32,22,0)');
  b.fillStyle = pool;
  b.beginPath();
  b.arc(0, 0, L * 0.8, 0, Math.PI * 2);
  b.fill();
  b.restore();

  // vignette
  const v = b.createRadialGradient(W / 2, H * 0.46, Math.min(W, H) * 0.25, W / 2, H * 0.5, Math.max(W, H) * 0.78);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.72)');
  b.fillStyle = v;
  b.fillRect(0, 0, W, H);
}

function seedMotes() {
  const rnd = mulberry32(seed + 99);
  const count = W < 640 ? 34 : 60;
  motes = [];
  for (let i = 0; i < count; i++) {
    const y = rnd() * floorY;
    motes.push({
      x: C.x + (rnd() - 0.5) * 2 * coneHalf(y),
      y,
      vx: (rnd() - 0.5) * 4,
      vy: (rnd() - 0.5) * 3,
      s: 0.5 + rnd() * 1.3,
      ph: rnd() * Math.PI * 2,
      tw: 0.4 + rnd() * 1.4,
    });
  }
}

function coneHalf(y) {
  return lerp(W * 0.035, L * 0.62, clamp(y / floorY, 0, 1.1));
}

// ------------------------------------------------------------------ input

function pointerPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function hitTest(x, y, coarse) {
  if (!geo) return null;
  const tol = coarse ? 34 : 22;
  let best = Infinity, bi = -1;
  for (let i = 0; i < geo.xs.length; i += 2) {
    const d = Math.hypot(geo.xs[i] - x, geo.ys[i] - y) - geo.rs[i];
    if (d < best) { best = d; bi = i; }
  }
  if (best > tol) return null;
  return geo.us[bi];
}

const interactive = () => (phase === 'intro' && time > 0.5) || phase === 'idle';

canvas.addEventListener('pointerdown', (e) => {
  sound.unlock();
  sound.startAmbience();
  if (!interactive() || bend.grab) return;
  const p = pointerPos(e);
  const u = hitTest(p.x, p.y, e.pointerType !== 'mouse');
  if (u == null) return;
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch { /* */ }
  startGrab(u, p.x, p.y, e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  const p = pointerPos(e);
  if (bend.grab && !bend.key && e.pointerId === bend.pointerId) {
    // coalesced events give smoother tracking on fast drags
    bend.px = p.x;
    bend.py = p.y;
    return;
  }
  if (e.pointerType === 'mouse') {
    bend.hover = interactive() && hitTest(p.x, p.y, false) != null;
    canvas.classList.toggle('can-grab', bend.hover);
  }
});

const endPointer = (e) => {
  if (bend.grab && !bend.key && e.pointerId === bend.pointerId) endGrab();
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('lostpointercapture', endPointer);
canvas.addEventListener('pointerleave', () => { if (!bend.grab) { bend.hover = false; canvas.classList.remove('can-grab'); } });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('keydown', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
    e.preventDefault();
    sound.unlock();
    sound.startAmbience();
    if (!interactive() || bend.grab) return;
    bend.key = true;
    bend.keySign = 1;
    bend.keyD = ginv(clamp(Math.abs(bend.d) / Dmax, 0, 0.999)) * Dbreak;
    startGrab(0.5, 0, 0, null);
  }
});
canvas.addEventListener('keyup', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && bend.grab && bend.key) endGrab();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && bend.grab) endGrab();
});

function startGrab(u, x, y, pointerId) {
  const b = bend;
  b.grab = true;
  b.pointerId = pointerId;
  b.sx = b.px = x;
  b.sy = b.py = y;
  b.aT = clamp(u, 0.25, 0.75);
  if (Math.abs(b.d) < 1.5) b.a = b.aT;
  const thr = Dbreak * (1 - 0.14 * b.dmg);
  b.off = Math.sign(b.d) * ginv(clamp(Math.abs(b.d) / Dmax, 0, 0.999)) * thr;
  b.strain = 0;
  sound.grab();
  buzz(6);
  kickLeaves(model, 3, Math.random);
  canvas.classList.add('grabbing');
  ui.intro.classList.add('away');
  clearTimeout(hintTimer);
  if (phase === 'intro') phase = 'idle';
}

function endGrab() {
  const b = bend;
  if (!b.grab) return;
  b.grab = false;
  b.key = false;
  b.pointerId = null;
  sound.release(b.speed + b.tension * 0.6);
  canvas.classList.remove('grabbing');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    if (!bend.grab && (phase === 'idle' || phase === 'intro')) ui.intro.classList.remove('away');
  }, 3200);
}

// ------------------------------------------------------------------ update

function updateIntact(dt) {
  const b = bend;
  b.hold = lerp(b.hold, b.grab ? 1 : 0, 1 - Math.exp(-dt * 6));
  b.a += (b.aT - b.a) * (1 - Math.exp(-dt * 10));
  const prev = b.d;

  if (b.grab) {
    let D;
    if (b.key) {
      b.keyD += Dbreak * (0.34 + 0.55 * (b.keyD / Dbreak)) * dt;
      D = b.keyD * b.keySign;
    } else {
      D = (b.px - b.sx) * ndx + (b.py - b.sy) * ndy + b.off;
    }
    const thr = Dbreak * (1 - 0.14 * b.dmg);
    const tau = Math.abs(D) / thr;
    b.tension = tau;
    const target = Math.sign(D) * Dmax * gcurve(tau);
    b.d += (target - b.d) * (1 - Math.exp(-dt * 16));
    if (dt > 0) b.v = (b.d - prev) / dt;

    if (tau > 0.55) b.dmg = Math.max(b.dmg, ((tau - 0.55) / 0.45) * 0.7);

    // the last bit of resistance before it goes
    if (tau >= 0.94) b.strain += dt * (1 + 7 * Math.min(1, (tau - 0.94) / 0.1));
    else b.strain = Math.max(0, b.strain - dt * 2);

    // fibres giving way
    if (tau > 0.45) {
      let rate = 1.2 + 16 * Math.pow((tau - 0.45) / 0.55, 2);
      rate *= 0.35 + Math.min(1.2, b.speed * 1.5);
      if (b.strain > 0) rate += 24;
      if (Math.random() < rate * dt) crackEvent(Math.min(1, tau));
    }
    if (b.strain > 0) buzz(4, 70);

    if (b.strain >= 0.24) {
      snap();
      return;
    }
  } else {
    const k = Math.pow(2 * Math.PI * 5.2, 2);
    const c = 2 * 0.15 * Math.sqrt(k);
    b.v += (-k * b.d - c * b.v) * dt;
    b.d += b.v * dt;
    b.tension = Math.max(0, b.tension - dt * 4);
    b.strain = 0;
  }
  b.jolt *= Math.exp(-dt * 22);
  b.speed = Math.abs(b.v) / Math.max(1, Dmax * 1.6);
  sound.updateCreak(b.speed, clamp(b.tension, 0, 1), b.grab);
}

function tensionSide() {
  return bend.d > 0 ? -1 : 1;
}

function crackEvent(tau) {
  const b = bend;
  sound.crack(0.2 + 0.8 * tau);
  b.jolt += Math.sign(b.d || 1) * r0 * 0.3 * (0.5 + tau);
  kickLeaves(model, 1.5 + 3 * tau, Math.random);
  buzz(tau > 0.85 ? 14 : 8, 80);
  shake = Math.max(shake, 0.05 * tau);
  if (model.fissures.length < 16 && Math.random() < 0.5) {
    model.fissures.push({
      u: b.a + (Math.random() - 0.5) * 0.035,
      side: tensionSide(),
      depth: 0.15 + Math.random() * 0.45,
      zig: Math.random() * 2 - 1,
    });
  }
}

function intactGeometry() {
  const b = bend;
  const idle = 1 - b.hold;
  let tremor = null;
  if (b.grab) {
    const amp = r0 * (0.3 * smoothstep(0.6, 1, b.tension) + 0.55 * Math.min(1, b.strain / 0.24));
    if (amp > 0.01) tremor = (u) => amp * Math.sin(Math.PI * u) * tremorNoise(time * 46 + u * 3);
  }
  const local = shapeLocal(model, N, L, r0, b.a, b.d + b.jolt, tremor);
  let along = 0;
  if (b.grab && !b.key) along = clamp(((b.px - b.sx) * tdx + (b.py - b.sy) * tdy) * 0.07, -10, 10);
  const floatY = Math.sin(time * 0.55) * 2.4 * idle;
  const cx = C.x + tdx * along + ndx * b.d * 0.1;
  const cy = C.y + floatY + tdy * along + ndy * b.d * 0.1;
  const ang = THETA + Math.sin(time * 0.37) * 0.008 * idle;
  return { g: frames(toWorld(local, cx, cy, ang)), cx, cy, ang };
}

let lastPose = null;

function snap() {
  const b = bend;
  phase = 'broken';
  tSnap = time;
  hitstop = 0.065;
  b.grab = false;
  try { if (b.pointerId != null) canvas.releasePointerCapture(b.pointerId); } catch { /* */ }
  canvas.classList.remove('grabbing', 'can-grab');
  sound.updateCreak(0, 0, false);

  const sign = Math.sign(b.d) || 1;
  const pose = lastPose;
  const bent = pose.g;
  buildPieces(b.a, b.d, sign, bent, pose);

  // throw the halves: broken ends carry on in the direction of the pull
  const s = L / 700;
  const [left, right] = pieces;
  const px = ndx * sign, py = ndy * sign;
  left.omega = sign * (4.2 + Math.random() * 2.2);
  right.omega = -sign * (4.8 + Math.random() * 2.4);
  left.vel.x = px * 160 * s - 70 * s;
  left.vel.y = py * 160 * s - 70 * s;
  right.vel.x = px * 180 * s + 80 * s;
  right.vel.y = py * 180 * s - 60 * s;

  const ig = Math.round(b.a * (N - 1));
  flashX = bent.xs[ig];
  flashY = bent.ys[ig];
  chips.burst(flashX, flashY, px, py, s, Math.random, floorY, 36);
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = (20 + Math.random() * 90) * s;
    puffs.push({ x: flashX, y: flashY, vx: Math.cos(a) * sp + px * 40, vy: Math.sin(a) * sp + py * 40, r: (4 + Math.random() * 8) * s, age: 0, life: 0.9 + Math.random() * 1.1 });
  }
  // the air moves
  for (const m of motes) {
    const dx = m.x - flashX, dy = m.y - flashY;
    const d = Math.hypot(dx, dy) + 20;
    const f = 9000 / d;
    m.vx += (dx / d) * f * 0.02;
    m.vy += (dy / d) * f * 0.02;
  }

  sound.snap();
  sound.cutAmbience(0.02);
  buzz([55, 45, 18]);
  flash = 1;
  shake = 1;
  punch = 1;
  kickLeaves(model, 16, Math.random);

  ui.intro.classList.add('gone');
  ui.title.classList.add('dim');
  lightTarget = 0.64;
  lightRate = 0.28;

  record = { v: 1, seed, state: 'broken', u: b.a, d: b.d / L, sign, at: Date.now() };
  saveRecord(record);
}

function sliceGeo(g, i0, i1) {
  return { xs: g.xs.slice(i0, i1 + 1), ys: g.ys.slice(i0, i1 + 1), rs: g.rs.slice(i0, i1 + 1), us: g.us.slice(i0, i1 + 1) };
}

function buildPieces(a, d, sign, bent, pose) {
  const brk = makeBreak(mulberry32(seed ^ 0x5bd1e995), -sign);
  const res = toWorld(shapeLocal(model, N, L, r0, a, d * 0.2, null), pose.cx, pose.cy, pose.ang);
  const ig = Math.round(a * (N - 1));
  const left = new Piece(sliceGeo(bent, 0, ig), sliceGeo(res, 0, ig), { start: { type: 'cut' }, end: brk.left }, floorY - 3);
  const right = new Piece(sliceGeo(bent, ig, N - 1), sliceGeo(res, ig, N - 1), { start: brk.right, end: { type: 'tip' } }, floorY + 10);
  pieces = [left, right];
  piecesSaved = false;
}

function restorePieces() {
  const r = record;
  const sign = r.sign || 1;
  const d = (r.d || 0.18) * L;
  const pose = { cx: C.x, cy: C.y, ang: THETA };
  const res = toWorld(shapeLocal(model, N, L, r0, r.u || 0.5, d * 0.2, null), pose.cx, pose.cy, pose.ang);
  buildPieces(r.u || 0.5, d, sign, res, pose);
  pieces.forEach((p, i) => {
    p.settleNow();
    p.da = 0;
    const s = r.pieces && r.pieces[i];
    if (s) {
      p.pos.x = W / 2 + s.x * L;
      p.pos.y = p.floor + s.y * L;
      p.ang = s.a;
      p.asleep = true;
      p.grounded = 1;
      p.flat = 1;
    }
  });
  if (!r.pieces) {
    const env = physEnv();
    for (let k = 0; k < 600 && !pieces.every((p) => p.asleep); k++) pieces.forEach((p) => p.step(1 / 120, env, k / 120));
    pieces.forEach((p) => { p.flat = 1; });
  }
  piecesSaved = !!r.pieces;
}

function physEnv() {
  return {
    g: 2500 * (L / 700) + 900,
    left: W * 0.1,
    right: W * 0.9,
    onClack: (p, s) => {
      if (phase === 'broken') {
        sound.clack(s);
        if (s > 0.25) buzz(Math.round(6 + 14 * s), 60);
      }
    },
  };
}

function savePieces() {
  record.pieces = pieces.map((p) => ({
    x: +((p.pos.x - W / 2) / L).toFixed(4),
    y: +((p.pos.y - p.floor) / L).toFixed(4),
    a: +(p.ang + (p.da || 0)).toFixed(4),
  }));
  saveRecord(record);
  piecesSaved = true;
}

function updatePieces(dt) {
  if (!pieces.length) return;
  const env = physEnv();
  const sub = 4;
  for (let k = 0; k < sub; k++) pieces.forEach((p) => p.step(dt / sub, env, time));
  pieces.forEach((p) => {
    p.flat = lerp(p.flat || 0, p.grounded ? 1 : 0, 1 - Math.exp(-dt * 3));
  });
  chips.step(dt, env.g, (s) => sound.tick(s));
  if (!piecesSaved && pieces.every((p) => p.asleep) && record.state !== 'fresh') savePieces();
}

function update(dtReal) {
  time += dtReal;

  // slow the world for a breath after the snap
  let ts = 1;
  if (hitstop > 0) {
    hitstop -= dtReal;
    ts = 0;
  } else if (tSnap >= 0) {
    const s = time - tSnap - 0.065;
    ts = s < 0.75 ? lerp(0.22, 1, easeInOut(clamp(s / 0.75, 0, 1))) : 1;
  }
  const dt = dtReal * ts;

  light = lerp(light, lightTarget, 1 - Math.exp(-dtReal * lightRate * 3));
  focus = lerp(focus, bend.hover || bend.grab ? 1 : 0, 1 - Math.exp(-dtReal * 5));
  flash *= Math.exp(-dtReal * 13);
  shake *= Math.exp(-dtReal * (shake > 0.2 ? 7 : 12));
  punch *= Math.exp(-dtReal * 5);

  if (phase === 'intro' || phase === 'idle') {
    updateIntact(dt);
    if (phase === 'intro' || phase === 'idle') {
      lastPose = intactGeometry();
      geo = lastPose.g;
      updateLeaves(geo, model, dt, L, time, 1 - bend.hold * 0.6);
    }
    // glint
    if (!bend.grab && time > glint.next && glint.u < 0) glint.u = -0.1;
    if (glint.u >= -0.1) {
      glint.u += dtReal * 0.62;
      glint.a = Math.sin(Math.PI * clamp((glint.u + 0.1) / 1.2, 0, 1)) * 0.35;
      if (glint.u > 1.1) { glint.u = -1; glint.a = 0; glint.next = time + 7 + Math.random() * 5; }
    }
  }
  if (phase !== 'intro' && phase !== 'idle') {
    updatePieces(dt);
    pieces.forEach((p) => { p.geo = frames(p.world()); updateLeaves(p.geo, model, dt, L, time, 0.15); });
  }

  if (phase === 'broken') {
    const since = time - tSnap;
    if (since > 2.8 && (pieces.every((p) => p.asleep) || since > 4.2)) {
      phase = 'wish';
      wish.show();
    }
  }

  // puffs
  for (let i = puffs.length - 1; i >= 0; i--) {
    const p = puffs[i];
    p.age += dt;
    if (p.age > p.life) { puffs.splice(i, 1); continue; }
    p.vx *= 1 - 2.2 * dt;
    p.vy *= 1 - 2.2 * dt;
    p.vy += 10 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.r += dt * 14;
  }

  // motes
  for (const m of motes) {
    m.vx *= 1 - 0.6 * dtReal;
    m.vy *= 1 - 0.6 * dtReal;
    m.x += (m.vx + Math.sin(time * 0.21 + m.ph) * 3) * dtReal;
    m.y += (m.vy + Math.cos(time * 0.17 + m.ph) * 2 - 1.2) * dtReal;
    if (m.y < -10) { m.y = floorY; m.x = C.x + (Math.random() - 0.5) * 2 * coneHalf(floorY); }
    if (m.y > floorY + 10) m.y = -5;
    const h = coneHalf(m.y) * 1.2;
    if (m.x < C.x - h) m.x = C.x + h;
    if (m.x > C.x + h) m.x = C.x - h;
  }
}

// ------------------------------------------------------------------ render

function strokeProjected(c, g, scale, widthAdd, alphaFn) {
  const n = g.xs.length;
  for (let i = 0; i < n - 1; i += 2) {
    const j = Math.min(n - 1, i + 2);
    const h = Math.max(0, floorY - g.ys[i]);
    const x0 = (g.xs[i] + h * 0.16) * scale;
    const y0 = (floorY + 2 - h * 0.035) * scale;
    const h1 = Math.max(0, floorY - g.ys[j]);
    const x1 = (g.xs[j] + h1 * 0.16) * scale;
    const y1 = (floorY + 2 - h1 * 0.035) * scale;
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.lineWidth = (g.rs[i] * 2.2 + h * widthAdd) * scale;
    c.strokeStyle = `rgba(0,0,0,${alphaFn(h).toFixed(3)})`;
    c.stroke();
  }
}

function drawShadows(geos) {
  const c = shadowCv.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, shadowCv.width, shadowCv.height);
  c.lineCap = 'round';
  for (const g of geos) strokeProjected(c, g, SH, 0.05, (h) => 0.75 * Math.exp(-h / (L * 0.5)));
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = 0.6;
  ctx.drawImage(shadowCv, 0, 0, W, H);
  ctx.restore();
}

function drawGlow(geos, amount) {
  if (amount <= 0.002) return;
  const c = glowCv.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, glowCv.width, glowCv.height);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = 'rgb(255,214,160)';
  for (const g of geos) {
    c.beginPath();
    for (let i = 0; i < g.xs.length; i += 3) {
      if (i === 0) c.moveTo(g.xs[i] * GL, g.ys[i] * GL);
      else c.lineTo(g.xs[i] * GL, g.ys[i] * GL);
    }
    c.lineWidth = (r0 * 2 + 18) * GL;
    c.stroke();
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = amount;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(glowCv, 0, 0, W, H);
  ctx.restore();
}

function drawMotes() {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const m of motes) {
    const inCone = 1 - smoothstep(0.6, 1.15, Math.abs(m.x - C.x) / coneHalf(m.y));
    const tw = 0.55 + 0.45 * Math.sin(time * m.tw + m.ph);
    const a = 0.26 * inCone * tw * smoothstep(0, floorY * 0.25, m.y);
    if (a < 0.01) continue;
    ctx.fillStyle = `rgba(255,232,196,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPuffs() {
  for (const p of puffs) {
    const q = p.age / p.life;
    const a = 0.16 * (1 - q) * (1 - q);
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
    g.addColorStop(0, `rgba(226,210,178,${a.toFixed(3)})`);
    g.addColorStop(1, 'rgba(226,210,178,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBranch(g, caps, stress, glintOpt, flat) {
  drawLeaves(ctx, g, model, L, 'back', flat);
  drawStem(ctx, g, model, { r0, startCap: caps.start, endCap: caps.end, stress, glint: glintOpt });
  drawLeaves(ctx, g, model, L, 'front', flat);
}

function contactShadow(g, a) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = `rgba(0,0,0,${a})`;
  for (let i = 0; i < g.xs.length - 2; i += 2) {
    ctx.beginPath();
    ctx.moveTo(g.xs[i] + 1.5, g.ys[i] + g.rs[i] * 0.8);
    ctx.lineTo(g.xs[i + 2] + 1.5, g.ys[i + 2] + g.rs[i + 2] * 0.8);
    ctx.lineWidth = g.rs[i] * 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bgCv, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // camera: shake and a small punch-in on the snap
  const amp = shake * (reduceMotion ? 3 : 10);
  const sx = (Math.random() - 0.5) * 2 * amp;
  const sy = (Math.random() - 0.5) * 2 * amp;
  const z = 1 + punch * (reduceMotion ? 0.004 : 0.018);
  ctx.translate(W / 2 + sx, H / 2 + sy);
  ctx.scale(z, z);
  ctx.translate(-W / 2, -H / 2);

  drawMotes();

  const intact = phase === 'intro' || phase === 'idle';
  const geos = intact ? (geo ? [geo] : []) : pieces.map((p) => p.geo).filter(Boolean);
  drawShadows(geos);

  const tensionShow = bend.grab ? bend.tension : Math.abs(bend.d) / Math.max(1, Dmax);
  const glowAmt = intact ? 0.03 + 0.035 * focus + 0.045 * smoothstep(0.5, 1, tensionShow) : 0.01;
  drawGlow(geos, glowAmt);

  if (intact && geo) {
    const stress = { u: bend.a, amount: Math.max(smoothstep(0.35, 1, tensionShow), bend.dmg * 0.35), side: tensionSide() };
    drawBranch(geo, { start: { type: 'cut' }, end: { type: 'tip' } }, stress, glint.a > 0 ? glint : null, 0);
  } else {
    for (const p of pieces) {
      if (!p.geo) continue;
      if (p.grounded) contactShadow(p.geo, 0.35 * (p.flat || 0));
      drawBranch(p.geo, p.caps, null, null, p.flat || 0);
    }
  }

  chips.draw(ctx, 1);
  drawPuffs();

  // flash at the break
  if (flash > 0.01) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const R = L * 0.45;
    const g = ctx.createRadialGradient(flashX, flashY, 0, flashX, flashY, R);
    g.addColorStop(0, `rgba(255,244,222,${(0.75 * flash).toFixed(3)})`);
    g.addColorStop(0.15, `rgba(255,220,170,${(0.25 * flash).toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,200,140,0)');
    ctx.fillStyle = g;
    ctx.fillRect(flashX - R, flashY - R, R * 2, R * 2);
    ctx.fillStyle = `rgba(255,240,220,${(0.07 * flash).toFixed(3)})`;
    ctx.fillRect(-20, -20, W + 40, H + 40);
    ctx.restore();
  }

  // overall light level
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dark = 1 - light;
  if (dark > 0.002) {
    ctx.fillStyle = `rgba(3,2,2,${dark.toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }
  // the room closes in while you pull
  const squeeze = bend.hold * 0.5 * smoothstep(0.2, 1, tensionShow);
  if (squeeze > 0.01 && intact) {
    const v = ctx.createRadialGradient(C.x, C.y, L * 0.3, C.x, C.y, Math.max(W, H) * 0.7);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, `rgba(0,0,0,${squeeze.toFixed(3)})`);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }
}

// ------------------------------------------------------------------ grain

function makeGrain() {
  const c = document.createElement('canvas');
  c.width = c.height = 180;
  const g = c.getContext('2d');
  const img = g.createImageData(180, 180);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  document.querySelector('.grain').style.backgroundImage = `url(${c.toDataURL()})`;
}

// ------------------------------------------------------------------ wish

const wish = new WishUI({
  sound,
  onConfirm: () => {
    phase = 'releasing';
    record.state = 'wished';
    record.wishedAt = Date.now();
    saveRecord(record);
    sound.wishRelease();
    buzz(28);
    lightTarget = 0.46;
    lightRate = 0.12;
    wish.release(fxCanvas, () => {
      phase = 'done';
      setTimeout(() => {
        ui.endMain.textContent = 'Your wish has been made.';
        ui.endMain.classList.add('on');
      }, 700);
      setTimeout(() => {
        ui.endSub.textContent = 'You only get one.';
        ui.endSub.classList.add('on');
      }, 3300);
    });
  },
});

// ------------------------------------------------------------------ boot

function boot() {
  makeGrain();
  layout();
  window.addEventListener('resize', layout);

  if (record.state === 'wished') {
    phase = 'already';
    restorePieces();
    lightTarget = 0.5;
    lightRate = 0.16;
    canvas.setAttribute('aria-label', 'The One Wish Willow lies broken.');
    canvas.tabIndex = -1;
    setTimeout(() => ui.title.classList.add('on', 'dim'), 400);
    setTimeout(() => {
      ui.endMain.classList.add('caps');
      ui.endMain.textContent = 'Your wish has already been made.';
      ui.endMain.classList.add('on');
    }, 1600);
    setTimeout(() => {
      ui.endSub.textContent = 'You only get one wish.';
      ui.endSub.classList.add('on');
    }, 3800);
    setTimeout(() => ui.credit.classList.add('on'), 4200);
  } else if (record.state === 'broken') {
    // broken, but the wish was never written
    phase = 'wish';
    restorePieces();
    lightTarget = 0.64;
    lightRate = 0.2;
    canvas.tabIndex = -1;
    setTimeout(() => ui.title.classList.add('on', 'dim'), 400);
    setTimeout(() => wish.show(), 1800);
  } else {
    phase = 'intro';
    lightTarget = 1;
    lightRate = 0.22;
    setTimeout(() => ui.title.classList.add('on'), 1100);
    setTimeout(() => ui.tagline.classList.add('on'), 2300);
    setTimeout(() => { if (phase === 'intro' || phase === 'idle') ui.hint.classList.add('on'); }, 4300);
    setTimeout(() => ui.credit.classList.add('on'), 4800);
  }

  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

boot();

// test hook: lets automated checks inspect state without affecting play
window.__oww = { get phase() { return phase; }, get bend() { return bend; }, get geo() { return geo; }, get pieces() { return pieces; } };
