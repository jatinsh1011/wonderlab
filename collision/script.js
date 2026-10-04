/* =====================================================================
   Collision · script.js — the app: scenarios, simulation clock, frame
   loop, UI, keyboard shortcuts, captions and labels.
   ===================================================================== */
(function () {
  'use strict';

  const Sim = window.CollisionSim;
  const MYR = Sim.MYR_PER_UNIT;
  const $ = (id) => document.getElementById(id);
  const reducedMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  const canvas = $('stage');

  // ---- fallback ------------------------------------------------------------
  const FALLBACK = {
    webgl2: ['Collision needs WebGL 2', 'This browser or device does not provide WebGL 2, which runs the star simulation on the graphics card. A current Chrome, Edge, Firefox or Safari should work.'],
    float: ['Collision needs HDR rendering', 'This device cannot render to floating-point buffers, which Collision uses to add up the light of a quarter-million stars.'],
    shader: ['The graphics driver refused the shaders', 'Collision could not compile its GPU programs on this device.'],
    lost: ['The graphics context was lost', 'The GPU reset or ran out of memory. Reload the page to start the simulation again.'],
  };
  function showFallback(kind) {
    const [title, text] = FALLBACK[kind] || FALLBACK.shader;
    const box = document.createElement('div');
    box.className = 'wl-fallback';
    box.setAttribute('role', 'alert');
    box.innerHTML = '<div><h2></h2><p></p><p><a class="wl-btn wl-btn--primary" href="../index.html">Back to Wonderlab</a></p></div>';
    box.querySelector('h2').textContent = title;
    box.querySelector('p').textContent = text;
    box.querySelectorAll('p')[1].style.marginTop = '20px';
    document.body.appendChild(box);
  }

  const renderer = window.CollisionRenderer.create(canvas);
  if (renderer.error) { showFallback(renderer.error); return; }

  // ---- particle budget ---------------------------------------------------
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const smallScreen = Math.min(window.screen.width, window.screen.height) < 700;
  const starsSelect = $('opt-stars');
  let budget = coarse && smallScreen ? 65536 : coarse ? 131072 : 262144;
  starsSelect.value = String(budget);
  const PATH = new Float32Array(Sim.MAX_PATH * 3 * 4);
  const ACC = new Float64Array(9);
  const MASSES = new Float32Array(12);
  let stateArr = null, infoArr = null;

  function allocate() {
    const cap = budget + (budget >> 3); // main galaxies + room for a flung interloper
    stateArr = new Float32Array(cap * 6);
    infoArr = new Float32Array(cap * 4);
    renderer.allocate(cap);
  }

  // ---- simulation state ----------------------------------------------------
  const sim = {
    sc: null, gals: [], n: 2, t: 0, tEnd: 1, friction: 0, hMax: 0.04,
    events: { peri: [], merge: null }, beats: [], beat: 0,
    playing: true, speed: 1, seekTo: null, ended: 0,
    count: 0, mainCount: 0, interloper: null,
    ranges: [0, 1, 2].map(() => ({ on: false, start: 0, stars: 0, dust: 0 })),
  };

  function particleSplit(gals) {
    const w = gals.map((g) => Math.pow(g.mass, 0.6));
    const total = w.reduce((a, b) => a + b, 0);
    let start = 0;
    return gals.map((g, i) => {
      const n = i === gals.length - 1 ? budget - start : Math.round(budget * w[i] / total);
      const dust = Math.round(n * g.kind.dust);
      const r = { start, stars: n - dust, dust };
      start += n;
      return r;
    });
  }

  function setMasses() {
    for (let i = 0; i < 3; i++) {
      const g = i < sim.n ? sim.gals[i] : null;
      MASSES[i * 4] = g ? g.Mb : 0;
      MASSES[i * 4 + 1] = g ? g.eb2 : 1;
      MASSES[i * 4 + 2] = g ? g.Mh : 0;
      MASSES[i * 4 + 3] = g ? g.ah2 : 1;
    }
  }

  // Build a scenario's galaxies and particles at t = 0.
  function build(sc) {
    sim.sc = sc;
    sim.gals = sc.galaxies.map((spec, i) => Sim.makeGalaxy(spec, i));
    sim.n = 2;
    sim.interloper = null;
    Sim.setupEncounter(sc.orbit, sim.gals);
    sim.friction = sc.friction;
    sim.tEnd = sc.duration / MYR;
    sim.events = Sim.predictEvents(sim.gals, sc.friction, sim.tEnd);
    // star step: a fraction of the tightest core's dynamical time
    sim.hMax = Math.min(0.04, ...sim.gals.map((g) => 0.25 * Math.sqrt(g.eb2 * g.eb / g.Mb)));
    const split = particleSplit(sim.gals);
    const rand = Sim.rng(0x9e3779b1 ^ sc.id.length * 7919);
    sim.gals.forEach((g, i) => {
      const r = split[i];
      Sim.fillGalaxy(g, stateArr, infoArr, r.start, r.stars, r.dust, rand);
      Object.assign(sim.ranges[i], { on: true, start: r.start, stars: r.stars, dust: r.dust });
    });
    sim.ranges[2].on = false;
    sim.mainCount = sim.count = budget;
    renderer.upload(0, stateArr, infoArr, budget);
    setMasses();
    sim.t = 0;
    sim.ended = 0;
    sim.beats = sc.beats.map(([ev, off, text]) => {
      const base = ev === 'start' ? 0 : ev === 'merge' ? sim.events.merge : sim.events.peri[ev === 'peri0' ? 0 : 1];
      return base == null ? null : { t: Math.max(0, base + off / MYR), text };
    }).filter((b) => b && b.t < sim.tEnd).sort((a, b) => a.t - b.t);
    sim.beat = 0;
    trails.reset();
    buildMarks();
  }

  // Advance the simulation by `adv` time units (cores on the CPU, stars on the GPU).
  function advance(adv) {
    const steps = Math.min(Sim.MAX_PATH - 1, Math.max(1, Math.ceil(adv / sim.hMax - 1e-9)));
    const h = adv / steps;
    Sim.trackCores(sim.gals, sim.n, h, steps, 4, sim.friction, ACC, PATH);
    renderer.integrate(PATH, MASSES, steps, h, sim.count);
    sim.t += adv;
  }

  // ---- interloper (fling a galaxy) ----------------------------------------
  function launchInterloper(pos, vel, spin) {
    const g = Sim.makeGalaxy(Sim.INTERLOPER, 2);
    Sim.setSpin(g, spin[0], spin[1], spin[2]);
    g.pos.set(pos);
    g.vel.set(vel);
    const n = budget >> 3, dust = Math.round(n * g.kind.dust);
    Sim.fillGalaxy(g, stateArr, infoArr, budget, n - dust, dust, Sim.rng((Math.random() * 1e9) | 0));
    renderer.upload(budget, stateArr, infoArr, n);
    sim.gals[2] = g;
    sim.n = 3;
    sim.interloper = { born: sim.t };
    sim.hMax = Math.min(sim.hMax, 0.25 * Math.sqrt(g.eb2 * g.eb / g.Mb));
    Object.assign(sim.ranges[2], { on: true, start: budget, stars: n - dust, dust });
    sim.count = budget + n;
    setMasses();
    labels[2].textContent = g.name;
    trails.reset();
  }

  // ---- scenario switching with a fade ------------------------------------------
  const view = { fade: 0, fadeGoal: 1, pending: null };
  function startScenario(id, opts) {
    const sc = Sim.SCENARIOS.find((s) => s.id === id) || Sim.SCENARIOS[0];
    const o = opts || {};
    view.pending = { sc, keepView: !!o.keepView, seek: o.seek };
    view.fadeGoal = 0;
    document.querySelectorAll('.scene').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scene === sc.id)));
    hideCaption();
  }
  function applyPending() {
    const { sc, keepView, seek } = view.pending;
    view.pending = null;
    const changed = sim.sc !== sc;
    build(sc);
    if (changed) {
      $('scene-title').textContent = sc.title;
      $('scene-desig').textContent = sc.designation;
      sim.gals.forEach((g, i) => { labels[i].textContent = g.name; });
      document.title = `Collision · ${sc.short} · Wonderlab`;
    }
    if (!keepView || changed) camera.setView(sc.view.az, sc.view.el);
    sim.seekTo = seek != null ? Math.min(seek, sim.tEnd) : sc.startAt / MYR;
    camera.frame(sim.gals, sim.n, sc.frame);
    camera.snap();
    view.fadeGoal = 1;
    sim.ended = 0;
    updateClock(true);
  }

  function seek(target) {
    target = Math.max(0, Math.min(sim.tEnd, target));
    if (target >= sim.t) sim.seekTo = target;
    else startScenario(sim.sc.id, { keepView: true, seek: target });
  }

  // ---- camera, fling, overlay ----------------------------------------------
  let fling = null;
  const camera = window.CollisionCamera.create(canvas, { capture: (e) => !!fling && fling.capture(e) });
  const overlay = $('overlay');
  const octx = overlay.getContext('2d');
  let overlayDirty = false;

  const trails = {
    pts: [[], [], []], last: -1e9,
    reset() { this.pts.forEach((p) => { p.length = 0; }); this.last = -1e9; },
    record() {
      if (sim.t - this.last < 1.2) return;
      this.last = sim.t;
      for (let i = 0; i < sim.n; i++) {
        const p = this.pts[i];
        if (p.length > 1200) p.splice(0, 300);
        p.push(sim.gals[i].pos[0], sim.gals[i].pos[1], sim.gals[i].pos[2]);
      }
    },
  };
  const proj = { x: 0, y: 0, depth: 0 };
  function drawOverlay() {
    const showTrails = $('opt-trails').checked;
    const flingDrawing = fling && fling.wantsDraw();
    if (!showTrails && !flingDrawing && !overlayDirty) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, overlay.width / dpr, overlay.height / dpr);
    overlayDirty = showTrails || flingDrawing;
    if (showTrails) {
      octx.lineWidth = 1.25;
      octx.lineJoin = 'round';
      for (let i = 0; i < sim.n; i++) {
        const p = trails.pts[i], tint = sim.gals[i].tint, n = p.length / 3;
        octx.strokeStyle = `rgba(${tint.map((c) => Math.round(150 + 105 * c)).join(',')},0.55)`;
        octx.beginPath();
        let pen = false;
        for (let k = 0; k <= n; k++) {
          const g = sim.gals[i];
          if (k < n) camera.project(p[k * 3], p[k * 3 + 1], p[k * 3 + 2], proj);
          else camera.project(g.pos[0], g.pos[1], g.pos[2], proj);
          if (proj.depth <= 0.5) { pen = false; continue; }
          if (pen) octx.lineTo(proj.x, proj.y); else octx.moveTo(proj.x, proj.y);
          pen = true;
        }
        octx.stroke();
      }
    }
    if (flingDrawing) fling.draw(octx);
  }

  // ---- labels -------------------------------------------------------------
  const labelBox = $('labels');
  const labels = [0, 1, 2].map(() => {
    const el = document.createElement('div');
    el.className = 'label';
    labelBox.appendChild(el);
    return el;
  });
  const labelPos = [{ x: 0, y: 0, depth: 0 }, { x: 0, y: 0, depth: 0 }, { x: 0, y: 0, depth: 0 }];
  function updateLabels() {
    const on = $('opt-labels').checked && view.fade > 0.9;
    for (let i = 0; i < 3; i++) {
      const el = labels[i];
      let show = on && i < sim.n;
      if (show) {
        const g = sim.gals[i];
        camera.project(g.pos[0], g.pos[1], g.pos[2], labelPos[i]);
        const p = labelPos[i];
        show = p.depth > 0.5 && p.x > 30 && p.x < camera.cssW - 150 && p.y > 90 && p.y < camera.cssH - 120;
        for (let j = 0; j < sim.n && show; j++) {
          if (j !== i && Math.hypot(labelPos[j].x - p.x, labelPos[j].y - p.y) < 70 && j < i) show = false;
        }
        if (show) {
          const off = Math.max(14, 0.42 * g.Rmax * camera.focal / renderer.height * camera.cssH / p.depth);
          el.style.transform = `translate3d(${(p.x + off * 0.72).toFixed(1)}px, ${(p.y - off * 0.72).toFixed(1)}px, 0)`;
        }
      }
      el.classList.toggle('is-on', show);
    }
  }

  // ---- captions ------------------------------------------------------------
  const captionEl = $('caption');
  let captionTimer = 0;
  function showCaption(text, timeLabel) {
    captionEl.textContent = '';
    if (timeLabel) {
      const s = document.createElement('span');
      s.className = 'caption__time';
      s.textContent = timeLabel;
      captionEl.appendChild(s);
    }
    captionEl.appendChild(document.createTextNode(text));
    captionEl.classList.remove('is-off');
    captionEl.classList.add('is-on');
    clearTimeout(captionTimer);
    captionTimer = setTimeout(hideCaption, 6500);
  }
  function hideCaption() {
    captionEl.classList.remove('is-on');
    captionEl.classList.add('is-off');
  }
  function updateBeats() {
    let k = sim.beat;
    while (k < sim.beats.length && sim.beats[k].t <= sim.t) k++;
    if (k !== sim.beat) {
      sim.beat = k;
      if (sim.seekTo === null || sim.seekTo - sim.t < 1) {
        const b = sim.beats[k - 1];
        showCaption(b.text, formatClock(b.t) + ' Myr');
      }
    }
  }

  // ---- clock & timeline ----------------------------------------------------------
  const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const formatClock = (t) => fmt.format(Math.round(t * MYR + sim.sc.clock));
  const clockValue = $('clock-value'), clockSuffix = $('clock-suffix');
  const timeline = $('timeline');
  let clockShown = '', timelineShown = -1, scrubbing = false;
  function updateClock(force) {
    const target = scrubbing ? Number(timeline.value) / 1000 * sim.tEnd : sim.t;
    const text = formatClock(target);
    if (text !== clockShown || force) {
      clockShown = text;
      clockValue.textContent = text;
      clockSuffix.textContent = sim.sc.clock ? 'from now' : '';
      timeline.setAttribute('aria-valuetext', `${text} million years${sim.sc.clock ? ' from now' : ''}`);
    }
    if (!scrubbing) {
      const v = Math.round(Math.min(1, sim.t / sim.tEnd) * 1000);
      if (v !== timelineShown || force) {
        timelineShown = v;
        timeline.value = String(v);
        window.Wonderlab.syncRange(timeline);
      }
    }
  }
  function buildMarks() {
    const box = $('marks');
    box.textContent = '';
    const add = (t, cls) => {
      if (t == null || t >= sim.tEnd) return;
      const m = document.createElement('span');
      m.className = 'mark' + (cls ? ' ' + cls : '');
      // the range thumb travels 16 px less than the track
      m.style.left = `calc(8px + (100% - 16px) * ${(t / sim.tEnd).toFixed(4)})`;
      box.appendChild(m);
    };
    sim.events.peri.slice(0, 3).forEach((t) => add(t));
    add(sim.events.merge, 'mark--merge');
  }
  timeline.addEventListener('input', () => { scrubbing = true; updateClock(true); });
  timeline.addEventListener('change', () => {
    scrubbing = false;
    seek(Number(timeline.value) / 1000 * sim.tEnd);
  });
  timeline.addEventListener('pointerup', () => { if (scrubbing) timeline.dispatchEvent(new Event('change')); });

  // ---- controls ------------------------------------------------------------------
  const playBtn = $('play');
  function setPlaying(on) {
    sim.playing = on;
    playBtn.classList.toggle('is-paused', !on);
    playBtn.setAttribute('aria-label', on ? 'Pause simulation' : 'Play simulation');
  }
  playBtn.addEventListener('click', () => setPlaying(!sim.playing));
  $('restart').addEventListener('click', () => startScenario(sim.sc.id, { keepView: true }));
  document.querySelectorAll('.scene').forEach((b) => b.addEventListener('click', () => startScenario(b.dataset.scene)));

  const speedInput = $('speed'), speedOut = $('speed-out');
  function applySpeed() {
    sim.speed = Math.pow(10, Number(speedInput.value) / 100);
    speedOut.textContent = (sim.speed < 0.995 ? sim.speed.toFixed(2) : sim.speed.toFixed(1)) + '×';
  }
  speedInput.addEventListener('input', applySpeed);
  function nudgeSpeed(dir) {
    speedInput.value = String(Math.max(-100, Math.min(60, Number(speedInput.value) + dir * 20)));
    window.Wonderlab.syncRange(speedInput);
    applySpeed();
  }

  const settingsBtn = $('settings-btn'), settingsPanel = $('settings');
  function toggleSettings(open) {
    const want = open == null ? settingsPanel.hidden : open;
    settingsPanel.hidden = !want;
    settingsBtn.setAttribute('aria-pressed', String(want));
    settingsBtn.setAttribute('aria-expanded', String(want));
  }
  settingsBtn.addEventListener('click', () => toggleSettings());
  document.addEventListener('pointerdown', (e) => {
    if (!settingsPanel.hidden && !settingsPanel.contains(e.target) && !settingsBtn.contains(e.target)) toggleSettings(false);
  });

  const tagInput = $('opt-tag'), rotateInput = $('opt-rotate'), dustInput = $('opt-dust');
  rotateInput.checked = !reducedMQ.matches;
  rotateInput.addEventListener('change', () => { camera.autoRotate = rotateInput.checked; });
  $('opt-trails').addEventListener('change', () => { overlayDirty = true; });
  starsSelect.addEventListener('change', () => {
    budget = Number(starsSelect.value);
    allocate();
    startScenario(sim.sc.id, { keepView: true });
  });

  // ---- keyboard ---------------------------------------------------------------------
  const isTextEntry = (el) => el instanceof Element && !!el.closest('input:not([type="range"]):not([type="checkbox"]), textarea, select, [contenteditable=""], [contenteditable="true"]');
  const dialogOpen = () => !!document.querySelector('dialog[open]');
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTextEntry(e.target) || dialogOpen()) return;
    const onRange = e.target instanceof HTMLInputElement && e.target.type === 'range';
    const k = e.key;
    let used = true;
    if (k === ' ' || k === 'Spacebar') { if (!e.repeat) setPlaying(!sim.playing); }
    else if (k === 'r' || k === 'R') { if (!e.repeat) startScenario(sim.sc.id, { keepView: true }); }
    else if (k >= '1' && k <= '4') { if (!e.repeat) startScenario(Sim.SCENARIOS[Number(k) - 1].id); }
    else if (k === '[') nudgeSpeed(-1);
    else if (k === ']') nudgeSpeed(1);
    else if (k === 'f' || k === 'F') { if (!e.repeat) fling.toggle(); }
    else if (k === 't' || k === 'T') { if (!e.repeat) { tagInput.checked = !tagInput.checked; } }
    else if (k === 'Escape' && fling.active) fling.toggle(false);
    else if (k === 'Escape' && !settingsPanel.hidden) toggleSettings(false);
    else if (k === '+' || k === '=') camera.zoomBy(0.85);
    else if (k === '-' || k === '_') camera.zoomBy(1 / 0.85);
    else if (!onRange && k === 'ArrowLeft') camera.nudge(0.9, 0);
    else if (!onRange && k === 'ArrowRight') camera.nudge(-0.9, 0);
    else if (!onRange && k === 'ArrowUp') camera.nudge(0, 0.7);
    else if (!onRange && k === 'ArrowDown') camera.nudge(0, -0.7);
    else used = false;
    if (used) {
      e.preventDefault();
      camera.touch(performance.now());
    }
  });
  // stop Space from also "clicking" a focused button on key-up
  window.addEventListener('keyup', (e) => {
    if ((e.key === ' ' || e.key === 'Spacebar') && e.target instanceof HTMLButtonElement && !dialogOpen()) e.preventDefault();
  });

  // ---- sizing & adaptive resolution ---------------------------------------------------
  const quality = { scale: 1, slow: 0, fast: 0, lastChange: 0, ema: 16.7 };
  function resize() {
    const cssW = Math.max(1, window.innerWidth), cssH = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const s = dpr * quality.scale;
    renderer.resize(Math.round(cssW * s), Math.round(cssH * s));
    camera.resize(cssW, cssH, renderer.height);
    overlay.width = Math.round(cssW * dpr);
    overlay.height = Math.round(cssH * dpr);
    overlayDirty = true;
  }
  function adapt(dtMs, now) {
    quality.ema += (dtMs - quality.ema) * 0.08;
    if (now - quality.lastChange < 2500) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (quality.ema > 21 && quality.scale * dpr > 0.6) {
      quality.scale = Math.max(0.6 / dpr, quality.scale * 0.85);
      quality.lastChange = now;
      resize();
    } else if (quality.ema < 17.4 && quality.scale < 1 && now - quality.lastChange > 9000) {
      quality.scale = Math.min(1, quality.scale * 1.12);
      quality.lastChange = now;
      resize();
    }
  }
  window.addEventListener('resize', resize);

  // ---- per-frame description for the renderer --------------------------------------
  const F = {
    view: camera.view, proj: camera.proj, sky: camera.sky,
    focal: 1, gain: 32, refDepth: 90, sigmaMin: 0.7, sigmaMax: 7, pxScale: 1,
    galC: new Float32Array(9), galU: new Float32Array(9), galV: new Float32Array(9),
    galTint: new Float32Array(9), galArm: new Float32Array(12), galInner: new Float32Array(3),
    boostYoung: 1, boostHII: 1, tag: 0.12,
    dustK: 0.6, bloomK: 0.03, exposure: 2.2, stretch: 10, fade: 0, seed: 0,
    ranges: sim.ranges, nuclei: new Float32Array(12),
  };
  const smooth = { tag: 0.12, dust: 0.6 };
  const nucProj = { x: 0, y: 0, depth: 0 };

  // Spiral-arm strength fades as the disks are torn apart.
  function armStrength(i) {
    const g = sim.gals[i];
    if (!g.armOrder) return 0;
    if (i === 2) return 0.8;
    const ev = sim.events, t = sim.t;
    if (sim.sc.id === 'cartwheel') {
      const p = ev.peri[0];
      return p == null ? 1 : 1 - 0.75 * smooth01((t - p) / (120 / MYR));
    }
    if (ev.merge != null) {
      const from = ev.peri[1] != null ? ev.peri[1] - 40 / MYR : ev.merge - 300 / MYR;
      return 1 - smooth01((t - from) / Math.max(1, ev.merge - from));
    }
    return ev.peri[0] == null ? 1 : 1 - 0.6 * smooth01((t - ev.peri[0]) / (500 / MYR));
  }
  const smooth01 = (x) => { const u = Math.max(0, Math.min(1, x)); return u * u * (3 - 2 * u); };

  // Interactions trigger bursts of star formation after each close passage.
  function starburst() {
    let young = 1, hii = 1;
    const tau = 260 / MYR, rise = 25 / MYR;
    const add = (t0, amp) => {
      const d = sim.t - t0;
      if (d <= 0) return;
      const k = Math.exp(-d / tau) * (1 - Math.exp(-d / rise));
      young += 0.7 * amp * k;
      hii += 2.4 * amp * k;
    };
    sim.events.peri.forEach((p, i) => add(p, i === 0 ? 1 : 1.3));
    if (sim.events.merge != null) add(sim.events.merge, 1.6);
    if (sim.interloper) add(sim.interloper.born + 60 / MYR, 0.6);
    return [young, hii];
  }

  function fillFrame(now, dt) {
    const pxScale = renderer.width / camera.cssW;
    F.focal = camera.focal;
    F.pxScale = pxScale;
    F.sigmaMin = 0.72 * pxScale;
    F.sigmaMax = 7.5 * pxScale;
    for (let i = 0; i < 3; i++) {
      const g = sim.gals[Math.min(i, sim.n - 1)];
      for (let c = 0; c < 3; c++) {
        F.galC[i * 3 + c] = g.pos[c];
        F.galU[i * 3 + c] = g.axisU[c];
        F.galV[i * 3 + c] = g.axisV[c];
        F.galTint[i * 3 + c] = g.tint[c];
      }
      F.galArm[i * 4] = g.patternAngle + g.patternSpeed * sim.t;
      F.galArm[i * 4 + 1] = g.cotPitch;
      F.galArm[i * 4 + 2] = i < sim.n ? armStrength(i) : 0;
      F.galArm[i * 4 + 3] = g.Rmax;
      F.galInner[i] = g.armInner;
    }
    const [young, hii] = starburst();
    F.boostYoung = young;
    F.boostHII = hii;
    smooth.tag += ((tagInput.checked ? 0.8 : 0.12) - smooth.tag) * Math.min(1, dt * 4);
    smooth.dust += ((dustInput.checked ? 0.6 : 0) - smooth.dust) * Math.min(1, dt * 4);
    F.tag = smooth.tag;
    F.dustK = smooth.dust < 0.005 ? 0 : smooth.dust;
    F.fade = view.fade * view.fade;
    F.seed = (now * 0.001) % 1;
    // galactic nuclei as projected Plummer cores, in buffer pixels
    const bufH = renderer.height;
    for (let i = 0; i < 3; i++) {
      F.nuclei[i * 4 + 2] = 1; // finite radius keeps unused slots free of 0/0
      F.nuclei[i * 4 + 3] = 0;
      if (i >= sim.n) continue;
      const g = sim.gals[i];
      camera.project(g.pos[0], g.pos[1], g.pos[2], nucProj);
      if (nucProj.depth <= 0.5) continue;
      const k = camera.focal / nucProj.depth;
      const a = Math.max(0.9 * pxScale, 0.09 * g.size * k);
      const lum = (g.kind.arms ? 0.012 : 0.03) * g.mass;
      F.nuclei[i * 4] = nucProj.x * pxScale;
      F.nuclei[i * 4 + 1] = bufH - nucProj.y * pxScale;
      F.nuclei[i * 4 + 2] = a;
      F.nuclei[i * 4 + 3] = lum * F.gain * k * k / (Math.PI * a * a);
    }
  }

  // ---- frame loop -------------------------------------------------------------------------
  let raf = 0, last = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dtMs = last ? now - last : 16.7;
    last = now;
    const dt = Math.min(dtMs, 50) / 1000;
    adapt(dtMs, now);

    // fades between scenarios
    const fadeRate = camera.reduced ? 2.2 : view.fadeGoal > view.fade ? 1.4 : 3.6;
    view.fade += Math.sign(view.fadeGoal - view.fade) * Math.min(Math.abs(view.fadeGoal - view.fade), dt * fadeRate);
    if (view.pending && view.fade <= 0) applyPending();

    // physics: fast-forward to a seek target, else play at the scenario's pace
    if (!view.pending) {
      if (sim.seekTo !== null) {
        const adv = Math.min(sim.seekTo - sim.t, (sim.hMax * (coarse ? 96 : 240)));
        if (adv > 1e-6) advance(adv);
        if (sim.seekTo - sim.t <= 1e-6) sim.seekTo = null;
      } else if (sim.playing && !(fling && fling.holding())) {
        advance(sim.sc.pace * sim.speed * dt / MYR);
      }
      trails.record();
      updateBeats();
      if (sim.t >= sim.tEnd && sim.seekTo === null) autoAdvance(dt, now);
    }

    camera.reduced = reducedMQ.matches;
    camera.frame(sim.gals, sim.n, sim.sc.frame);
    camera.update(dt, now);
    fillFrame(now, dt);
    renderer.render(F);
    updateLabels();
    updateClock(false);
    drawOverlay();
  }

  // When a scenario ends and nobody is interacting, move on to the next one.
  function autoAdvance(dt, now) {
    sim.ended += dt;
    if (sim.ended > 6 && sim.playing && now - camera.lastInput > 12000 && !fling.active && !dialogOpen()) {
      const i = Sim.SCENARIOS.indexOf(sim.sc);
      startScenario(Sim.SCENARIOS[(i + 1) % Sim.SCENARIOS.length].id);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf) {
      last = 0;
      raf = requestAnimationFrame(frame);
    }
  });
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    cancelAnimationFrame(raf);
    raf = -1;
    showFallback('lost');
  });

  // ---- boot ---------------------------------------------------------------------------------
  fling = window.CollisionFling.create({
    canvas, camera, sim, Sim,
    onLaunch: launchInterloper,
    onMode: (on) => {
      const btn = $('fling');
      btn.setAttribute('aria-pressed', String(on));
      canvas.classList.toggle('is-fling', on);
      overlayDirty = true;
      if (on) showCaption('Drag from where the new galaxy starts toward where it should go', 'Fling');
      else hideCaption();
    },
  });
  $('fling').addEventListener('click', () => fling.toggle());

  camera.autoRotate = rotateInput.checked;
  allocate();
  resize();
  applySpeed();
  startScenario('antennae');
  view.fade = 0;
  applyPending();
  raf = requestAnimationFrame(frame);
})();
