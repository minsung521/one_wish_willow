// One Wish Willow — one stick, one snap, one wish.

import { mulberry32, makeNoise1D, clamp, lerp, smoothstep, easeInOut } from './util.js';
import { createWillow, renderWillow, makeFracture, makePieces, drawCrack } from './willow.js';
import { loadModel, Stage } from './stage.js';
import { RigidPiece, Chips } from './pieces.js';
import { Sound } from './audio.js';
import { buzz } from './haptics.js';
import { loadRecord, saveRecord } from './storage.js';
import { WishUI } from './wish.js';

const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const ctx = canvas.getContext('2d');
const fxCanvas = $('fx');
const ui = {
  gate: $('gate'),
  gateGo: $('gate-go'),
  gateTitle: $('gate-title'),
  credit: $('credit'),
  hint: $('hint'),
  endMain: $('ending-main'),
  endSub: $('ending-sub'),
};

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = window.matchMedia('(pointer: coarse)').matches;
const THETA = -0.03;
const OPEN_T = 1.9; // seconds from tapping the box to holding the willow
const BOX_TO_WILLOW = 1.428 / 1.835; // willow length / box length in the model

// ------------------------------------------------------------------ state

let record = loadRecord();
const seed = record ? record.seed : (Math.random() * 0x7fffffff) | 0;
if (!record) {
  record = { v: 2, seed, state: 'fresh' };
  saveRecord(record);
}

const willow = createWillow(seed);
// where the willow breaks, in model units along its length (0 = centre)
const X0 = (mulberry32(seed + 3)() - 0.5) * 0.06;
const tremorNoise = makeNoise1D(mulberry32(seed + 7));
const sound = new Sound();

let W = 0, H = 0, dpr = 1;
let L = 0, C = { x: 0, y: 0 }, floorY = 0, Dbreak = 150;
const ndx = -Math.sin(THETA), ndy = Math.cos(THETA);

let R = null; // the painted stick (fallback when WebGL is unavailable)
let stage = null; // the 3D model (box + willow)
let use3D = false;
let geom = null; // stick silhouette in stick-local px: { R0, yc, r, rTop, rBot }
let frac = null; // where it will break, once we know which way it is pulled
let partsCache = null;

let phase = 'gate'; // gate | opening | intro | idle | broken | wish | releasing | done | already
let time = 0;
let light = 0;
let lightTarget = 0;
let lightRate = 0.3;
let flash = 0, flashX = 0, flashY = 0;
let shake = 0, punch = 0;
let hitstop = 0;
let tSnap = -1;
let pieces = [];
let piecesSaved = false;
const chips = new Chips();
const puffs = [];
let motes = [];
let pose = { x: 0, y: 0, ang: THETA };
let hintTimer = 0;
let grabbedOnce = false;
// the box on the first screen
const box = { x: 0, y: 0, len: 0, t0: 0, open: -1, hover: 0, pop: 0, nudge: 0, lastNudge: 0 };

const st = {
  grab: false, key: false, keyD: 0, pointerId: null,
  sx: 0, sy: 0, px: 0, py: 0, gx: 0,
  tension: 0, speed: 0, strain: 0, crack: 0, sign: 1,
  disp: 0, dispV: 0, tilt: 0, tiltV: 0, jolt: 0, hold: 0,
};

// ------------------------------------------------------------------ layout

const bgCv = document.createElement('canvas');
let renderTimer = 0;

function renderScale() {
  let S = clamp(dpr * 1.25, 2, 3);
  const area = (L * 1.08) * (L * 0.2);
  const max = 900000;
  if (area * S * S > max) S = Math.max(1.25, Math.sqrt(max / area));
  return S;
}

function layout() {
  W = window.innerWidth;
  H = window.innerHeight;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  for (const cv of [canvas, fxCanvas]) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
  }
  const narrow = W < 640;
  const newL = use3D
    ? Math.round(narrow ? Math.min(W * 0.74, 340) : clamp(Math.min(W * 0.44, H * 0.78), 360, 580))
    : Math.round(narrow ? Math.min(W * 0.74, 360) : clamp(Math.min(W * 0.5, H * 0.85), 380, 640));
  box.len = Math.round(narrow ? Math.min(W * 0.8, 420) : clamp(Math.min(W * 0.5, H * 0.95), 420, 640));
  box.x = W / 2;
  box.y = H * 0.47;
  C = { x: W / 2, y: H * 0.46 };
  floorY = C.y + clamp(Math.max(newL * 0.34, H * 0.16), 100, 230);
  Dbreak = clamp(Math.min(W, H) * 0.24, 110, 200);
  ui.hint.style.top = Math.round(floorY + 30) + 'px';
  paintBackground();
  seedMotes();

  if (use3D) {
    stage.resize(W, H, dpr);
    const changed = Math.abs(newL - L) > 1;
    L = newL;
    geom = geom3D(L);
    placeGate();
    if (changed && pieces.length && pieces.every((p) => p.asleep) && record.pieces) restorePieces();
    return;
  }

  if (!R) {
    L = newL;
    R = renderWillow(willow, L, renderScale());
    geom = R.geom;
  } else if (Math.abs(newL - L) > 1) {
    // repaint once the resizing settles
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      const busy = st.grab || (pieces.length && !pieces.every((p) => p.asleep));
      if (busy) return;
      L = newL;
      R = renderWillow(willow, L, renderScale());
      geom = R.geom;
      frac = null;
      partsCache = null;
      if (pieces.length) restorePieces();
    }, 220);
  } else if (pieces.length && pieces.every((p) => p.asleep) && record.pieces) {
    restorePieces();
  }
}

