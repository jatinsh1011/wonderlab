/* =====================================================================
   Collision · fling.js — "fling a galaxy": in fling mode a drag launches
   a third, smaller galaxy from the press point with a velocity set by the
   drag. While aiming, time holds and the predicted orbit (a CPU
   integration of all three cores, dynamical friction included) is drawn
   on the overlay. Exposes window.CollisionFling.
   ===================================================================== */
(function (root) {
  'use strict';

  const VEL_PER_KPC = 1 / 12;   // launch speed (units) per kpc of drag
  const VEL_MAX = 4;            // ≈ 830 km/s
  const PREVIEW_STEPS = 230, PREVIEW_H = 0.3;

  function create(o) {
    const { canvas, camera, sim, Sim, onLaunch, onMode } = o;
    const MYR = Sim.MYR_PER_UNIT;
    const tmpl = Sim.makeGalaxy(Sim.INTERLOPER, 2);
    const ghost = [0, 1, 2].map(() => ({ Mb: 0, eb2: 1, Mh: 0, ah2: 1, M: 1, pos: new Float64Array(3), vel: new Float64Array(3) }));
    const acc = new Float64Array(9);
    const p0 = new Float64Array(3), p1 = new Float64Array(3), vel = new Float64Array(3), spin = new Float64Array(3);
    const path = new Float32Array((PREVIEW_STEPS + 1) * 2);
    const scr = { x: 0, y: 0, depth: 0 };
    let active = false, drag = null, pathN = 0, closest = null, dirty = false;

    function toggle(on) {
      const want = on == null ? !active : !!on;
      if (want === active) return;
      active = want;
      drag = null;
      onMode(active);
    }

    // Launch point and velocity from the current drag.
    function aim() {
      camera.unproject(drag.x0, drag.y0, p0);
      camera.unproject(drag.x1, drag.y1, p1);
      let speed = 0;
      for (let c = 0; c < 3; c++) { vel[c] = (p1[c] - p0[c]) * VEL_PER_KPC; speed += vel[c] * vel[c]; }
      speed = Math.sqrt(speed);
      if (speed > VEL_MAX) for (let c = 0; c < 3; c++) vel[c] *= VEL_MAX / speed;
    }

    // Integrate copies of the two scenario cores plus the candidate ahead.
    function predict() {
      for (let i = 0; i < 2; i++) {
        const g = sim.gals[i], q = ghost[i];
        q.Mb = g.Mb; q.eb2 = g.eb2; q.Mh = g.Mh; q.ah2 = g.ah2; q.M = g.M;
        q.pos.set(g.pos); q.vel.set(g.vel);
      }
      const q = ghost[2];
      q.Mb = tmpl.Mb; q.eb2 = tmpl.eb2; q.Mh = tmpl.Mh; q.ah2 = tmpl.ah2; q.M = tmpl.M;
      q.pos.set(p0); q.vel.set(vel);
      pathN = 0;
      closest = null;
      let best = Infinity;
      for (let k = 0; k <= PREVIEW_STEPS; k++) {
        if (k > 0) Sim.stepCores(ghost, 3, PREVIEW_H, sim.friction, acc);
        camera.project(q.pos[0], q.pos[1], q.pos[2], scr);
        if (scr.depth > 0.5) { path[pathN * 2] = scr.x; path[pathN * 2 + 1] = scr.y; pathN++; }
        for (let i = 0; i < 2; i++) {
          const d = Math.hypot(q.pos[0] - ghost[i].pos[0], q.pos[1] - ghost[i].pos[1], q.pos[2] - ghost[i].pos[2]);
          if (d < best && scr.depth > 0.5) { best = d; closest = { d, t: k * PREVIEW_H, x: scr.x, y: scr.y }; }
        }
      }
    }

    function capture(e) {
      if (!active) return false;
      if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return true;
      canvas.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
      camera.touch(performance.now());
      aim();
      dirty = true;
      return true;
    }

    canvas.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.x1 = e.clientX;
      drag.y1 = e.clientY;
      camera.touch(performance.now());
      dirty = true;
    });
    const release = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      const len = Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0);
      if (e.type === 'pointerup' && len > 14) {
        aim();
        // tilt the newcomer's disk toward the viewer so it reads as a spiral
        const v = camera.view;
        const a = Math.random() * Math.PI * 2;
        for (let c = 0; c < 3; c++) spin[c] = v[c * 4 + 2] + 0.55 * (Math.cos(a) * v[c * 4] + Math.sin(a) * v[c * 4 + 1]);
        onLaunch(p0, vel, spin);
        drag = null;
        toggle(false);
        return;
      }
      drag = null;
      dirty = true;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    function arrowHead(ctx, x0, y0, x1, y1, size) {
      const a = Math.atan2(y1 - y0, x1 - x0);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - size * Math.cos(a - 0.45), y1 - size * Math.sin(a - 0.45));
      ctx.lineTo(x1 - size * Math.cos(a + 0.45), y1 - size * Math.sin(a + 0.45));
      ctx.closePath();
      ctx.fill();
    }

    function draw(ctx) {
      if (!drag) return;
      if (dirty) { aim(); dirty = false; }
      predict();
      const accent = '167,139,250';
      // predicted path, fading with time
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.setLineDash([2, 7]);
      for (let k = 1; k < pathN; k++) {
        ctx.strokeStyle = `rgba(${accent},${(0.95 * (1 - k / pathN)).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(path[k * 2 - 2], path[k * 2 - 1]);
        ctx.lineTo(path[k * 2], path[k * 2 + 1]);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // launch disk and velocity arrow
      const r = Math.max(10, 0.45 * tmpl.Rmax / camera.worldPerPixel());
      const g = ctx.createRadialGradient(drag.x0, drag.y0, 0, drag.x0, drag.y0, r);
      g.addColorStop(0, 'rgba(255,220,250,0.9)');
      g.addColorStop(0.25, `rgba(${accent},0.35)`);
      g.addColorStop(1, `rgba(${accent},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(drag.x0, drag.y0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(drag.x0, drag.y0);
      ctx.lineTo(drag.x1, drag.y1);
      ctx.stroke();
      if (Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) > 14) arrowHead(ctx, drag.x0, drag.y0, drag.x1, drag.y1, 9);
      // readout: launch speed and closest approach
      const kms = Math.round(Math.hypot(vel[0], vel[1], vel[2]) * 207.4);
      ctx.font = '600 11px ui-monospace, "SF Mono", Menlo, monospace';
      ctx.textBaseline = 'middle';
      const lx = Math.min(drag.x1 + 14, camera.cssW - 120), ly = Math.max(drag.y1 - 14, 16);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillText(`${kms} km/s`, lx + 1, ly + 1);
      ctx.fillStyle = '#fff';
      ctx.fillText(`${kms} km/s`, lx, ly);
      if (closest && closest.d < 40) {
        const label = `closest ${Math.round(closest.d)} kpc · +${Math.round(closest.t * MYR)} Myr`;
        ctx.strokeStyle = `rgba(${accent},0.9)`;
        ctx.beginPath();
        ctx.arc(closest.x, closest.y, 6, 0, Math.PI * 2);
        ctx.stroke();
        const tx = Math.min(closest.x + 12, camera.cssW - 210);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillText(label, tx + 1, closest.y + 1);
        ctx.fillStyle = `rgb(${accent})`;
        ctx.fillText(label, tx, closest.y);
      }
    }

    return {
      toggle, capture, draw,
      wantsDraw: () => !!drag,
      holding: () => !!drag,
      get active() { return active; },
    };
  }

  root.CollisionFling = Object.freeze({ create });
})(window);
