// The wish: a quiet prompt, a single line to write on, and a press-and-hold
// to let it go. On release the words burn away letter by letter.

import { clamp } from './util.js';
import { buzz } from './haptics.js';

const HOLD_MS = 1500;
const INK = [239, 230, 214];

export class WishUI {
  constructor({ sound, onConfirm }) {
    this.sound = sound;
    this.onConfirm = onConfirm;
    this.root = document.getElementById('wish');
    this.input = document.getElementById('wish-input');
    this.count = document.getElementById('wish-count');
    this.btn = document.getElementById('wish-hold');
    this.fill = document.getElementById('hold-fill');
    this.p = 0;
    this.pressing = false;
    this.done = false;
    this.raf = 0;
    this._bind();
    this._viewport();
  }

  _bind() {
    const { input, btn } = this;
    input.addEventListener('input', () => this._changed());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!e.repeat && this._hasText()) this._press(true);
      }
    });
    input.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') this._press(false);
    });
    input.addEventListener('focus', () => this.root.classList.toggle('compact', this._keyboardLikely()));
    input.addEventListener('blur', () => this.root.classList.remove('compact'));

    btn.addEventListener('pointerdown', (e) => {
      if (btn.disabled) return;
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch { /* */ }
      this._press(true);
    });
    const up = () => this._press(false);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', up);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn.addEventListener('keydown', (e) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
        e.preventDefault();
        this._press(true);
      }
    });
    btn.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') this._press(false);
    });
  }

  _keyboardLikely() {
    return window.matchMedia('(pointer: coarse)').matches;
  }

  // Keep the prompt inside the visible area when the on-screen keyboard is up.
  _viewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      document.documentElement.style.setProperty('--vvh', vv.height + 'px');
      document.documentElement.style.setProperty('--vvtop', vv.offsetTop + 'px');
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    apply();
  }

  _hasText() {
    return this.input.value.trim().length > 0;
  }

  _changed() {
    const el = this.input;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
    const left = el.maxLength - el.value.length;
    this.count.textContent = left <= 30 ? String(left) : '';
    this.count.classList.toggle('on', left <= 30);
    const ok = this._hasText();
    this.btn.disabled = !ok;
    this.btn.classList.toggle('ready', ok);
    if (!ok) this._press(false);
  }

  show(instant = false) {
    const r = this.root;
    r.classList.add('shown');
    r.setAttribute('aria-hidden', 'false');
    if (instant) {
      r.classList.add('q-on', 'field-on');
      return;
    }
    requestAnimationFrame(() => r.classList.add('q-on'));
    setTimeout(() => r.classList.add('field-on'), 1500);
    setTimeout(() => {
      if (!this._keyboardLikely()) this.input.focus({ preventScroll: true });
    }, 2300);
  }

  _press(on) {
    if (this.done) return;
    if (on) {
      if (this.pressing || !this._hasText()) return;
      this.pressing = true;
      this.btn.classList.add('pressing');
      this.sound.holdStart();
      buzz(8);
    } else {
      if (!this.pressing) return;
      this.pressing = false;
      this.btn.classList.remove('pressing');
      if (this.p < 1) this.sound.holdEnd();
    }
    if (!this.raf) {
      let last = performance.now();
      const tick = (now) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (this.pressing) this.p += dt / (HOLD_MS / 1000);
        else this.p -= dt * 2.5;
        this.p = clamp(this.p, 0, 1);
        const e = 1 - Math.pow(1 - this.p, 2);
        this.fill.style.transform = `scaleX(${e})`;
        this.sound.holdProgress(this.p);
        if (this.pressing && this.p >= 1) {
          this.raf = 0;
          this._confirm();
          return;
        }
        if (!this.pressing && this.p <= 0) {
          this.raf = 0;
          return;
        }
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
  }

  _confirm() {
    this.done = true;
    this.pressing = false;
    this.sound.holdEnd(0.4);
    const text = this.input.value.trim();
    this.input.readOnly = true;
    this.btn.disabled = true;
    this.input.blur();
    this.onConfirm(text);
  }

  /** Begin the burn. Calls onDone when the last ember is gone. */
  release(fxCanvas, onDone) {
    const burn = new Burn(fxCanvas, this.input);
    this.root.classList.add('leaving');
    burn.start(() => {
      this.root.classList.remove('shown');
      this.root.setAttribute('aria-hidden', 'true');
      onDone();
    });
  }
}

