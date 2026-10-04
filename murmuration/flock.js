/* =====================================================================
   Murmuration: flock + falcon simulation (classic script, no DOM)

   Every starling steers by its 7 nearest neighbours (topological
   interaction, Ballerini et al. 2008), found with a spatial hash over
   typed arrays. On top of separation, alignment and edge-weighted
   cohesion, an excitable-medium "escape wave" runs over the same
   neighbour graph: a bird that sees the falcon rolls into an escape turn
   and its neighbours copy the manoeuvre a beat later. Banking birds show
   more wing to the viewer, so the wave reads as a dark band sweeping
   across the flock. A coarse population grid lets birds that have been
   cut off from the main mass find their way back to it.
   ===================================================================== */
(function (root) {
  'use strict';

  const K = 7;                 // neighbours per bird
  // Each bird refreshes its neighbour list every STRIDE steps. Flockmates fly
  // together, so over 4 steps they barely move relative to one another.
  const STRIDE = 4;
  const CELL = 1.35;           // hash-grid cell (m), about the distance to the 7th neighbour
  const INV_CELL = 1 / CELL;
  const MAX_D2 = 4 * CELL * CELL;
  const TABLE = 1 << 16;
  const MASK = TABLE - 1;
  const OFF = 16384;           // makes cell coordinates positive so `| 0` floors
  const G = 9.81;
  const TWO_PI = Math.PI * 2;

  const SEP_R = 1.4;           // personal space (m)
  const INV_SEP_R = 1 / SEP_R;

  // Escape-wave medium. A resting bird whose neighbour's excitation exceeds
  // THRESH starts rising at RISE per second and crosses THRESH ~2 frames
  // later, so a front advances about one neighbour every 33 ms.
  const RISE = 9;
  const THRESH = 0.3;
  const EXC_TAU = 0.36;        // decay time constant after the peak (s)
  const REFRACT = 1.8;         // refractory period: keeps waves moving outward

  // Snapshot record (stride 8) read by neighbours: x, y, z, excitation, hx, hy, hz, -
  const S = 8;

  // Coarse population grid (8 m cells around the roost): how many birds a
  // bird can see within ~12 m. Small torn-off groups count few and head home.
  const CG = 8, INV_CG = 1 / CG, CGX = 32, CGY = 16, CGZ = 32, CG_N = CGX * CGY * CGZ;

  // dst = src summed with its two neighbours along one axis (stride, length)
  function box3(src, dst, stride, len) {
    for (let k = 0; k < CG_N; k++) {
      const p = ((k / stride) | 0) % len;
      let v = src[k];
      if (p > 0) v += src[k - stride];
      if (p < len - 1) v += src[k + stride];
      dst[k] = v;
    }
  }

  const hash = (x, y, z) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & MASK;

  // ---------------------------------------------------------------------
  class Flock {
    constructor(maxN) {
      const f32 = () => new Float32Array(maxN);
      this.maxN = maxN;
      this.n = 0;
      this.frame = 0;
      this.seed = 0x9e3779b9;

      // Double-buffered snapshot: every bird reads the same state of its
      // neighbours (Jacobi update) and writes its own next state.
      this.cur = new Float32Array(maxN * S);
      this.nxt = new Float32Array(maxN * S);
      this.vx = f32(); this.vy = f32(); this.vz = f32();
      this.wx = f32(); this.wy = f32(); this.wz = f32();   // wander (Ornstein-Uhlenbeck)
      this.roll = f32(); this.phase = f32(); this.amp = f32(); this.rate = f32();
      this.excAmp = f32(); this.refr = f32();
      this.rising = new Uint8Array(maxN);
      this.ex = f32(); this.ey = f32(); this.ez = f32();   // copied escape direction

      this.nb = new Int32Array(maxN * K);
      this.nc = new Uint8Array(maxN);

      this.gx = new Int32Array(maxN); this.gy = new Int32Array(maxN); this.gz = new Int32Array(maxN);
      this.cell = new Int32Array(maxN);
      this.start = new Int32Array(TABLE + 1);
      this.cursor = new Int32Array(TABLE);
      this.sorted = new Int32Array(maxN);
      this.sp = new Float32Array(maxN * 4);              // positions in bucket order
      this.rangeS = new Int32Array(27); this.rangeE = new Int32Array(27);
      this.stamp = new Int32Array(TABLE); this.stampId = 0;   // de-duplicates buckets per query
      this.pop = new Int32Array(CG_N); this.popTmp = new Int32Array(CG_N); this.popCell = new Int32Array(maxN);
      this.popMax = 0;
      this.bestD = new Float64Array(K); this.bestM = new Int32Array(K);

      // Soft ellipsoidal roost volume (its centre wanders, see updateRoost).
      this.roost = { x: 0, y: 27, z: 175, rx: 72, ry: 17, rz: 48 };
      this.t = {};          // tuning, filled in by setMood
      this.setMood(0.45);

      // Aggregates from the last step (camera, falcon and audio read these).
      this.cx = 0; this.cy = 27; this.cz = 175;
      this.radius = 30;
      this.agitation = 0;   // mean excitation
      this.turning = 0;     // mean lateral acceleration (m/s²)
      this.polar = 1;       // polarization |mean heading|: 1 = everyone flies the same way
      this.speed = 0;       // mean speed (m/s)
    }

    setMood(m) {
      const t = this.t;
      this.mood = m;
      t.cruise = 10.5 + 4 * m;
      t.vmin = 5.5;
      t.vmax = t.cruise * 1.65;
      t.wAli = 3.3 - 1.4 * m;      // heading relaxation rate (1/s)
      t.wCoh = 11 - 2 * m;         // pull toward neighbours for a one-sided (edge) neighbourhood
      t.wSep = 42;
      t.noise = 0.5 + 1.6 * m;     // wander strength (m/s²); more than ~2 frays the flock's edge
      t.hopGain = 0.955 + 0.032 * m;
      t.predR = 10 + 5 * m;        // radius of the hole the falcon tears open (m)
      t.flee = 48 + 25 * m;
      t.esc = 6 + 8 * m;
      t.home = 6;                  // pull on birds cut off from the main mass (m/s²)
    }

    rand() {
      let s = this.seed;
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      this.seed = s;
      return (s >>> 0) / 4294967296;
    }

    // Wandering centre of the roost volume: the flock keeps chasing it,
    // overshooting and folding back on itself.
    updateRoost(time) {
      const r = this.roost;
      r.x = -6 + 26 * Math.sin(0.041 * time + 0.7) + 8 * Math.sin(0.107 * time + 2.1);
      r.y = 27 + 6 * Math.sin(0.053 * time + 1.9);
      r.z = 178 + 24 * Math.sin(0.033 * time + 2.4);
    }

    // Seed n birds around the roost centre (see addBirds for the shape).
    spawn(n) {
      const r = this.roost;
      this.n = 0;
      this.addBirds(n, r.x, r.y, r.z);
      this.cx = r.x; this.cy = r.y; this.cz = r.z;
    }

    initBird(i, x, y, z, hx, hy, hz, speed) {
      const o = i * S, c = this.cur;
      c[o] = x; c[o + 1] = y; c[o + 2] = z; c[o + 3] = 0;
      c[o + 4] = hx; c[o + 5] = hy; c[o + 6] = hz;
      this.vx[i] = hx * speed; this.vy[i] = hy * speed; this.vz[i] = hz * speed;
      this.wx[i] = 0; this.wy[i] = 0; this.wz[i] = 0;
      this.roll[i] = 0;
      this.phase[i] = this.rand() * TWO_PI;
      this.amp[i] = 0.5;
      this.rate[i] = 8.2 + this.rand() * 2.6;           // individual wingbeat (Hz)
      this.excAmp[i] = 0; this.refr[i] = 0; this.rising[i] = 0;
      this.ex[i] = 0; this.ey[i] = 0; this.ez[i] = 1;
      this.nc[i] = 0;
    }

    // A twisted sheet about 80 m long, bowed round a turn and flying along
    // its own curve. Where the sheet turns edge-on it reads dark and where it
    // faces the viewer it reads light, so the first frame already shows the
    // banded density of a real murmuration.
    addBirds(count, ox, oy, oz) {
      const end = Math.min(this.maxN, this.n + count), R = 46;
      for (let i = this.n; i < end; i++) {
        const a = (this.rand() * 2 - 1) * 0.85;           // position along the arc
        const v = this.rand() * 2 - 1, w = this.rand() * 2 - 1;
        const hx = Math.cos(a), hz = Math.sin(a);           // heading = arc tangent
        const th = 0.5 + 2.4 * a;                           // the sheet's twist
        const sw = Math.cos(th) * v * 20, sh = Math.sin(th) * v * 20;   // across the sheet
        const tw = -Math.sin(th) * w * 4, th2 = Math.cos(th) * w * 4;  // through its thickness
        const lat = sw + tw, up = sh + th2;
        const x = ox + Math.sin(a) * R - hz * lat;
        const z = oz - 14 + (1 - Math.cos(a)) * R * 0.9 + hx * lat;
        const y = oy + up + 5 * Math.sin(a * 3.2);
        this.initBird(i, x, y, z, hx, 0, hz, this.t.cruise);
      }
      this.n = end;
    }

    // Grow by cloning random existing birds (keeps the flock's shape); shrink by
    // truncation (bird order is random, so dropping the tail thins uniformly).
    setCount(n) {
      n = Math.max(0, Math.min(this.maxN, n | 0));
      if (n <= this.n) { this.n = n; return; }
      if (this.n === 0) { this.spawn(n); return; }
      const have = this.n, c = this.cur;
      for (let i = have; i < n; i++) {
        const s = ((this.rand() * have) | 0) * S;
        this.initBird(i, c[s] + (this.rand() - 0.5) * 1.6, c[s + 1] + (this.rand() - 0.5) * 1.6, c[s + 2] + (this.rand() - 0.5) * 1.6,
          c[s + 4], c[s + 5], c[s + 6], this.t.cruise);
      }
      this.n = n;
    }

    // Counting sort of birds into hash buckets; positions are copied in bucket
    // order so the neighbour scan reads contiguous memory.
    buildGrid() {
      const n = this.n, c = this.cur;
      const gx = this.gx, gy = this.gy, gz = this.gz, cell = this.cell;
      const start = this.start, cursor = this.cursor, sorted = this.sorted, sp = this.sp;
      start.fill(0);
      for (let i = 0, o = 0; i < n; i++, o += S) {
        const cx = (c[o] * INV_CELL + OFF) | 0, cy = (c[o + 1] * INV_CELL + OFF) | 0, cz = (c[o + 2] * INV_CELL + OFF) | 0;
        gx[i] = cx; gy[i] = cy; gz[i] = cz;
        const h = hash(cx, cy, cz);
        cell[i] = h;
        start[h + 1]++;
      }
      for (let h = 0; h < TABLE; h++) start[h + 1] += start[h];
      cursor.set(start.subarray(0, TABLE));
      for (let i = 0, o = 0; i < n; i++, o += S) {
        const k = cursor[cell[i]]++, q = k * 4;
        sorted[k] = i; sp[q] = c[o]; sp[q + 1] = c[o + 1]; sp[q + 2] = c[o + 2];
      }
    }

    // k-nearest-neighbour search over the 27 surrounding cells. Birds are
    // visited in bucket order so the 27 bucket ranges are rebuilt only when
    // the cell changes. A third of the flock refreshes per step (STRIDE).
    findNeighbours() {
      const n = this.n, parity = this.frame % STRIDE, c = this.cur;
      const gx = this.gx, gy = this.gy, gz = this.gz;
      const start = this.start, sorted = this.sorted, sp = this.sp;
      const rs = this.rangeS, re = this.rangeE, bd = this.bestD, bm = this.bestM, nb = this.nb, nc = this.nc;
      const stamp = this.stamp;
      let lx = -1, ly = -1, lz = -1, cells = 0, id = this.stampId;
      for (let k = 0; k < n; k++) {
        const i = sorted[k];
        if (i % STRIDE !== parity) continue;
        const cx = gx[i], cy = gy[i], cz = gz[i];
        if (cx !== lx || cy !== ly || cz !== lz) {
          lx = cx; ly = cy; lz = cz; cells = 0; id++;
          for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const h = hash(cx + dx, cy + dy, cz + dz);
            const s = start[h], e = start[h + 1];
            if (s === e || stamp[h] === id) continue;   // empty, or two cells share a bucket
            stamp[h] = id;
            rs[cells] = s; re[cells] = e; cells++;
          }
        }
        const o = i * S, x = c[o], y = c[o + 1], z = c[o + 2];
        let cnt = 0, worst = MAX_D2;
        for (let q = 0; q < cells; q++) {
          for (let m = rs[q], me = re[q], a = m * 4; m < me; m++, a += 4) {
            const dx = sp[a] - x, dy = sp[a + 1] - y, dz = sp[a + 2] - z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 >= worst || d2 === 0) continue;
            let p = cnt < K ? cnt++ : K - 1;
            while (p > 0 && bd[p - 1] > d2) { bd[p] = bd[p - 1]; bm[p] = bm[p - 1]; p--; }
            bd[p] = d2; bm[p] = m;
            if (cnt === K) worst = bd[K - 1];
          }
        }
        const base = i * K;
        for (let q = 0; q < cnt; q++) nb[base + q] = sorted[bm[q]];
        nc[i] = cnt;
      }
      this.stampId = id;
    }

    // Bin birds into the coarse grid, then take 3x3x3 box sums (separably),
    // leaving each cell holding the population of its 24 m neighbourhood.
    regionalPopulation() {
      const n = this.n, c = this.cur, r = this.roost, pop = this.pop, tmp = this.popTmp, cell = this.popCell;
      const ox = r.x - CGX * CG * 0.5, oy = r.y - CGY * CG * 0.5, oz = r.z - CGZ * CG * 0.5;
      tmp.fill(0);
      for (let i = 0, o = 0; i < n; i++, o += S) {
        const fx = (c[o] - ox) * INV_CG, fy = (c[o + 1] - oy) * INV_CG, fz = (c[o + 2] - oz) * INV_CG;
        if (fx < 0 || fy < 0 || fz < 0 || fx >= CGX || fy >= CGY || fz >= CGZ) { cell[i] = -1; continue; }
        const k = ((fz | 0) * CGY + (fy | 0)) * CGX + (fx | 0);
        cell[i] = k;
        tmp[k]++;
      }
      box3(tmp, pop, 1, CGX);
      box3(pop, tmp, CGX, CGY);
      box3(tmp, pop, CGX * CGY, CGZ);
      let max = 0;
      for (let k = 0; k < CG_N; k++) if (pop[k] > max) max = pop[k];
      this.popMax = max;
    }

    // env: { instances, predX..predVZ, predScale } (see script.js)
    step(dt, env) {
      if (this.n === 0) return;
      this.buildGrid();
      this.findNeighbours();
      this.regionalPopulation();
      this.integrate(dt, env);
      this.frame++;
    }

    integrate(dt, env) {
      const n = this.n, t = this.t, r = this.roost, c = this.cur, nx_ = this.nxt;
      const vx = this.vx, vy = this.vy, vz = this.vz, wx = this.wx, wy = this.wy, wz = this.wz;
      const nb = this.nb, nc = this.nc, excAmp = this.excAmp;
      const refr = this.refr, rising = this.rising, ex = this.ex, ey = this.ey, ez = this.ez;
      const roll = this.roll, phase = this.phase, amp = this.amp, rate = this.rate;
      const inst = env.instances;

      const cruise = t.cruise, vmin = t.vmin, vmaxBase = t.vmax;
      const wAliV = t.wAli * cruise, cohK = t.wCoh / K, wSep = t.wSep, escAcc = t.esc, hopGain = t.hopGain;
      // Ornstein-Uhlenbeck wander: relaxes over 0.7 s, stationary std = t.noise
      const ouKeep = Math.exp(-dt / 0.7), ouKick = t.noise * Math.sqrt((1 - ouKeep * ouKeep) * 3);
      const decay = Math.exp(-dt / EXC_TAU);
      const rollK = 1 - Math.exp(-dt / 0.09), ampK = 1 - Math.exp(-dt / 0.25);
      const irx = 1 / r.rx, iry = 1 / r.ry, irz = 1 / r.rz;
      const gcx = this.cx, gcy = this.cy, gcz = this.cz;
      const popCell = this.popCell, popN = this.pop, popMin = Math.max(20, this.popMax * 0.15), homeAcc = t.home;

      const fX = env.predX, fY = env.predY, fZ = env.predZ;
      const fsp = Math.hypot(env.predVX, env.predVY, env.predVZ) + 1e-6;
      const fhx = env.predVX / fsp, fhy = env.predVY / fsp, fhz = env.predVZ / fsp;
      const predR = t.predR * env.predScale, predR2 = predR * predR, iPredR = 1 / predR;
      const trigR2 = predR2 * 0.3, flee = t.flee * env.predScale;
      const tubeR = predR * 0.75, lookAhead = 34 + fsp * 0.6, dodge = 34 * env.predScale;

      let s = this.seed;
      let sumX = 0, sumY = 0, sumZ = 0, sumR2 = 0, sumE = 0, sumLat = 0;
      let sumHX = 0, sumHY = 0, sumHZ = 0, sumSp = 0;

      for (let i = 0, o = 0; i < n; i++, o += S) {
        const x = c[o], y = c[o + 1], z = c[o + 2];
        const hxi = c[o + 4], hyi = c[o + 5], hzi = c[o + 6];
        const cnt = nc[i], base = i * K;
        let cX = 0, cY = 0, cZ = 0, aX = 0, aY = 0, aZ = 0, sX = 0, sY = 0, sZ = 0, eMax = 0, eFrom = -1;
        for (let q = 0; q < cnt; q++) {
          const j = nb[base + q], b = j * S;
          const dx = c[b] - x, dy = c[b + 1] - y, dz = c[b + 2] - z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-4;
          const inv = 1 / d;
          const ux = dx * inv, uy = dy * inv, uz = dz * inv;
          cX += ux; cY += uy; cZ += uz;
          aX += c[b + 4]; aY += c[b + 5]; aZ += c[b + 6];
          if (d < SEP_R) {
            const k = 1 - d * INV_SEP_R, w = k * k;
            sX -= ux * w; sY -= uy * w; sZ -= uz * w;
          }
          const e = c[b + 3];
          if (e > eMax) { eMax = e; eFrom = j; }
        }

        // Cohesion along the mean unit vector to the K neighbours: ~0 deep inside
        // the flock, up to 1 at its edge, so the border is pulled in hard (sharp
        // edges). The topological rule has no range, so neighbours beyond the
        // search radius are taken to lie toward the flock's centre: small groups
        // that break away are drawn home instead of balling up on their own.
        const gdx = gcx - x, gdy = gcy - y, gdz = gcz - z;
        const gd = Math.sqrt(gdx * gdx + gdy * gdy + gdz * gdz) + 1e-3;
        // Vertical cohesion is weaker: like real flocks, the mass stays a thin,
        // wide sheet rather than rounding into a ball.
        const miss = (K - cnt) / gd;
        let fx = (cX + gdx * miss) * cohK, fy = (cY + gdy * miss) * cohK * 0.6, fz = (cZ + gdz * miss) * cohK;
        if (cnt > 0) {
          const ic = 1 / cnt;
          fx += (aX * ic - hxi) * wAliV; fy += (aY * ic - hyi) * wAliV; fz += (aZ * ic - hzi) * wAliV;
          fx += sX * wSep; fy += sY * wSep; fz += sZ * wSep;
        }
        // A bird that sees few others around it (a torn-off group or a lone
        // straggler) flies back toward the main mass instead of drifting.
        const pc = popCell[i], pop = pc >= 0 ? popN[pc] : 0;
        if (pop < popMin) {
          const gmag = homeAcc * (1 - pop / popMin) / gd;
          fx += gdx * gmag; fy += gdy * gmag; fz += gdz * gmag;
        }

        // Soft ellipsoidal roost boundary: beyond ~80 % of the radius the bird turns
        // back along the ellipsoid normal, mostly sideways so it banks rather than brakes.
        const qx = (x - r.x) * irx, qy = (y - r.y) * iry, qz = (z - r.z) * irz;
        const rr = Math.sqrt(qx * qx + qy * qy + qz * qz);
        if (rr > 0.8) {
          let bt = Math.min((rr - 0.8) * 2.2, 1); bt = bt * bt * (3 - 2 * bt);
          let nx = -qx * irx, ny = -qy * iry, nz = -qz * irz;
          const nl = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) + 1e-9);
          nx *= nl; ny *= nl; nz *= nl;
          const nd = (nx * hxi + ny * hyi + nz * hzi) * 0.7;
          const bw = bt * (10 + 8 * Math.max(0, rr - 1.2));
          fx += (nx - nd * hxi) * bw; fy += (ny - nd * hyi) * bw; fz += (nz - nd * hzi) * bw;
        }
        // stay clear of the reeds; mild preference for level flight
        if (y < 11) fy += (11 - y) * 2.0;
        fy -= vy[i] * 0.3;

        // Predator: radial flight (flash expansion) plus a sideways dodge out of
        // the falcon's flight path, which carves the tunnel it leaves behind.
        const rx = x - fX, ry = y - fY, rz = z - fZ;
        const pd2 = rx * rx + ry * ry + rz * rz;
        let triggered = false;
        if (pd2 < predR2 * 2.4) {
          const pd = Math.sqrt(pd2) + 1e-3;
          if (pd < predR) {
            const k = 1 - pd * iPredR, a = flee * k * k / pd;
            fx += rx * a; fy += ry * a; fz += rz * a;
          }
          const along = rx * fhx + ry * fhy + rz * fhz;
          if (along > -4 && along < lookAhead) {
            const qx2 = rx - along * fhx, qy2 = ry - along * fhy, qz2 = rz - along * fhz;
            const perp = Math.sqrt(qx2 * qx2 + qy2 * qy2 + qz2 * qz2) + 1e-3;
            if (perp < tubeR) {
              const a = dodge * (1 - perp / tubeR) * (1 - Math.max(0, along) / lookAhead) / perp;
              fx += qx2 * a; fy += qy2 * a; fz += qz2 * a;
            }
          }
          if (pd2 < trigR2 && refr[i] <= 0) {
            triggered = true;
            const il = 1 / pd;
            ex[i] = rx * il; ey[i] = ry * il * 0.5; ez[i] = rz * il;
          }
        }

        // Escape-wave dynamics (double-buffered, so a front moves one hop per update).
        let e = c[o + 3];
        if (rising[i]) {
          e += RISE * dt;
          if (e >= excAmp[i]) { e = excAmp[i]; rising[i] = 0; }
        } else e *= decay;
        let rf = refr[i];
        if (rf > 0) rf -= dt;
        else if (triggered) { rising[i] = 1; excAmp[i] = 1; rf = REFRACT; }
        else if (eMax > THRESH) {
          rising[i] = 1; excAmp[i] = excAmp[eFrom] * hopGain; rf = REFRACT;
          ex[i] = ex[eFrom]; ey[i] = ey[eFrom]; ez[i] = ez[eFrom];     // copy the manoeuvre
        }
        refr[i] = rf;
        if (e > 0.02) {
          // escape: a hard sideways turn toward the copied direction, plus a burst of speed
          const ed = ex[i] * hxi + ey[i] * hyi + ez[i] * hzi;
          const k = e * escAcc, kf = e * 3;
          fx += (ex[i] - ed * hxi) * k + hxi * kf;
          fy += (ey[i] - ed * hyi) * k + hyi * kf;
          fz += (ez[i] - ed * hzi) * k + hzi * kf;
        }

        // wander
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        const w0 = wx[i] * ouKeep + ((s >>> 0) / 2147483648 - 1) * ouKick;
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        const w1 = wy[i] * ouKeep + ((s >>> 0) / 2147483648 - 1) * ouKick * 0.6;
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        const w2 = wz[i] * ouKeep + ((s >>> 0) / 2147483648 - 1) * ouKick;
        wx[i] = w0; wy[i] = w1; wz[i] = w2;
        fx += w0; fy += w1; fz += w2;

        // cruise-speed regulation
        let vxi = vx[i], vyi = vy[i], vzi = vz[i];
        const sp0 = Math.sqrt(vxi * vxi + vyi * vyi + vzi * vzi) + 1e-6;
        const sr = (cruise * (1 + 0.35 * e) - sp0) * 1.4;
        fx += hxi * sr; fy += hyi * sr; fz += hzi * sr;

        // integrate (semi-implicit Euler) and clamp speed
        vxi += fx * dt; vyi += fy * dt; vzi += fz * dt;
        let sp = Math.sqrt(vxi * vxi + vyi * vyi + vzi * vzi) + 1e-6;
        const vmax = vmaxBase * (1 + 0.4 * e);
        if (sp > vmax) { const k = vmax / sp; vxi *= k; vyi *= k; vzi *= k; sp = vmax; }
        else if (sp < vmin) { const k = vmin / sp; vxi *= k; vyi *= k; vzi *= k; sp = vmin; }
        vx[i] = vxi; vy[i] = vyi; vz[i] = vzi;
        const isp = 1 / sp;
        const nx = x + vxi * dt, ny = y + vyi * dt, nz = z + vzi * dt;
        const nhx = vxi * isp, nhy = vyi * isp, nhz = vzi * isp;
        nx_[o] = nx; nx_[o + 1] = ny; nx_[o + 2] = nz; nx_[o + 3] = e;
        nx_[o + 4] = nhx; nx_[o + 5] = nhy; nx_[o + 6] = nhz;

        // Bank into the turn: roll ≈ atan(lateral accel / g), linearised, plus the
        // escape roll that makes agitation waves visible.
        const rl = 1 / (Math.sqrt(nhx * nhx + nhz * nhz) + 1e-6);
        const rgx = -nhz * rl, rgz = nhx * rl;
        const lat = fx * rgx + fz * rgz;
        let side = 0;
        if (e > 0.02) side = (ex[i] * rgx + ez[i] * rgz) >= 0 ? e : -e;
        let rt = lat / G * 0.8 + side * 1.15;
        rt = rt > 1.35 ? 1.35 : rt < -1.35 ? -1.35 : rt;
        const ro = roll[i] + (rt - roll[i]) * rollK;
        roll[i] = ro;

        // wingbeat: effort from forward acceleration, climb and alarm
        let effort = 0.45 + (fx * nhx + fy * nhy + fz * nhz) * 0.05 + vyi * 0.045 + e * 0.9;
        effort = effort < 0 ? 0 : effort > 1 ? 1 : effort;
        const am = amp[i] + (0.12 + 0.78 * effort - amp[i]) * ampK;
        amp[i] = am;
        let ph = phase[i] + dt * TWO_PI * rate[i] * (0.8 + 0.6 * effort);
        if (ph > TWO_PI) ph -= TWO_PI;
        phase[i] = ph;

        // instance record: position + roll, heading scaled by (1 + amp), phase
        const io = i * 8, hs = 1 + am;
        inst[io] = nx; inst[io + 1] = ny; inst[io + 2] = nz; inst[io + 3] = ro;
        inst[io + 4] = nhx * hs; inst[io + 5] = nhy * hs; inst[io + 6] = nhz * hs; inst[io + 7] = ph;

        sumX += nx; sumY += ny; sumZ += nz;
        sumR2 += (nx - gcx) * (nx - gcx) + (ny - gcy) * (ny - gcy) + (nz - gcz) * (nz - gcz);
        sumE += e;
        sumLat += lat < 0 ? -lat : lat;
        sumHX += nhx; sumHY += nhy; sumHZ += nhz; sumSp += sp;
      }
      this.seed = s;
      this.cur = nx_; this.nxt = c;

      const inN = 1 / n;
      this.cx = sumX * inN; this.cy = sumY * inN; this.cz = sumZ * inN;
      this.radius = Math.sqrt(sumR2 * inN);
      this.agitation = sumE * inN;
      this.turning = sumLat * inN;
      this.polar = Math.sqrt(sumHX * sumHX + sumHY * sumHY + sumHZ * sumHZ) * inN;
      this.speed = sumSp * inN;
    }

    // A stoop strike: everything within `radius` is flung outward (flash
    // expansion) and starts a full-strength escape wave.
    burst(x, y, z, radius, strength) {
      const n = this.n, r2 = radius * radius, c = this.cur;
      for (let i = 0, o = 0; i < n; i++, o += S) {
        const dx = c[o] - x, dy = c[o + 1] - y, dz = c[o + 2] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const d = Math.sqrt(d2) + 1e-3, k = 1 - d / radius;
        const dv = strength * k * k / d;
        this.vx[i] += dx * dv; this.vy[i] += dy * dv * 0.6; this.vz[i] += dz * dv;
        this.ex[i] = dx / d; this.ey[i] = dy / d * 0.5; this.ez[i] = dz / d;
        this.excAmp[i] = 1; this.rising[i] = 1; this.refr[i] = REFRACT;
      }
    }

    // position of bird i (falcon targeting)
    bird(i, out) {
      const o = i * S, c = this.cur;
      out[0] = c[o]; out[1] = c[o + 1]; out[2] = c[o + 2];
      return out;
    }

    randomBird() { return (this.rand() * this.n) | 0; }
  }

  // ---------------------------------------------------------------------
  // The falcon: a steering agent with capped acceleration, so it chases the
  // way a bird must, overshooting and banking round rather than snapping.
  const PATROL = 0, ATTACK = 1, EXIT = 2, STEER = 3, STOOP = 4, RECOVER = 5, LOITER = 6;

  class Falcon {
    constructor() {
      this.x = -48; this.y = 52; this.z = 150;
      this.vx = 15; this.vy = -1; this.vz = 2;
      this.hx = 1; this.hy = 0; this.hz = 0;
      this.roll = 0; this.phase = 0; this.amp = 0.6; this.tuck = 0;
      this.mode = PATROL; this.modeT = 0;
      this.nextAttack = 0.5;     // first pass soon after load so the flock reacts at once
      this.orbit = Math.PI;
      this.prey = 0;
      this.stoopPrey = -1;
      this.tx = 0; this.ty = 0; this.tz = 0;
      this.sx = 0; this.sy = 0; this.sz = 0;  // stoop aim
      this.threat = 1;           // scales the flock's predator radius
      this.tmp = new Float32Array(3);
    }

    setMode(m) { this.mode = m; this.modeT = 0; }

    // Dive at a point, or at bird `prey` (tracked as it flees) when prey >= 0.
    stoop(tx, ty, tz, prey) {
      this.sx = tx; this.sy = ty; this.sz = tz;
      this.stoopPrey = prey;
      this.setMode(STOOP);
    }

    // input: { steering, tx, ty, tz, autopilot, mood }
    update(dt, flock, input) {
      this.modeT += dt;
      const m = this.mode;
      if (input.steering && (m === PATROL || m === ATTACK || m === EXIT || m === LOITER)) this.setMode(STEER);
      if (!input.steering && m === STEER) this.setMode(input.autopilot ? PATROL : LOITER);
      if (!input.autopilot && (m === PATROL || m === ATTACK || m === EXIT)) this.setMode(LOITER);
      if (input.autopilot && m === LOITER) this.setMode(PATROL);

      let speed = 16, acc = 20, tuckT = 0, flap = 0.55;
      const fr = flock.radius;
      switch (this.mode) {
        case PATROL: {
          // circle just outside the flock, then make a pass through it
          this.orbit += dt * 0.24;
          const R = fr * 1.4 + 26;
          this.tx = flock.cx + Math.cos(this.orbit) * R;
          this.ty = flock.cy + 10 + 6 * Math.sin(this.orbit * 2.3);
          this.tz = flock.cz + Math.sin(this.orbit) * R * 0.7;
          flap = Math.sin(this.modeT * 1.3) > 0.2 ? 0.65 : 0.35;
          this.nextAttack -= dt;
          if (this.nextAttack <= 0 && flock.n > 0) { this.prey = flock.randomBird(); this.setMode(ATTACK); }
          break;
        }
        case ATTACK: {
          const p = flock.bird(this.prey < flock.n ? this.prey : 0, this.tmp);
          this.tx = p[0]; this.ty = p[1]; this.tz = p[2];
          speed = 34; acc = 46; flap = 0.9;
          const dx = this.tx - this.x, dy = this.ty - this.y, dz = this.tz - this.z;
          if (Math.hypot(dx, dy, dz) < 3 || this.modeT > 5 || (this.modeT > 0.6 && dx * this.vx + dy * this.vy + dz * this.vz < 0)) this.setMode(EXIT);
          break;
        }
        case EXIT: {
          this.tx = this.x + this.hx * 40; this.ty = this.y + this.hy * 40 + 8; this.tz = this.z + this.hz * 40;
          speed = 26; acc = 18; flap = 0.6;
          if (this.modeT > 1.6) {
            this.nextAttack = (6.5 - 3.5 * input.mood) * (0.7 + Math.random() * 0.6);
            this.orbit = Math.atan2((this.z - flock.cz) / 0.7, this.x - flock.cx);
            this.setMode(PATROL);
          }
          break;
        }
        case STEER: {
          this.tx = input.tx; this.ty = input.ty; this.tz = input.tz;
          const d = Math.hypot(this.tx - this.x, this.ty - this.y, this.tz - this.z);
          speed = Math.min(32, Math.max(14, d * 1.1)); acc = 34; flap = 0.75;
          break;
        }
        case STOOP: {
          if (this.stoopPrey >= 0 && this.stoopPrey < flock.n) {
            const p = flock.bird(this.stoopPrey, this.tmp);
            this.sx = p[0]; this.sy = p[1]; this.sz = p[2];
          }
          this.tx = this.sx; this.ty = this.sy; this.tz = this.sz;
          speed = 62; acc = 120; tuckT = 1; flap = 0.05;
          const dx = this.tx - this.x, dy = this.ty - this.y, dz = this.tz - this.z;
          if (Math.hypot(dx, dy, dz) < 6 || this.modeT > 2.4 || (this.modeT > 0.25 && dx * this.vx + dy * this.vy + dz * this.vz < 0)) {
            flock.burst(this.x, this.y, this.z, 17, 15);
            this.setMode(RECOVER);
          }
          break;
        }
        case RECOVER: {
          this.tx = this.x + this.hx * 40; this.ty = this.y + 26; this.tz = this.z + this.hz * 40;
          speed = 22; acc = 26; flap = 0.85;
          if (this.modeT > 1.4) {
            this.nextAttack = 5;
            this.setMode(input.steering ? STEER : input.autopilot ? PATROL : LOITER);
          }
          break;
        }
        default: { // LOITER: lazy circles well away from the flock
          this.orbit += dt * 0.16;
          const R = fr * 1.8 + 60;
          this.tx = flock.cx + Math.cos(this.orbit) * R;
          this.ty = flock.cy + 22;
          this.tz = flock.cz + Math.sin(this.orbit) * R * 0.6;
          speed = 14; acc = 12; flap = 0.3;
        }
      }
      this.threat = this.mode === STOOP ? 1.7 : this.mode === ATTACK ? 1.15 : 1;

      // velocity steering with an acceleration cap
      const dx = this.tx - this.x, dy = this.ty - this.y, dz = this.tz - this.z;
      const d = Math.hypot(dx, dy, dz) + 1e-6;
      let stx = dx / d * speed - this.vx, sty = dy / d * speed - this.vy, stz = dz / d * speed - this.vz;
      const k = Math.min(3 * dt, acc * dt / (Math.hypot(stx, sty, stz) + 1e-6));   // relax ~0.33 s, capped at acc
      stx *= k; sty *= k; stz *= k;
      this.vx += stx; this.vy += sty; this.vz += stz;
      let sp = Math.hypot(this.vx, this.vy, this.vz);
      if (sp < 9 || sp > 70) { const c = (sp < 9 ? 9 : 70) / sp; this.vx *= c; this.vy *= c; this.vz *= c; sp = sp < 9 ? 9 : 70; }
      this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
      if (this.y < 7) { this.y = 7; if (this.vy < 0) this.vy *= -0.3; }
      this.hx = this.vx / sp; this.hy = this.vy / sp; this.hz = this.vz / sp;

      const rl = 1 / (Math.hypot(this.hx, this.hz) + 1e-6);
      const lat = (stx * -this.hz * rl + stz * this.hx * rl) / Math.max(dt, 1e-3);
      const rt = Math.max(-1.3, Math.min(1.3, lat / G * 0.7));
      this.roll += (rt - this.roll) * (1 - Math.exp(-dt / 0.15));
      this.tuck += (tuckT - this.tuck) * (1 - Math.exp(-dt / 0.12));
      this.amp += (flap - this.amp) * (1 - Math.exp(-dt / 0.2));
      this.phase = (this.phase + dt * TWO_PI * (3.6 + 2.2 * this.amp)) % TWO_PI;
    }

    writeInstance(out) {
      const hs = 1 + this.amp;
      out[0] = this.x; out[1] = this.y; out[2] = this.z; out[3] = this.roll;
      out[4] = this.hx * hs; out[5] = this.hy * hs; out[6] = this.hz * hs; out[7] = this.phase;
    }
  }
  root.Murmur = root.Murmur || {};
  root.Murmur.Flock = Flock;
  root.Murmur.Falcon = Falcon;
})(globalThis);
