/* =====================================================================
   Murmuration: synthesized sound (classic script)
   Wind through the reeds, the soft roar of thousands of wings that swells
   when the flock turns or panics, and a falling swoosh for each stoop.
   Everything is filtered noise; nothing is loaded. The context is only
   created from a user gesture (enable()).
   ===================================================================== */
(function (root) {
  'use strict';

  // ~4 s of stereo pink noise (Paul Kellet's economy filter), looped by the sources.
  function pinkNoise(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
      }
      // crossfade the ends so the loop point is seamless
      const fade = Math.floor(ctx.sampleRate * 0.05);
      for (let i = 0; i < fade; i++) {
        const k = i / fade;
        d[i] = d[i] * k + d[len - fade + i] * (1 - k);
      }
    }
    return buf;
  }

  class Sound {
    constructor() {
      this.ctx = null;
      this.on = false;
      this.suspendTimer = 0;
    }

    build() {
      const AC = root.AudioContext || root.webkitAudioContext;
      const ctx = new AC();
      this.ctx = ctx;
      this.noise = pinkNoise(ctx, 4);

      this.master = ctx.createGain();
      this.master.gain.value = 0;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 3;
      this.master.connect(comp).connect(ctx.destination);

      // wind: low-passed noise whose cutoff breathes with the gusts
      const wind = ctx.createBufferSource();
      wind.buffer = this.noise;
      wind.loop = true;
      this.windFilter = ctx.createBiquadFilter();
      this.windFilter.type = 'lowpass';
      this.windFilter.frequency.value = 380;
      this.windFilter.Q.value = 0.7;
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0.55;
      wind.connect(this.windFilter).connect(this.windGain).connect(this.master);

      // wing rush: band-passed noise, panned toward the flock
      const rush = ctx.createBufferSource();
      rush.buffer = this.noise;
      rush.loop = true;
      this.rushFilter = ctx.createBiquadFilter();
      this.rushFilter.type = 'bandpass';
      this.rushFilter.frequency.value = 1100;
      this.rushFilter.Q.value = 0.55;
      this.rushGain = ctx.createGain();
      this.rushGain.gain.value = 0;
      this.pan = ctx.createStereoPanner();
      rush.connect(this.rushFilter).connect(this.rushGain).connect(this.pan).connect(this.master);

      wind.start();
      rush.start(0, 1.9);
    }

    // Must run inside a user gesture (click / key) so the context may start.
    enable() {
      if (!this.ctx) this.build();
      clearTimeout(this.suspendTimer);
      this.ctx.resume();
      this.on = true;
      this.master.gain.setTargetAtTime(0.85, this.ctx.currentTime, 0.5);
    }

    disable() {
      if (!this.ctx) return;
      this.on = false;
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.12);
      clearTimeout(this.suspendTimer);
      this.suspendTimer = setTimeout(() => { if (!this.on) this.ctx.suspend(); }, 700);
    }

    // Page hidden: stop the clock without forgetting the user's choice.
    pause(hidden) {
      if (!this.ctx || !this.on) return;
      if (hidden) this.ctx.suspend(); else this.ctx.resume();
    }

    // p: { rush 0..1, gust 0..1, pan -1..1 }
    update(p) {
      if (!this.on) return;
      const t = this.ctx.currentTime;
      this.rushGain.gain.setTargetAtTime(0.05 + 0.75 * p.rush, t, 0.18);
      this.rushFilter.frequency.setTargetAtTime(700 + 1500 * p.rush, t, 0.25);
      this.windFilter.frequency.setTargetAtTime(260 + 520 * p.gust, t, 0.9);
      this.windGain.gain.setTargetAtTime(0.4 + 0.35 * p.gust, t, 0.9);
      this.pan.pan.setTargetAtTime(p.pan, t, 0.35);
    }

    // A stoop: a bright swoosh that falls away as the falcon drops through.
    whoosh() {
      if (!this.on) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 1.4;
      f.frequency.setValueAtTime(2600, t);
      f.frequency.exponentialRampToValueAtTime(320, t + 1.0);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.9, t + 0.32);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.25);
      src.connect(f).connect(g).connect(this.master);
      src.onended = () => { src.disconnect(); f.disconnect(); g.disconnect(); };
      src.start(t, Math.random() * 2.5, 1.3);
    }
  }

  root.Murmur = root.Murmur || {};
  root.Murmur.Sound = Sound;
})(window);
