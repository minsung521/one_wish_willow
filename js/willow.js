// The One Wish Willow, as it appears in the film: a short, rigid willow
// stick (about 5¾ in long) with dark brown bark and light tan branch scars
// where side shoots were cut away. It does not bend. It cracks, then snaps
// cleanly in the middle.
//
// The stick is painted once, pixel by pixel, into an offscreen canvas:
// bark fibres, fissures, lenticels, raised knots and shaved scars are grown
// from seeded noise, then lit as a solid cylinder (key, fill and two rim
// lights, in linear light). At the break, the same pixels are split along a
// jagged fracture and the torn fibres are recoloured as fresh pale wood.

import { mulberry32, clamp, smoothstep } from './util.js';
import { makePerlin } from './noise.js';

export const R_FRAC = 0.044; // radius as a fraction of length

const lin = (c) => [Math.pow(c[0] / 255, 2.2), Math.pow(c[1] / 255, 2.2), Math.pow(c[2] / 255, 2.2)];
const norm3 = (x, y, z) => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};

const BARK_DARK = lin([54, 35, 24]);
const BARK_WARM = lin([98, 61, 37]);
const BARK_GREY = lin([86, 72, 58]);
const LENTICEL = lin([146, 120, 90]);
const TAN = lin([208, 172, 124]);
const TAN_EDGE = lin([168, 130, 86]);
const TAN_RING = lin([146, 108, 70]);
const PITH = lin([88, 56, 34]);
const END = lin([212, 180, 132]);
const END_RING = lin([164, 126, 84]);
const FRACT = lin([236, 216, 172]);
const FRACT_DARK = lin([190, 158, 112]);

// x → right, y → up, z → towards the viewer
const KEY = norm3(-0.46, 0.64, 0.62);
const KEY_C = [1.34, 1.16, 0.93];
const FILL = norm3(0.6, 0.05, 0.8);
const FILL_C = [0.08, 0.095, 0.115];
const RIM_LO = norm3(0.45, -0.5, -0.74);
const RIM_LO_C = [0.3, 0.36, 0.44];
const RIM_HI = norm3(-0.1, 0.82, -0.56);
const RIM_HI_C = [0.46, 0.38, 0.27];
const AMB = 0.035;
const HALF = norm3(KEY[0], KEY[1], KEY[2] + 1);

function tone(x) {
  // exposure + extended Reinhard, then back to sRGB
  const e = x * 1.18;
  const t = (e * (1 + e / 5.76)) / (1 + e);
  return Math.round(255 * Math.pow(clamp(t, 0, 1), 1 / 2.2));
}

export function createWillow(seed) {
  const rand = mulberry32(seed);
  const P = makePerlin(rand);
  const shape = {
    bow: (0.005 + rand() * 0.008) * (rand() < 0.5 ? -1 : 1),
    bowPhase: (rand() - 0.5) * 0.8,
    wob: rand() * 50,
    taper: 0.07 + rand() * 0.06,
    taperDir: rand() < 0.5 ? 1 : -1,
    twist: (rand() - 0.5) * 1.6,
    breakU: 0.5 + (rand() - 0.5) * 0.04,
  };

  // Branch scars: raised knots with a cut face, and longer shaved patches.
  const scars = [];
  const slots = [0.11, 0.23, 0.35, 0.645, 0.76, 0.885];
  const skip = Math.floor(rand() * slots.length);
  slots.forEach((s, k) => {
    if (k === skip && rand() < 0.6) return;
    const knot = rand() < 0.6;
    const edge = knot && rand() < 0.45;
    scars.push({
      type: knot ? 'knot' : 'shave',
      u: s + (rand() - 0.5) * 0.05,
      phi: edge ? 1.0 + rand() * 0.34 : (rand() - 0.5) * 1.5 + 0.15,
      hl: knot ? 0.015 + rand() * 0.011 : 0.032 + rand() * 0.03,
      hs: knot ? 0.3 + rand() * 0.14 : 0.24 + rand() * 0.14,
      raise: knot ? 0.14 + rand() * 0.1 : 0,
      rot: (rand() - 0.5) * (knot ? 0.5 : 0.3),
      ring: 0.6 + rand() * 0.8,
    });
  });

  return { seed, P, shape, scars };
}