/** The 3D willow's silhouette, measured from the model, in stick-local px. */
function geom3D(len) {
  const prof = stage.model.willow.profile;
  const at = (x) => prof.at(x / len);
  return {
    R0: len * Math.max(...prof.ry) * 0.85,
    yc: (x) => -at(x).cy * len,
    r: (x) => at(x).ry * len,
    rTop: (x) => at(x).ry * len,
    rBot: (x) => at(x).ry * len,
  };
}

/** Put the (invisible) box button and the title where the 3D box is. */
function placeGate() {
  if (!use3D || phase !== 'gate') return;
  drawBox(0);
  const r = stage.boxRect();
  const pad = 14;
  Object.assign(ui.gate.style, {
    left: Math.round(r.x0 - pad) + 'px',
    top: Math.round(r.y0 - pad) + 'px',
    width: Math.round(r.x1 - r.x0 + pad * 2) + 'px',
    height: Math.round(r.y1 - r.y0 + pad * 2) + 'px',
  });
  ui.gateTitle.style.top = Math.max(24, Math.round(r.y0 - (W < 640 ? 78 : 96))) + 'px';
}

function paintBackground() {
  bgCv.width = Math.round(W * dpr);
  bgCv.height = Math.round(H * dpr);
  const b = bgCv.getContext('2d');
  b.setTransform(dpr, 0, 0, dpr, 0, 0);
  b.fillStyle = '#030303';
  b.fillRect(0, 0, W, H);

  const Rg = Math.max(W, H) * 0.8;
  const g = b.createRadialGradient(C.x, C.y - H * 0.04, 0, C.x, C.y, Rg);
  g.addColorStop(0, 'rgb(17,14,11)');
  g.addColorStop(0.24, 'rgb(10,8,7)');
  g.addColorStop(0.6, 'rgb(5,4,4)');
  g.addColorStop(1, 'rgb(2,2,2)');
  b.fillStyle = g;
  b.fillRect(0, 0, W, H);

  // a narrow cone of light from above
  const topW = W * 0.03;
  const botW = Math.max(160, W < 640 ? W * 0.42 : 360);
  const f = clamp(floorY / H, 0.3, 0.98);
  for (let k = 0; k < 5; k++) {
    const s = 1 + k * 0.12;
    b.beginPath();
    b.moveTo(C.x - topW * s, -10);
    b.lineTo(C.x + topW * s, -10);
    b.lineTo(C.x + botW * s * (H / floorY), H);
    b.lineTo(C.x - botW * s * (H / floorY), H);
    b.closePath();
    const cg = b.createLinearGradient(0, 0, 0, H);
    cg.addColorStop(0, 'rgba(255,226,180,0)');
    cg.addColorStop(f * 0.5, 'rgba(255,226,180,0.0035)');
    cg.addColorStop(f, 'rgba(255,226,180,0.007)');
    cg.addColorStop(Math.min(1, f + 0.1), 'rgba(255,226,180,0.002)');
    cg.addColorStop(1, 'rgba(255,226,180,0)');
    b.fillStyle = cg;
    b.fill();
  }

  // where the light lands
  b.save();
  b.translate(C.x, floorY + 6);
  b.scale(1, 0.12);
  const poolR = botW * 1.25;
  const pool = b.createRadialGradient(0, 0, 0, 0, 0, poolR);
  pool.addColorStop(0, 'rgba(60,48,35,0.34)');
  pool.addColorStop(0.5, 'rgba(40,32,24,0.16)');
  pool.addColorStop(1, 'rgba(30,24,18,0)');
  b.fillStyle = pool;
  b.beginPath();
  b.arc(0, 0, poolR, 0, Math.PI * 2);
  b.fill();
  b.restore();

  const v = b.createRadialGradient(W / 2, H * 0.46, Math.min(W, H) * 0.22, W / 2, H * 0.5, Math.max(W, H) * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.8)');
  b.fillStyle = v;
  b.fillRect(0, 0, W, H);
}

function seedMotes() {
  const rnd = mulberry32(seed + 99);
  const count = W < 640 ? 22 : 36;
  motes = [];
  for (let i = 0; i < count; i++) {
    const y = rnd() * floorY;
    motes.push({
      x: C.x + (rnd() - 0.5) * 2 * coneHalf(y),
      y,
      vx: (rnd() - 0.5) * 4,
      vy: (rnd() - 0.5) * 3,
      s: 0.5 + rnd() * 1.1,
      ph: rnd() * Math.PI * 2,
      tw: 0.4 + rnd() * 1.4,
    });
  }
}

