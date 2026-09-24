// The One Wish Willow: a single young willow shoot.
//
// Geometry lives in "u" (0 = the cut end, 1 = the growing tip). The same
// model draws the intact branch and both broken halves, so every bud, leaf,
// streak and crack stays exactly where it was after the break.

import { mulberry32, makeNoise1D, clamp, smoothstep, lerp, rgb, mixColor } from './util.js';

const BARK = [
  [0.0, [84, 55, 34]],
  [0.35, [104, 73, 40]],
  [0.7, [120, 94, 47]],
  [1.0, [132, 112, 56]],
];
const WOOD_IN = [238, 226, 188];
const WOOD_OUT = [186, 158, 108];
const BUD = [92, 52, 32];
const SPEC = [255, 236, 204];
const RIM = [74, 86, 88];

const STOP_P = [0, 0.035, 0.09, 0.17, 0.26, 0.35, 0.45, 0.56, 0.68, 0.8, 0.9, 0.96, 1];

function barkAt(u) {
  for (let i = 1; i < BARK.length; i++) {
    if (u <= BARK[i][0]) {
      const t = (u - BARK[i - 1][0]) / (BARK[i][0] - BARK[i - 1][0]);
      return mixColor(BARK[i - 1][1], BARK[i][1], t);
    }
  }
  return BARK[BARK.length - 1][1];
}

// Lit cylinder cross-section. t = +1 is the side facing up (towards the light).
function shade(base, t) {
  const c = Math.sqrt(Math.max(0, 1 - t * t));
  const lamb = Math.max(0, 0.6 * t + 0.8 * c);
  const spec = Math.pow(Math.max(0, 0.36 * t + 0.933 * c), 34) * 0.42;
  const sheen = Math.pow(Math.max(0, 0.36 * t + 0.933 * c), 6) * 0.1;
  const edge = 0.55 + 0.45 * Math.sqrt(c);
  const rim = smoothstep(-0.62, -0.98, t) * 0.55;
  const I = (0.14 + 0.98 * lamb) * edge;
  return [
    base[0] * I + SPEC[0] * (spec + sheen) + RIM[0] * rim,
    base[1] * I + SPEC[1] * (spec + sheen) + RIM[1] * rim,
    base[2] * I + SPEC[2] * (spec + sheen) + RIM[2] * rim,
  ];
}