function ycFrac(w, u) {
  const s = w.shape;
  const uc = clamp(u, 0, 1);
  return s.bow * (Math.sin(Math.PI * uc + s.bowPhase) - 0.62) + 0.004 * w.P.noise(uc * 2.2 + s.wob, 0.37) + 0.0022 * w.P.noise(uc * 6.3 + s.wob, 5.1);
}

function rFrac(w, u) {
  const s = w.shape;
  const uc = clamp(u, 0, 1);
  return R_FRAC * (1 + s.taper * (uc - 0.5) * s.taperDir) * (1 + 0.045 * w.P.noise(uc * 4.5 + s.wob, 2.71) + 0.018 * w.P.noise(uc * 12 + s.wob, 8.3));
}

function scarD(sc, u, phi) {
  const a = (u - sc.u) / sc.hl;
  const b = (phi - sc.phi) / sc.hs;
  const c = Math.cos(sc.rot);
  const s = Math.sin(sc.rot);
  const x = a * c - b * s;
  const y = a * s + b * c;
  return Math.sqrt(x * x + y * y);
}

function knobAt(w, u, phi) {
  let k = 0;
  for (const sc of w.scars) {
    if (!sc.raise) continue;
    const d = scarD(sc, u, phi);
    if (d < 1.9) k += sc.raise * (d < 1.1 ? 1 : 1 - smoothstep(1.1, 1.9, d));
  }
  return k;
}

// Relief of a scar: a knot is a cut-off side shoot, a raised collar of bark
// around a slightly dished face; a shave is a shallow knife cut through the
// bark.
function scarHeight(sc, d, r) {
  if (sc.type === 'knot') {
    const top = sc.raise * r;
    if (d < 0.92) return top * (0.7 - 0.14 * (1 - (d / 0.92) * (d / 0.92)));
    if (d < 1.1) return top * (0.7 + 0.3 * smoothstep(0.92, 1.1, d));
    return top * (1 - smoothstep(1.1, 2.25, d));
  }
  return d < 1 ? -0.055 * r * (1 - smoothstep(0.9, 1.0, d)) : 0;
}

/** Geometry helpers in CSS px, stick-local (origin at the centre, +x along). */
export function makeGeom(w, L) {
  const u = (x) => x / L + 0.5;
  return {
    L,
    R0: L * R_FRAC,
    yc: (x) => L * ycFrac(w, u(x)),
    r: (x) => L * rFrac(w, u(x)),
    rTop: (x) => L * rFrac(w, u(x)) * (1 + knobAt(w, clamp(u(x), 0, 1), Math.PI / 2)),
    rBot: (x) => L * rFrac(w, u(x)) * (1 + knobAt(w, clamp(u(x), 0, 1), -Math.PI / 2)),
  };
}

/**
 * Paint the intact stick.
 * @param {number} L  length in CSS px
 * @param {number} S  device px per CSS px for the offscreen image
 */
