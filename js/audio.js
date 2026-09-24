// Every sound is synthesised with Web Audio — no samples to load.
//
// Browsers only let audio start from a real user activation (a click, a tap
// being released, a key). A finger pressing down and dragging is not one on
// mobile, so the context is unlocked at the "begin" tap. Every one-shot
// sound checks that the context is actually running: if it is not, the
// sound is dropped rather than queued. A queued snap would otherwise play
// much later, on the next tap.
//
//  ambience : a barely-there room tone, cut dead at the moment of the snap
//  stress   : dry fibres under load: faint hiss, ticks, then cracks
//  snap     : hard split + short body ring + thump + splinters, in a small room
//  clack    : the halves landing
//  wish     : a held tone while confirming, then a slow swell as it leaves

export class Sound {
  constructor() {
    this.ctx = null;
    this.amb = null;
    this.stressNodes = null;
    this.hold = null;
    this.jingleData = null;
    this.jingleBuf = null;
    // the box's opening jingle: start fetching right away so it is ready for the tap
    fetch('assets/audio/jingle.wav').then((r) => (r.ok ? r.arrayBuffer() : null)).then((d) => { this.jingleData = d; }).catch(() => {});
  }

  get live() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Call from inside user-activation handlers (click, pointerup, keydown). */
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
    if (this.ctx.state !== 'running') {
      try {
        const p = this.ctx.resume();
        if (p && p.catch) p.catch(() => {});
      } catch {
        /* ignore */
      }
    }
    if (!this._primed) {
      // a silent buffer started inside the gesture fully unlocks iOS
      try {
        const b = this.ctx.createBuffer(1, 1, 22050);
        const s = this.ctx.createBufferSource();
        s.buffer = b;
        s.connect(this.ctx.destination);
        s.start(0);
        this._primed = true;
      } catch {
        /* ignore */
      }
    }
  }

  _build() {
    const ctx = this.ctx;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 8;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.001;
    this.comp.release.value = 0.18;
    this.master = ctx.createGain();
    this.master.gain.value = 0.95;
    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.2, 3.4);
    this.reverbOut = ctx.createGain();
    this.reverbOut.gain.value = 0.5;
    this.reverb.connect(this.reverbOut);
    this.reverbOut.connect(this.master);
  }

  _impulse(seconds, decay) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    const ramp = ctx.sampleRate * 0.01;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const k = 0.2 + 0.72 * t;
        lp += (Math.random() * 2 - 1 - lp) * (1 - k);
        d[i] = lp * Math.pow(1 - t, decay) * (i < ramp ? i / ramp : 1);
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

  _filter(type, freq, q = 1) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  _env(gain, t, peak, attack, decay) {
    const g = gain.gain;
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(peak, t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  _burst({ t, type = 'bandpass', freq = 2000, q = 1, peak = 0.3, attack = 0.001, decay = 0.05, send = 0, hp = 0 }) {
    const ctx = this.ctx;
    const src = this._noiseSource(true);
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
    src.start(t, Math.random() * 1.5, attack + decay + 0.05);
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
    out.gain.exponentialRampToValueAtTime(1, t + 3.5);
    out.connect(this.master);

    const low = this._noiseSource(true);
    const lp = this._filter('lowpass', 240, 0.5);
    const lg = ctx.createGain();
    lg.gain.value = 0.045;
    low.connect(lp);
    lp.connect(lg);
    lg.connect(out);

    const air = this._noiseSource(true);
    const bp = this._filter('bandpass', 1100, 0.6);
    const ag = ctx.createGain();
    ag.gain.value = 0.005;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.0035;
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

  cutAmbience(time = 0.02) {
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

  // ---------------------------------------------------------------- load

  /** Continuous, very quiet fibre noise while the stick is under load. */
  stress(tension, speed, active) {
    if (!this.live) return;
    if (!this.stressNodes) {
      const ctx = this.ctx;
      const hiss = this._noiseSource(true);
      const hf = this._filter('bandpass', 2600, 2.2);
      const hg = ctx.createGain();
      hg.gain.value = 0;
      hiss.connect(hf);
      hf.connect(hg);
      hg.connect(this.master);
      const low = this._noiseSource(true);
      const lf = this._filter('bandpass', 320, 3);
      const lg = ctx.createGain();
      lg.gain.value = 0;
      low.connect(lf);
      lf.connect(lg);
      lg.connect(this.master);
      hiss.start();
      low.start(0, 0.9);
      this.stressNodes = { hg, lg };
    }
    const t = this.now;
    const tt = Math.min(1, tension);
    const s = Math.min(1.5, speed);
    this.stressNodes.hg.gain.setTargetAtTime(active ? tt * tt * (0.004 + 0.012 * s) : 0, t, 0.03);
    this.stressNodes.lg.gain.setTargetAtTime(active ? tt * tt * tt * 0.05 : 0, t, 0.05);
  }

  /** A single dry fibre popping. */
  tick(intensity) {
    if (!this.live) return;
    const t = this.now + 0.002;
    const i = Math.min(1, intensity);
    this._burst({ t, type: 'bandpass', freq: 2400 + Math.random() * 4200, q: 3, peak: 0.015 + 0.07 * i, attack: 0.0004, decay: 0.004 + 0.006 * i, send: 0.15 });
  }

  /** A bigger crack as the stick starts to go. */
  crack(intensity) {
    if (!this.live) return;
    const t = this.now + 0.002;
    const i = Math.min(1, intensity);
    this._burst({ t, type: 'bandpass', freq: 2800 + Math.random() * 2600, q: 1.5, hp: 1000, peak: 0.06 + 0.32 * i * i, attack: 0.0006, decay: 0.01 + 0.022 * i, send: 0.25 });
    this._burst({ t, type: 'bandpass', freq: 850 + Math.random() * 700, q: 12, peak: 0.05 + 0.2 * i, attack: 0.0008, decay: 0.025 + 0.035 * i, send: 0.15 });
  }

  /** Let go before it broke: the stick settles back with a tiny knock. */
  settle(strength) {
    if (!this.live) return;
    const s = Math.min(1, strength);
    if (s < 0.08) return;
    const t = this.now + 0.002;
    this._burst({ t, type: 'bandpass', freq: 700 + Math.random() * 300, q: 10, peak: 0.03 + 0.07 * s, attack: 0.001, decay: 0.05 });
  }

  snap() {
    if (!this.live) return;
    const t = this.now + 0.001;
    // the split: hard, bright and short, two fronts a few ms apart
    this._burst({ t, type: 'highpass', freq: 1600, q: 0.7, peak: 1.0, attack: 0.0004, decay: 0.038, send: 0.18 });
    this._burst({ t: t + 0.005, type: 'bandpass', freq: 3800, q: 1.1, peak: 0.6, attack: 0.0004, decay: 0.026, send: 0.12 });
    this._burst({ t: t + 0.013, type: 'bandpass', freq: 5600, q: 1.4, peak: 0.24, attack: 0.0004, decay: 0.02, send: 0.08 });
    // dry wood rings for an instant, no longer
    this._burst({ t, type: 'bandpass', freq: 1050, q: 8, peak: 0.8, attack: 0.0008, decay: 0.055, send: 0.12 });
    this._burst({ t, type: 'bandpass', freq: 2300, q: 6, peak: 0.45, attack: 0.0008, decay: 0.035, send: 0.08 });
    this._burst({ t, type: 'bandpass', freq: 520, q: 5, peak: 0.35, attack: 0.001, decay: 0.07, send: 0.08 });
    this._tone({ t, freq: 140, freqEnd: 60, peak: 0.38, attack: 0.0015, decay: 0.09 });
    // a few fibres letting go right behind it
    for (let k = 0; k < 6; k++) {
      const dt = 0.008 + Math.pow(Math.random(), 1.8) * 0.07;
      this._burst({ t: t + dt, type: 'bandpass', freq: 2800 + Math.random() * 4200, q: 2, hp: 1500, peak: 0.03 + Math.random() * 0.07, attack: 0.0004, decay: 0.005 + Math.random() * 0.01 });
    }
    if (this.stressNodes) {
      this.stressNodes.hg.gain.setTargetAtTime(0, t, 0.01);
      this.stressNodes.lg.gain.setTargetAtTime(0, t, 0.01);
    }
  }

  /**
   * Opening the box: the film's novelty "jingle and a fun pop surprise".
   * A party-popper pop, then a bright little toy fanfare played through a
   * cheap, warbling speaker, slightly out of tune.
   */
  /** The recorded jingle from the film's box, if it loaded; else the synthesised one. */
  jingle() {
    if (!this.ctx || this.ctx.state === 'closed') return;
    if (this.jingleBuf) return this._playJingle(this.jingleBuf);
    if (this.jingleData) {
      const data = this.jingleData;
      this.jingleData = null;
      this.ctx.decodeAudioData(data.slice(0)).then((buf) => { this.jingleBuf = buf; this._playJingle(buf); }).catch(() => this.jingleSynth());
      return;
    }
    this.jingleSynth();
  }

  _playJingle(buf) {
    const ctx = this.ctx;
    const t = this.now + 0.01;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = 0.8;
    src.connect(g);
    g.connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.12;
    g.connect(send);
    send.connect(this.reverb);
    src.start(t);
  }

  jingleSynth() {
    // Called inside the tap that unlocks audio: the context may still be
    // finishing its resume, which takes milliseconds, so this one sound is
    // scheduled either way.
    if (!this.ctx || this.ctx.state === 'closed') return;
    const ctx = this.ctx;
    const t = this.now + 0.01;
    // pop
    this._burst({ t, type: 'bandpass', freq: 1800, q: 0.8, peak: 0.55, attack: 0.0006, decay: 0.05, send: 0.2 });
    this._tone({ t, freq: 320, freqEnd: 90, peak: 0.25, attack: 0.001, decay: 0.07 });

    // the cheap speaker: distortion, band-limited, with a wow in the pitch
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 3.2) * 0.9;
    }
    shaper.curve = curve;
    const hp = this._filter('highpass', 380, 0.7);
    const lp = this._filter('lowpass', 3400, 0.9);
    const out = ctx.createGain();
    out.gain.value = 0.2;
    shaper.connect(hp);
    hp.connect(lp);
    lp.connect(out);
    out.connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.35;
    out.connect(send);
    send.connect(this.reverb);
    const wow = ctx.createOscillator();
    wow.frequency.value = 5.2;
    const wowG = ctx.createGain();
    wowG.gain.value = 14; // cents
    wow.connect(wowG);
    wow.start(t);
    wow.stop(t + 2.2);

    // C E G C' ... then a held major chord, all a touch flat
    const notes = [
      [0.06, 523.25, 0.1],
      [0.16, 659.25, 0.1],
      [0.26, 783.99, 0.1],
      [0.36, 1046.5, 0.16],
      [0.56, 783.99, 0.08],
      [0.66, 1046.5, 0.6],
    ];
    const chord = [[0.66, 659.25, 0.6], [0.66, 523.25, 0.6]];
    for (const [dt, f, len] of [...notes, ...chord]) {
      for (const [type, lvl, det] of [['square', 0.5, -9], ['triangle', 0.7, 6]]) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f * 0.994;
        o.detune.value = det;
        wowG.connect(o.detune);
        const g = ctx.createGain();
        const st = t + dt;
        g.gain.setValueAtTime(0.0001, st);
        g.gain.linearRampToValueAtTime(lvl * 0.5, st + 0.006);
        g.gain.exponentialRampToValueAtTime(lvl * 0.2, st + len * 0.5);
        g.gain.exponentialRampToValueAtTime(0.0001, st + len + 0.35);
        o.connect(g);
        g.connect(shaper);
        o.start(st);
        o.stop(st + len + 0.4);
      }
    }
    // a sprinkle of glitter on top
    for (let k = 0; k < 7; k++) {
      this._tone({ t: t + 0.7 + k * 0.07 + Math.random() * 0.03, freq: 2400 + Math.random() * 1800, peak: 0.018, attack: 0.002, decay: 0.12, send: 0.5 });
    }
  }

  clack(strength) {
    if (!this.live) return;
    const t = this.now + 0.002;
    const s = Math.min(1, strength);
    this._burst({ t, type: 'bandpass', freq: 560 + Math.random() * 700, q: 12, peak: 0.1 + 0.42 * s, attack: 0.0008, decay: 0.06 + 0.05 * s, send: 0.45 });
    this._burst({ t, type: 'bandpass', freq: 2300 + Math.random() * 1400, q: 5, peak: 0.05 + 0.2 * s, attack: 0.0006, decay: 0.02, send: 0.3 });
    this._tone({ t, freq: 170 + Math.random() * 50, freqEnd: 105, peak: 0.06 + 0.14 * s, attack: 0.001, decay: 0.06 });
  }

  // ---------------------------------------------------------------- wish

  holdStart() {
    if (!this.live || this.hold) return;
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
    this.hold.out.gain.setTargetAtTime(0.0001 + 0.06 * p * p, t, 0.05);
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
    if (!this.live) return;
    const ctx = this.ctx;
    const t = this.now + 0.01;
    const out = ctx.createGain();
    out.gain.value = 1;
    const lp = this._filter('lowpass', 1500, 0.5);
    lp.connect(out);
    out.connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.9;
    out.connect(send);
    send.connect(this.reverb);
    [
      [98, 0.045],
      [98.4, 0.035],
      [146.8, 0.035],
      [196, 0.03],
      [293.7, 0.02],
      [440, 0.01],
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
    const src = this._noiseSource(true);
    const bp = this._filter('bandpass', 5200, 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.014, t + 1.0);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);
    src.connect(bp);
    bp.connect(g);
    g.connect(send);
    g.connect(this.master);
    src.start(t, Math.random(), 3.7);
  }
}