function coneHalf(y) {
  const botW = Math.max(160, W < 640 ? W * 0.42 : 360);
  return lerp(W * 0.03, botW, clamp(y / floorY, 0, 1.1));
}

// ------------------------------------------------------------------ input

// Audio may only start inside a real user activation. Try on every one.
['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'].forEach((ev) =>
  window.addEventListener(ev, () => sound.unlock(), { capture: true, passive: true }),
);

function pointerPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function toLocal(x, y) {
  const dx = x - pose.x;
  const dy = y - pose.y;
  const c = Math.cos(pose.ang);
  const s = Math.sin(pose.ang);
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

function hitTest(x, y, touch) {
  if (!geom) return null;
  const p = toLocal(x, y);
  const pad = touch ? 28 : 14;
  if (Math.abs(p.x) > L / 2 + pad) return null;
  const xx = clamp(p.x, -L / 2, L / 2);
  const g = geom;
  const r = Math.max(g.rTop(xx), g.rBot(xx));
  if (Math.abs(p.y - g.yc(xx)) > r + pad) return null;
  return xx;
}

const interactive = () => (phase === 'intro' && light > 0.25) || phase === 'idle';

canvas.addEventListener('pointerdown', (e) => {
  if (!interactive() || st.grab) return;
  const p = pointerPos(e);
  const gx = hitTest(p.x, p.y, e.pointerType !== 'mouse');
  if (gx == null) return;
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch { /* */ }
  startGrab(gx, p.x, p.y, e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  const p = pointerPos(e);
  if (st.grab && !st.key && e.pointerId === st.pointerId) {
    st.px = p.x;
    st.py = p.y;
    return;
  }
  if (e.pointerType === 'mouse') canvas.classList.toggle('can-grab', interactive() && hitTest(p.x, p.y, false) != null);
});

const endPointer = (e) => {
  if (st.grab && !st.key && e.pointerId === st.pointerId) endGrab();
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('lostpointercapture', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('keydown', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
    e.preventDefault();
    if (!interactive() || st.grab) return;
    st.key = true;
    st.keyD = 0;
    startGrab(0, 0, 0, null);
  }
});
canvas.addEventListener('keyup', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && st.grab && st.key) endGrab();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && st.grab) endGrab();
});

function startGrab(gx, x, y, pointerId) {
  st.grab = true;
  st.pointerId = pointerId;
  st.sx = st.px = x;
  st.sy = st.py = y;
  st.gx = gx;
  st.strain = 0;
  st.tension = 0;
  grabbedOnce = true;
  sound.tick(0.35);
  buzz(6);
  canvas.classList.add('grabbing');
  hideHint();
  if (phase === 'intro') phase = 'idle';
}

function endGrab() {
  if (!st.grab) return;
  st.grab = false;
  st.key = false;
  st.pointerId = null;
  sound.settle(st.tension);
  sound.stress(0, 0, false);
  canvas.classList.remove('grabbing');
  hideHint();
  hintTimer = setTimeout(() => {
    if (!st.grab && (phase === 'idle' || phase === 'intro')) showHint();
  }, 4000);
}

function showHint() {
  ui.hint.classList.remove('away');
  ui.hint.classList.add('on');
}

function hideHint() {
  clearTimeout(hintTimer);
  if (ui.hint.classList.contains('on')) ui.hint.classList.add('away');
}

// ------------------------------------------------------------------ the stick

function prepareFracture(sign) {
  if (frac && frac.ts === sign) return;
  if (use3D) {
    // cut the model now, while nothing is moving; the halves stay hidden until the snap
    stage.breakAt(X0, sign, seed + (sign > 0 ? 1 : 2));
    stage.showHalves([null, null], L);
    frac = { ts: sign, x0: X0 * L, r0: geom.r(X0 * L) };
    return;
  }
  frac = makeFracture(willow, R, sign);
  partsCache = null;
  const want = frac;
  // paint the two halves ahead of time so the snap frame stays light
  setTimeout(() => {
    if (frac === want && !partsCache) partsCache = { frac: want, parts: makePieces(willow, R, want) };
  }, 0);
}