export function renderWillow(w, L, S) {
  const P = w.P;
  const sh = w.shape;
  const geom = makeGeom(w, L);
  const R0 = geom.R0;

  let maxY = 0;
  for (let k = 0; k <= 60; k++) maxY = Math.max(maxY, Math.abs(L * ycFrac(w, k / 60)));
  const padX = R0 * 0.5 + 4;
  const halfH = maxY + R0 * 1.55 + 4;
  const wCss = L + 2 * padX;
  const hCss = 2 * halfH;
  const Wc = Math.ceil(wCss * S);
  const Hc = Math.ceil(hCss * S);
  const ox = padX + L / 2;
  const oy = halfH;
  const N = Wc * Hc;

  const alb = new Float32Array(N * 3);
  const nb = new Float32Array(N * 3);
  const hgt = new Float32Array(N);
  const cov = new Float32Array(N);
  const vv = new Float32Array(N);
  const mat = new Uint8Array(N); // 0 none, 1 bark, 2 wood

  const colYc = new Float32Array(Wc);
  const colR = new Float32Array(Wc);
  const colRT = new Float32Array(Wc);
  const colRB = new Float32Array(Wc);
  const colDr = new Float32Array(Wc);
  const colDy = new Float32Array(Wc);
  for (let i = 0; i < Wc; i++) {
    const lx = (i + 0.5) / S - ox;
    colYc[i] = geom.yc(lx);
    colR[i] = geom.r(lx);
    colRT[i] = geom.rTop(lx);
    colRB[i] = geom.rBot(lx);
  }
  for (let i = 0; i < Wc; i++) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(Wc - 1, i + 1);
    const dx = (i1 - i0) / S;
    colDr[i] = (colR[i1] - colR[i0]) / dx;
    colDy[i] = -(colYc[i1] - colYc[i0]) / dx;
  }

  const rL = geom.r(-L / 2);
  const rR = geom.r(L / 2);
  const ewL = rL * 0.3;
  const ewR = rR * 0.3;
  const faceC = -L / 2 + ewL; // centre of the visible cut face (left end)
  const capC = L / 2 - ewR; // start of the rounded far end (right end)

  // ---------------------------------------------------------------- pass 1
  for (let i = 0; i < Wc; i++) {
    const lx = (i + 0.5) / S - ox;
    if (lx < -L / 2 - 1.5 || lx > L / 2 + 1.5) continue;
    const u = clamp(lx / L + 0.5, 0, 1);
    const yc = colYc[i];
    const rBase = colR[i];
    const dr = colDr[i];
    const dYc = colDy[i];
    const tw = sh.twist * u;

    for (let j = 0; j < Hc; j++) {
      const ly = (j + 0.5) / S - oy;
      const dy = ly - yc;
      const rr = dy < 0 ? colRT[i] : colRB[i];
      let v = dy / rr;
      if (Math.abs(v) > 1 + 2 / (rr * S)) continue;
      let c = clamp((1 - Math.abs(v)) * rr * S + 0.5, 0, 1);
      v = clamp(v, -0.9999, 0.9999);
      const sinp = -v;
      const cosp = Math.sqrt(1 - v * v);
      const phi = Math.asin(sinp);
      const idx = j * Wc + i;

      // base normal of a surface of revolution with a curved axis
      let nx = -(dYc * sinp + dr);
      let ny = sinp;
      let nz = cosp;

      // ---- bark
      const pa = phi + tw;
      const F1 = P.fbm(u * 11 + 1.3, pa * 9, 4);
      const F2 = P.noise(u * 38 + 7.7, pa * 26);
      const F3 = P.noise(u * 95 + 2.1, pa * 60);
      // fissures run along the stick, never across it
      const rid = 1 - Math.abs(P.noise(u * 1.5 + 3.3, pa * 5));
      const fis = smoothstep(0.955, 0.994, rid);
      const M1 = P.fbm(u * 3.4 + 11, pa * 1.3, 3);
      const M2 = P.noise(u * 7 + 21, pa * 2.2);
      const lent = smoothstep(0.6, 0.74, P.noise(u * 150 + 5, pa * 14)) * smoothstep(0, 0.5, P.noise(u * 6 + 2, pa * 2.5));

      const t1 = clamp(0.5 + 0.95 * M1, 0, 1);
      let ar = BARK_DARK[0] + (BARK_WARM[0] - BARK_DARK[0]) * t1;
      let ag = BARK_DARK[1] + (BARK_WARM[1] - BARK_DARK[1]) * t1;
      let ab = BARK_DARK[2] + (BARK_WARM[2] - BARK_DARK[2]) * t1;
      const t2 = clamp(0.55 * M2 + 0.12, 0, 0.45);
      ar += (BARK_GREY[0] - ar) * t2;
      ag += (BARK_GREY[1] - ag) * t2;
      ab += (BARK_GREY[2] - ab) * t2;
      const fshade = (0.86 + 0.2 * (0.5 + 0.5 * F1) + 0.06 * F2 + 0.035 * F3) * (1 - 0.5 * fis);
      ar *= fshade;
      ag *= fshade;
      ab *= fshade;
      ar += (LENTICEL[0] - ar) * 0.4 * lent;
      ag += (LENTICEL[1] - ag) * 0.4 * lent;
      ab += (LENTICEL[2] - ab) * 0.4 * lent;
      let h = rBase * (0.02 * F1 + 0.008 * F2 + 0.003 * F3 - 0.04 * fis + 0.016 * lent);
      let m = 1;

      // ---- branch scars
      let relief = 0;
      for (const sc of w.scars) {
        const d = scarD(sc, u, phi);
        if (d > 2.25) continue;
        relief += scarHeight(sc, d, rBase);
        if (d < 1.14) {
          const rim = smoothstep(0.88, 1.0, d) * (1 - smoothstep(1.0, 1.14, d));
          const fw = 1 - smoothstep(0.93, 1.01, d);
          if (fw > 0) {
            const grain = P.noise(u * 140 + sc.u * 40, phi * 5);
            const rings = 0.5 + 0.5 * Math.sin(d * (sc.type === 'knot' ? 24 : 11) * sc.ring + 2.2 * P.noise(u * 30, phi * 6));
            let wr = TAN[0] + (TAN_EDGE[0] - TAN[0]) * smoothstep(0.5, 0.97, d);
            let wg = TAN[1] + (TAN_EDGE[1] - TAN[1]) * smoothstep(0.5, 0.97, d);
            let wb = TAN[2] + (TAN_EDGE[2] - TAN[2]) * smoothstep(0.5, 0.97, d);
            const rk = 0.26 * rings + 0.12 * (0.5 + 0.5 * grain);
            wr += (TAN_RING[0] - wr) * rk;
            wg += (TAN_RING[1] - wg) * rk;
            wb += (TAN_RING[2] - wb) * rk;
            if (sc.type === 'knot') {
              const pk = 1 - smoothstep(0.05, 0.12, d);
              wr += (PITH[0] - wr) * pk;
              wg += (PITH[1] - wg) * pk;
              wb += (PITH[2] - wb) * pk;
            }
            // the collar shades the rim of the face
            const occ = 1 - 0.22 * smoothstep(0.5, 0.96, d);
            wr *= occ;
            wg *= occ;
            wb *= occ;
            ar += (wr - ar) * fw;
            ag += (wg - ag) * fw;
            ab += (wb - ab) * fw;
            // the cut is a flat plane
            const fny = Math.sin(sc.phi);
            const fnz = Math.cos(sc.phi);
            const k = 0.78 * fw;
            nx *= 1 - k;
            ny += (fny - ny) * k;
            nz += (fnz - nz) * k;
            h = h * (1 - fw) + fw * rBase * 0.005 * grain;
            if (fw > 0.5) m = 2;
          }
          const dk = 1 - 0.6 * rim;
          ar *= dk;
          ag *= dk;
          ab *= dk;
        }
      }
      h += relief * 0.7;

      // ---- the ends
      if (lx < faceC + ewL) {
        const fx = (lx - faceC) / ewL;
        const e = Math.sqrt(fx * fx + v * v);
        const fc = clamp((1 - e) * Math.min(ewL, rBase) * S + 0.5, 0, 1);
        if (lx < faceC) c = Math.min(c, fc);
        if (fc > 0) {
          const rho = Math.min(1, e);
          const rings = 0.5 + 0.5 * Math.sin(rho * 34 + 3 * P.noise(fx * 3, v * 3));
          let er = END[0] + (END_RING[0] - END[0]) * (0.35 * rings + 0.3 * smoothstep(0.6, 0.86, rho));
          let eg = END[1] + (END_RING[1] - END[1]) * (0.35 * rings + 0.3 * smoothstep(0.6, 0.86, rho));
          let eb = END[2] + (END_RING[2] - END[2]) * (0.35 * rings + 0.3 * smoothstep(0.6, 0.86, rho));
          const barkRing = smoothstep(0.84, 0.92, rho);
          er += (BARK_DARK[0] - er) * barkRing;
          eg += (BARK_DARK[1] - eg) * barkRing;
          eb += (BARK_DARK[2] - eb) * barkRing;
          const pk = 1 - smoothstep(0.05, 0.1, rho);
          er += (PITH[0] - er) * pk;
          eg += (PITH[1] - eg) * pk;
          eb += (PITH[2] - eb) * pk;
          const f = lx < faceC ? 1 : fc;
          ar += (er - ar) * f;
          ag += (eg - ag) * f;
          ab += (eb - ab) * f;
          nx += (-0.9 - nx) * f;
          ny += (0.1 + 0.12 * -v - ny) * f;
          nz += (0.42 - nz) * f;
          h *= 1 - f;
          if (f > 0.5) m = 2;
        }
      } else if (lx > capC) {
        const fx = (lx - capC) / ewR;
        const e = Math.sqrt(fx * fx + v * v);
        c = Math.min(c, clamp((1 - e) * Math.min(ewR, rBase) * S + 0.5, 0, 1));
        const q = Math.sqrt(Math.max(0, 1 - fx * fx));
        nx = nx * q + fx;
        ny *= q;
        nz *= q;
      }

      if (c <= 0) continue;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nb[idx * 3] = nx / nl;
      nb[idx * 3 + 1] = ny / nl;
      nb[idx * 3 + 2] = nz / nl;
      alb[idx * 3] = ar;
      alb[idx * 3 + 1] = ag;
      alb[idx * 3 + 2] = ab;
      hgt[idx] = h;
      cov[idx] = c;
      vv[idx] = v;
      mat[idx] = m;
    }
  }

  // ---------------------------------------------------------------- pass 2
  const light = new Float32Array(N * 3);
  const spec = new Float32Array(N);
  const canvas = document.createElement('canvas');
  canvas.width = Wc;
  canvas.height = Hc;
  const cx = canvas.getContext('2d');
  const img = cx.createImageData(Wc, Hc);
  const D = img.data;
  const KB = 1.35;

  for (let j = 0; j < Hc; j++) {
    for (let i = 0; i < Wc; i++) {
      const idx = j * Wc + i;
      if (cov[idx] <= 0) continue;
      const h = hgt[idx];
      const hl = i > 0 && cov[idx - 1] > 0 ? hgt[idx - 1] : h;
      const hr = i < Wc - 1 && cov[idx + 1] > 0 ? hgt[idx + 1] : h;
      const hu = j > 0 && cov[idx - Wc] > 0 ? hgt[idx - Wc] : h;
      const hd = j < Hc - 1 && cov[idx + Wc] > 0 ? hgt[idx + Wc] : h;
      const hx = clamp(((hr - hl) * S) / 2, -1.6, 1.6);
      const hy = clamp(((hd - hu) * S) / 2, -1.6, 1.6);
      const v = vv[idx];
      const sinp = -v;
      const cosp = Math.sqrt(Math.max(0, 1 - v * v));
      const hs = -hy * cosp;
      let nx = nb[idx * 3] - KB * hx;
      let ny = nb[idx * 3 + 1] - KB * hs * cosp;
      let nz = nb[idx * 3 + 2] + KB * hs * sinp;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;

      let dk = nx * KEY[0] + ny * KEY[1] + nz * KEY[2];
      dk = Math.max(0, (dk + 0.12) / 1.12);
      const df = Math.max(0, nx * FILL[0] + ny * FILL[1] + nz * FILL[2]);
      const graze = Math.pow(1 - Math.max(0, nz), 1.5);
      const rl = Math.max(0, nx * RIM_LO[0] + ny * RIM_LO[1] + nz * RIM_LO[2]) * graze;
      const rh = Math.max(0, nx * RIM_HI[0] + ny * RIM_HI[1] + nz * RIM_HI[2]) * graze;
      const amb = AMB * (0.65 + 0.35 * ny);
      const ao = 0.78 + 0.22 * Math.max(0, nz);
      const lr = (amb + dk * KEY_C[0] + df * FILL_C[0] + rl * RIM_LO_C[0] + rh * RIM_HI_C[0]) * ao;
      const lg = (amb + dk * KEY_C[1] + df * FILL_C[1] + rl * RIM_LO_C[1] + rh * RIM_HI_C[1]) * ao;
      const lb = (amb + dk * KEY_C[2] + df * FILL_C[2] + rl * RIM_LO_C[2] + rh * RIM_HI_C[2]) * ao;
      const nh = Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]);
      const wood = mat[idx] === 2;
      const sp = (wood ? 0.07 : 0.05) * Math.pow(nh, wood ? 24 : 14);

      light[idx * 3] = lr;
      light[idx * 3 + 1] = lg;
      light[idx * 3 + 2] = lb;
      spec[idx] = sp;

      const o = idx * 4;
      D[o] = tone(alb[idx * 3] * lr + sp * KEY_C[0]);
      D[o + 1] = tone(alb[idx * 3 + 1] * lg + sp * KEY_C[1]);
      D[o + 2] = tone(alb[idx * 3 + 2] * lb + sp * KEY_C[2]);
      D[o + 3] = Math.round(cov[idx] * 255);
    }
  }
  cx.putImageData(img, 0, 0);

  return {
    canvas, L, S, Wc, Hc, wCss, hCss, ox, oy, geom,
    buf: { light, spec, cov, vv, data: new Uint8ClampedArray(D) },
  };
}