export function createTwig(seed) {
  const rand = mulberry32(seed);
  const noise = makeNoise1D(rand);
  const noise2 = makeNoise1D(rand);

  // Nodes: alternate sides, irregular spacing, closer together near the tip.
  const nodes = [];
  let u = 0.06 + rand() * 0.04;
  let side = rand() < 0.5 ? 1 : -1;
  while (u < 0.955) {
    nodes.push({ u, side, leaf: null });
    side = -side;
    u += (0.1 - 0.035 * u) + rand() * 0.05;
  }

  // Leaves: mostly towards the tip, one lone leaf lower down.
  const leaves = [];
  const mkLeaf = (node, scale = 1) => {
    const leaf = {
      u: node.u,
      side: node.side,
      ang: 0.36 + rand() * 0.34,
      len: (0.085 + rand() * 0.05) * scale,
      wid: 0.105 + rand() * 0.035,
      curl: (rand() - 0.5) * 0.22 - node.side * 0.07,
      tone: rand(),
      under: rand() < 0.28,
      phase: rand() * Math.PI * 2,
      phi: 0,
      omega: 0,
      k: 70 + rand() * 50,
      px: null, py: null, vx: 0, vy: 0,
    };
    node.leaf = leaf;
    leaves.push(leaf);
  };
  nodes.forEach((n) => {
    if (n.u > 0.64 && rand() < 0.88) mkLeaf(n, 0.8 + 0.4 * (1 - n.u));
  });
  const lower = nodes.filter((n) => n.u > 0.14 && n.u < 0.3);
  if (lower.length) mkLeaf(lower[Math.floor(rand() * lower.length)], 0.8);
  // terminal pair
  mkLeaf({ u: 0.975, side: 1 }, 0.62);
  mkLeaf({ u: 0.985, side: -1 }, 0.5);

  const streaks = [];
  for (let i = 0; i < 90; i++) {
    const len = 0.02 + Math.pow(rand(), 2) * 0.22;
    streaks.push({
      u0: rand() * (1 - len * 0.5) - len * 0.3,
      len,
      t: (rand() * 2 - 1) * 0.86,
      dark: rand() < 0.62,
      a: 0.1 + rand() * 0.28,
      w: 0.45 + rand() * 0.8,
      wob: rand() * 100,
    });
  }

  const lenticels = [];
  for (let i = 0; i < 70; i++) {
    const uu = 0.02 + rand() * 0.9;
    lenticels.push({ u: uu, t: (rand() * 2 - 1) * 0.75, s: 0.5 + rand() * 0.8, a: 0.18 + rand() * 0.3 });
  }

  const phase = rand() * Math.PI * 2;
  const bowAmp = 0.008 + rand() * 0.008;

  // Pre-baked shaded gradient stops for bands along the length.
  const bins = 16;
  const palettes = [];
  for (let b = 0; b < bins; b++) {
    const base = barkAt(b / (bins - 1));
    palettes.push(STOP_P.map((p) => [p, rgb(shade(base, 1 - 2 * p))]));
  }

  return {
    seed,
    rand,
    noise,
    noise2,
    nodes,
    leaves,
    streaks,
    lenticels,
    palettes,
    fissures: [],
    // natural resting bow (units of L, +y = down)
    natY(u) {
      return -bowAmp * Math.sin(Math.PI * u * 1.15 + phase * 0.2) + 0.0035 * noise2(u * 7 + 3);
    },
    radius(u) {
      let r = 1 - 0.6 * Math.pow(u, 1.12);
      r *= 1 + 0.045 * noise(u * 16);
      for (let i = 0; i < nodes.length; i++) {
        const d = (u - nodes[i].u) / 0.0075;
        if (d > -4 && d < 4) r += 0.13 * Math.exp(-d * d);
      }
      r *= 1 - smoothstep(0.955, 1, u) * 0.5;
      r *= 1 + smoothstep(0.03, 0, u) * 0.05;
      return r;
    },
  };
}

// Deflection of a simply supported beam under a point load at `a`,
// normalised so the loaded point moves exactly 1.
export function bend(u, a) {
  const b = 1 - a;
  const norm = a * b * (1 - a * a - b * b);
  if (u <= a) return (b * u * (1 - b * b - u * u)) / norm;
  const v = 1 - u;
  return (a * v * (1 - a * a - v * v)) / norm;
}

/**
 * Local geometry of the intact branch, centred on the origin, pointing +x.
 * Returns arrays sized N: xs, ys, rs, us.
 */
export function shapeLocal(model, N, L, r0, a, d, tremor) {
  const xs = new Float32Array(N);
  const ys = new Float32Array(N);
  const rs = new Float32Array(N);
  const us = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    us[i] = u;
    xs[i] = (u - 0.5) * L;
    ys[i] = L * model.natY(u) + d * bend(u, a) + (tremor ? tremor(u) : 0);
    rs[i] = r0 * model.radius(u);
  }
  // Keep the branch inextensible: pull the ends in as it bends.
  for (let iter = 0; iter < 3; iter++) {
    let len = 0;
    for (let i = 1; i < N; i++) len += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    const k = L / len;
    if (Math.abs(k - 1) < 1e-4) break;
    for (let i = 0; i < N; i++) xs[i] *= k;
  }
  // re-centre around the load point so it tracks the finger
  return { xs, ys, rs, us };
}

export function toWorld(local, cx, cy, ang) {
  const n = local.xs.length;
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  for (let i = 0; i < n; i++) {
    const x = local.xs[i];
    const y = local.ys[i];
    xs[i] = cx + x * c - y * s;
    ys[i] = cy + x * s + y * c;
  }
  return { xs, ys, rs: local.rs, us: local.us };
}