function updateIntact(dt) {
  st.hold = lerp(st.hold, st.grab ? 1 : 0, 1 - Math.exp(-dt * 6));

  if (st.grab) {
    let D;
    if (st.key) {
      st.keyD += Dbreak * (0.3 + 0.5 * (st.keyD / Dbreak)) * dt;
      D = st.keyD;
    } else {
      D = (st.px - st.sx) * ndx + (st.py - st.sy) * ndy;
    }
    if (Math.abs(D) > 3 && st.crack < 0.02) st.sign = D > 0 ? 1 : -1;
    const along = D * st.sign;
    const tau = Math.max(0, along) / Dbreak;
    if (dt > 0) st.speed = Math.abs(tau - st.tension) / dt;
    st.tension = tau;

    // It is stiff: it barely gives, it only tilts a hair towards the pull.
    const k = 1 - Math.exp(-2.6 * Math.min(tau, 1.2));
    const Dm = Math.min(5, L * 0.009);
    const tDisp = st.sign * Dm * k;
    const tTilt = st.sign * (st.gx / (L / 2)) * 0.022 * k;
    const f = 1 - Math.exp(-dt * 28);
    st.disp += (tDisp - st.disp) * f;
    st.tilt += (tTilt - st.tilt) * f;
    st.dispV = st.tiltV = 0;

    if (tau > 0.3) prepareFracture(st.sign);
    if (frac && frac.ts === st.sign) st.crack = Math.max(st.crack, smoothstep(0.6, 1.0, tau) * 0.8);

    // dry fibres popping, faster and louder as it nears the break
    if (tau > 0.25) {
      let rate = 1.5 + 34 * Math.pow((tau - 0.25) / 0.75, 2);
      rate *= 0.35 + Math.min(1.4, st.speed * 2.5);
      if (st.strain > 0) rate += 30;
      if (Math.random() < rate * dt) sound.tick(0.2 + 0.8 * Math.min(1, tau));
    }
    if (tau > 0.62) {
      let rate = 0.8 + 6 * Math.pow((tau - 0.62) / 0.38, 2);
      if (st.strain > 0) rate += 10;
      if (Math.random() < rate * dt) crackEvent(Math.min(1, tau));
    }
    sound.stress(tau, st.speed, true);

    // the last instant of resistance
    if (tau >= 0.97) st.strain += dt * (1 + 6 * Math.min(1, (tau - 0.97) / 0.08));
    else st.strain = Math.max(0, st.strain - dt * 2);
    if (st.strain > 0) buzz(5, 60);
    if (st.strain >= 0.13) {
      snap();
      return;
    }
  } else {
    // stiff wood springs straight back
    const k = Math.pow(2 * Math.PI * 10, 2);
    const c = 2 * 0.32 * Math.sqrt(k);
    st.dispV += (-k * st.disp - c * st.dispV) * dt;
    st.disp += st.dispV * dt;
    st.tiltV += (-k * st.tilt - c * st.tiltV) * dt;
    st.tilt += st.tiltV * dt;
    st.tension = Math.max(0, st.tension - dt * 5);
    st.strain = 0;
    st.speed = 0;
  }
  st.jolt *= Math.exp(-dt * 30);
}

function crackEvent(tau) {
  sound.crack(0.3 + 0.7 * tau);
  st.jolt += st.sign * (0.5 + 1.1 * tau);
  buzz(tau > 0.85 ? 16 : 10, 80);
  shake = Math.max(shake, 0.03 + 0.05 * tau);
  st.crack = Math.min(0.95, st.crack + 0.06);
  if (frac) {
    // a few crumbs of bark drop from the crack
    const p = localToWorld(frac.x0, geom.yc(frac.x0) + st.sign * geom.r(frac.x0) * 0.95);
    chips.burst(p.x, p.y, ndx * st.sign, ndy * st.sign, 0.35 * (L / 560), Math.random, floorY, 2 + Math.floor(tau * 3));
  }
}

function localToWorld(x, y, P = pose) {
  const c = Math.cos(P.ang);
  const s = Math.sin(P.ang);
  return { x: P.x + x * c - y * s, y: P.y + x * s + y * c };
}

function computePose() {
  const idle = 1 - st.hold;
  const floatY = Math.sin(time * 0.6) * 2.2 * idle;
  let tr = 0, tra = 0;
  if (st.grab) {
    const amp = smoothstep(0.45, 1, st.tension) * 0.8 + Math.min(1, st.strain / 0.13) * 1.6;
    if (amp > 0.01) {
      tr = tremorNoise(time * 55) * amp;
      tra = tremorNoise(time * 47 + 30) * amp * 0.0018;
    }
  }
  const off = st.disp + st.jolt + tr;
  pose = {
    x: C.x + ndx * off,
    y: C.y + floatY + ndy * off,
    ang: THETA + st.tilt + tra + Math.sin(time * 0.37) * 0.006 * idle,
  };
  if (phase === 'opening') {
    const k = easeInOut(clamp((time - box.open - 0.3) / (OPEN_T - 0.3), 0, 1));
    const bs = boxState();
    pose = { x: lerp(bs.x, pose.x, k), y: lerp(bs.y - bs.lift, pose.y, k), ang: lerp(0, pose.ang, k) };
  }
}

/** Length of the willow on screen right now (it grows out of the box). */
function stickLen() {
  if (phase !== 'opening') return L;
  const k = easeInOut(clamp((time - box.open - 0.3) / (OPEN_T - 0.3), 0, 1));
  return lerp(box.len * BOX_TO_WILLOW * 0.96, L, k);
}

// ------------------------------------------------------------------ the box