// ---------------------------------------------------------------------------
// The break
// ---------------------------------------------------------------------------

/**
 * A jagged fracture across the stick. Long torn fibres on the tension side
 * (the outside of the bend), a short clean shear on the compression side.
 * @param {number} ts  +1 when the bottom edge is in tension, -1 for the top
 */
export function makeFracture(w, R, ts) {
  const rand = mulberry32((w.seed * 7 + (ts > 0 ? 11 : 23)) >>> 0);
  const L = R.L;
  const x0 = (w.shape.breakU - 0.5) * L;
  const r0 = R.geom.r(x0);
  const K = 16;
  const slope = (rand() - 0.5) * 0.5;
  const base = new Float32Array(K + 1);
  for (let k = 0; k <= K; k++) {
    const v = -1 + (2 * k) / K;
    const tension = smoothstep(-0.2, 1, v * ts);
    base[k] = x0 + r0 * (slope * v + (rand() - 0.5) * (0.08 + 0.2 * tension));
  }
  const spikes = [];
  const nT = 5 + Math.floor(rand() * 3);
  for (let s = 0; s < nT; s++) {
    const at = 0.06 + rand() * 0.92;
    spikes.push({
      v: ts * at,
      w: 0.09 + rand() * 0.12,
      len: r0 * (0.28 + rand() * 0.95) * (0.5 + 0.5 * at),
      dir: rand() < 0.5 ? 1 : -1,
    });
  }
  for (let s = 0; s < 3; s++) {
    spikes.push({ v: -ts * (0.1 + rand() * 0.8), w: 0.05 + rand() * 0.05, len: r0 * (0.08 + rand() * 0.2), dir: rand() < 0.5 ? 1 : -1 });
  }

  const baseAt = (v) => {
    const f = clamp((v + 1) / 2, 0, 1) * K;
    const k = Math.min(K - 1, Math.floor(f));
    const t = f - k;
    return base[k] + (base[k + 1] - base[k]) * t;
  };
  const ext = (v, dir) => {
    let e = 0;
    for (const s of spikes) {
      if (s.dir !== dir) continue;
      const t = Math.abs(v - s.v) / s.w;
      if (t < 1) e = Math.max(e, s.len * Math.pow(1 - t, 1.4));
    }
    return e;
  };
  // left piece owns x < edge(v); right piece owns x > edge(v)
  const edge = (v) => baseAt(v) + ext(v, 1) - ext(v, -1);
  return { ts, x0, r0, baseAt, edge, ext };
}