// Tangents and "up" normals (material side, +t) for a world polyline.
export function frames(geo) {
  const { xs, ys } = geo;
  const n = xs.length;
  const tx = new Float32Array(n);
  const ty = new Float32Array(n);
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 1, i + 1);
    let dx = xs[i1] - xs[i0];
    let dy = ys[i1] - ys[i0];
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    tx[i] = dx;
    ty[i] = dy;
    nx[i] = dy;
    ny[i] = -dx;
  }
  geo.tx = tx;
  geo.ty = ty;
  geo.nx = nx;
  geo.ny = ny;
  return geo;
}

// Interpolated frame at a given u inside a (possibly partial) geometry.
export function sampleAt(geo, u) {
  const n = geo.us.length;
  const u0 = geo.us[0];
  const u1 = geo.us[n - 1];
  const f = clamp((u - u0) / (u1 - u0), 0, 1) * (n - 1);
  const i = Math.min(n - 2, Math.floor(f));
  const k = f - i;
  const L = (arr) => arr[i] + (arr[i + 1] - arr[i]) * k;
  let tx = L(geo.tx);
  let ty = L(geo.ty);
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl;
  ty /= tl;
  return { x: L(geo.xs), y: L(geo.ys), r: L(geo.rs), tx, ty, nx: ty, ny: -tx, i: f };
}

function inRange(geo, u, pad = 0) {
  const n = geo.us.length;
  return u >= geo.us[0] + pad && u <= geo.us[n - 1] - pad;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} geo  world geometry with frames
 * @param {object} model
 * @param {object} o    { r0, startCap, endCap, stress, glint, brk }
 */
