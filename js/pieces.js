// The two halves after the snap are rigid bodies: they keep the exact
// pixels they had in the stick, fall, knock against the floor and settle.

import { clamp } from './util.js';

export class RigidPiece {
  /**
   * @param {object} part  { canvas, wCss, hCss, ox, oy, samples } in stick-local CSS px
   * @param {{x:number,y:number,ang:number}} pose  where the stick's local origin was in the world
   * @param {number} floor  y of the floor under this piece
   */
  constructor(part, pose, floor) {
    this.part = part;
    this.floor = floor;
    const S = part.samples;
    let cx = 0, cy = 0, w = 0;
    for (const s of S) {
      const wi = s.r * s.r;
      cx += s.x * wi;
      cy += s.y * wi;
      w += wi;
    }
    cx /= w;
    cy /= w;
    this.com = { x: cx, y: cy };
    this.lx = S.map((s) => s.x - cx);
    this.ly = S.map((s) => s.y - cy);
    this.rs = S.map((s) => s.r);
    let I = 0;
    for (let i = 0; i < S.length; i++) {
      const wi = this.rs[i] * this.rs[i];
      I += (this.lx[i] * this.lx[i] + this.ly[i] * this.ly[i] + this.rs[i] * this.rs[i] * 0.5) * wi;
    }
    this.invMass = 1;
    this.invI = w / Math.max(1, I);
    this.ang = pose.ang;
    const c = Math.cos(pose.ang), s = Math.sin(pose.ang);
    this.pos = { x: pose.x + cx * c - cy * s, y: pose.y + cx * s + cy * c };
    this.vel = { x: 0, y: 0 };
    this.omega = 0;
    this.asleep = false;
    this.still = 0;
    this.grounded = 0;
    this.lastClack = -1;
  }

  /** Stick-local origin of this piece in the world, for saving/restoring. */
  originPose() {
    const c = Math.cos(this.ang), s = Math.sin(this.ang);
    return {
      x: this.pos.x - (this.com.x * c - this.com.y * s),
      y: this.pos.y - (this.com.x * s + this.com.y * c),
      ang: this.ang,
    };
  }

  setOriginPose(p) {
    const c = Math.cos(p.ang), s = Math.sin(p.ang);
    this.ang = p.ang;
    this.pos.x = p.x + this.com.x * c - this.com.y * s;
    this.pos.y = p.y + this.com.x * s + this.com.y * c;
  }

  worldPoint(i) {
    const c = Math.cos(this.ang), s = Math.sin(this.ang);
    return {
      x: this.pos.x + this.lx[i] * c - this.ly[i] * s,
      y: this.pos.y + this.lx[i] * s + this.ly[i] * c,
    };
  }

  draw(ctx) {
    const p = this.part;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.ang);
    ctx.translate(-this.com.x, -this.com.y);
    ctx.drawImage(p.canvas, -p.ox, -p.oy, p.wCss, p.hCss);
    ctx.restore();
  }

  step(dt, env, time) {
    if (this.asleep) return;
    this.vel.y += env.g * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.ang += this.omega * dt;
    this.omega *= 1 - 0.2 * dt;

    const c = Math.cos(this.ang), s = Math.sin(this.ang);

    // keep the whole piece on screen
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < this.lx.length; i++) {
      const wx = this.lx[i] * c - this.ly[i] * s;
      if (wx - this.rs[i] < minX) minX = wx - this.rs[i];
      if (wx + this.rs[i] > maxX) maxX = wx + this.rs[i];
    }
    if (this.pos.x + minX < env.left) {
      this.pos.x = env.left - minX;
      if (this.vel.x < 0) this.vel.x *= -0.3;
    } else if (this.pos.x + maxX > env.right) {
      this.pos.x = env.right - maxX;
      if (this.vel.x > 0) this.vel.x *= -0.3;
    }

    const contacts = [];
    let maxPen = 0;
    for (let i = 0; i < this.lx.length; i++) {
      const rx = this.lx[i] * c - this.ly[i] * s;
      const ry = this.lx[i] * s + this.ly[i] * c + this.rs[i] * 0.92;
      const pen = this.pos.y + ry - this.floor;
      if (pen > 0) {
        contacts.push({ rx, ry, pen });
        if (pen > maxPen) maxPen = pen;
      }
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
          // dry wood on a hard floor: one dull hop at most, then it lies down
          const e = vcy > 260 ? 0.12 : 0;
          const denom = this.invMass + ct.rx * ct.rx * this.invI;
          const j = ((1 + e) * vcy) / denom;
          this.vel.y -= j * this.invMass;
          this.omega -= ct.rx * j * this.invI;
          const dt2 = this.invMass + ct.ry * ct.ry * this.invI;
          const jt = clamp(-vcx / dt2, -0.6 * j, 0.6 * j);
          this.vel.x += jt * this.invMass;
          this.omega += -ct.ry * jt * this.invI;
        }
      }
      if (hardest > 60 && time - this.lastClack > 0.07) {
        this.lastClack = time;
        env.onClack(this, clamp(hardest / 900, 0, 1));
      }
      this.omega *= 1 - clamp(4 * dt, 0, 1);
      this.vel.x *= 1 - clamp(2.4 * dt, 0, 1);
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

// Splinters and bark crumbs thrown out at the snap; they stay where they land.
export class Chips {
  constructor() {
    this.list = [];
  }

  burst(x, y, dirX, dirY, scale, rand, floor, count = 30) {
    for (let i = 0; i < count; i++) {
      const spread = (rand() - 0.5) * 2.4;
      const c = Math.cos(spread), s = Math.sin(spread);
      const bx = dirX * c - dirY * s;
      const by = dirX * s + dirY * c;
      const sp = (120 + Math.pow(rand(), 1.7) * 560) * scale;
      const long = rand() < 0.3;
      const wood = rand() < 0.6;
      this.list.push({
        x: x + (rand() - 0.5) * 8 * scale,
        y: y + (rand() - 0.5) * 8 * scale,
        vx: bx * sp + (rand() - 0.5) * 110 * scale,
        vy: by * sp - rand() * 200 * scale,
        a: rand() * Math.PI * 2,
        w: (rand() - 0.5) * 32,
        len: (long ? 4 + rand() * 8 : 1.1 + rand() * 2.6) * scale,
        wid: (long ? 0.6 + rand() * 0.7 : 0.9 + rand() * 1.5) * scale,
        col: wood ? [214 + rand() * 30, 190 + rand() * 30, 142 + rand() * 32] : [56 + rand() * 36, 36 + rand() * 22, 22 + rand() * 12],
        floor: floor + (rand() - 0.3) * 24 * scale,
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
      ctx.fillStyle = `rgba(${c.col[0] | 0},${c.col[1] | 0},${c.col[2] | 0},${(c.rest ? 0.7 : 1) * dim})`;
      ctx.fillRect(-c.len / 2, -c.wid / 2, c.len, c.wid);
      ctx.restore();
    }
  }
}
