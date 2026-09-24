// Small math helpers and a seeded RNG so that every visitor's branch is
// unique, yet the same branch (and the same break) comes back on reload.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

// Smooth 1D value noise, deterministic for a given rng.
export function makeNoise1D(rand, size = 256) {
  const table = new Float32Array(size);
  for (let i = 0; i < size; i++) table[i] = rand() * 2 - 1;
  return (x) => {
    const xi = Math.floor(x);
    const f = x - xi;
    const a = table[((xi % size) + size) % size];
    const b = table[(((xi + 1) % size) + size) % size];
    const s = f * f * (3 - 2 * f);
    return a + (b - a) * s;
  };
}

export function rgb(c, a = 1) {
  return a >= 1
    ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
    : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a.toFixed(3)})`;
}

export function mixColor(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}