function boxState() {
  const base = { x: box.x, y: box.y, yaw: -0.42 + Math.sin(time * 0.45) * 0.09, pitch: 1.02 + Math.sin(time * 0.7) * 0.025, lift: Math.sin(time * 0.9) * 3, scale: 1, opacity: 1 };
  // an occasional hop, like a novelty toy asking to be picked up
  if (box.nudge > 0) {
    const u = 1 - box.nudge;
    const e = Math.sin(Math.PI * u);
    base.lift += e * 9;
    base.yaw += Math.sin(u * Math.PI * 4) * 0.05 * e;
  }
  base.scale = 1 + 0.03 * box.hover + 0.06 * box.pop;
  if (phase === 'opening') {
    const t = time - box.open;
    base.opacity = 1 - smoothstep(0.25, 0.95, t);
    base.lift -= smoothstep(0.15, 1.1, t) * 16;
    base.scale *= 1 + smoothstep(0.1, 1, t) * 0.05;
  }
  return base;
}

function drawBox() {
  if (!use3D) return;
  if (phase !== 'gate' && phase !== 'opening') {
    stage.showBox(false);
    return;
  }
  const b = boxState();
  stage.showBox(true, b.x, b.y, box.len * b.scale, b.yaw, b.pitch, b.lift, b.opacity);
}

function updateBox(dt) {
  box.hover = lerp(box.hover, box.hoverTarget ? 1 : 0, 1 - Math.exp(-dt * 8));
  box.pop *= Math.exp(-dt * 7);
  if (box.nudge > 0) box.nudge = Math.max(0, box.nudge - dt / 0.5);
  if (time - box.t0 > 3.5 && time - box.lastNudge > 4.5 && !box.hoverTarget) {
    box.lastNudge = time;
    box.nudge = 1;
  }
}

// ------------------------------------------------------------------ the snap

function snap() {
  const sign = st.sign;
  // sound and touch first, at this exact instant
  sound.snap();
  sound.cutAmbience(0.02);
  buzz([45, 35, 14]);

  phase = 'broken';
  tSnap = time;
  hitstop = 0.05;
  st.grab = false;
  try { if (st.pointerId != null) canvas.releasePointerCapture(st.pointerId); } catch { /* */ }
  canvas.classList.remove('grabbing', 'can-grab');
  hideHint();

  if (!frac || frac.ts !== sign) prepareFracture(sign);
  const parts = use3D ? parts3D() : partsCache && partsCache.frac === frac ? partsCache.parts : makePieces(willow, R, frac);
  const at = { ...pose };
  pieces = [new RigidPiece(parts.left, at, floorY - 6), new RigidPiece(parts.right, at, floorY + 12)];
  piecesSaved = false;

  // the broken ends carry on in the direction of the pull
  const s = L / 560;
  const [left, right] = pieces;
  const px = ndx * sign, py = ndy * sign;
  left.omega = sign * (3.4 + Math.random() * 1.8);
  right.omega = -sign * (3.8 + Math.random() * 2);
  // spread them only as far as the screen has room for
  const room = Math.max(0, (W - 24 - L) / 2);
  const spread = clamp(room * 0.9, 24, 140);
  left.vel = { x: px * 150 * s - spread * (0.75 + Math.random() * 0.4), y: py * 150 * s - 60 * s };
  right.vel = { x: px * 160 * s + spread * (0.8 + Math.random() * 0.4), y: py * 160 * s - 50 * s };
  // a little roll about their own axis as they tumble (3D only)
  left.spin = 0;
  right.spin = 0;
  left.spinV = (Math.random() - 0.5) * 7;
  right.spinV = (Math.random() - 0.5) * 7;

  const b = localToWorld(frac.x0, geom.yc(frac.x0) + sign * geom.r(frac.x0) * 0.3, at);
  flashX = b.x;
  flashY = b.y;
  chips.burst(flashX, flashY, px, py, s, Math.random, floorY, 34);
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = (20 + Math.random() * 80) * s;
    puffs.push({ x: flashX, y: flashY, vx: Math.cos(a) * sp + px * 40, vy: Math.sin(a) * sp + py * 40, r: (3 + Math.random() * 7) * s, age: 0, life: 0.8 + Math.random() * 1.0 });
  }
  for (const m of motes) {
    const dx = m.x - flashX, dy = m.y - flashY;
    const d = Math.hypot(dx, dy) + 20;
    m.vx += (dx / d) * (180 / d) * 9;
    m.vy += (dy / d) * (180 / d) * 9;
  }

  flash = 1;
  shake = 1;
  punch = 1;
  lightTarget = 0.6;
  lightRate = 0.26;

  record = { v: 2, seed, state: 'broken', sign, at: Date.now() };
  saveRecord(record);
}

/** Collision outlines for the two 3D halves, in stick-local px. */
function parts3D() {
  const mk = (a, b) => {
    const samples = [];
    for (let s = 0; s <= 14; s++) {
      const x = a + ((b - a) * s) / 14;
      samples.push({ x, y: geom.yc(x), r: geom.r(x) });
    }
    return { samples };
  };
  return { left: mk(-L / 2, frac.x0), right: mk(frac.x0, L / 2) };
}

