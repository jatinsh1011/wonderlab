/* =====================================================================
   Liquid Light · script.js
   Palettes, painting (mouse, pen, multi-touch), the kaleidoscope, idle
   motion and the controls around the fluid solver in fluid.js.
   ===================================================================== */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const canvas = $('#stage');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const coarsePointer = matchMedia('(pointer: coarse)').matches;

  // ---------- colour ----------
  function hsv(h, s, v) {
    h = ((h % 1) + 1) % 1;
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  }
  const pingpong = (t) => 1 - Math.abs(2 * (t - Math.floor(t)) - 1);
  function ramp(stops, t) {
    const x = (t - Math.floor(t)) * stops.length;
    const i = Math.floor(x) % stops.length, j = (i + 1) % stops.length;
    let f = x - Math.floor(x);
    f = f * f * (3 - 2 * f);
    return [0, 1, 2].map((k) => stops[i][k] + (stops[j][k] - stops[i][k]) * f);
  }

  // Ink colours are absorbances (how much red, green and blue each ink soaks up), so
  // they mix like pigment: phthalo blue over gold leaves only green unabsorbed.
  const INKS = [
    [1.0, 0.5, 0.12],   // phthalo blue
    [0.1, 0.95, 0.6],   // crimson
    [0.02, 0.22, 1.0],  // gold
    [1.0, 0.2, 0.42],   // deep teal
  ];

  const PALETTES = [
    { name: 'Neon', accent: '#7cf4ff', ink: '#03161b', bg: [0.006, 0.006, 0.016], gain: 0.15, color: (t) => hsv(t, 0.92, 1) },
    { name: 'Aurora', accent: '#7dffb3', ink: '#031a0d', bg: [0.003, 0.01, 0.026], gain: 0.15, color: (t) => hsv(0.36 + 0.5 * pingpong(t), 0.85, 1) },
    { name: 'Lava', accent: '#ff8a5c', ink: '#1f0800', bg: [0.026, 0.004, 0.003], gain: 0.16, color: (t) => hsv(-0.025 + 0.155 * pingpong(t), 1, 1) },
    { name: 'Ink', accent: '#2f5bd3', ink: '#ffffff', bg: [0.955, 0.94, 0.9], gain: 0.5, paper: true, color: (t) => ramp(INKS, t) },
  ];
  const SYMMETRY = [0, 2, 3, 4, 6, 8];
  const QUALITY = { high: [192, 1024], medium: [144, 768], low: [96, 512] };
  const FORCE = 6000;

  const state = {
    palette: 0,
    sym: 0,
    paused: false,
    idle: true,
    quality: 'auto',
    level: coarsePointer ? 'medium' : 'high',
    hueT: Math.random(),
    lastInteract: -1e9,
    nextIdle: 0,
    clearUntil: 0,
    fade: 0.9,
    snapshot: false,
  };

  // ---------- fluid ----------
  function fallback(message) {
    const el = document.createElement('div');
    el.className = 'wl-fallback';
    el.innerHTML = `<div><h1 style="margin:0 0 12px;font:700 24px/1.2 var(--wl-font-display)">Liquid Light</h1><p>${message}</p></div>`;
    document.body.appendChild(el);
  }

  let fluid = null;
  try {
    fluid = window.LiquidFluid ? window.LiquidFluid.create(canvas) : { error: 'webgl2' };
  } catch (err) {
    fluid = { error: 'init' };
  }
  if (!fluid || fluid.error) {
    fallback(fluid && fluid.error === 'float'
      ? 'This piece needs a GPU that can render to floating-point textures. Try a recent version of Chrome, Edge, Safari or Firefox.'
      : 'This piece needs WebGL2, which this browser or device doesn\'t provide. Try a recent version of Chrome, Edge, Safari or Firefox.');
    return;
  }
  const params = fluid.params;

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    fallback('The graphics driver was reset. <a href="" style="color:var(--wl-accent)">Reload the page</a> to keep painting.');
  });

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      fluid.resize();
    }
  }

  function setLevel(level) {
    state.level = level;
    fluid.setResolution(QUALITY[level][0], QUALITY[level][1]);
  }

  // Velocity is stored in grid cells per second, so a finer grid needs a stronger push
  // for a stroke to move the same distance on screen.
  const forceScale = () => fluid.simShort / 160;

  // ---------- splats ----------
  function paletteColor(t, gain) {
    const P = PALETTES[state.palette];
    const c = P.color(t), g = gain * P.gain;
    return [c[0] * g, c[1] * g, c[2] * g];
  }

  // Kaleidoscope: copy every splat around the centre, n rotations, each with its mirror image.
  function splat(x, y, dx, dy, color, radiusScale) {
    const n = SYMMETRY[state.sym];
    if (!n) {
      fluid.splat(x, y, dx, dy, color, radiusScale);
      return;
    }
    const aspect = canvas.width / canvas.height;
    const px = (x - 0.5) * aspect, py = y - 0.5;
    // 2n copies share the dye, so a mandala glows instead of flooding the screen
    const share = 3 / Math.sqrt(2 * n);
    color = [color[0] * share, color[1] * share, color[2] * share];
    // finer, gentler copies: twelve full-strength jets would just fill the screen
    dx *= 0.55;
    dy *= 0.55;
    radiusScale = (radiusScale || 1) * 0.7;
    for (let m = 0; m < 2; m++) {
      const f = m ? -1 : 1;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        const qx = px * c - py * f * s, qy = px * s + py * f * c;
        fluid.splat(qx / aspect + 0.5, qy + 0.5, dx * c - dy * f * s, dx * s + dy * f * c, color, radiusScale);
      }
    }
  }

  function burst(count, gain) {
    const calm = reducedMotion.matches;
    if (SYMMETRY[state.sym]) count = Math.max(2, Math.round(count / 2.5)); // each splat is already mirrored many times
    for (let i = 0; i < count; i++) {
      state.hueT += 0.08 + Math.random() * 0.14;
      const angle = Math.random() * Math.PI * 2;
      const f = (calm ? 260 : 700) * (0.5 + Math.random()) * forceScale();
      splat(0.15 + Math.random() * 0.7, 0.15 + Math.random() * 0.7, Math.cos(angle) * f, Math.sin(angle) * f, paletteColor(state.hueT, gain), 1.1);
    }
  }

  // ---------- pointers ----------
  const pointers = new Map();
  const interacted = () => { state.lastInteract = performance.now(); };

  function uv(e) {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
    const [x, y] = uv(e);
    let p = pointers.get(e.pointerId);
    if (!p) {
      p = { x, y, px: x, py: y, down: false, moved: false, t: 0, mouse: e.pointerType === 'mouse' };
      pointers.set(e.pointerId, p);
    }
    p.down = true;
    p.x = p.px = x;
    p.y = p.py = y;
    p.t = state.hueT += 0.27;
    // A press drops a bloom of colour where you touch.
    splat(x, y, (Math.random() - 0.5) * 140, (Math.random() - 0.5) * 140, paletteColor(p.t, 2.2), 1.1);
    interacted();
  });

  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = uv(e);
    const p = pointers.get(e.pointerId);
    if (!p) {
      // A mouse stirs the fluid just by moving over it; touches start on pointerdown.
      if (e.pointerType === 'mouse') pointers.set(e.pointerId, { x, y, px: x, py: y, down: false, moved: false, t: state.hueT += 0.27, mouse: true });
      return;
    }
    p.x = x;
    p.y = y;
    p.moved = true;
    interacted();
  });

  function release(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    p.down = false;
    if (!p.mouse) pointers.delete(e.pointerId);
  }
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') pointers.delete(e.pointerId); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Turn each pointer's movement since the last frame into a trail of splats, spaced
  // closely enough that fast strokes stay continuous.
  function applyPointers() {
    const W = canvas.width, H = canvas.height, short = Math.min(W, H);
    const reach = Math.sqrt(params.radius / 100) * short;
    for (const p of pointers.values()) {
      if (!p.moved) continue;
      p.moved = false;
      const ddx = (p.x - p.px) * W, ddy = (p.y - p.py) * H;
      const dist = Math.hypot(ddx, ddy);
      if (dist < 0.5) continue;
      const hover = p.mouse && !p.down;
      const steps = Math.min(8, Math.max(1, Math.ceil(dist / (reach * 0.55))));
      const share = 1 / Math.sqrt(steps);
      const force = FORCE * forceScale() * (hover ? 0.7 : 1) * share;
      const fx = (ddx / short) * force, fy = (ddy / short) * force;
      p.t += (dist / short) * 0.4; // the colour drifts as you paint
      const color = paletteColor(p.t, (hover ? 0.5 : 1) * share);
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        splat(p.px + (p.x - p.px) * f, p.py + (p.y - p.py) * f, fx, fy, color, 1);
      }
      p.px = p.x;
      p.py = p.y;
    }
  }

  // ---------- idle motion: gentle currents so the canvas never sits empty ----------
  function idleSplats(now) {
    if (!state.idle || state.paused) return;
    if (now - state.lastInteract < 2600) {
      state.nextIdle = now + 700;
      return;
    }
    if (now < state.nextIdle) return;
    const calm = reducedMotion.matches;
    state.nextIdle = now + (calm ? 3600 : 650) + Math.random() * (calm ? 3000 : 1300);
    state.hueT += 0.1 + Math.random() * 0.2;
    const x = 0.12 + Math.random() * 0.76, y = 0.12 + Math.random() * 0.76;
    const heading = Math.atan2(0.5 - y, 0.5 - x) + (Math.random() - 0.5) * 2.4;
    const f = (calm ? 240 : 520) * (0.6 + Math.random() * 0.8) * forceScale();
    splat(x, y, Math.cos(heading) * f, Math.sin(heading) * f, paletteColor(state.hueT, calm ? 2.6 : 4.2), 1.1);
  }

  // ---------- controls ----------
  const swatches = [...document.querySelectorAll('.swatch')];
  const themeMeta = document.querySelector('meta[name="theme-color"]');

  function setPalette(i) {
    const prev = PALETTES[state.palette], next = PALETTES[i];
    state.palette = i;
    params.bg = next.bg;
    params.paper = !!next.paper;
    document.documentElement.style.setProperty('--wl-accent', next.accent);
    document.documentElement.style.setProperty('--wl-accent-ink', next.ink);
    document.body.classList.toggle('is-paper', !!next.paper);
    themeMeta.setAttribute('content', next.paper ? '#f4f0e6' : '#000000');
    swatches.forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
    // Light dye and ink are opposite things (emission vs absorption), so switching
    // between them starts a fresh canvas; switching between light palettes blends.
    if (!!prev.paper !== !!next.paper) {
      fluid.clear();
      burst(6, next.paper ? 3.5 : 6);
    }
  }
  swatches.forEach((b, i) => b.addEventListener('click', () => setPalette(i)));

  const symBtn = $('#sym'), symLabel = $('#sym-label');
  function setSymmetry(k) {
    state.sym = k;
    const n = SYMMETRY[k];
    symLabel.textContent = n ? `${n}-fold` : 'Off';
    symBtn.setAttribute('aria-pressed', String(n > 0));
    symBtn.setAttribute('aria-label', `Kaleidoscope: ${n ? n + '-fold' : 'off'}. Press S to change.`);
  }
  symBtn.addEventListener('click', () => setSymmetry((state.sym + 1) % SYMMETRY.length));

  const pauseBtn = $('#pause');
  function setPaused(on) {
    state.paused = on;
    pauseBtn.setAttribute('aria-pressed', String(on));
    pauseBtn.setAttribute('aria-label', on ? 'Let it flow again (P)' : 'Freeze the flow (P)');
  }
  pauseBtn.addEventListener('click', () => setPaused(!state.paused));

  function clearCanvas() {
    if (state.paused) fluid.clear();
    else state.clearUntil = performance.now() + 650; // a quick fade rather than a hard cut
  }
  $('#clear').addEventListener('click', clearCanvas);
  $('#burst').addEventListener('click', () => burst(7, 7));
  $('#snap').addEventListener('click', () => { state.snapshot = true; });

  const settings = $('#settings'), settingsBtn = $('#settings-btn');
  settingsBtn.addEventListener('click', () => {
    settings.hidden = !settings.hidden;
    settingsBtn.setAttribute('aria-expanded', String(!settings.hidden));
  });

  function bindRange(id, apply) {
    const input = $(id), out = $(id + '-out');
    const update = () => { out.textContent = apply(Number(input.value)); };
    input.addEventListener('input', update);
    update();
  }
  bindRange('#opt-curl', (v) => { params.curl = v; return String(v); });
  bindRange('#opt-fade', (v) => {
    // 0 → the dye lingers for ages, 100 → it vanishes within a second or two
    state.fade = 0.12 * Math.pow(30, v / 100);
    return v < 20 ? 'Lingers' : v < 45 ? 'Slow' : v < 75 ? 'Medium' : 'Fast';
  });
  bindRange('#opt-size', (v) => {
    params.radius = 0.08 + 0.55 * Math.pow(v / 100, 1.6);
    return v < 25 ? 'Fine' : v < 55 ? 'Medium' : v < 80 ? 'Broad' : 'Huge';
  });
  $('#opt-bloom').addEventListener('change', (e) => { params.bloom = e.target.checked; });
  $('#opt-idle').addEventListener('change', (e) => { state.idle = e.target.checked; });
  $('#opt-quality').addEventListener('change', (e) => {
    state.quality = e.target.value;
    setLevel(state.quality === 'auto' ? (coarsePointer ? 'medium' : 'high') : state.quality);
  });

  const isTextEntry = (el) => el instanceof Element && !!el.closest('input[type="text"], input[type="search"], textarea, [contenteditable="true"]');
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTextEntry(e.target)) return;
    if (document.querySelector('dialog[open]')) return;
    switch (e.code) {
      case 'Space':
        if (e.target instanceof Element && e.target.closest('button, select, input, a')) return; // let Space press a focused control
        e.preventDefault();
        if (!e.repeat) burst(7, 7);
        break;
      case 'KeyS': setSymmetry((state.sym + 1) % SYMMETRY.length); break;
      case 'KeyP': setPaused(!state.paused); break;
      case 'KeyC': clearCanvas(); break;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4':
        setPalette(Number(e.code.slice(5)) - 1);
        break;
      default: return;
    }
    interacted();
  });

  // ---------- snapshot ----------
  function saveSnapshot() {
    // Called right after drawing, before the frame is presented, so the buffer is intact.
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `liquid-light-${PALETTES[state.palette].name.toLowerCase()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  }

  // ---------- adaptive quality: step down if frames stay slow ----------
  let slow = 0;
  function adapt(rawDt) {
    if (state.quality !== 'auto' || state.level === 'low' || rawDt > 0.25) return;
    slow = rawDt > 1 / 42 ? slow + rawDt : Math.max(0, slow - rawDt * 0.5);
    if (slow > 2.5) {
      slow = 0;
      setLevel(state.level === 'high' ? 'medium' : 'low');
    }
  }

  // ---------- loop ----------
  resize();
  setLevel(state.level);
  setPalette(0);
  setSymmetry(0);
  burst(reducedMotion.matches ? 6 : 11, 7);

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden) {
      last = now;
      return;
    }
    const rawDt = (now - last) / 1000;
    const dt = Math.min(rawDt, 1 / 30);
    last = now;
    resize();
    adapt(rawDt);
    applyPointers();
    idleSplats(now);
    const clearing = now < state.clearUntil;
    params.dyeDissipation = clearing ? 9 : state.fade;
    params.velocityDissipation = clearing ? 3 : reducedMotion.matches ? 0.6 : 0.2;
    if (!state.paused) fluid.step(dt);
    fluid.render(now / 1000);
    if (state.snapshot) {
      state.snapshot = false;
      saveSnapshot();
    }
  }
  requestAnimationFrame(frame);

  document.addEventListener('visibilitychange', () => { last = performance.now(); });
})();