function pieceImage(w, R, F, left) {
  const { Wc, Hc, S, ox, oy, buf } = R;
  const P = w.P;
  const canvas = document.createElement('canvas');
  canvas.width = Wc;
  canvas.height = Hc;
  const cx = canvas.getContext('2d');
  const img = cx.createImageData(Wc, Hc);
  const D = img.data;
  const src = buf.data;
  const r0 = F.r0;
  for (let j = 0; j < Hc; j++) {
    for (let i = 0; i < Wc; i++) {
      const idx = j * Wc + i;
      const c0 = buf.cov[idx];
      if (c0 <= 0) continue;
      const lx = (i + 0.5) / S - ox;
      if (Math.abs(lx - F.x0) > r0 * 3) {
        // far from the break: copy as is, to whichever half owns it
        if ((left && lx < F.x0) || (!left && lx > F.x0)) {
          const o = idx * 4;
          D[o] = src[o]; D[o + 1] = src[o + 1]; D[o + 2] = src[o + 2]; D[o + 3] = src[o + 3];
        }
        continue;
      }
      const v = buf.vv[idx];
      const e = F.edge(v);
      const side = left ? (e - lx) * S + 0.5 : (lx - e) * S + 0.5;
      const k = clamp(side, 0, 1);
      if (k <= 0) continue;
      const o = idx * 4;
      const b = F.baseAt(v);
      // how much of this pixel is freshly torn wood
      const pale = left
        ? smoothstep(b - r0 * 0.46, b - r0 * 0.16, lx)
        : 1 - smoothstep(b + r0 * 0.16, b + r0 * 0.46, lx);
      const lip = left
        ? smoothstep(b - r0 * 0.62, b - r0 * 0.48, lx) * (1 - smoothstep(b - r0 * 0.48, b - r0 * 0.34, lx))
        : smoothstep(b + r0 * 0.34, b + r0 * 0.48, lx) * (1 - smoothstep(b + r0 * 0.48, b + r0 * 0.62, lx));
      if (pale > 0.001 || lip > 0.001) {
        const fib = 0.5 + 0.5 * P.noise(lx * 0.12 + 3, v * 24);
        const ar = FRACT[0] + (FRACT_DARK[0] - FRACT[0]) * fib * 0.8;
        const ag = FRACT[1] + (FRACT_DARK[1] - FRACT[1]) * fib * 0.8;
        const ab = FRACT[2] + (FRACT_DARK[2] - FRACT[2]) * fib * 0.8;
        const lr = buf.light[idx * 3] * 1.05 + 0.04;
        const lg = buf.light[idx * 3 + 1] * 1.05 + 0.04;
        const lb = buf.light[idx * 3 + 2] * 1.05 + 0.04;
        const sp = buf.spec[idx] * 0.6;
        const fr = tone(ar * lr + sp * KEY_C[0]);
        const fg = tone(ag * lg + sp * KEY_C[1]);
        const fb = tone(ab * lb + sp * KEY_C[2]);
        const dim = 1 - 0.45 * lip;
        D[o] = (src[o] + (fr - src[o]) * pale) * dim;
        D[o + 1] = (src[o + 1] + (fg - src[o + 1]) * pale) * dim;
        D[o + 2] = (src[o + 2] + (fb - src[o + 2]) * pale) * dim;
      } else {
        D[o] = src[o]; D[o + 1] = src[o + 1]; D[o + 2] = src[o + 2];
      }
      D[o + 3] = Math.round(src[o + 3] * k);
    }
  }
  cx.putImageData(img, 0, 0);

  // collision samples along the axis
  const samples = [];
  const a = left ? -R.L / 2 : F.x0;
  const b = left ? F.x0 : R.L / 2;
  const n = 14;
  for (let s = 0; s <= n; s++) {
    const x = a + ((b - a) * s) / n;
    samples.push({ x, y: R.geom.yc(x), r: Math.max(R.geom.rTop(x), R.geom.rBot(x)) });
  }
  return { canvas, wCss: R.wCss, hCss: R.hCss, ox: R.ox, oy: R.oy, samples };
}