function restorePieces() {
  const sign = record.sign === -1 ? -1 : 1;
  let parts;
  if (use3D) {
    frac = null;
    prepareFracture(sign);
    parts = parts3D();
  } else {
    frac = makeFracture(willow, R, sign);
    parts = makePieces(willow, R, frac);
  }
  const at = { x: C.x, y: C.y, ang: THETA };
  pieces = [new RigidPiece(parts.left, at, floorY - 6), new RigidPiece(parts.right, at, floorY + 12)];
  const saved = record.v === 2 && Array.isArray(record.pieces) && record.pieces.length === 2 ? record.pieces : null;
  if (saved) {
    pieces.forEach((p, i) => {
      p.setOriginPose({ x: W / 2 + saved[i].x * L, y: floorY + saved[i].y * L, ang: saved[i].a });
      p.spin = saved[i].s || 0;
      p.asleep = true;
      p.grounded = 1;
    });
    piecesSaved = true;
  } else {
    // no saved resting place: let them drop where they broke
    const spread = clamp(Math.max(0, (W - 24 - L) / 2) * 0.9, 24, 140);
    pieces[0].vel.x = -spread;
    pieces[1].vel.x = spread * 1.1;
    pieces[0].omega = 1.2;
    pieces[1].omega = -1.4;
    const env = physEnv();
    for (let k = 0; k < 900 && !pieces.every((p) => p.asleep); k++) pieces.forEach((p) => p.step(1 / 120, env, k / 120));
    pieces.forEach((p) => { p.asleep = true; });
    if (record.state !== 'fresh') savePieces();
  }
}

function physEnv() {
  return {
    g: 2300 * (L / 560) + 800,
    left: 12,
    right: W - 12,
    onClack: () => {},
  };
}

function savePieces() {
  record.v = 2;
  record.pieces = pieces.map((p) => {
    const o = p.originPose();
    return { x: +((o.x - W / 2) / L).toFixed(4), y: +((o.y - floorY) / L).toFixed(4), a: +o.ang.toFixed(4), s: +(p.spin || 0).toFixed(3) };
  });
  saveRecord(record);
  piecesSaved = true;
}

function updatePieces(dt) {
  if (!pieces.length) return;
  const env = physEnv();
  const sub = 4;
  for (let k = 0; k < sub; k++) pieces.forEach((p) => p.step(dt / sub, env, time));
  chips.step(dt, env.g, () => {});
  for (const p of pieces) {
    if (p.spinV == null) continue;
    p.spin += p.spinV * dt;
    p.spinV *= Math.exp(-dt * (p.grounded ? 7 : 0.6));
  }
  if (!piecesSaved && pieces.every((p) => p.asleep) && record.state !== 'fresh') savePieces();
}

// ------------------------------------------------------------------ update

