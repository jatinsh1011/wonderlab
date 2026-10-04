/* =====================================================================
   Murmuration: app (camera, input, UI, main loop)
   flock.js simulates, render.js draws, audio.js sings; this file wires
   them together and keeps the frame rate honest.
   ===================================================================== */
(() => {
  'use strict';

  const M = window.Murmur;
  const $ = (id) => document.getElementById(id);
  const DEG = Math.PI / 180;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const canvas = $('scene');

  // ---- device tier ------------------------------------------------------
  const coarse = matchMedia('(pointer: coarse)').matches;
  const compact = Math.min(innerWidth, innerHeight) < 600;
  const tier = coarse ? (compact ? 'phone' : 'tablet') : 'desktop';
  const MAX_BIRDS = { phone: 8000, tablet: 12000, desktop: 20000 }[tier];
  const START_BIRDS = { phone: 4500, tablet: 7000, desktop: 12000 }[tier];
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motionQuery.matches;

  let renderer;
  try {
    renderer = new M.Renderer(canvas);
  } catch (err) {
    $('fallback-detail').textContent = String((err && err.message) || err);
    $('fallback').hidden = false;
    return;
  }

  // ---- state & simulation ---------------------------------------------
  const state = { birds: START_BIRDS, mood: 0.45, light: 0.4, autopilot: true };
  const flock = new M.Flock(MAX_BIRDS);
  const falcon = new M.Falcon();
  const sound = new M.Sound();
  const inst = new Float32Array(MAX_BIRDS * 8);
  const env = { instances: inst, predX: 0, predY: 0, predZ: 0, predVX: 0, predVY: 0, predVZ: 0, predScale: 1 };
  const input = { steering: false, tx: 0, ty: 0, tz: 0, autopilot: true, mood: state.mood };
  renderer.ensureInstances(MAX_BIRDS);

  const effectiveMood = () => (reduced ? Math.min(state.mood, 0.3) : state.mood);
  flock.setMood(effectiveMood());
  flock.updateRoost(0);
  flock.spawn(state.birds);

  // ---- camera: a watcher crouched at the water's edge -------------------
  const cam = {
    pos: new Float32Array([0, 1.4, 0]),
    fwd: new Float32Array(3), right: new Float32Array(3), up: new Float32Array(3),
    tanX: 0.47, tanY: 0.29,
    yaw: { x: 0, v: 0 }, pitch: { x: 0.08, v: 0 },
  };
  // critically damped spring (implicit Euler, stable for any dt)
  function spring(s, target, omega, dt) {
    const f = 1 + 2 * dt * omega, oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo, det = 1 / (f + hhoo);
    const x = (f * s.x + dt * s.v + hhoo * target) * det;
    s.v = (s.v + hoo * (target - s.x)) * det;
    s.x = x;
  }
  let viewW = 1, viewH = 1;
  function updateCamera(dt, t, snap) {
    const aspect = viewW / viewH;
    // about 50° across on wide screens; tall screens open the vertical field instead
    cam.tanY = clamp(Math.tan(25 * DEG) / aspect, Math.tan(15 * DEG), Math.tan(36 * DEG));
    cam.tanX = cam.tanY * aspect;
    const portrait = aspect < 1;
    const dx = flock.cx - cam.pos[0], dy = flock.cy - cam.pos[1], dz = flock.cz - cam.pos[2];
    // follow the flock, but never so far that the reeds swing into the middle
    // of the shot or the sun leaves it (a narrow portrait frame follows closer)
    const yawT = clamp(Math.atan2(dx, dz) * (portrait ? 0.85 : 0.72), -9 * DEG, 9 * DEG);
    const elev = Math.atan2(dy, Math.hypot(dx, dz));
    let pitchT = elev - Math.atan((portrait ? 0.06 : 0.16) * cam.tanY);
    // keep the horizon in the lower part of the frame, never off it
    const lo = Math.atan(0.2 * cam.tanY), hi = Math.atan((portrait ? 0.5 : 0.62) * cam.tanY);
    pitchT = clamp(pitchT, lo, hi);
    if (snap) { cam.yaw.x = yawT; cam.pitch.x = pitchT; cam.yaw.v = cam.pitch.v = 0; }
    const w = reduced ? 0.45 : 0.8;
    spring(cam.yaw, yawT, w, dt);
    spring(cam.pitch, pitchT, w, dt);
    // a breath of hand-held drift
    const hand = reduced ? 0 : 1;
    const yaw = cam.yaw.x + hand * (0.0016 * Math.sin(t * 0.31) + 0.0007 * Math.sin(t * 0.83 + 1.3));
    const pitch = cam.pitch.x + hand * (0.0009 * Math.sin(t * 0.43 + 0.7) + 0.0004 * Math.sin(t * 1.1));
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    cam.fwd[0] = sy * cp; cam.fwd[1] = sp; cam.fwd[2] = cy * cp;
    cam.right[0] = cy; cam.right[1] = 0; cam.right[2] = -sy;
    cam.up[0] = -sp * sy; cam.up[1] = cp; cam.up[2] = -sp * cy;
  }

  // Unnormalised ray through a CSS pixel (its component along fwd is exactly 1).
  function ray(px, py, out) {
    const nx = (px / viewW) * 2 - 1, ny = 1 - (py / viewH) * 2;
    for (let i = 0; i < 3; i++) out[i] = cam.fwd[i] + nx * cam.tanX * cam.right[i] + ny * cam.tanY * cam.up[i];
    return out;
  }
  const rayTmp = new Float32Array(3);
  // Where the pointer sits on the plane through the flock that faces the camera.
  function pointerWorld(px, py, out) {
    const d = ray(px, py, rayTmp);
    const depth = Math.max(40, (flock.cx - cam.pos[0]) * cam.fwd[0] + (flock.cy - cam.pos[1]) * cam.fwd[1] + (flock.cz - cam.pos[2]) * cam.fwd[2]);
    out[0] = cam.pos[0] + d[0] * depth;
    out[1] = clamp(cam.pos[1] + d[1] * depth, 6, 120);
    out[2] = cam.pos[2] + d[2] * depth;
    return out;
  }

  // ---- scene parameters handed to the renderer each frame ---------------
  const scene = {
    n: 0, inst, falconInst: new Float32Array(8), falconSweep: 0,
    cam, sunDir: new Float32Array(3), time: 0, lead: 0, falconLead: 0, wind: 0.6,
    minPx: 2.2, fog: 1 / 1700, birdScale: 2.4, falconScale: 2.9,
    birdGlow: 0.06, reedGlow: 1.0, haze: 0.85, hazeLod: 1.5,
    bloom: 0.85, bloomThreshold: 1.1, frame: 0,
  };
  let pal = null;
  function applyLight() {
    pal = renderer.setTime(state.light);
    // backlit wings and plumes only glow while the sun is near the horizon
    const sunlight = clamp((pal.sun + 6) / 7, 0, 1);
    scene.birdGlow = 0.06 * sunlight;
    scene.reedGlow = sunlight;
    const el = pal.sun * DEG, az = 13 * DEG;
    scene.sunDir[0] = Math.sin(az) * Math.cos(el);
    scene.sunDir[1] = Math.sin(el);
    scene.sunDir[2] = Math.cos(az) * Math.cos(el);
  }
  applyLight();

  // ---- sizing & adaptive resolution -------------------------------------
  const quality = { scale: 1, ema: 16.7, lastCheck: 0, goodSince: 0, raisedAt: -1e9, ceiling: 1, warmUntil: 0 };
  let dpr = 1, needResize = true;
  function resize() {
    viewW = Math.max(1, innerWidth);
    viewH = Math.max(1, innerHeight);
    dpr = Math.min(devicePixelRatio || 1, 2);
    // keep the drawing buffer within ~5.3 Mpx before adaptive scaling
    const fit = Math.min(1, Math.sqrt(5.3e6 / (viewW * viewH * dpr * dpr)));
    const s = fit * quality.scale;
    const w = Math.max(2, Math.round(viewW * dpr * s)), h = Math.max(2, Math.round(viewH * dpr * s));
    const bg = Math.min(1, Math.sqrt(1.15e6 / (w * h)));
    renderer.resize(w, h, bg);
    // the haze blur spans about 3 CSS pixels whatever the buffer density
    scene.hazeLod = Math.log2(Math.max(1, 3 * w / viewW));
    needResize = false;
  }
  addEventListener('resize', () => { needResize = true; });

  // Resolution follows the frame rate: drop 15 % when frames run long, creep
  // back up after a calm spell, and never return to a step that just failed.
  // Start-up (shader warm-up) and one-off hitches are ignored.
  function adaptQuality(now, frameMs) {
    if (now < quality.warmUntil || frameMs > 120) return;
    quality.ema += (frameMs - quality.ema) * 0.05;
    if (now - quality.lastCheck < 1000) return;
    quality.lastCheck = now;
    if (quality.ema > 20 && quality.scale > 0.56) {
      if (now - quality.raisedAt < 5000) quality.ceiling = quality.scale * 0.97;
      quality.scale = Math.max(0.55, quality.scale * 0.85);
      quality.goodSince = now;
      needResize = true;
    } else if (quality.ema < 17.5) {
      if (now - quality.goodSince > 6000 && quality.scale < quality.ceiling) {
        quality.scale = Math.min(quality.ceiling, quality.scale * 1.1);
        quality.goodSince = quality.raisedAt = now;
        needResize = true;
      }
    } else quality.goodSince = now;
  }

  // ---- input --------------------------------------------------------------
  const pointer = { x: 0, y: 0, inside: false, lastMove: -1e9, touch: false, down: false, downX: 0, downY: 0, downT: 0 };
  const target = new Float32Array(3);
  const reticle = $('reticle');

  function placeReticle() {
    reticle.style.transform = `translate3d(${pointer.x}px, ${pointer.y}px, 0)`;
  }
  canvas.addEventListener('pointermove', (e) => {
    pointer.x = e.clientX; pointer.y = e.clientY;
    pointer.touch = e.pointerType === 'touch';
    pointer.inside = true;
    if (!pointer.touch || pointer.down) pointer.lastMove = performance.now();
    if (!pointer.touch) placeReticle();
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    pointer.x = e.clientX; pointer.y = e.clientY;
    pointer.touch = e.pointerType === 'touch';
    pointer.inside = true;
    pointer.down = true;
    pointer.downX = e.clientX; pointer.downY = e.clientY; pointer.downT = performance.now();
    pointer.lastMove = pointer.downT;
    canvas.setPointerCapture(e.pointerId);
    if (!pointer.touch) stoopAt(e.clientX, e.clientY);     // mouse / pen: dive at once
  });
  const endPointer = (e) => {
    if (!pointer.down) return;
    pointer.down = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    // touch: a quick tap dives, a drag only steered
    if (e.type === 'pointerup' && pointer.touch && performance.now() - pointer.downT < 450 &&
        Math.hypot(e.clientX - pointer.downX, e.clientY - pointer.downY) < 14) stoopAt(e.clientX, e.clientY);
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => { if (!pointer.down) pointer.inside = false; });

  function steeringActive(now) {
    return pointer.inside && now - pointer.lastMove < (pointer.touch ? 1600 : 2600);
  }

  // Pick the bird nearest the pointer's ray (within ~3°) and dive at it;
  // empty sky sends the falcon at the point under the pointer instead.
  function stoopAt(px, py) {
    const d = ray(px, py, rayTmp);
    const il = 1 / Math.hypot(d[0], d[1], d[2]);
    const dx = d[0] * il, dy = d[1] * il, dz = d[2] * il;
    const c = flock.cur, n = flock.n, step = n > 6000 ? 3 : 1;
    let best = -1, bestA = 0.05 * 0.05;
    for (let i = 0; i < n; i += step) {
      const o = i * 8;
      const vx = c[o] - cam.pos[0], vy = c[o + 1] - cam.pos[1], vz = c[o + 2] - cam.pos[2];
      const along = vx * dx + vy * dy + vz * dz;
      if (along <= 1) continue;
      const a2 = (vx * vx + vy * vy + vz * vz - along * along) / (along * along);
      if (a2 < bestA) { bestA = a2; best = i; }
    }
    pointerWorld(px, py, target);
    if (best >= 0) { const o = best * 8; target[0] = c[o]; target[1] = c[o + 1]; target[2] = c[o + 2]; }
    launchStoop(best);
    pulse(px, py);
  }
  // Space / the Stoop button: dive into the dense heart of the flock.
  function stoopAtFlock() {
    let best = 0, bd = Infinity;
    for (let k = 0; k < 12; k++) {
      const i = flock.randomBird(), o = i * 8, c = flock.cur;
      const d = (c[o] - flock.cx) ** 2 + (c[o + 1] - flock.cy) ** 2 + (c[o + 2] - flock.cz) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    flock.bird(best, target);
    launchStoop(best);
  }
  function launchStoop(prey) {
    falcon.stoop(target[0], target[1], target[2], prey);
    sound.whoosh();
  }
  function pulse(px, py) {
    if (!pointer.touch && reticleOn) {
      reticle.classList.remove('is-strike');
      void reticle.offsetWidth;   // restart the CSS animation
      reticle.classList.add('is-strike');
      return;
    }
    const p = document.createElement('div');
    p.className = 'mm-tap wl-ui';
    p.style.transform = `translate3d(${px}px, ${py}px, 0)`;
    p.addEventListener('animationend', () => p.remove(), { once: true });
    document.body.appendChild(p);
  }

  // ---- UI ---------------------------------------------------------------
  const ui = {
    birds: $('birds'), birdsOut: $('birds-out'), mood: $('mood'), moodOut: $('mood-out'),
    light: $('light'), lightOut: $('light-out'), autopilot: $('autopilot'),
    sound: $('sound'), stoop: $('stoop'), panel: $('panel'), toggle: $('panel-toggle'), stats: $('stats'),
  };
  const fmt = (n) => n.toLocaleString('en-US');
  const moodWord = (m) => (m < 0.2 ? 'Calm' : m < 0.42 ? 'Easy' : m < 0.64 ? 'Restless' : m < 0.84 ? 'Wild' : 'Chaotic');
  const lightWord = (t) => (t < 0.14 ? 'Golden hour' : t < 0.3 ? 'Low sun' : t < 0.5 ? 'Sunset' : t < 0.66 ? 'Afterglow' : t < 0.85 ? 'Dusk' : 'Last light');

  ui.birds.max = String(MAX_BIRDS);
  ui.birds.value = String(state.birds);
  function setBirds(n) {
    state.birds = n;
    flock.setCount(n);
    ui.birdsOut.textContent = fmt(n);
  }
  function setMood(m) {
    state.mood = m;
    flock.setMood(effectiveMood());
    ui.moodOut.textContent = moodWord(m);
  }
  function setLight(t) {
    state.light = clamp(t, 0, 1);
    applyLight();
    ui.lightOut.textContent = lightWord(state.light);
  }
  function setAutopilot(on) {
    state.autopilot = on;
    ui.autopilot.checked = on;
  }
  function setSound(on) {
    if (on) sound.enable(); else sound.disable();
    ui.sound.setAttribute('aria-pressed', String(on));
    ui.sound.classList.toggle('is-on', on);
  }
  function setPanel(open) {
    ui.panel.classList.toggle('is-open', open);
    ui.toggle.setAttribute('aria-expanded', String(open));
  }

  ui.birds.addEventListener('input', () => setBirds(+ui.birds.value));
  ui.mood.addEventListener('input', () => setMood(+ui.mood.value / 100));
  ui.light.addEventListener('input', () => setLight(+ui.light.value / 100));
  ui.autopilot.addEventListener('change', () => setAutopilot(ui.autopilot.checked));
  ui.sound.addEventListener('click', () => setSound(!sound.on));
  ui.stoop.addEventListener('click', stoopAtFlock);
  ui.toggle.addEventListener('click', () => setPanel(!ui.panel.classList.contains('is-open')));
  setBirds(state.birds);
  setMood(+ui.mood.value / 100);
  setLight(+ui.light.value / 100);
  setPanel(tier === 'desktop');
  Wonderlab.syncRanges();

  const isTyping = (el) => el instanceof Element && !!el.closest('input:not([type="range"]):not([type="checkbox"]), textarea, select, [contenteditable=""], [contenteditable="true"]');
  addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
    if (document.querySelector('dialog[open]')) return;
    const k = e.key;
    if (k === ' ') {
      if (e.target instanceof Element && e.target.closest('button, a, input')) return;   // let controls handle Space
      e.preventDefault();
      if (!e.repeat) stoopAtFlock();
    } else if (k === 'a' || k === 'A') {
      if (!e.repeat) setAutopilot(!state.autopilot);
    } else if (k === 'm' || k === 'M') {
      if (!e.repeat) setSound(!sound.on);
    } else if (k === '[' || k === ']') {
      setLight(state.light + (k === ']' ? 0.04 : -0.04));
      ui.light.value = String(Math.round(state.light * 100));
      Wonderlab.syncRanges();
    }
  });

  motionQuery.addEventListener('change', (e) => { reduced = e.matches; flock.setMood(effectiveMood()); });

  // ---- main loop ----------------------------------------------------------
  let raf = 0, last = 0, simAcc = 0, simTime = 0, wall = 0, statT = 0, lost = false, reticleOn = false;
  const voice = { rush: 0, gust: 0, pan: 0 };
  const SIM_DT = 1 / 60;

  function stepSim(h, now) {
    simTime += h;
    flock.updateRoost(simTime);
    input.steering = steeringActive(now);
    if (input.steering) {
      pointerWorld(pointer.x, pointer.y, target);
      input.tx = target[0]; input.ty = target[1]; input.tz = target[2];
    }
    input.autopilot = state.autopilot;
    input.mood = effectiveMood();
    falcon.update(h, flock, input);
    env.predX = falcon.x; env.predY = falcon.y; env.predZ = falcon.z;
    env.predVX = falcon.vx; env.predVY = falcon.vy; env.predVZ = falcon.vz;
    env.predScale = falcon.threat * (reduced ? 0.8 : 1);
    flock.step(h, env);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const frameMs = now - last;
    const dt = Math.min(0.1, frameMs / 1000);
    last = now;
    if (needResize) resize();
    adaptQuality(now, frameMs);

    // the flock is simulated at ~60 Hz whatever the display rate; on faster
    // displays the vertex shader extrapolates birds along their headings
    const speed = reduced ? 0.75 : 1;
    simAcc += dt * speed;
    if (simAcc >= SIM_DT * 0.97) {
      stepSim(Math.min(simAcc, 1 / 30), now);
      simAcc = 0;
    }
    wall += dt * speed;
    updateCamera(dt, wall, false);

    scene.n = flock.n;
    scene.lead = simAcc * flock.t.cruise;
    scene.falconLead = simAcc * Math.hypot(falcon.vx, falcon.vy, falcon.vz);
    scene.time = wall;
    scene.frame++;
    scene.wind = reduced ? 0.35 : 0.55 + 0.25 * Math.sin(wall * 0.11);
    falcon.writeInstance(scene.falconInst);
    scene.falconSweep = falcon.tuck;
    renderer.render(scene);

    const steering = input.steering && !pointer.touch;
    if (steering !== reticleOn) { reticleOn = steering; reticle.classList.toggle('is-on', steering); }

    if (sound.on) {
      const dx = flock.cx - cam.pos[0], dz = flock.cz - cam.pos[2];
      const rel = Math.atan2(dx, dz) - Math.atan2(cam.fwd[0], cam.fwd[2]);
      // the roar of wings swells as the flock turns or panics, louder when near
      voice.rush = clamp(flock.turning / 16 + flock.agitation * 2.2, 0, 1) * clamp(260 / Math.hypot(dx, dz), 0.4, 1.4) * 0.8;
      voice.gust = 0.5 + 0.5 * Math.sin(wall * 0.11);
      voice.pan = clamp(rel * 2.2, -0.8, 0.8);
      sound.update(voice);
    }
    if (now - statT > 500) {
      statT = now;
      ui.stats.textContent = `${fmt(flock.n)} starlings · polarization ${flock.polar.toFixed(2)} · ${flock.speed.toFixed(1)} m/s`;
    }
  }

  function start() {
    if (raf || lost || document.hidden) return;
    last = performance.now();
    quality.warmUntil = last + 2500;
    quality.ema = 16.7;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  document.addEventListener('visibilitychange', () => {
    sound.pause(document.hidden);
    if (document.hidden) stop(); else start();
  });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; stop(); });
  canvas.addEventListener('webglcontextrestored', () => {
    renderer.init();
    renderer.ensureInstances(MAX_BIRDS);
    lost = false;
    needResize = true;
    start();
  });

  // settle the flock for a moment so the very first frame already flows
  for (let i = 0; i < 30; i++) stepSim(SIM_DT, -1e9);
  resize();
  updateCamera(SIM_DT, 0, true);
  start();
})();
