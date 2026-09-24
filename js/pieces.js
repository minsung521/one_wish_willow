// Rigid-body halves after the snap. Each half keeps the shape it had at the
// moment of breaking, then relaxes most of the bend out (green wood keeps a
// little), falls, knocks against the floor and comes to rest.

import { clamp } from './util.js';

export class Piece {
  /**
   * @param {object} bent  world geometry at the break {xs, ys, rs, us}
   * @param {object} rest  same slice with the bend mostly relaxed
   */
  constructor(bent, rest, caps, floor) {
    const n = bent.xs.length;
    this.n = n;
    this.rs = bent.rs;
    this.us = bent.us;
    this.caps = caps;
    this.floor = floor;

    // centre of mass (weighted by cross-section)
    let cx = 0, cy = 0, w = 0;
    for (let i = 0; i < n; i++) {
      const wi = bent.rs[i] * bent.rs[i];
      cx += bent.xs[i] * wi;
      cy += bent.ys[i] * wi;
      w += wi;
    }
    cx /= w;
    cy /= w;
    this.pos = { x: cx, y: cy };
    this.vel = { x: 0, y: 0 };
    this.ang = 0;
    this.omega = 0;

    this.bx = new Float32Array(n);
    this.by = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.bx[i] = bent.xs[i] - cx;
      this.by[i] = bent.ys[i] - cy;
    }

    // align the relaxed shape with the bent one (same centre, same chord)
    let rx = 0, ry = 0;
    for (let i = 0; i < n; i++) {
      const wi = rest.rs[i] * rest.rs[i];
      rx += rest.xs[i] * wi;
      ry += rest.ys[i] * wi;
    }
    rx /= w;
    ry /= w;
    const chord = (xs, ys) => Math.atan2(ys[n - 1] - ys[0], xs[n - 1] - xs[0]);
    const da = chord(bent.xs, bent.ys) - chord(rest.xs, rest.ys);
    // rotation between the relaxed slice's own frame and this body's frame
    this.da = da;
    const c = Math.cos(da), s = Math.sin(da);
    this.qx = new Float32Array(n);
    this.qy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = rest.xs[i] - rx;
      const y = rest.ys[i] - ry;
      this.qx[i] = x * c - y * s;
      this.qy[i] = x * s + y * c;
    }

    let I = 0;
    for (let i = 0; i < n; i++) {
      const wi = bent.rs[i] * bent.rs[i];
      I += (this.qx[i] * this.qx[i] + this.qy[i] * this.qy[i] + bent.rs[i] * bent.rs[i] * 0.5) * wi;
    }
    this.invMass = 1;
    this.invI = w / Math.max(1, I);

    this.relax = 0;
    this.relaxV = 0;
    this.asleep = false;
    this.still = 0;
    this.lastClack = -1;
    this.grounded = 0;
    this.lx = new Float32Array(n);
    this.ly = new Float32Array(n);
    this._local();
  }

  _local() {
    const k = clamp(this.relax, 0, 1.3);
    for (let i = 0; i < this.n; i++) {
      this.lx[i] = this.bx[i] + (this.qx[i] - this.bx[i]) * k;
      this.ly[i] = this.by[i] + (this.qy[i] - this.by[i]) * k;
    }
  }

  settleNow() {
    this.relax = 1;
    this.relaxV = 0;
    this._local();
  }

  world() {
    const n = this.n;
    const xs = new Float32Array(n);
    const ys = new Float32Array(n);
    const c = Math.cos(this.ang), s = Math.sin(this.ang);
    for (let i = 0; i < n; i++) {
      xs[i] = this.pos.x + this.lx[i] * c - this.ly[i] * s;
      ys[i] = this.pos.y + this.lx[i] * s + this.ly[i] * c;
    }
    return { xs, ys, rs: this.rs, us: this.us };
  }

  /**
   * @param {number} dt
   * @param {{g:number, left:number, right:number, onClack:function}} env
   */
  step(dt, env, time) {
    // spring the bend out of the wood (slightly underdamped)
    if (this.relax < 0.999 || Math.abs(this.relaxV) > 0.01) {
      const k = 1600;
      const c = 2 * 0.38 * Math.sqrt(k);
      this.relaxV += (k * (1 - this.relax) - c * this.relaxV) * dt;
      this.relax += this.relaxV * dt;
      this._local();
    }
    if (this.asleep) return;

    this.vel.y += env.g * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.ang += this.omega * dt;
    this.omega *= 1 - 0.25 * dt;

    // walls keep the pieces on screen
    if (this.pos.x < env.left && this.vel.x < 0) this.vel.x *= -0.4;
    if (this.pos.x > env.right && this.vel.x > 0) this.vel.x *= -0.4;

    const c = Math.cos(this.ang), s = Math.sin(this.ang);
    const contacts = [];
    let maxPen = 0;
    for (let i = 0; i < this.n; i += 3) {
      const rx = this.lx[i] * c - this.ly[i] * s;
      const ry = this.lx[i] * s + this.ly[i] * c;
      const bottom = this.pos.y + ry + this.rs[i] * 0.95;
      const pen = bottom - this.floor;
      if (pen > 0) {
        contacts.push({ rx, ry: ry + this.rs[i] * 0.95, pen });
        if (pen > maxPen) maxPen = pen;
      }
    }
    // also the very end
    {
      const i = this.n - 1;
      const rx = this.lx[i] * c - this.ly[i] * s;
      const ry = this.lx[i] * s + this.ly[i] * c;
      const pen = this.pos.y + ry + this.rs[i] - this.floor;
      if (pen > 0) contacts.push({ rx, ry: ry + this.rs[i], pen });
      if (pen > maxPen) maxPen = pen;
    }

    if (contacts.length) {
      this.pos.y -= maxPen;
      this.grounded = 1;
      let hardest = 0;
      for (let pass = 0; pass < 2; pass++) {
        for (const ct of contacts) {
          const vcx = this.vel.x - this.omega * ct.ry;
          const vcy = this.vel.y + this.omega * ct.rx;
          if (vcy <= 0) continue;
          if (pass === 0) hardest = Math.max(hardest, vcy);
          const e = vcy > 140 ? 0.28 : 0;
          const denom = this.invMass + ct.rx * ct.rx * this.invI;
          const j = ((1 + e) * vcy) / denom;
          this.vel.y -= j * this.invMass;
          this.omega -= ct.rx * j * this.invI;
          // friction
          const dt2 = this.invMass + ct.ry * ct.ry * this.invI;
          let jt = -vcx / dt2;
          const lim = 0.55 * j;
          jt = clamp(jt, -lim, lim);
          this.vel.x += jt * this.invMass;
          this.omega += -ct.ry * jt * this.invI;
        }
      }
      if (hardest > 60 && time - this.lastClack > 0.07) {
        this.lastClack = time;
        env.onClack(this, clamp(hardest / 900, 0, 1));
      }
      this.omega *= 1 - clamp(4 * dt, 0, 1);
      this.vel.x *= 1 - clamp(2.2 * dt, 0, 1);
    }

    // resting contact: bleed off the jitter of a stick lying on a floor
    const speed = Math.hypot(this.vel.x, this.vel.y);
    if (this.grounded && speed < 40 && Math.abs(this.omega) < 0.6) {
      const k = Math.exp(-dt * 9);
      this.vel.x *= k;
      this.omega *= k;
      if (this.vel.y < 0) this.vel.y *= k;
    }
    if (this.grounded && speed < 22 && Math.abs(this.omega) < 0.3) {
      this.still += dt;
      if (this.still > 0.4) {
        this.asleep = true;
        this.vel.x = this.vel.y = 0;
        this.omega = 0;
      }
    } else {
      this.still = Math.max(0, this.still - dt * 1.5);
    }
  }
}