function update(dtReal) {
  time += dtReal;

  let ts = 1;
  if (hitstop > 0) {
    hitstop -= dtReal;
    ts = 0;
  } else if (tSnap >= 0) {
    const s = time - tSnap - 0.05;
    ts = s < 0.6 ? lerp(0.3, 1, easeInOut(clamp(s / 0.6, 0, 1))) : 1;
  }
  const dt = dtReal * ts;

  light = lerp(light, lightTarget, 1 - Math.exp(-dtReal * lightRate * 3));
  flash *= Math.exp(-dtReal * 18);
  shake *= Math.exp(-dtReal * (shake > 0.2 ? 8 : 13));
  punch *= Math.exp(-dtReal * 6);

  if (phase === 'gate' || phase === 'opening' || phase === 'intro' || phase === 'idle') {
    if (phase === 'intro' || phase === 'idle') updateIntact(dt);
    if (phase === 'gate' || phase === 'opening' || phase === 'intro' || phase === 'idle') computePose();
  }
  if (phase === 'gate') updateBox(dtReal);
  if (phase === 'opening' && time - box.open > OPEN_T) {
    phase = 'intro';
    if (use3D) stage.showBox(false);
  }
  if (pieces.length) updatePieces(dt);

  if (phase === 'broken') {
    const since = time - tSnap;
    if (since > 2.8 && (pieces.every((p) => p.asleep) || since > 4.2)) {
      phase = 'wish';
      wish.show();
    }
  }

  for (let i = puffs.length - 1; i >= 0; i--) {
    const p = puffs[i];
    p.age += dt;
    if (p.age > p.life) { puffs.splice(i, 1); continue; }
    p.vx *= 1 - 2.2 * dt;
    p.vy *= 1 - 2.2 * dt;
    p.vy += 8 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.r += dt * 12;
  }

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

function softShadow(cx, fy, halfLen, ang, height, rad) {
  const a = 0.55 * Math.exp(-height / (L * 0.5));
  if (a < 0.01) return;
  const rx = halfLen * (1 + (height / L) * 0.3);
  const ry = Math.max(3, rad * 0.5 + height * 0.05);
  ctx.save();
  ctx.translate(cx + height * 0.1, fy + 3);
  ctx.rotate(ang * 0.2);
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, `rgba(0,0,0,${a.toFixed(3)})`);
  g.addColorStop(0.55, `rgba(0,0,0,${(a * 0.55).toFixed(3)})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawMotes() {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const m of motes) {
    const inCone = 1 - smoothstep(0.6, 1.15, Math.abs(m.x - C.x) / coneHalf(m.y));
    const tw = 0.55 + 0.45 * Math.sin(time * m.tw + m.ph);
    const a = 0.16 * inCone * tw * smoothstep(0, floorY * 0.25, m.y);
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
    const a = 0.07 * (1 - q) * (1 - q);
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
    g.addColorStop(0, `rgba(170,150,120,${a.toFixed(3)})`);
    g.addColorStop(1, 'rgba(170,150,120,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function render3D() {
  const opening = phase === 'opening';
  const showStick = (opening && time - box.open > 0.3) || ((phase === 'intro' || phase === 'idle') && !pieces.length);
  if (phase === 'gate' || opening) {
    const b = boxState();
    softShadow(b.x, floorY, box.len * 0.46, 0, floorY - b.y + b.lift, box.len * 0.05);
  }
  if (showStick) softShadow(pose.x, floorY, stickLen() / 2, pose.ang, floorY - pose.y, geom.R0);
  for (const p of pieces) {
    const a = p.worldPoint(0);
    const b = p.worldPoint(p.lx.length - 1);
    softShadow((a.x + b.x) / 2, p.floor, Math.abs(b.x - a.x) / 2 + geom.R0, Math.atan2(b.y - a.y, b.x - a.x), Math.max(0, p.floor - (a.y + b.y) / 2), geom.R0);
  }
  stage.showStick(pose, stickLen(), showStick);
  if (pieces.length) stage.showHalves(pieces.map((p) => p.originPose()), L, pieces.map((p) => p.spin || 0));
  drawBox();
  stage.render();
  ctx.drawImage(stage.canvas, 0, 0, W, H);
  if (showStick && !opening && frac && st.crack > 0) drawCrack3D();
}

/** A hairline crack opening from the side under tension. */
function drawCrack3D() {
  const ts = frac.ts;
  const p = st.crack;
  const x = frac.x0;
  const yc = geom.yc(x);
  const r = geom.r(x) * 0.9;
  const vEnd = ts * (1 - 1.4 * p);
  const steps = 18;
  const pts = [];
  for (let s = 0; s <= steps; s++) {
    const v = ts + ((vEnd - ts) * s) / steps;
    pts.push([x + r * (0.1 * Math.sin(v * 11 + seed) + 0.05 * Math.sin(v * 29)), yc + v * r]);
  }
  ctx.save();
  ctx.translate(pose.x, pose.y);
  ctx.rotate(pose.ang);
  ctx.lineCap = 'round';
  for (let s = 0; s < steps; s++) {
    const q = s / steps;
    ctx.beginPath();
    ctx.moveTo(pts[s][0], pts[s][1]);
    ctx.lineTo(pts[s + 1][0], pts[s + 1][1]);
    ctx.lineWidth = 0.5 + (1 - q) * (0.5 + 2 * p);
    ctx.strokeStyle = `rgba(8,5,3,${(0.45 + 0.45 * (1 - q)).toFixed(3)})`;
    ctx.stroke();
  }
  ctx.translate(0.8, -0.3 * ts);
  ctx.beginPath();
  for (let s = 0; s <= steps * 0.7; s++) (s ? ctx.lineTo(pts[s][0], pts[s][1]) : ctx.moveTo(pts[s][0], pts[s][1]));
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = `rgba(236,214,168,${(0.3 * p).toFixed(3)})`;
  ctx.stroke();
  ctx.restore();
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bgCv, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const amp = shake * (reduceMotion ? 2 : 8);
  const sx = (Math.random() - 0.5) * 2 * amp;
  const sy = (Math.random() - 0.5) * 2 * amp;
  const z = 1 + punch * (reduceMotion ? 0.003 : 0.014);
  ctx.translate(W / 2 + sx, H / 2 + sy);
  ctx.scale(z, z);
  ctx.translate(-W / 2, -H / 2);

  drawMotes();

  if (use3D) {
    render3D();
  } else if (!pieces.length && R) {
    softShadow(pose.x, floorY, L / 2, pose.ang, floorY - pose.y, R.geom.R0);
    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(pose.ang);
    ctx.drawImage(R.canvas, -R.ox, -R.oy, R.wCss, R.hCss);
    if (frac && st.crack > 0) drawCrack(ctx, R, frac, st.crack);
    ctx.restore();
  } else {
    for (const p of pieces) {
      const a = p.worldPoint(0);
      const b = p.worldPoint(p.lx.length - 1);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      softShadow(cx, p.floor, Math.abs(b.x - a.x) / 2 + geom.R0, Math.atan2(b.y - a.y, b.x - a.x), Math.max(0, p.floor - cy), geom.R0);
    }
    for (const p of pieces) p.draw(ctx);
  }

  chips.draw(ctx, 1);
  drawPuffs();

  if (flash > 0.01) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const Rf = L * 0.16;
    const g = ctx.createRadialGradient(flashX, flashY, 0, flashX, flashY, Rf);
    g.addColorStop(0, `rgba(255,240,215,${(0.3 * flash).toFixed(3)})`);
    g.addColorStop(0.25, `rgba(255,220,170,${(0.08 * flash).toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,200,140,0)');
    ctx.fillStyle = g;
    ctx.fillRect(flashX - Rf, flashY - Rf, Rf * 2, Rf * 2);
    ctx.restore();
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dark = 1 - light;
  if (dark > 0.002) {
    ctx.fillStyle = `rgba(2,2,2,${dark.toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }
  // the room closes in while you pull
  const squeeze = st.hold * 0.45 * smoothstep(0.2, 1, st.tension);
  if (squeeze > 0.01 && !pieces.length) {
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
      }, 500);
      setTimeout(() => {
        ui.endSub.textContent = 'You only get one.';
        ui.endSub.classList.add('on');
      }, 3000);
      if (use3D) showCredit(4200);
    });
  },
});

// ------------------------------------------------------------------ boot

function enter(e) {
  if (phase !== 'gate') return;
  sound.unlock();
  sound.jingle();
  sound.startAmbience();
  buzz(12);
  ui.gate.classList.add('leaving');
  setTimeout(() => { ui.gate.hidden = true; }, 900);
  ui.gateTitle.classList.remove('on');
  ui.credit.classList.remove('on');
  if (use3D) {
    phase = 'opening';
    box.open = time;
    box.pop = 1;
  } else {
    phase = 'intro';
  }
  lightTarget = 1;
  lightRate = 0.3;
  canvas.tabIndex = 0;
  // keyboard users land on the stick
  if (e && e.detail === 0) setTimeout(() => canvas.focus({ preventScroll: true }), 50);
  hintTimer = setTimeout(() => {
    if (!grabbedOnce && (phase === 'intro' || phase === 'idle')) showHint();
  }, 3800 + (use3D ? OPEN_T * 1000 : 0));
}

function showCredit(delay) {
  setTimeout(() => ui.credit.classList.add('on'), delay);
}

async function boot() {
  makeGrain();
  try {
    const model = await loadModel('assets/willow/willow.gltf');
    stage = new Stage(model);
    use3D = true;
  } catch (err) {
    console.warn('3D model unavailable, falling back to the painted willow:', err);
    use3D = false;
    ui.credit.hidden = true;
  }
  ui.gate.classList.toggle('boxmode', use3D);
  layout();
  window.addEventListener('resize', layout);
  ui.gateGo.textContent = coarse ? 'Tap to begin' : 'Click to begin';
  ui.hint.textContent = coarse ? 'Press and pull to snap it.' : 'Press on the willow and pull to snap it.';

  if (record.state === 'wished') {
    phase = 'already';
    ui.gate.hidden = true;
    restorePieces();
    lightTarget = 0.46;
    lightRate = 0.16;
    canvas.setAttribute('aria-label', 'The One Wish Willow lies broken in two.');
    setTimeout(() => {
      ui.endMain.classList.add('caps');
      ui.endMain.textContent = 'Your wish has already been made.';
      ui.endMain.classList.add('on');
    }, 1600);
    setTimeout(() => {
      ui.endSub.textContent = 'You only get one wish.';
      ui.endSub.classList.add('on');
    }, 3800);
    showCredit(4400);
  } else if (record.state === 'broken') {
    // broken, but the wish was never written
    phase = 'wish';
    ui.gate.hidden = true;
    restorePieces();
    lightTarget = 0.6;
    lightRate = 0.2;
    canvas.setAttribute('aria-label', 'The One Wish Willow lies broken in two.');
    setTimeout(() => wish.show(), 1800);
  } else {
    phase = 'gate';
    box.t0 = time;
    ui.gate.addEventListener('click', enter);
    ui.gate.addEventListener('pointerenter', () => { box.hoverTarget = true; });
    ui.gate.addEventListener('pointerleave', () => { box.hoverTarget = false; });
    if (use3D) {
      // the box is the way in: it fades up in its light
      lightTarget = 1;
      lightRate = 0.25;
      placeGate();
      setTimeout(() => ui.gateTitle.classList.add('on'), 700);
      setTimeout(() => ui.gate.classList.add('on'), 700);
      showCredit(1600);
    } else {
      ui.gateTitle.style.top = Math.round(H * 0.5 - 60) + 'px';
      setTimeout(() => ui.gateTitle.classList.add('on'), 400);
      setTimeout(() => ui.gate.classList.add('on'), 400);
      setTimeout(() => ui.gate.classList.add('go'), 2200);
    }
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

// test hook: lets automated checks read state without affecting play
window.__oww = {
  get phase() { return phase; },
  get st() { return st; },
  get pose() { return pose; },
  get L() { return L; },
  get pieces() { return pieces; },
  get audio() { return sound.ctx ? sound.ctx.state : 'none'; },
  get use3D() { return use3D; },
  get box() { return box; },
};
