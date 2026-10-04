/* =====================================================================
   Collision · camera.js — orbit camera with inertia, idle auto-rotate,
   wheel / trackpad-pinch / touch-pinch zoom and automatic framing that
   keeps every galaxy core in view. Exposes window.CollisionCamera.
   ===================================================================== */
(function (root) {
  'use strict';

  const FOV_Y = 40 * Math.PI / 180;
  const EL_LIMIT = 1.45;
  const ZOOM_MIN = 0.22, ZOOM_MAX = 3.2;

  // column-major 4×4 helpers writing into preallocated arrays
  function perspective(out, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    out.fill(0);
    out[0] = f / aspect; out[5] = f;
    out[10] = (far + near) * nf; out[11] = -1;
    out[14] = 2 * far * near * nf;
  }
  function multiply(out, a, b) {
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      for (let r = 0; r < 4; r++) out[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
    }
  }
  const damp = (from, to, tau, dt) => to + (from - to) * Math.exp(-dt / Math.max(tau, 1e-4));

  function create(canvas, opts) {
    const cam = {
      az: 0.5, el: 0.9, zoom: 1, zoomGoal: 1,
      dist: 120, distGoal: 120,
      target: new Float64Array(3), targetGoal: new Float64Array(3),
      eye: new Float64Array(3),
      vAz: 0, vEl: 0,
      autoRotate: true, reduced: false,
      lastInput: -1e9,
      view: new Float32Array(16), proj: new Float32Array(16), sky: new Float32Array(16),
      viewProj: new Float32Array(16),
      aspect: 1, focal: 1, cssW: 1, cssH: 1,
    };
    const rot = new Float32Array(16), skyProj = new Float32Array(16);

    // ---- framing ---------------------------------------------------------
    // Fit a sphere around every core (plus its disk), weighted toward the
    // heavier galaxies, never wider than the scenario allows.
    cam.frame = (gals, n, cap) => {
      let wsum = 0, cx = 0, cy = 0, cz = 0, host = gals[0], second = 0;
      for (let i = 0; i < n; i++) {
        const g = gals[i], w = g.M;
        wsum += w; cx += w * g.pos[0]; cy += w * g.pos[1]; cz += w * g.pos[2];
        if (g.M > host.M) host = g;
      }
      for (let i = 0; i < n; i++) if (gals[i] !== host) second = Math.max(second, gals[i].M);
      cx /= wsum; cy /= wsum; cz /= wsum;
      let r = 0;
      for (let i = 0; i < n; i++) {
        const g = gals[i];
        r = Math.max(r, Math.hypot(g.pos[0] - cx, g.pos[1] - cy, g.pos[2] - cz) + 0.85 * g.Rmax);
      }
      // Once a much lighter companion has flown beyond the widest view, aiming at
      // the barycentre would leave the main galaxy drifting toward a corner over
      // empty space, so glide the aim onto the main galaxy and let the companion
      // leave the frame. Pairs of similar mass keep the shared framing.
      const lopsided = Math.min(1, Math.max(0, (1 - second / host.M - 0.4) / 0.3));
      let k = Math.min(1, Math.max(0, (r - cap) / (0.4 * cap)));
      k = k * k * (3 - 2 * k) * lopsided;
      cx += (host.pos[0] - cx) * k; cy += (host.pos[1] - cy) * k; cz += (host.pos[2] - cz) * k;
      r = Math.max(30, Math.min(r, cap));
      cam.targetGoal[0] = cx; cam.targetGoal[1] = cy; cam.targetGoal[2] = cz;
      const tanY = Math.tan(FOV_Y / 2), tanX = tanY * cam.aspect;
      cam.distGoal = r / Math.sin(Math.atan(Math.min(tanX, tanY))) * 1.04;
    };

    cam.snap = () => {
      cam.target.set(cam.targetGoal);
      cam.dist = cam.distGoal;
      cam.zoom = cam.zoomGoal;
    };

    cam.setView = (az, el) => {
      cam.az = az; cam.el = el; cam.vAz = 0; cam.vEl = 0;
      cam.zoom = cam.zoomGoal = 1;
    };

    cam.touch = (now) => { cam.lastInput = now; };

    cam.update = (dt, now) => {
      // inertia after a drag, then gentle auto-rotation once idle
      const idle = now - cam.lastInput;
      if (!dragging) {
        const k = Math.exp(-dt / 0.42);
        cam.vAz *= k; cam.vEl *= k;
        cam.az += cam.vAz * dt;
        cam.el += cam.vEl * dt;
        if (cam.autoRotate && !cam.reduced && idle > 4500) {
          cam.az += 0.035 * dt * Math.min(1, (idle - 4500) / 2500);
        }
      }
      cam.el = Math.max(-EL_LIMIT, Math.min(EL_LIMIT, cam.el));
      const tau = cam.reduced ? 1.6 : 1.1;
      for (let c = 0; c < 3; c++) cam.target[c] = damp(cam.target[c], cam.targetGoal[c], 0.7, dt);
      cam.dist = damp(cam.dist, cam.distGoal, tau, dt);
      cam.zoom = Math.exp(damp(Math.log(cam.zoom), Math.log(cam.zoomGoal), 0.18, dt));
      cam.compute();
    };

    cam.compute = () => {
      const d = cam.dist * cam.zoom;
      const ce = Math.cos(cam.el), se = Math.sin(cam.el), ca = Math.cos(cam.az), sa = Math.sin(cam.az);
      // camera basis: forward f points from the eye to the target
      const fx = -ce * sa, fy = -se, fz = -ce * ca;
      let rx = -fz, rz = fx; // right = f × up(0,1,0) = (-fz, 0, fx)
      const rl = Math.hypot(rx, rz) || 1;
      rx /= rl; rz /= rl;
      const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy; // up = right × f
      cam.eye[0] = cam.target[0] - fx * d; cam.eye[1] = cam.target[1] - fy * d; cam.eye[2] = cam.target[2] - fz * d;
      rot.fill(0);
      rot[0] = rx; rot[4] = 0; rot[8] = rz;
      rot[1] = ux; rot[5] = uy; rot[9] = uz;
      rot[2] = -fx; rot[6] = -fy; rot[10] = -fz;
      rot[15] = 1;
      const v = cam.view;
      v.set(rot);
      const ex = cam.eye[0], ey = cam.eye[1], ez = cam.eye[2];
      v[12] = -(rx * ex + rz * ez);
      v[13] = -(ux * ex + uy * ey + uz * ez);
      v[14] = fx * ex + fy * ey + fz * ez;
      perspective(cam.proj, FOV_Y, cam.aspect, Math.max(0.3, d * 0.01), d * 30 + 3000);
      multiply(cam.viewProj, cam.proj, cam.view);
      perspective(skyProj, FOV_Y, cam.aspect, 0.01, 10);
      multiply(cam.sky, skyProj, rot);
    };

    cam.resize = (cssW, cssH, bufferH) => {
      cam.cssW = cssW; cam.cssH = cssH;
      cam.aspect = cssW / Math.max(1, cssH);
      cam.focal = 0.5 * bufferH / Math.tan(FOV_Y / 2);
    };

    // World → CSS pixels. Returns depth (≤ 0 when behind the camera).
    cam.project = (x, y, z, out) => {
      const m = cam.viewProj;
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      out.depth = cw;
      if (cw <= 1e-6) return out;
      out.x = (cx / cw * 0.5 + 0.5) * cam.cssW;
      out.y = (0.5 - cy / cw * 0.5) * cam.cssH;
      return out;
    };

    // CSS pixel → world point on the plane through the target facing the camera.
    cam.unproject = (sx, sy, out) => {
      const d = cam.dist * cam.zoom;
      const t = Math.tan(FOV_Y / 2);
      const nx = (sx / cam.cssW * 2 - 1) * t * cam.aspect * d;
      const ny = (1 - sy / cam.cssH * 2) * t * d;
      const v = cam.view; // rows of the rotation are the camera axes
      for (let c = 0; c < 3; c++) out[c] = cam.target[c] + v[c * 4] * nx + v[c * 4 + 1] * ny;
      return out;
    };
    cam.worldPerPixel = () => 2 * Math.tan(FOV_Y / 2) * cam.dist * cam.zoom / cam.cssH;

    cam.zoomBy = (factor) => {
      cam.zoomGoal = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cam.zoomGoal * factor));
    };
    cam.nudge = (dAz, dEl) => {
      cam.vAz += dAz; cam.vEl += dEl;
    };

    // ---- pointer input -----------------------------------------------------
    const pointers = new Map();
    let dragging = false, pinchDist = 0, lastX = 0, lastY = 0, lastT = 0;
    const now = () => performance.now();

    function onDown(e) {
      if (opts.capture(e)) return;
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      cam.touch(now());
      if (pointers.size === 1) {
        dragging = true;
        cam.vAz = 0; cam.vEl = 0;
        lastX = e.clientX; lastY = e.clientY; lastT = now();
        canvas.classList.add('is-dragging');
      } else if (pointers.size === 2) {
        dragging = false;
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    }
    function onMove(e) {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX; p.y = e.clientY;
      cam.touch(now());
      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0 && d > 0) cam.zoomBy(pinchDist / d);
        pinchDist = d;
        return;
      }
      if (!dragging) return;
      const t = now(), dt = Math.max(1, t - lastT) / 1000;
      const k = 3.2 / Math.max(320, Math.min(cam.cssW, cam.cssH * 1.4));
      const dAz = -(e.clientX - lastX) * k, dEl = (e.clientY - lastY) * k;
      cam.az += dAz; cam.el = Math.max(-EL_LIMIT, Math.min(EL_LIMIT, cam.el + dEl));
      // smoothed angular velocity for the release fling
      cam.vAz = 0.6 * cam.vAz + 0.4 * (dAz / dt);
      cam.vEl = 0.6 * cam.vEl + 0.4 * (dEl / dt);
      lastX = e.clientX; lastY = e.clientY; lastT = t;
    }
    function onUp(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (pointers.size === 1) {
        const [a] = [...pointers.values()];
        lastX = a.x; lastY = a.y; lastT = now();
        dragging = true; pinchDist = 0;
        return;
      }
      if (pointers.size === 0) {
        if (now() - lastT > 90) { cam.vAz = 0; cam.vEl = 0; }
        if (cam.reduced) { cam.vAz *= 0.3; cam.vEl *= 0.3; }
        dragging = false;
        canvas.classList.remove('is-dragging');
      }
    }
    function onWheel(e) {
      e.preventDefault();
      cam.touch(now());
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? cam.cssH : 1;
      const dy = Math.max(-240, Math.min(240, e.deltaY * unit));
      cam.zoomBy(Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0015)));
    }

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    cam.isDragging = () => dragging || pointers.size > 1;
    return cam;
  }

  root.CollisionCamera = Object.freeze({ create });
})(window);