export function drawStem(ctx, geo, model, o) {
  const { xs, ys, rs, us, tx, ty, nx, ny } = geo;
  const n = xs.length;

  // Which way is "up" for lighting? Keep the highlight on the world-up side.
  let up = 0;
  for (let i = 0; i < n; i += 4) up += -ny[i];
  const ss = up >= 0 ? 1 : -1;
  const bins = model.palettes.length;

  // --- body: short overlapping quads, each with its own cross gradient
  for (let i = 0; i < n - 1; i++) {
    const ax = xs[i], ay = ys[i], bx = xs[i + 1], by = ys[i + 1];
    const ra = rs[i], rb = rs[i + 1];
    const ex = (tx[i] + tx[i + 1]) * 0.35;
    const ey = (ty[i] + ty[i + 1]) * 0.35;
    const first = i === 0 ? 0 : 1;
    const last = i === n - 2 ? 0 : 1;
    ctx.beginPath();
    ctx.moveTo(ax + nx[i] * ra - ex * first, ay + ny[i] * ra - ey * first);
    ctx.lineTo(bx + nx[i + 1] * rb + ex * last, by + ny[i + 1] * rb + ey * last);
    ctx.lineTo(bx - nx[i + 1] * rb + ex * last, by - ny[i + 1] * rb + ey * last);
    ctx.lineTo(ax - nx[i] * ra - ex * first, ay - ny[i] * ra - ey * first);
    ctx.closePath();
    const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
    let mnx = nx[i] + nx[i + 1], mny = ny[i] + ny[i + 1];
    const ml = Math.hypot(mnx, mny) || 1;
    mnx = (mnx / ml) * ss;
    mny = (mny / ml) * ss;
    const rm = (ra + rb) * 0.5;
    const g = ctx.createLinearGradient(mx + mnx * rm, my + mny * rm, mx - mnx * rm, my - mny * rm);
    const pal = model.palettes[Math.min(bins - 1, Math.round(((us[i] + us[i + 1]) * 0.5) * (bins - 1)))];
    for (let k = 0; k < pal.length; k++) g.addColorStop(pal[k][0], pal[k][1]);
    ctx.fillStyle = g;
    ctx.fill();
  }

  const u0 = us[0];
  const u1 = us[n - 1];
  const idx = (u) => clamp(Math.round(((u - u0) / (u1 - u0)) * (n - 1)), 0, n - 1);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // --- longitudinal bark streaks
  for (const s of model.streaks) {
    const a = Math.max(s.u0, u0 + 0.004);
    const b = Math.min(s.u0 + s.len, u1 - 0.004);
    if (b - a < 0.006) continue;
    const i0 = idx(a);
    const i1 = idx(b);
    if (i1 - i0 < 1) continue;
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const tt = s.t + 0.05 * Math.sin(us[i] * 60 + s.wob);
      const px = xs[i] + nx[i] * rs[i] * tt;
      const py = ys[i] + ny[i] * rs[i] * tt;
      if (i === i0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    // fade the ends by drawing twice at lower alpha is overkill; one stroke is fine
    ctx.lineWidth = s.w * (o.r0 / 7);
    ctx.strokeStyle = s.dark ? `rgba(28,16,8,${s.a})` : `rgba(226,196,146,${s.a * 0.5})`;
    ctx.stroke();
  }

  // --- lenticels
  ctx.lineWidth = Math.max(0.6, o.r0 * 0.13);
  for (const l of model.lenticels) {
    if (!inRange(geo, l.u, 0.006)) continue;
    const i = idx(l.u);
    const px = xs[i] + nx[i] * rs[i] * l.t;
    const py = ys[i] + ny[i] * rs[i] * l.t;
    const h = o.r0 * 0.22 * l.s;
    ctx.beginPath();
    ctx.moveTo(px - tx[i] * h, py - ty[i] * h);
    ctx.lineTo(px + tx[i] * h, py + ty[i] * h);
    ctx.strokeStyle = `rgba(222,200,156,${l.a})`;
    ctx.stroke();
  }

  // --- cracks from earlier attempts
  for (const f of model.fissures) {
    if (!inRange(geo, f.u, 0.002)) continue;
    const s = sampleAt(geo, f.u);
    const steps = 5;
    ctx.beginPath();
    for (let k = 0; k <= steps; k++) {
      const q = k / steps;
      const tt = f.side * lerp(1.02, f.depth, q);
      const jig = (k % 2 ? 1 : -1) * f.zig * s.r * 0.22;
      const px = s.x + s.nx * s.r * tt + s.tx * jig;
      const py = s.y + s.ny * s.r * tt + s.ty * jig;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.lineWidth = Math.max(0.6, o.r0 * 0.11);
    ctx.strokeStyle = 'rgba(16,8,4,0.8)';
    ctx.stroke();
    ctx.lineWidth = Math.max(0.4, o.r0 * 0.06);
    ctx.strokeStyle = 'rgba(236,222,176,0.22)';
    ctx.stroke();
  }

  // --- stress: pale fibres showing through on the tension side
  if (o.stress && o.stress.amount > 0.01 && inRange(geo, o.stress.u)) {
    const st = o.stress;
    const A = st.amount;
    const span = 0.012 + 0.02 * A;
    const ia = idx(st.u - span);
    const ib = idx(st.u + span);
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      for (let i = ia; i <= ib; i++) {
        const tt = st.side * (pass ? 0.9 : 0.72);
        const px = xs[i] + nx[i] * rs[i] * tt;
        const py = ys[i] + ny[i] * rs[i] * tt;
        if (i === ia) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.lineWidth = rs[idx(st.u)] * (pass ? 0.18 : 0.42) * (0.4 + A);
      ctx.strokeStyle = pass ? `rgba(248,244,214,${0.5 * A * A})` : `rgba(214,216,160,${0.32 * A * A})`;
      ctx.stroke();
    }
    // compression wrinkles on the inside of the bend
    if (A > 0.35) {
      const s = sampleAt(geo, st.u);
      const cnt = 3;
      ctx.lineWidth = Math.max(0.5, o.r0 * 0.08);
      ctx.strokeStyle = `rgba(20,10,4,${0.5 * (A - 0.35)})`;
      for (let k = 0; k < cnt; k++) {
        const off = (k - (cnt - 1) / 2) * s.r * 0.55;
        ctx.beginPath();
        ctx.moveTo(s.x + s.tx * off - s.nx * st.side * s.r * 0.98, s.y + s.ty * off - s.ny * st.side * s.r * 0.98);
        ctx.lineTo(s.x + s.tx * off * 1.1 - s.nx * st.side * s.r * 0.6, s.y + s.ty * off * 1.1 - s.ny * st.side * s.r * 0.6);
        ctx.stroke();
      }
    }
  }

  // --- buds at the nodes
  for (const nd of model.nodes) {
    if (!inRange(geo, nd.u, 0.01)) continue;
    const s = sampleAt(geo, nd.u);
    const size = nd.leaf ? 0.75 : 1;
    drawBud(ctx, s, nd.side, o.r0 * size, 0.85);
  }

  // --- ends
  drawCap(ctx, geo, o.startCap, true, o);
  drawCap(ctx, geo, o.endCap, false, o);

  // --- a slow glint that travels the length now and then
  if (o.glint != null && o.glint.a > 0.001) {
    const gu = o.glint.u;
    const w = 0.07;
    const ia = idx(gu - w);
    const ib = idx(gu + w);
    for (let i = ia; i < ib; i++) {
      const q = 1 - Math.abs((us[i] - gu) / w);
      if (q <= 0) continue;
      const t1 = 0.42 * ss;
      ctx.beginPath();
      ctx.moveTo(xs[i] + nx[i] * rs[i] * t1, ys[i] + ny[i] * rs[i] * t1);
      ctx.lineTo(xs[i + 1] + nx[i + 1] * rs[i + 1] * t1, ys[i + 1] + ny[i + 1] * rs[i + 1] * t1);
      ctx.lineWidth = rs[i] * 0.5;
      ctx.strokeStyle = `rgba(255,238,206,${(q * q * o.glint.a).toFixed(3)})`;
      ctx.stroke();
    }
  }
}

function drawBud(ctx, s, side, r0, lift) {
  const bx = s.x + s.nx * side * s.r * lift;
  const by = s.y + s.ny * side * s.r * lift;
  // points towards the tip, pressed against the stem
  const dx = s.tx * 0.93 + s.nx * side * 0.36;
  const dy = s.ty * 0.93 + s.ny * side * 0.36;
  const len = r0 * 1.15;
  const wid = r0 * 0.36;
  const px = -dy;
  const py = dx;
  const tipX = bx + dx * len;
  const tipY = by + dy * len;
  ctx.beginPath();
  ctx.moveTo(bx - px * wid - dx * wid * 0.3, by - py * wid - dy * wid * 0.3);
  ctx.quadraticCurveTo(bx - px * wid * 1.1 + dx * len * 0.6, by - py * wid * 1.1 + dy * len * 0.6, tipX, tipY);
  ctx.quadraticCurveTo(bx + px * wid * 1.1 + dx * len * 0.6, by + py * wid * 1.1 + dy * len * 0.6, bx + px * wid - dx * wid * 0.3, by + py * wid - dy * wid * 0.3);
  ctx.closePath();
  const upSide = (py < 0 ? 1 : -1);
  const g = ctx.createLinearGradient(bx + px * wid * upSide, by + py * wid * upSide, bx - px * wid * upSide, by - py * wid * upSide);
  g.addColorStop(0, rgb([BUD[0] * 1.45, BUD[1] * 1.4, BUD[2] * 1.3]));
  g.addColorStop(0.45, rgb(BUD));
  g.addColorStop(1, rgb([BUD[0] * 0.35, BUD[1] * 0.3, BUD[2] * 0.3]));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = 'rgba(24,10,4,0.45)';
  ctx.stroke();
}

function drawCap(ctx, geo, cap, atStart, o) {
  if (!cap) return;
  const n = geo.xs.length;
  const i = atStart ? 0 : n - 1;
  const ex = geo.xs[i];
  const ey = geo.ys[i];
  const r = geo.rs[i];
  const ox = atStart ? -geo.tx[i] : geo.tx[i];
  const oy = atStart ? -geo.ty[i] : geo.ty[i];
  const nx = geo.nx[i];
  const ny = geo.ny[i];

  if (cap.type === 'cut') {
    // An old clean cut, seen at an angle: pale wood, rings, dark pith.
    ctx.save();
    ctx.translate(ex + ox * r * 0.05, ey + oy * r * 0.05);
    ctx.rotate(Math.atan2(oy, ox));
    ctx.scale(0.36, 1);
    const g = ctx.createRadialGradient(0, -r * 0.15, 0, 0, 0, r);
    g.addColorStop(0, rgb([222, 204, 160]));
    g.addColorStop(0.55, rgb([196, 170, 120]));
    g.addColorStop(0.82, rgb([150, 118, 74]));
    g.addColorStop(0.9, rgb([70, 44, 24]));
    g.addColorStop(1, rgb([40, 24, 12]));
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.0, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = 'rgba(120,90,50,0.35)';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(70,40,20,0.8)';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else if (cap.type === 'tip') {
    // terminal bud
    const s = { x: ex, y: ey, r, tx: ox, ty: oy, nx, ny };
    drawBud(ctx, s, 0, Math.max(o.r0 * 0.9, r * 2.2), 0);
  } else if (cap.type === 'jag') {
    drawJag(ctx, ex, ey, ox, oy, nx, ny, r, cap);
  }
}

// Torn fibres at a fresh break.
function drawJag(ctx, ex, ey, ox, oy, nx, ny, r, cap) {
  const spikes = cap.spikes;
  const M = spikes.length;
  // bark splinter on the tension side
  if (cap.splinter) {
    const sp = cap.splinter;
    const bx = ex + nx * r * sp.t;
    const by = ey + ny * r * sp.t;
    const w = r * 0.32;
    ctx.beginPath();
    ctx.moveTo(bx - nx * w * Math.sign(sp.t), by - ny * w * Math.sign(sp.t));
    ctx.lineTo(bx + ox * r * sp.len + nx * r * sp.bend, by + oy * r * sp.len + ny * r * sp.bend);
    ctx.lineTo(bx + nx * w * 0.2 * Math.sign(sp.t), by + ny * w * 0.2 * Math.sign(sp.t));
    ctx.closePath();
    ctx.fillStyle = rgb([92, 66, 38]);
    ctx.fill();
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = 'rgba(210,190,140,0.35)';
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.moveTo(ex - nx * r, ey - ny * r);
  for (let k = 0; k < M; k++) {
    const sk = spikes[k];
    const tv = -1 + (2 * k) / M;
    const tt = -1 + (2 * k + 1) / M + sk.skew;
    if (k > 0) {
      const vl = Math.min(spikes[k - 1].len, sk.len) * 0.25;
      ctx.lineTo(ex + nx * r * tv + ox * r * vl, ey + ny * r * tv + oy * r * vl);
    }
    ctx.lineTo(ex + nx * r * tt * 0.95 + ox * r * sk.len, ey + ny * r * tt * 0.95 + oy * r * sk.len);
  }
  ctx.lineTo(ex + nx * r, ey + ny * r);
  ctx.closePath();
  let maxLen = 0.5;
  for (const s of spikes) maxLen = Math.max(maxLen, s.len);
  const g = ctx.createLinearGradient(ex, ey, ex + ox * r * maxLen, ey + oy * r * maxLen);
  g.addColorStop(0, rgb(WOOD_OUT));
  g.addColorStop(0.35, rgb([214, 196, 150]));
  g.addColorStop(1, rgb(WOOD_IN));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 0.55;
  ctx.strokeStyle = 'rgba(60,38,18,0.55)';
  ctx.stroke();

  // a few loose fibres
  ctx.lineWidth = Math.max(0.5, r * 0.07);
  ctx.strokeStyle = 'rgba(240,228,190,0.7)';
  for (const f of cap.fibres) {
    const bx = ex + nx * r * f.t;
    const by = ey + ny * r * f.t;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + ox * r * f.len + nx * r * f.bend, by + oy * r * f.len + ny * r * f.bend);
    ctx.stroke();
  }
}

// Build the complementary tear patterns for the two halves.
export function makeBreak(rand, tensionSide) {
  const M = 7;
  const left = [];
  const right = [];
  for (let k = 0; k < M; k++) {
    const t = -1 + (2 * k + 1) / M;
    // fibres on the tension side tear longer
    const bias = 0.35 + 0.65 * smoothstep(-1, 1, t * tensionSide);
    const a = 0.25 + rand() * 1.1 * bias + 0.2 * bias;
    left.push({ len: a, skew: (rand() - 0.5) * 0.12 });
    right.push({ len: Math.max(0.2, 1.5 * bias - a * 0.7 + rand() * 0.35), skew: (rand() - 0.5) * 0.12 });
  }
  const fib = () => {
    const out = [];
    const c = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < c; i++) {
      const t = tensionSide * (0.1 + rand() * 0.85);
      out.push({ t, len: 0.8 + rand() * 1.6, bend: (rand() - 0.5) * 0.6 });
    }
    return out;
  };
  return {
    left: { type: 'jag', spikes: left, fibres: fib(), splinter: { t: tensionSide * 0.8, len: 2.6 + rand() * 1.8, bend: tensionSide * 0.25 } },
    right: { type: 'jag', spikes: right, fibres: fib(), splinter: null },
  };
}

// ---------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------

function leafFrame(geo, leaf, flat) {
  const s = sampleAt(geo, leaf.u);
  const side = leaf.side;
  const ang = leaf.ang * (1 - 0.55 * flat);
  const c = Math.cos(ang);
  const sn = Math.sin(ang);
  let dx = s.tx * c + s.nx * side * sn;
  let dy = s.ty * c + s.ny * side * sn;
  const cp = Math.cos(leaf.phi);
  const sp = Math.sin(leaf.phi);
  const rx = dx * cp - dy * sp;
  const ry = dx * sp + dy * cp;
  dx = rx;
  dy = ry;
  const ax = s.x + s.nx * side * s.r * 0.55;
  const ay = s.y + s.ny * side * s.r * 0.55;
  return { ax, ay, dx, dy };
}

export function updateLeaves(geo, model, dt, L, time, calm) {
  if (dt <= 0) return;
  for (const leaf of model.leaves) {
    if (!inRange(geo, leaf.u)) continue;
    const f = leafFrame(geo, leaf, 0);
    if (leaf.px == null || dt > 0.1) {
      leaf.px = f.ax;
      leaf.py = f.ay;
      leaf.vx = 0;
      leaf.vy = 0;
      continue;
    }
    const vx = (f.ax - leaf.px) / dt;
    const vy = (f.ay - leaf.py) / dt;
    let axx = (vx - leaf.vx) / dt;
    let ayy = (vy - leaf.vy) / dt;
    const am = Math.hypot(axx, ayy);
    const cap = 60000;
    if (am > cap) {
      axx *= cap / am;
      ayy *= cap / am;
    }
    leaf.px = f.ax;
    leaf.py = f.ay;
    leaf.vx = vx;
    leaf.vy = vy;
    const len = leaf.len * L;
    // perpendicular to the leaf
    const px = -f.dy;
    const py = f.dx;
    const drive = -(axx * px + ayy * py) / len * 0.55;
    // a little weight: leaves sag with gravity
    const grav = (980 * (0 * px + 1 * py)) / len * 0.012;
    const sway = calm * 0.05 * Math.sin(time * 1.2 + leaf.phase) + calm * 0.02 * Math.sin(time * 2.9 + leaf.phase * 2);
    const acc = -leaf.k * (leaf.phi - sway) - 5.5 * leaf.omega + drive + grav;
    leaf.omega += acc * dt;
    leaf.phi += leaf.omega * dt;
    leaf.phi = clamp(leaf.phi, -1.1, 1.1);
  }
}

export function kickLeaves(model, amount, rand) {
  for (const leaf of model.leaves) leaf.omega += (rand() - 0.5) * amount;
}

export function drawLeaves(ctx, geo, model, L, layer, flat = 0) {
  for (const leaf of model.leaves) {
    if ((layer === 'back') !== (leaf.side > 0)) continue;
    if (!inRange(geo, leaf.u, 0.003)) continue;
    const f = leafFrame(geo, leaf, flat);
    drawLeaf(ctx, f, leaf, L);
  }
}

function drawLeaf(ctx, f, leaf, L) {
  const len = leaf.len * L;
  const half = len * leaf.wid * 0.5;
  const { dx, dy } = f;
  const px = -dy;
  const py = dx;
  const stalk = len * 0.07;
  const bx = f.ax + dx * stalk;
  const by = f.ay + dy * stalk;
  const curl = leaf.curl * len;
  const S = 16;
  const pt = (v, w) => {
    const c = curl * v * v;
    return [bx + dx * v * len + px * (c + w), by + dy * v * len + py * (c + w)];
  };
  const hw = (v) => half * 3.55 * Math.pow(v, 0.62) * Math.pow(1 - v, 1.3);

  // petiole
  ctx.beginPath();
  ctx.moveTo(f.ax, f.ay);
  ctx.lineTo(bx, by);
  ctx.lineWidth = Math.max(0.8, half * 0.22);
  ctx.strokeStyle = 'rgb(88,96,52)';
  ctx.stroke();

  ctx.beginPath();
  let p = pt(0, 0);
  ctx.moveTo(p[0], p[1]);
  for (let k = 1; k <= S; k++) {
    const v = k / S;
    p = pt(v, hw(v));
    ctx.lineTo(p[0], p[1]);
  }
  for (let k = S - 1; k >= 1; k--) {
    const v = k / S;
    p = pt(v, -hw(v));
    ctx.lineTo(p[0], p[1]);
  }
  ctx.closePath();

  const t = leaf.tone;
  const top = leaf.under ? [120, 136, 110] : [lerp(44, 62, t), lerp(66, 84, t), lerp(34, 40, t)];
  const mid = leaf.under ? [150, 164, 138] : [lerp(78, 102, t), lerp(104, 126, t), lerp(50, 60, t)];
  const lit = leaf.under ? [182, 192, 166] : [lerp(116, 140, t), lerp(142, 160, t), lerp(72, 82, t)];
  // light from above: the upper half of the blade catches it
  const upSign = py < 0 ? 1 : -1;
  const mx = bx + dx * len * 0.4;
  const my = by + dy * len * 0.4;
  const g = ctx.createLinearGradient(mx + px * half * 1.3 * upSign, my + py * half * 1.3 * upSign, mx - px * half * 1.3 * upSign, my - py * half * 1.3 * upSign);
  g.addColorStop(0, rgb(lit));
  g.addColorStop(0.48, rgb(mid));
  g.addColorStop(0.52, rgb(top));
  g.addColorStop(1, rgb([top[0] * 0.55, top[1] * 0.55, top[2] * 0.55]));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = 'rgba(18,24,10,0.45)';
  ctx.stroke();

  // midrib
  ctx.beginPath();
  p = pt(0, 0);
  ctx.moveTo(p[0], p[1]);
  for (let k = 1; k <= 12; k++) {
    const v = (k / 12) * 0.9;
    p = pt(v, 0);
    ctx.lineTo(p[0], p[1]);
  }
  ctx.lineWidth = Math.max(0.5, half * 0.12);
  ctx.strokeStyle = leaf.under ? 'rgba(236,240,220,0.45)' : 'rgba(210,220,160,0.32)';
  ctx.stroke();
}