export function makePieces(w, R, F) {
  return { left: pieceImage(w, R, F, true), right: pieceImage(w, R, F, false) };
}

/** A crack creeping in from the tension side before the snap. */
export function drawCrack(ctx, R, F, progress) {
  if (progress <= 0.001) return;
  const g = R.geom;
  const ts = F.ts;
  const vEnd = ts * (1 - 1.5 * progress);
  const steps = 26;
  const pts = [];
  for (let s = 0; s <= steps; s++) {
    const q = s / steps;
    const v = ts + (vEnd - ts) * q;
    const x = F.baseAt(v) + F.r0 * 0.05 * Math.sin(v * 23 + F.x0) + F.r0 * 0.03 * Math.sin(v * 51);
    const rr = v < 0 ? g.rTop(x) : g.rBot(x);
    pts.push([x, g.yc(x) + v * rr * 0.985]);
  }
  ctx.save();
  ctx.lineCap = 'round';
  // wide open where it started, a hairline at its tip
  for (let s = 0; s < steps; s++) {
    const q = s / steps;
    const a = pts[s], b = pts[s + 1];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineWidth = 0.5 + (1 - q) * (0.6 + 2.2 * progress);
    ctx.strokeStyle = `rgba(10,6,3,${(0.5 + 0.45 * (1 - q)).toFixed(3)})`;
    ctx.stroke();
  }
  // fresh fibres catching the light along one lip
  ctx.translate(0.8, -0.3 * ts);
  ctx.beginPath();
  const n = Math.max(2, Math.round(steps * 0.7));
  for (let s = 0; s <= n; s++) (s ? ctx.lineTo(pts[s][0], pts[s][1]) : ctx.moveTo(pts[s][0], pts[s][1]));
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = `rgba(236,214,168,${(0.28 * progress).toFixed(3)})`;
  ctx.stroke();
  ctx.restore();
}
