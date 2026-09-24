// Every sound is synthesised with Web Audio — no samples to load.
//
//  ambience  : a barely-there room tone, cut dead at the moment of the snap
//  creak     : impulse train through wooden body resonances (stick-slip),
//              driven by how fast and how hard the branch is being bent
//  crack     : single fibres giving way under load
//  snap      : layered transient + body knock + low thump + fibre crackle,
//              left ringing in a small room reverb
//  clack     : broken pieces landing
//  wish      : a held tone while confirming, then a slow swell as it leaves

export class Sound {
  constructor() {
    this.ctx = null;
    this.ready = false;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC({ latencyHint: 'interactive' });
      } catch {
        return;
      }
      this._build();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this.ready = true;
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  _build() {
    const ctx = this.ctx;

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.knee.value = 10;
    this.comp.ratio.value = 5;
    this.comp.attack.value = 0.002;
    this.comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);

    // White noise, shared by everything.
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;

    // Small, dark room.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.6, 3.2);
    this.reverbOut = ctx.createGain();
    this.reverbOut.gain.value = 0.55;
    this.reverb.connect(this.reverbOut);
    this.reverbOut.connect(this.master);

    this._buildCreak();
  }

  _impulse(seconds, decay) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        // progressively darker tail
        const k = 0.25 + 0.7 * t;
        lp = lp + (Math.random() * 2 - 1 - lp) * (1 - k);
        d[i] = lp * Math.pow(1 - t, decay) * (i < ctx.sampleRate * 0.012 ? i / (ctx.sampleRate * 0.012) : 1);
      }
    }
    return buf;
  }

  _noiseSource(loop = false) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = loop;
    return src;
  }

  _startNoise(src, when, dur) {
    const off = Math.random() * 1.5;
    src.start(when, off, dur);
  }

  _filter(type, freq, q = 1) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  _env(gainNode, t, peak, attack, decay) {
    const g = gainNode.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(peak, t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  // A filtered noise burst. Returns nothing; cleans itself up.
  _burst({ t, type = 'bandpass', freq = 2000, q = 1, peak = 0.3, attack = 0.001, decay = 0.05, send = 0, hp = 0 }) {
    const ctx = this.ctx;
    const src = this._noiseSource();
    let node = src;
    if (hp) {
      const h = this._filter('highpass', hp, 0.7);
      node.connect(h);
      node = h;
    }
    const f = this._filter(type, freq, q);
    node.connect(f);
    const g = ctx.createGain();
    f.connect(g);
    g.connect(this.master);
    if (send) {
      const s = ctx.createGain();
      s.gain.value = send;
      g.connect(s);
      s.connect(this.reverb);
    }
    this._env(g, t, peak, attack, decay);
    this._startNoise(src, t, attack + decay + 0.05);
  }

  _tone({ t, freq, freqEnd = 0, type = 'sine', peak = 0.2, attack = 0.002, decay = 0.1, send = 0 }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + attack + decay);
    const g = ctx.createGain();
    o.connect(g);
    g.connect(this.master);
    if (send) {
      const s = ctx.createGain();
      s.gain.value = send;
      g.connect(s);
      s.connect(this.reverb);
    }
    this._env(g, t, peak, attack, decay);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
  }

  // ---------------------------------------------------------------- ambience

  startAmbience() {
    if (!this.ctx || this.amb) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(1, t + 3);
    out.connect(this.master);

    const low = this._noiseSource(true);
    const lp = this._filter('lowpass', 260, 0.5);
    const lg = ctx.createGain();
    lg.gain.value = 0.05;
    low.connect(lp);
    lp.connect(lg);
    lg.connect(out);

    const air = this._noiseSource(true);
    const bp = this._filter('bandpass', 1100, 0.6);
    const ag = ctx.createGain();
    ag.gain.value = 0.006;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.004;
    lfo.connect(lfoG);
    lfoG.connect(ag.gain);
    air.connect(bp);
    bp.connect(ag);
    ag.connect(out);

    low.start(t);
    air.start(t, 0.7);
    lfo.start(t);
    this.amb = { out, nodes: [low, air, lfo] };
  }

  cutAmbience(time = 0.04) {
    if (!this.amb) return;
    const t = this.ctx.currentTime;
    const g = this.amb.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(0.0001, t, time);
    const nodes = this.amb.nodes;
    setTimeout(() => nodes.forEach((n) => { try { n.stop(); } catch { /* */ } }), 2000);
    this.amb = null;
  }

  // ---------------------------------------------------------------- creak

  _buildCreak() {
    const ctx = this.ctx;
    // An impulse train: cosine partials of equal amplitude.
    const n = 48;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let k = 1; k < n; k++) real[k] = 1 - k / n;
    const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(wave);
    osc.frequency.value = 50;

    const pre = ctx.createGain();
    pre.gain.value = 0.35;
    osc.connect(pre);

    const out = ctx.createGain();
    out.gain.value = 0;
    // Wooden body resonances.
    [
      [380, 11, 1.0],
      [820, 9, 0.7],
      [1570, 7, 0.45],
      [2900, 5, 0.18],
    ].forEach(([f, q, g]) => {
      const bp = this._filter('bandpass', f, q);
      const gg = ctx.createGain();
      gg.gain.value = g;
      pre.connect(bp);
      bp.connect(gg);
      gg.connect(out);
    });

    // Fibrous friction hiss.
    const fr = this._noiseSource(true);
    const frf = this._filter('bandpass', 2600, 1.4);
    const frg = ctx.createGain();
    frg.gain.value = 0;
    fr.connect(frf);
    frf.connect(frg);
    frg.connect(this.master);

    const send = ctx.createGain();
    send.gain.value = 0.12;
    out.connect(this.master);
    out.connect(send);
    send.connect(this.reverb);

    osc.start();
    fr.start();
    this.creak = { osc, out, frg };
  }

  /**
   * @param {number} speed normalised bend speed (0..~2)
   * @param {number} tension 0..1
   * @param {boolean} active whether the branch is held
   */
  updateCreak(speed, tension, active) {
    if (!this.creak) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1.4, speed);
    const onset = Math.min(1, tension * 3);
    const level = active ? s * (0.02 + 0.22 * tension * tension) * onset * (0.55 + 0.45 * Math.random()) : 0;
    const hiss = active ? s * (0.004 + 0.02 * tension) : 0;
    const f = 34 + 110 * tension + (Math.random() - 0.5) * (10 + 30 * tension);
    this.creak.out.gain.setTargetAtTime(level, t, 0.025);
    this.creak.frg.gain.setTargetAtTime(hiss, t, 0.04);
    this.creak.osc.frequency.setTargetAtTime(Math.max(18, f), t, 0.015);
  }

  // ---------------------------------------------------------------- events

  grab() {
    if (!this.ready) return;
    const t = this.now + 0.005;
    // a finger closing on bark
    this._burst({ t, type: 'bandpass', freq: 900 + Math.random() * 200, q: 9, peak: 0.1, attack: 0.001, decay: 0.035 });
    // and the leaves answering
    this._rustle(t + 0.01, 0.045, 0.28);
  }

  _rustle(t, peak, dur) {
    const ctx = this.ctx;
    const src = this._noiseSource();
    const hp = this._filter('highpass', 2200, 0.7);
    const bp = this._filter('bandpass', 4200 + Math.random() * 1500, 0.9);
    const g = ctx.createGain();
    src.connect(hp);
    hp.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    const gg = g.gain;
    gg.setValueAtTime(0.0001, t);
    const steps = 7;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      gg.linearRampToValueAtTime(peak * (1 - k) * (0.35 + Math.random() * 0.65) + 0.0001, t + dur * k);
    }
    this._startNoise(src, t, dur + 0.05);
  }

  release(speed) {
    if (!this.ready) return;
    const t = this.now + 0.005;
    const s = Math.min(1, speed);
    if (s < 0.05) return;
    this._rustle(t, 0.02 + 0.07 * s, 0.25 + 0.35 * s);
    this._burst({ t, type: 'lowpass', freq: 500, q: 0.7, peak: 0.05 * s, attack: 0.02, decay: 0.2 });
  }

  crack(intensity) {
    if (!this.ready) return;
    const t = this.now + 0.002;
    const i = Math.min(1, intensity);
    this._burst({ t, type: 'bandpass', freq: 2600 + Math.random() * 3000, q: 1.6, hp: 900, peak: 0.05 + 0.3 * i * i, attack: 0.0008, decay: 0.012 + 0.03 * i, send: 0.2 });
    this._burst({ t, type: 'bandpass', freq: 650 + Math.random() * 900, q: 14, peak: 0.04 + 0.22 * i, attack: 0.001, decay: 0.03 + 0.05 * i });
  }

  snap() {
    if (!this.ready) return;
    const t = this.now + 0.002;
    // the break: two splits a hair apart, then fibres
    this._burst({ t, type: 'highpass', freq: 1100, q: 0.7, peak: 1.0, attack: 0.0006, decay: 0.07, send: 0.9 });
    this._burst({ t: t + 0.011, type: 'bandpass', freq: 3400, q: 1.2, peak: 0.6, attack: 0.0006, decay: 0.05, send: 0.6 });
    this._burst({ t: t + 0.027, type: 'bandpass', freq: 5200, q: 1.5, peak: 0.28, attack: 0.0006, decay: 0.04, send: 0.4 });
    // wood body knock
    this._burst({ t, type: 'bandpass', freq: 1150, q: 7, peak: 0.95, attack: 0.001, decay: 0.13, send: 0.7 });
    this._burst({ t, type: 'bandpass', freq: 2350, q: 6, peak: 0.55, attack: 0.001, decay: 0.08, send: 0.5 });
    this._burst({ t, type: 'bandpass', freq: 520, q: 8, peak: 0.5, attack: 0.001, decay: 0.16, send: 0.5 });
    // weight
    this._tone({ t, freq: 150, freqEnd: 42, peak: 0.55, attack: 0.002, decay: 0.24 });
    // fibres tearing loose
    for (let k = 0; k < 11; k++) {
      const dt = 0.03 + Math.pow(Math.random(), 1.6) * 0.26;
      this._burst({ t: t + dt, type: 'bandpass', freq: 2500 + Math.random() * 4500, q: 2, hp: 1500, peak: 0.03 + Math.random() * 0.1, attack: 0.0006, decay: 0.008 + Math.random() * 0.02, send: 0.3 });
    }
    // leaves thrown
    this._rustle(t + 0.02, 0.08, 0.5);
  }

  clack(strength) {
    if (!this.ready) return;
    const t = this.now + 0.002;
    const s = Math.min(1, strength);
    this._burst({ t, type: 'bandpass', freq: 700 + Math.random() * 900, q: 12, peak: 0.08 + 0.4 * s, attack: 0.0008, decay: 0.05 + 0.05 * s, send: 0.45 });
    this._burst({ t, type: 'bandpass', freq: 2600 + Math.random() * 1400, q: 5, peak: 0.04 + 0.2 * s, attack: 0.0006, decay: 0.02, send: 0.3 });
    this._tone({ t, freq: 190 + Math.random() * 60, freqEnd: 120, peak: 0.05 + 0.12 * s, attack: 0.001, decay: 0.05 });
  }

  tick(strength) {
    if (!this.ready) return;
    const t = this.now + 0.002 + Math.random() * 0.01;
    this._burst({ t, type: 'bandpass', freq: 3500 + Math.random() * 4000, q: 4, peak: 0.015 + 0.05 * Math.min(1, strength), attack: 0.0005, decay: 0.008, send: 0.4 });
  }

  // ---------------------------------------------------------------- wish

  holdStart() {
    if (!this.ready || this.hold) return;
    const ctx = this.ctx;
    const t = this.now;
    const out = ctx.createGain();
    out.gain.value = 0.0001;
    const lp = this._filter('lowpass', 900, 0.5);
    lp.connect(out);
    out.connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    out.connect(send);
    send.connect(this.reverb);
    const oscs = [196, 196.7, 293.7].map((f) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(lp);
      o.start(t);
      return o;
    });
    this.hold = { out, oscs, lp };
  }

  holdProgress(p) {
    if (!this.hold) return;
    const t = this.now;
    this.hold.out.gain.setTargetAtTime(0.0001 + 0.07 * p * p, t, 0.05);
    this.hold.lp.frequency.setTargetAtTime(700 + 1400 * p, t, 0.08);
    this.hold.oscs.forEach((o, i) => o.frequency.setTargetAtTime([196, 196.7, 293.7][i] * (1 + 0.03 * p), t, 0.1));
  }

  holdEnd(fade = 0.12) {
    if (!this.hold) return;
    const { out, oscs } = this.hold;
    const t = this.now;
    out.gain.cancelScheduledValues(t);
    out.gain.setValueAtTime(out.gain.value, t);
    out.gain.setTargetAtTime(0.0001, t, fade);
    oscs.forEach((o) => o.stop(t + fade * 8));
    this.hold = null;
  }

  wishRelease() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = this.now + 0.01;
    const out = ctx.createGain();
    out.gain.value = 1;
    const lp = this._filter('lowpass', 1600, 0.5);
    lp.connect(out);
    out.connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.9;
    out.connect(send);
    send.connect(this.reverb);
    [
      [98, 0.05],
      [98.4, 0.04],
      [146.8, 0.04],
      [196, 0.035],
      [293.7, 0.025],
      [440, 0.012],
      [587.3, 0.006],
    ].forEach(([f, peak], i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + 1.1 + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 7.5);
      o.connect(g);
      g.connect(lp);
      o.start(t);
      o.stop(t + 7.6);
    });
    // breath of air as the words leave
    const src = this._noiseSource(true);
    const hp = this._filter('bandpass', 5200, 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.016, t + 1.0);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);
    src.connect(hp);
    hp.connect(g);
    g.connect(send);
    g.connect(this.master);
    this._startNoise(src, t, 3.7);
  }
}
