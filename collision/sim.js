/* =====================================================================
   Collision · sim.js — physics, galaxy models and scenarios.
   A restricted N-body model in the spirit of Toomre & Toomre (1972):
   every galaxy is a rigid potential (a Plummer core for the bulge plus
   a broad Plummer dark-matter halo) moving on a softened few-body orbit,
   and its stars are massless test particles that feel every galaxy.
   Units: G = 1, length 1 kpc, mass 1e10 M☉, so one velocity unit is
   207.4 km/s and one time unit is 4.714 Myr.
   Plain classic script with no DOM access (it also runs under Node).
   ===================================================================== */
(function (root) {
  'use strict';

  const MYR_PER_UNIT = 4.714;
  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;

  // Particle populations (stored in the x channel of the info attribute).
  const POP = Object.freeze({ BULGE: 0, DISK: 1, YOUNG: 2, HII: 3, DUST: 4 });

  // Galaxy recipes. mix = share of the stellar particles per population
  // (bulge, old disk, young stars, HII regions); light = share of the
  // galaxy's light each population carries; dust = extra dust particles
  // as a fraction of the galaxy's whole particle budget.
  const KINDS = {
    spiral: { bulgeMass: 1.0, mix: [0.13, 0.45, 0.36, 0.06], light: [0.30, 0.45, 0.22, 0.03], dust: 0.13, arms: 1 },
    compact: { bulgeMass: 1.8, mix: [0.55, 0.37, 0.07, 0.01], light: [0.62, 0.32, 0.055, 0.005], dust: 0.04, arms: 0 },
  };

  // ---- deterministic randomness ------------------------------------------
  function rng(seed) { // mulberry32
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rand) { // Box–Muller
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rand());
  }

  // ---- mass model --------------------------------------------------------
  // Circular speed in one galaxy's spherical potential (core + halo).
  function vcirc(g, r) {
    const r2 = r * r;
    return Math.sqrt(r2 * (g.Mb * Math.pow(r2 + g.eb2, -1.5) + g.Mh * Math.pow(r2 + g.ah2, -1.5)));
  }

  function setSpin(g, nx, ny, nz) {
    const inv = 1 / Math.hypot(nx, ny, nz);
    const n = g.spin;
    n[0] = nx * inv; n[1] = ny * inv; n[2] = nz * inv;
    // U: any unit vector in the disk plane; V = N × U so rotation runs U → V.
    const ax = Math.abs(n[0]) < 0.9 ? 1 : 0, ay = 1 - ax;
    let ux = ay * n[2], uy = -ax * n[2], uz = ax * n[1] - ay * n[0]; // (ax, ay, 0) × N
    const iu = 1 / Math.hypot(ux, uy, uz);
    ux *= iu; uy *= iu; uz *= iu;
    g.axisU[0] = ux; g.axisU[1] = uy; g.axisU[2] = uz;
    g.axisV[0] = n[1] * uz - n[2] * uy;
    g.axisV[1] = n[2] * ux - n[0] * uz;
    g.axisV[2] = n[0] * uy - n[1] * ux;
  }

  // Reference spiral (mass 1, size 1): a 1e10 M☉ core and 1.3e11 M☉ halo
  // give a roughly flat rotation curve of 170–200 km/s out to 15 kpc.
  function makeGalaxy(spec, index) {
    const kind = KINDS[spec.kind || 'spiral'];
    const m = spec.mass, s = spec.size;
    const g = {
      index, name: spec.name, kind, mass: m, size: s,
      Mb: kind.bulgeMass * m, eb: 0.5 * s, Mh: 13 * m, ah: 6 * s,
      Rd: 2.8 * s, Rmax: 15 * s, hz: 0.2 * s, bulgeA: 0.55 * s,
      pos: new Float64Array(3), vel: new Float64Array(3),
      spin: new Float64Array(3), axisU: new Float64Array(3), axisV: new Float64Array(3),
      tint: spec.tint,
      cotPitch: 1 / Math.tan((spec.pitch || 16) * DEG),
      armOrder: kind.arms,
      patternAngle: (spec.armPhase || 0) * DEG,
      patternSpeed: 0,
      start: 0, nStars: 0, nDust: 0,
    };
    g.M = g.Mb + g.Mh;
    g.eb2 = g.eb * g.eb;
    g.ah2 = g.ah * g.ah;
    g.armInner = 0.65 * g.Rd;
    // the two-armed density wave co-rotates with the disk at 75 % of its radius
    const rc = 0.75 * g.Rmax;
    g.patternSpeed = vcirc(g, rc) / rc;
    if (spec.tilt !== undefined) {
      // tilt: angle between the disk's spin and the orbital spin (+y); 0° prograde, 180° retrograde
      const t = spec.tilt * DEG, nd = (spec.node || 0) * DEG;
      setSpin(g, Math.sin(t) * Math.sin(nd), Math.cos(t), Math.sin(t) * Math.cos(nd));
    }
    return g;
  }

  // ---- galaxy–galaxy gravity -------------------------------------------
  // Each pair of components interacts like two Plummer spheres with summed
  // squared softening, so forces are exactly antisymmetric.
  function pairPotential(a, b, r2) {
    return -(a.Mb * b.Mb / Math.sqrt(r2 + a.eb2 + b.eb2) + a.Mb * b.Mh / Math.sqrt(r2 + a.eb2 + b.ah2)
      + a.Mh * b.Mb / Math.sqrt(r2 + a.ah2 + b.eb2) + a.Mh * b.Mh / Math.sqrt(r2 + a.ah2 + b.ah2));
  }
  function pairStrength(a, b, r2) { // |force| / separation
    return a.Mb * b.Mb * Math.pow(r2 + a.eb2 + b.eb2, -1.5) + a.Mb * b.Mh * Math.pow(r2 + a.eb2 + b.ah2, -1.5)
      + a.Mh * b.Mb * Math.pow(r2 + a.ah2 + b.eb2, -1.5) + a.Mh * b.Mh * Math.pow(r2 + a.ah2 + b.ah2, -1.5);
  }

  function coreAccel(gals, n, friction, acc) {
    acc.fill(0, 0, n * 3);
    for (let i = 0; i < n; i++) {
      const a = gals[i];
      for (let j = i + 1; j < n; j++) {
        const b = gals[j];
        const dx = b.pos[0] - a.pos[0], dy = b.pos[1] - a.pos[1], dz = b.pos[2] - a.pos[2];
        const r2 = dx * dx + dy * dy + dz * dz;
        const k = pairStrength(a, b, r2);
        const ka = k / a.M, kb = k / b.M;
        acc[i * 3] += ka * dx; acc[i * 3 + 1] += ka * dy; acc[i * 3 + 2] += ka * dz;
        acc[j * 3] -= kb * dx; acc[j * 3 + 1] -= kb * dy; acc[j * 3 + 2] -= kb * dz;
        if (friction > 0) {
          // Dynamical friction, approximated as a drag on the relative velocity
          // that grows as the halos overlap; split by mass so momentum is conserved.
          const gam = friction * Math.pow(1 + r2 / (a.ah2 + b.ah2), -2.5);
          const wa = gam * b.M / (a.M + b.M), wb = gam * a.M / (a.M + b.M);
          for (let c = 0; c < 3; c++) {
            const dv = a.vel[c] - b.vel[c];
            acc[i * 3 + c] -= wa * dv;
            acc[j * 3 + c] += wb * dv;
          }
        }
      }
    }
  }

  // One kick–drift–kick leapfrog step for the galaxy cores (h may be negative).
  function stepCores(gals, n, h, friction, acc) {
    coreAccel(gals, n, friction, acc);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) gals[i].vel[c] += 0.5 * h * acc[i * 3 + c];
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) gals[i].pos[c] += h * gals[i].vel[c];
    coreAccel(gals, n, friction, acc);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) gals[i].vel[c] += 0.5 * h * acc[i * 3 + c];
  }

  // Put two galaxies on an orbit that reaches pericentre q after tPeri time
  // units. e is an energy-based eccentricity: 1 parabolic, <1 bound, >1
  // hyperbolic. We start at pericentre and integrate backwards.
  function setupEncounter(orbit, gals) {
    const a = gals[0], b = gals[1];
    const M = a.M + b.M, mu = a.M * b.M / M;
    const vp = Math.sqrt(-(1 + orbit.e) * pairPotential(a, b, orbit.q * orbit.q) / mu);
    // relative separation along +x and motion along −z: the orbital spin points along +y
    a.pos.set([orbit.q * b.M / M, 0, 0]);
    b.pos.set([-orbit.q * a.M / M, 0, 0]);
    a.vel.set([0, 0, -vp * b.M / M]);
    b.vel.set([0, 0, vp * a.M / M]);
    const acc = new Float64Array(9), h = 0.01;
    for (let s = Math.round(orbit.tPeri / h); s > 0; s--) stepCores(gals, 2, -h, 0, acc);
  }

  // Integrate a copy of the cores ahead to find pericentres and the merger
  // (the cores count as merged once they stay within 3 kpc for ~40 Myr).
  function predictEvents(gals, friction, horizon) {
    const copy = gals.slice(0, 2).map((g) => ({ ...g, pos: Float64Array.from(g.pos), vel: Float64Array.from(g.vel) }));
    const acc = new Float64Array(9), h = 0.02;
    let peri = [], merge = null, close = -1, d0 = Infinity, d1 = Infinity;
    for (let t = h; t <= horizon && merge === null; t += h) {
      stepCores(copy, 2, h, friction, acc);
      const d = Math.hypot(copy[0].pos[0] - copy[1].pos[0], copy[0].pos[1] - copy[1].pos[1], copy[0].pos[2] - copy[1].pos[2]);
      if (d1 < d0 && d1 <= d && d1 < 45) peri.push(t - h);
      if (d >= 3) close = -1;
      else if (close < 0) close = t;
      else if (t - close > 8.5) merge = close;
      d0 = d1; d1 = d;
    }
    if (merge !== null) peri = peri.filter((t) => t < merge);
    return { peri, merge };
  }

  // ---- particles --------------------------------------------------------
  // Circular orbit of radius r about unit axis l at phase th, speed v.
  // Writes position (0..2) and velocity (3..5) relative to the galaxy.
  function orbitAbout(lx, ly, lz, r, th, v, out) {
    // P ⟂ l built from a helper axis, Q = l × P
    const hx = Math.abs(lx) < 0.9 ? 1 : 0, hy = 1 - hx;
    const d = hx * lx + hy * ly;
    let px = hx - d * lx, py = hy - d * ly, pz = -d * lz;
    const ip = 1 / Math.hypot(px, py, pz);
    px *= ip; py *= ip; pz *= ip;
    const qx = ly * pz - lz * py, qy = lz * px - lx * pz, qz = lx * py - ly * px;
    const c = Math.cos(th), s = Math.sin(th);
    out[0] = r * (c * px + s * qx); out[1] = r * (c * py + s * qy); out[2] = r * (c * pz + s * qz);
    out[3] = v * (c * qx - s * px); out[4] = v * (c * qy - s * py); out[5] = v * (c * qz - s * pz);
  }

  // Orbit axis tilted from the disk spin by angle `tilt` in a random direction.
  function tiltedAxis(g, tilt, rand, out) {
    const a = rand() * TAU, s = Math.sin(tilt), c = Math.cos(tilt);
    const ca = Math.cos(a) * s, sa = Math.sin(a) * s;
    for (let k = 0; k < 3; k++) out[k] = c * g.spin[k] + ca * g.axisU[k] + sa * g.axisV[k];
  }

  // Exponential-disk radius: p(R) ∝ R·exp(−R/scale) is a Gamma(2) variate.
  function diskRadius(rand, scale, rmin, rmax) {
    for (;;) {
      const r = -scale * Math.log(Math.max(rand() * rand(), 1e-12));
      if (r >= rmin && r <= rmax) return r;
    }
  }

  // Fill one galaxy's particles: nStars stars in a shuffled order (so any
  // prefix of the range is a fair sub-sample for adaptive quality), then
  // nDust dust clouds. state: xyz + velocity, info: population, galaxy,
  // luminosity, seed. Every particle starts on a circular orbit in its own
  // galaxy's potential (plus a little dispersion), so disks are in
  // equilibrium at t = 0.
  function fillGalaxy(g, state, info, start, nStars, nDust, rand) {
    const kind = g.kind;
    const counts = [0, 0, 0, 0];
    let assigned = 0;
    for (let p = 0; p < 3; p++) { counts[p] = Math.round(nStars * kind.mix[p]); assigned += counts[p]; }
    counts[3] = nStars - assigned;

    const perm = new Uint32Array(nStars);
    for (let i = 0; i < nStars; i++) perm[i] = i;
    for (let i = nStars - 1; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }

    const out = new Float64Array(6), axis = new Float64Array(3);
    const wSum = [0, 0, 0, 0, 0];
    let next = 0;
    const put = (slot, pop, w, sigma) => {
      const i = start + slot;
      for (let c = 0; c < 3; c++) {
        state[i * 6 + c] = g.pos[c] + out[c];
        state[i * 6 + 3 + c] = g.vel[c] + out[3 + c] + sigma * gauss(rand);
      }
      info[i * 4] = pop; info[i * 4 + 1] = g.index; info[i * 4 + 2] = w; info[i * 4 + 3] = rand();
      wSum[pop] += w;
    };

    // Bulge: Plummer-distributed radii on circular orbits in random planes,
    // biased to co-rotate with the disk (a slowly rotating, oblate bulge).
    for (let n = 0; n < counts[POP.BULGE]; n++) {
      let r;
      do r = g.bulgeA / Math.sqrt(Math.pow(Math.max(rand(), 1e-9), -2 / 3) - 1); while (r > 6 * g.bulgeA);
      const ux = gauss(rand), uy = gauss(rand), uz = gauss(rand);
      const il = 1 / Math.hypot(ux, uy, uz);
      const lx = 0.9 * g.spin[0] + ux * il, ly = 0.9 * g.spin[1] + uy * il, lz = 0.9 * g.spin[2] + uz * il;
      const ll = 1 / Math.hypot(lx, ly, lz);
      const v = vcirc(g, r);
      orbitAbout(lx * ll, ly * ll, lz * ll, r, rand() * TAU, v, out);
      put(perm[next++], POP.BULGE, 1, 0.1 * v);
    }

    // Old disk: sampled with a 1.3× longer scale length and re-weighted to
    // the true profile, so the faint outskirts (tomorrow's tidal tails) are
    // resolved by more, dimmer particles.
    const stretch = 1.3, kw = 1 / g.Rd - 1 / (stretch * g.Rd);
    for (let n = 0; n < counts[POP.DISK]; n++) {
      const r = diskRadius(rand, stretch * g.Rd, 0.3 * g.bulgeA, g.Rmax);
      const z = Math.max(-0.8, Math.min(0.8, g.hz * gauss(rand) / r));
      tiltedAxis(g, Math.asin(z), rand, axis);
      const v = vcirc(g, r);
      orbitAbout(axis[0], axis[1], axis[2], r, rand() * TAU, v, out);
      put(perm[next++], POP.DISK, Math.exp(-kw * r), 0.07 * v);
    }

    // Young stars in loose associations and HII regions in tight knots:
    // members share an orbit plane and start close together, then shear apart.
    const clusters = (pop, total, scale, rmin, size, minMembers, spread, bright) => {
      let left = total;
      while (left > 0) {
        const rc = diskRadius(rand, scale, rmin, g.Rmax);
        const members = Math.min(left, minMembers + ((rand() * spread) | 0));
        tiltedAxis(g, Math.asin(Math.min(0.5, 0.5 * g.hz * gauss(rand) / rc)), rand, axis);
        const th = rand() * TAU;
        const w = bright ? 0.4 + 3 * Math.pow(rand(), 4) : 1;
        for (let m = 0; m < members; m++) {
          const r = Math.max(0.3, rc + size * gauss(rand));
          const v = vcirc(g, r);
          orbitAbout(axis[0], axis[1], axis[2], r, th + size * gauss(rand) / rc, v, out);
          put(perm[next++], pop, w, 0.025 * v);
        }
        left -= members;
      }
    };
    clusters(POP.YOUNG, counts[POP.YOUNG], 1.25 * g.Rd, 0.5 * g.Rd, 0.22, 6, 18, false);
    clusters(POP.HII, counts[POP.HII], 1.2 * g.Rd, 0.6 * g.Rd, 0.06, 3, 7, true);

    // Dust: a thin, slightly clumpy exponential layer.
    for (let n = 0; n < nDust;) {
      const rc = diskRadius(rand, 1.3 * g.Rd, 0.4 * g.Rd, 0.92 * g.Rmax);
      const members = Math.min(nDust - n, 2 + ((rand() * 4) | 0));
      tiltedAxis(g, Math.asin(Math.min(0.5, 0.35 * g.hz * gauss(rand) / rc)), rand, axis);
      const th = rand() * TAU;
      for (let m = 0; m < members; m++, n++) {
        const r = Math.max(0.3, rc + 0.25 * gauss(rand));
        const v = vcirc(g, r);
        orbitAbout(axis[0], axis[1], axis[2], r, th + 0.25 * gauss(rand) / rc, v, out);
        put(nStars + n, POP.DUST, 1, 0.02 * v);
      }
    }

    // Normalise luminosities: each population carries its share of the
    // galaxy's light (∝ mass); dust carries an opacity budget instead.
    const budget = [kind.light[0], kind.light[1], kind.light[2], kind.light[3], 1];
    for (let i = start, end = start + nStars + nDust; i < end; i++) {
      const pop = info[i * 4];
      info[i * 4 + 2] *= (budget[pop] * g.mass) / Math.max(wSum[pop], 1e-9);
    }
  }

  // Sample the core orbits for one frame of star integration: `steps` star
  // steps of length h, each split into `sub` finer core steps. Writes the
  // core positions at all steps + 1 step boundaries as RGBA rows (one row
  // per galaxy, MAX_PATH texels wide) for the GPU's path texture.
  const MAX_PATH = 257;
  function trackCores(gals, n, h, steps, sub, friction, acc, out) {
    const write = (k) => {
      for (let i = 0; i < n; i++) {
        const o = (i * MAX_PATH + k) * 4, p = gals[i].pos;
        out[o] = p[0]; out[o + 1] = p[1]; out[o + 2] = p[2];
      }
    };
    write(0);
    for (let k = 1; k <= steps; k++) {
      for (let s = 0; s < sub; s++) stepCores(gals, n, h / sub, friction, acc);
      write(k);
    }
  }

  // ---- scenarios ------------------------------------------------------------
  // tilt: angle between each disk's spin and the orbital spin (0° prograde).
  // orbit: pericentre q (kpc), eccentricity e, time to first pericentre (units).
  // clock: Myr shown at t = 0. pace: Myr per second at 1× speed. startAt: Myr
  // to fast-forward on (re)start. frame: largest radius (kpc) the camera
  // widens to. view: opening camera azimuth/elevation (rad). beats: captions
  // keyed to predicted events ('start', 'peri0', 'peri1', 'merge') + offset in Myr.
  const AMBER = [1.0, 0.74, 0.42], ICE = [0.6, 0.7, 1.0], ORCHID = [1.0, 0.52, 0.92];
  const SCENARIOS = [
    {
      id: 'antennae', title: 'The Antennae', short: 'Antennae', designation: 'NGC 4038 / 4039 · Corvus',
      blurb: 'Two equal spirals swing past each other on a prograde orbit, unfurl two long, curving tidal tails, then fall back together and merge.',
      galaxies: [
        { name: 'NGC 4038', mass: 1, size: 1, tilt: 25, node: 30, armPhase: 0, tint: AMBER },
        { name: 'NGC 4039', mass: 1, size: 1, tilt: 45, node: 200, armPhase: 70, tint: ICE },
      ],
      orbit: { q: 12, e: 0.8, tPeri: 50 },
      friction: 0.175, duration: 1500, clock: 0, pace: 26, startAt: 70, frame: 62,
      view: { az: 0.5, el: 0.95 },
      beats: [
        ['start', 0, 'Two spirals fall toward each other'],
        ['peri0', -15, 'First close passage'],
        ['peri0', 110, 'Tides fling out two long, curving tails'],
        ['peri1', -15, 'Second passage: the disks collide'],
        ['peri1', 50, 'Roughly the Antennae as Hubble sees them today'],
        ['merge', -60, 'The cores spiral together'],
        ['merge', 140, 'One remnant, still trailing its tails'],
      ],
    },
    {
      id: 'mice', title: 'The Mice', short: 'Mice', designation: 'NGC 4676 · Coma Berenices',
      blurb: 'A grazing encounter: one disk is seen nearly edge-on, so its tail becomes a long straight streak, like a mouse’s tail.',
      galaxies: [
        { name: 'NGC 4676 A', mass: 1, size: 1, tilt: 15, node: 40, armPhase: 20, tint: AMBER },
        { name: 'NGC 4676 B', mass: 0.9, size: 0.95, tilt: 70, node: 250, armPhase: 140, tint: ICE },
      ],
      orbit: { q: 12, e: 0.8, tPeri: 42 },
      friction: 0.2, duration: 1100, clock: 0, pace: 22, startAt: 60, frame: 58,
      view: { az: -0.4, el: 1.05 },
      beats: [
        ['start', 0, 'Two spirals on a grazing course'],
        ['peri0', -15, 'Closest approach'],
        ['peri0', 160, 'About where Hubble sees the Mice today'],
        ['peri1', -15, 'They fall back together'],
        ['merge', -50, 'The cores merge'],
      ],
    },
    {
      id: 'cartwheel', title: 'The Cartwheel', short: 'Cartwheel', designation: 'ESO 350-40 · Sculptor',
      blurb: 'A compact galaxy plunges almost straight through the centre of a big disk. The sudden pull sends a ring of stars rippling outward.',
      galaxies: [
        { name: 'Cartwheel', mass: 1.1, size: 1.15, tilt: 90, node: 0, armPhase: 0, tint: ICE },
        { name: 'Intruder', kind: 'compact', mass: 0.3, size: 0.45, tilt: 40, node: 90, tint: AMBER },
      ],
      orbit: { q: 1.2, e: 1.8, tPeri: 28 },
      friction: 0.02, duration: 650, clock: 0, pace: 13, startAt: 40, frame: 34,
      view: { az: 0.35, el: 0.45 },
      beats: [
        ['start', 0, 'A compact galaxy dives at a big disk'],
        ['peri0', -8, 'Bullseye: it punches straight through'],
        ['peri0', 60, 'A ring of crowded orbits ripples outward'],
        ['peri0', 260, 'The ring keeps expanding as the intruder flees'],
      ],
    },
    {
      id: 'milkomeda', title: 'Milky Way + Andromeda', short: 'MW + M31', designation: 'Our future · billions of years from now',
      blurb: 'A first plunge, a slow fall back and a final merger into one giant elliptical, “Milkomeda”. The clock counts millions of years from today.',
      galaxies: [
        { name: 'Milky Way', mass: 1, size: 1, tilt: 60, node: 90, armPhase: 0, tint: AMBER },
        { name: 'Andromeda', mass: 1.35, size: 1.15, tilt: 115, node: 300, armPhase: 50, tint: ICE },
      ],
      orbit: { q: 24, e: 0.55, tPeri: 60 },
      friction: 0.4, duration: 2600, clock: 3590, pace: 40, startAt: 80, frame: 72,
      view: { az: 0.9, el: 0.8 },
      beats: [
        ['start', 0, 'Andromeda closes in on the Milky Way'],
        ['peri0', -15, 'First passage, about 3.9 billion years from now'],
        ['peri0', 160, 'Both disks unravel into tidal tails'],
        ['peri1', -15, 'Their dark halos have drained the orbit: second plunge'],
        ['merge', -50, 'The two cores coalesce'],
        ['merge', 150, '“Milkomeda”: one giant elliptical galaxy'],
      ],
    },
  ];

  // The third galaxy a user can fling in (its spin is chosen at launch).
  const INTERLOPER = { name: 'Interloper', mass: 0.35, size: 0.6, armPhase: 0, tint: ORCHID };

  root.CollisionSim = Object.freeze({
    MYR_PER_UNIT, MAX_PATH, POP, SCENARIOS, INTERLOPER,
    rng, vcirc, makeGalaxy, setSpin, setupEncounter, predictEvents, stepCores, trackCores, fillGalaxy,
  });
})(typeof window !== 'undefined' ? window : globalThis);