// ---------------------------------------------------------------------------

class Burn {
  constructor(canvas, textarea) {
    this.canvas = canvas;
    this.ta = textarea;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
  }

  _layout() {
    const ta = this.ta;
    const cs = getComputedStyle(ta);
    const rect = ta.getBoundingClientRect();
    const mirror = document.createElement('div');
    const copy = [
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
      'textAlign', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'textTransform',
      'wordSpacing', 'textIndent', 'fontFeatureSettings', 'fontKerning',
    ];
    copy.forEach((k) => { mirror.style[k] = cs[k]; });
    Object.assign(mirror.style, {
      position: 'fixed',
      left: rect.left + 'px',
      top: rect.top + 'px',
      width: rect.width + 'px',
      boxSizing: 'border-box',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'break-word',
      wordBreak: 'normal',
      visibility: 'hidden',
      pointerEvents: 'none',
      margin: '0',
      border: '0',
    });
    const node = document.createTextNode(ta.value);
    mirror.appendChild(node);
    document.body.appendChild(mirror);

    const chars = [];
    const range = document.createRange();
    const str = ta.value;
    let i = 0;
    for (const ch of str) {
      const len = ch.length;
      if (ch.trim()) {
        range.setStart(node, i);
        range.setEnd(node, i + len);
        const rs = range.getClientRects();
        const r = rs[0];
        if (r && r.width > 0) chars.push({ ch, x: r.left, y: r.top, w: r.width, h: r.height });
      }
      i += len;
    }
    document.body.removeChild(mirror);
    this.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    this.chars = chars;
  }

  _raster() {
    const { dpr, chars } = this;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cv = this.canvas;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = this.font;
    ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText('Hg');
    const asc = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || 18;
    const desc = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || 6;
    for (const c of chars) c.base = c.y + (c.h - (asc + desc)) / 2 + asc;

    // sample the glyphs into particles
    const off = document.createElement('canvas');
    off.width = cv.width;
    off.height = cv.height;
    const o = off.getContext('2d', { willReadFrequently: true });
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.font = this.font;
    o.textBaseline = 'alphabetic';
    o.fillStyle = '#fff';
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of chars) {
      o.fillText(c.ch, c.x, c.base);
      minX = Math.min(minX, c.x - 4);
      minY = Math.min(minY, c.y - 4);
      maxX = Math.max(maxX, c.x + c.w + 8);
      maxY = Math.max(maxY, c.y + c.h + 4);
    }
    if (!chars.length) {
      this.parts = { n: 0 };
      return;
    }
    const bx = Math.max(0, Math.floor(minX * dpr));
    const by = Math.max(0, Math.floor(minY * dpr));
    const bw = Math.min(off.width - bx, Math.ceil((maxX - minX) * dpr));
    const bh = Math.min(off.height - by, Math.ceil((maxY - minY) * dpr));
    const img = o.getImageData(bx, by, bw, bh).data;

    let ink = 0;
    for (let k = 3; k < img.length; k += 16) if (img[k] > 100) ink++;
    const est = ink * 4;
    const target = 5200;
    const step = Math.max(1, Math.round(Math.sqrt(est / target)));