// Chips of bark and wood thrown out at the snap; they stay where they land.
export class Chips {
  constructor() {
    this.list = [];
  }

  burst(x, y, dirX, dirY, scale, rand, floor, count = 34) {
    for (let i = 0; i < count; i++) {
      const spread = (rand() - 0.5) * 2.6;
      const c = Math.cos(spread), s = Math.sin(spread);
      const bx = dirX * c - dirY * s;
      const by = dirX * s + dirY * c;
      const sp = (140 + Math.pow(rand(), 1.6) * 620) * scale;
      const long = rand() < 0.22;
      const wood = rand() < 0.55;
      this.list.push({
        x: x + (rand() - 0.5) * 6,
        y: y + (rand() - 0.5) * 6,
        vx: bx * sp + (rand() - 0.5) * 120 * scale,
        vy: by * sp - rand() * 220 * scale,
        a: rand() * Math.PI * 2,
        w: (rand() - 0.5) * 30,
        len: (long ? 5 + rand() * 7 : 1.2 + rand() * 2.8) * scale,
        wid: (long ? 0.6 + rand() * 0.6 : 0.9 + rand() * 1.6) * scale,
        col: wood ? [220 + rand() * 25, 200 + rand() * 25, 150 + rand() * 30] : [70 + rand() * 40, 46 + rand() * 25, 26 + rand() * 12],
        floor: floor + (rand() - 0.3) * 26 * scale,
        rest: false,
        bounced: 0,
      });
    }
  }

  step(dt, g, onTick) {
    for (const c of this.list) {
      if (c.rest) continue;
      c.vy += g * dt;
      c.vx *= 1 - 0.4 * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.a += c.w * dt;
      if (c.y > c.floor) {
        c.y = c.floor;
        if (c.vy > 90 && c.bounced < 3) {
          if (c.bounced === 0) onTick(Math.min(1, c.vy / 900));
          c.vy *= -0.32;
          c.vx *= 0.6;
          c.w *= 0.5;
          c.bounced++;
        } else {
          c.rest = true;
          c.vy = 0;
        }
      }
    }
  }

  draw(ctx, dim) {
    for (const c of this.list) {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.a);
      ctx.fillStyle = `rgba(${c.col[0] | 0},${c.col[1] | 0},${c.col[2] | 0},${(c.rest ? 0.75 : 1) * dim})`;
      ctx.fillRect(-c.len / 2, -c.wid / 2, c.len, c.wid);
      ctx.restore();
    }
  }
}