    const xs = [], ys = [], owner = [];
    const claimed = new Uint8Array(bw * bh);
    for (let ci = 0; ci < chars.length; ci++) {
      const c = chars[ci];
      const x0 = Math.max(bx, Math.floor((c.x - 2) * dpr));
      const x1 = Math.min(bx + bw, Math.ceil((c.x + c.w + 4) * dpr));
      const y0 = Math.max(by, Math.floor(c.y * dpr));
      const y1 = Math.min(by + bh, Math.ceil((c.y + c.h) * dpr));
      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          const idx = (y - by) * bw + (x - bx);
          const a = img[idx * 4 + 3];
          if (a > 110 && !claimed[idx]) {
            claimed[idx] = 1;
            xs.push(x / dpr);
            ys.push(y / dpr);
            owner.push(ci);
          }
        }
      }
    }
    const n = xs.length;
    const P = {
      n,
      x: new Float32Array(xs),
      y: new Float32Array(ys),
      vx: new Float32Array(n),
      vy: new Float32Array(n),
      t0: new Float32Array(n),
      life: new Float32Array(n),
      age: new Float32Array(n),
      seed: new Float32Array(n),
    };
    for (let k = 0; k < n; k++) {
      const c = chars[owner[k]];
      P.t0[k] = c.t0 + Math.random() * 0.28;
      P.life[k] = 1.3 + Math.random() * 1.6;
      P.vx[k] = (Math.random() - 0.5) * 22;
      P.vy[k] = -8 - Math.random() * 30;
      P.seed[k] = Math.random() * 100;
    }
    this.parts = P;
    this.size = Math.max(1, step * 0.9);
  }

  start(onDone) {
    this._layout();
    const n = this.chars.length;
    const stagger = n > 1 ? Math.min(0.075, 2.2 / n) : 0;
    this.chars.forEach((c, i) => { c.t0 = 0.45 + i * stagger; });
    this._raster();
    this.end = 0.45 + n * stagger + 3.2;
    this.t = 0;
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.t += dt;
      this._draw(dt);
      if (this.t < this.end) requestAnimationFrame(frame);
      else {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        onDone();
      }
    };
    requestAnimationFrame(frame);
  }

  _draw(dt) {
    const { ctx, t } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // the words themselves, until each letter catches
    ctx.font = this.font;
    ctx.textBaseline = 'alphabetic';
    for (const c of this.chars) {
      const k = clamp((t - c.t0) / 0.42, 0, 1);
      if (k >= 1) continue;
      if (k > 0) {
        // ember glow as it catches
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.shadowColor = `rgba(255,150,70,${0.9 * (1 - k)})`;
        ctx.shadowBlur = 14;
        ctx.fillStyle = `rgba(255,${(190 - 60 * k) | 0},${(120 - 60 * k) | 0},${(0.8 * (1 - k)).toFixed(3)})`;
        ctx.fillText(c.ch, c.x, c.base);
        ctx.restore();
      }
      ctx.fillStyle = `rgba(${INK[0]},${INK[1]},${INK[2]},${(1 - k) * (1 - k)})`;
      ctx.fillText(c.ch, c.x, c.base);
    }

    const P = this.parts;
    if (!P.n) return;
    ctx.globalCompositeOperation = 'lighter';
    const s = this.size;
    for (let k = 0; k < P.n; k++) {
      if (t < P.t0[k]) continue;
      const age = (P.age[k] += dt);
      const q = age / P.life[k];
      if (q >= 1) continue;
      P.vy[k] -= 34 * dt;
      P.vx[k] += Math.sin(P.y[k] * 0.045 + P.seed[k] + t * 1.3) * 42 * dt;
      P.vx[k] *= 1 - 0.8 * dt;
      P.x[k] += P.vx[k] * dt;
      P.y[k] += P.vy[k] * dt;
      let r, g, b;
      if (q < 0.18) {
        const m = q / 0.18;
        r = 239 + 16 * m; g = 230 - 50 * m; b = 214 - 124 * m;
      } else {
        const m = (q - 0.18) / 0.82;
        r = 255 - 90 * m; g = 180 - 120 * m; b = 90 - 60 * m;
      }
      const a = q < 0.18 ? 0.9 : 0.9 * Math.pow(1 - (q - 0.18) / 0.82, 1.4);
      ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${a.toFixed(3)})`;
      const sz = s * (1 - q * 0.6);
      ctx.fillRect(P.x[k] - sz / 2, P.y[k] - sz / 2, sz, sz);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
