/* =====================================================================
   Murmuration: WebGL2 renderer (classic script)

   Passes per frame
     1. reflection  mirrored birds, falcon and reeds -> R8 coverage (low res)
     2. sky         HDR dusk sky, clouds, far silhouettes and the marsh
                    water (which samples pass 1 through its ripples)
     3. layer       birds, falcon and reeds as coverage + glow -> RG8, 4x MSAA
     4. bloom       13-tap downsample / tent upsample chain
     5. final       composite, bloom, filmic tone map, grade, vignette, dither

   Birds never touch the HDR buffer directly: the layer stores how much
   of each pixel is covered by "ink" (R) and how much backlit glow it
   carries (G). Distant birds simply cover less, so they fade into
   whatever lies behind them, which is aerial perspective for free.
   ===================================================================== */
(function (root) {
  'use strict';

  const HEAD = '#version 300 es\nprecision highp float;\n';

  const NOISE = `
float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float h12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1.0, 0.0)), u.x), mix(h12(i + vec2(0.0, 1.0)), h12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float vn1(float x) { float i = floor(x), f = fract(x); return mix(h11(i), h11(i + 1.0), f * f * (3.0 - 2.0 * f)); }
const mat2 OCT = mat2(1.6, 1.2, -1.2, 1.6);
// fractal sums normalised to a mean of about 0.5 whatever the octave count
float fbm(vec2 p, int n) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 7; i++) { if (i >= n) break; s += a * vn(p); p = OCT * p + 7.3; a *= 0.5; }
  return s / (1.0 - 2.0 * a);
}
float fbm1(float x, int n) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { if (i >= n) break; s += a * vn1(x); x = x * 2.07 + 13.1; a *= 0.5; }
  return s / (1.0 - 2.0 * a);
}
`;

  // Full-screen triangle from gl_VertexID (no buffers).
  const VS_FULL = HEAD + `
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  // ---------------------------------------------------------------------
  // Sky, far silhouettes and marsh. The camera only rotates, so everything
  // here is a pure function of view direction: a 2.5D world in one shader.
  const FS_SKY = HEAD + NOISE + `
in vec2 vUv;
out vec4 o;
uniform vec3 uFwd, uRight, uUp, uSun;
uniform float uTime, uCamH, uPix, uStars, uSunI, uMist, uDusk;
uniform sampler2D uRefl;
uniform vec3 uZen, uMid, uHor, uSunC, uGlow, uCloudL, uCloudD, uFar, uTree, uWater, uMistC, uInk;

const float TREE_D = 900.0;

vec3 sky(vec3 d) {
  float e = max(d.y, 0.0);
  float cs = dot(d, uSun);
  vec2 dh = normalize(d.xz + vec2(0.0, 1e-5));
  float toward = dot(dh, normalize(uSun.xz)) * 0.5 + 0.5;    // 1 under the sun, 0 opposite
  vec3 c = mix(uHor, uMid, 1.0 - exp(-e * 8.0));
  c = mix(c, uZen, smoothstep(0.06, 0.75, e));
  // the glowing band along the horizon: hot and tall beneath the sun, thin elsewhere
  float tw = toward * toward;
  c += uGlow * exp(-e * mix(26.0, 10.0, tw)) * (0.1 + 0.9 * tw * tw);
  // forward (Mie) scattering around the sun, from a broad aureole to a tight halo
  float g = max(cs, 0.0);
  c += uSunC * (0.07 * pow(g, 6.0) + 0.5 * pow(g, 60.0) + 2.6 * pow(g, 650.0));
  return c;
}

float sunDisc(vec3 d) {
  float a = sqrt(max(2.0 - 2.0 * dot(d, uSun), 0.0));      // angle from the sun's centre (rad)
  const float R = 0.0078;
  return smoothstep(R + uPix, R - uPix, a) * (1.0 - 0.4 * a * a / (R * R));
}

// A streaky deck of altocumulus lit from below by the low sun.
vec4 clouds(vec3 d, int oct) {
  float e = d.y;
  if (e < 0.004) return vec4(0.0);
  vec2 p = d.xz / (e + 0.03) * 0.36 + vec2(uTime * 0.004, uTime * 0.0011);
  vec2 w = vec2(fbm(p * 0.7 + 1.7, 3), fbm(p * 0.7 + 9.2, 3));
  vec2 s = (p + (w - 0.5) * 1.4) * vec2(0.75, 2.3);           // stretched into long streaks
  float n = fbm(s, oct);
  float den = smoothstep(0.55, 0.8, n);
  if (den <= 0.0) return vec4(0.0);
  vec2 sd = normalize(uSun.xz) * vec2(0.75, 2.3) * 0.09;
  float n2 = fbm(s + sd, min(oct, 4));
  float rim = clamp(0.5 + (n - n2) * 5.0, 0.0, 1.0);          // edges that face the sun catch more light
  float cs = max(dot(d, uSun), 0.0);
  vec3 lit = mix(uCloudD * 1.25 + uCloudL * 0.16, uCloudL, pow(cs, 3.0)) * (1.0 + 0.9 * pow(cs, 8.0) + 3.0 * pow(cs, 40.0));
  // once the sun has set, high clouds fall into the earth's shadow and only
  // those low over the western horizon keep the afterglow
  vec2 dh = normalize(d.xz + vec2(0.0, 1e-5));
  float toward = dot(dh, normalize(uSun.xz)) * 0.5 + 0.5;
  lit *= mix(1.0, smoothstep(0.32, 0.02, e) * (0.25 + 0.75 * toward * toward), uDusk);
  float thick = smoothstep(0.6, 0.95, n);
  vec3 col = mix(lit + uCloudD * 0.6 * uDusk, uCloudD, thick * 0.8) + lit * rim * 0.45 * (0.3 + pow(cs, 3.0));
  col = mix(col, uHor * 0.85 + uGlow * 0.3, smoothstep(0.1, 0.0, e) * 0.55);  // haze toward the horizon
  float band = 1.0 - 0.7 * smoothstep(0.24, 0.1, e) * smoothstep(0.02, 0.07, e);
  return vec4(col, den * smoothstep(0.004, 0.05, e) * 0.94 * band);
}

vec3 stars(vec3 d) {
  if (uStars <= 0.0 || d.y < 0.03) return vec3(0.0);
  vec2 sp = vec2(atan(d.x, d.z), asin(d.y)) * 140.0;
  vec2 cell = floor(sp);
  float h = h12(cell);
  if (h < 0.93) return vec3(0.0);
  vec2 c = vec2(h12(cell + 7.1), h12(cell + 3.3)) * 0.7 + 0.15;
  float r = length(sp - cell - c) / 140.0 / max(uPix, 1e-5);
  float b = exp(-r * r * 1.4) * pow((h - 0.93) / 0.07, 2.0) * (0.75 + 0.25 * sin(uTime * 2.3 + h * 300.0));
  return vec3(0.75, 0.82, 1.0) * b * uStars * smoothstep(0.03, 0.2, d.y);
}

vec3 skyAll(vec3 d, int oct) {
  vec3 c = sky(d) + uSunC * (sunDisc(d) * uSunI) + stars(d);
  vec4 cl = clouds(d, oct);
  return mix(c, cl.rgb, cl.a);
}

// ---- far silhouettes --------------------------------------------------
// Reed beds at three distances: patchy, with ragged tufted tops (metres).
float reedHeight(float az, float D, float seed) {
  float x = az * D;                                    // metres along the bank
  float m = smoothstep(0.52, 0.6, fbm1(x * 0.03 + seed, 3));
  if (m <= 0.0) return 0.0;
  float t = vn1(x * 2.3 + seed) * 0.5 + vn1(x * 6.1 + seed * 1.7) * 0.3 + vn1(x * 15.0 + seed) * 0.2;
  return sqrt(m) * (0.9 + 1.5 * t * t);
}

// Rounded winter crowns: overlapping domes along a line.
float crowns(float x, float seed) {
  float i = floor(x), top = 0.0;
  for (int k = -1; k <= 1; k++) {
    float j = i + float(k);
    float c = j + 0.5 + (h11(j + seed) - 0.5) * 0.8;
    float r = 0.6 + 0.7 * h11(j * 1.7 + seed + 3.0);
    float q = (x - c) / r;
    top = max(top, (0.4 + 0.6 * h11(j * 3.1 + seed + 7.0)) * sqrt(max(1.0 - q * q, 0.0)));
  }
  return top;
}
float treeTop(float az) {
  float wood = smoothstep(0.36, 0.56, fbm1(az * 3.1 + 2.0, 3));
  float x = az * 105.0;
  return 0.0017 + wood * (0.0105 * crowns(x, 1.0) + 0.006 * crowns(x * 2.4, 5.0) + 0.002 * vn1(x * 9.0));
}
float hillTop(float az) { return 0.0035 + 0.0105 * fbm1(az * 2.3 + 5.0, 4); }

// Front-to-back "over" of everything that stands on the horizon, for a primary
// ray (refl = 0) or a ray reflected off the water at distance tw (refl = 1).
// Heights are measured from the eye, or from the mirrored eye (h + camH).
vec4 horizon(float az, float e, float tw, float refl) {
  vec4 acc = vec4(0.0);
  float aa = uPix * 1.1 + refl * 0.0025;
  float hs = refl > 0.5 ? 1.0 : -1.0;
  float toward = pow(max(dot(normalize(vec2(sin(az), cos(az))), normalize(uSun.xz)), 0.0), 8.0);
  for (int k = 0; k < 3; k++) {
    float D = k == 0 ? 140.0 : k == 1 ? 310.0 : 560.0;
    if (refl > 0.5 ? D < tw : e < -uCamH / D) continue;
    float h = reedHeight(az, D, float(k) * 13.7 + 2.0);
    if (h <= 0.0) continue;
    float top = (h + hs * uCamH) / D;
    float a = smoothstep(top + aa, top - aa, e);
    if (a <= 0.0) continue;
    float haze = 1.0 - exp(-D / 700.0);
    vec3 c = mix(uInk * 2.0, uFar * 0.85, haze);
    c += uGlow * 0.35 * toward * smoothstep(top - 0.7 / D, top, e) * (1.0 - refl * 0.6);  // backlit plumes
    acc += (1.0 - acc.a) * a * vec4(c, 1.0);
  }
  if (refl < 0.5 && e < -uCamH / TREE_D) return acc;   // the ray meets open water first
  if (acc.a < 0.999) {
    float top = treeTop(az) + hs * uCamH / TREE_D + uCamH / TREE_D;
    float lace = (vn(vec2(az * 900.0, e * 1200.0)) - 0.5) * 0.004 * smoothstep(0.003, 0.01, top);
    float a = smoothstep(top + aa, top - aa, e + lace);
    vec3 c = mix(uTree, uFar, 0.22) + uGlow * 0.06 * toward;
    acc += (1.0 - acc.a) * a * vec4(c, 1.0);
  }
  if (acc.a < 0.999) {
    float top = hillTop(az);
    float a = smoothstep(top + aa, top - aa, e);
    acc += (1.0 - acc.a) * a * vec4(mix(uFar, uHor, 0.3), 1.0);
  }
  return acc;
}

vec3 water(vec3 d) {
  float t = uCamH / max(-d.y, 1e-4);
  vec2 wp = d.xz * t;
  // metres of water under one pixel, across and along the view; ripples finer
  // than that are averaged away so the far water settles into a clean mirror
  float fz = t * t * uPix / uCamH, fx = t * uPix;
  vec2 rp = wp * vec2(0.5, 1.4) + vec2(uTime * 0.16, uTime * 0.05);
  float n0 = fbm(rp, 3), n1 = fbm(rp + vec2(0.09, 0.0), 3), n2 = fbm(rp + vec2(0.0, 0.09), 3);
  float fine = exp(-fz * 2.6 - fx * 1.2);
  // long, slow swells survive further out and make the reflections sway
  vec2 sp = wp * vec2(0.08, 0.22) + vec2(uTime * 0.05, 0.0);
  float s0 = vn(sp), s1 = vn(sp + vec2(0.15, 0.0)), s2 = vn(sp + vec2(0.0, 0.15));
  float swell = exp(-fz * 0.35);
  vec2 slope = vec2(n0 - n1, n0 - n2) * 0.42 * fine + vec2(s0 - s1, s0 - s2) * 0.07 * swell;
  vec3 n = normalize(vec3(slope.x, 1.0, slope.y));
  vec3 r = reflect(d, n);
  r.y = max(r.y, 0.0004);
  float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(-d, n), 0.0, 1.0), 5.0);
  vec3 sc = skyAll(r, 3);
  vec4 hz = horizon(atan(r.x, r.z), r.y, t, 1.0);
  sc = sc * (1.0 - hz.a) + hz.rgb;
  // mirrored flock and reeds, wobbling with the ripples
  vec2 ru = vUv + slope * vec2(0.03, 0.012);
  vec2 rt = 1.0 / vec2(textureSize(uRefl, 0));
  float cov = 0.4 * texture(uRefl, ru).r + 0.15 * (texture(uRefl, ru + rt * vec2(1.5, 0.5)).r + texture(uRefl, ru - rt * vec2(1.5, 0.5)).r
            + texture(uRefl, ru + rt * vec2(-0.5, 1.5)).r + texture(uRefl, ru - rt * vec2(-0.5, 1.5)).r);
  sc = mix(sc, uInk, cov);
  vec3 col = mix(uWater, sc, fres);
  // floating mats of dead reed and mud
  float mat = smoothstep(0.64, 0.7, fbm(wp * vec2(0.06, 0.11) + 3.0, 4));
  col = mix(col, uInk * 1.6 + uGlow * 0.012, mat * 0.8 * smoothstep(12.0, 25.0, t) * (1.0 - smoothstep(40.0, 160.0, t)));
  return col;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 d = normalize(uFwd + ndc.x * uRight + ndc.y * uUp);
  float az = atan(d.x, d.z);
  float e = d.y;
  vec4 hz = (e > -0.05 && e < 0.04) ? horizon(az, e, 0.0, 0.0) : vec4(0.0);
  vec3 col = hz.rgb;
  if (hz.a < 0.999) {
    vec3 behind = e < -uCamH / TREE_D ? water(d) : skyAll(d, 6);
    col += behind * (1.0 - hz.a);
  }
  // low mist lying over the marsh, thickest on the far water
  float m = uMist * exp(-abs(e) * 65.0) * (0.6 + 0.4 * fbm(vec2(az * 7.0 - uTime * 0.012, uTime * 0.006), 3));
  col = mix(col, uMistC, clamp(m, 0.0, 1.0));
  o = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------------
  // Birds (and the falcon): instanced silhouettes. Tiny birds are grown to a
  // minimum on-screen span and their coverage reduced by the area ratio, so
  // sub-pixel birds neither vanish nor shimmer.
  const VS_BIRD = HEAD + `
layout(location = 0) in vec4 aV;     // local vertex (m): x right, y up, z forward; w = wing flex
layout(location = 1) in vec4 iP;     // position, roll
layout(location = 2) in vec4 iH;     // heading * (1 + flap amplitude), wingbeat phase
uniform mat4 uVP;
uniform vec3 uCam, uSun;
uniform float uScale, uSpan, uFocal, uMinPx, uMirror, uFog, uLead, uSweep, uGlow;
out float vA;
out float vG;
void main() {
  float hs = length(iH.xyz);
  vec3 h = iH.xyz / hs;
  float amp = hs - 1.0;
  vec3 pos = iP.xyz + h * uLead;
  vec3 r = vec3(h.z, 0.0, -h.x);                       // cross(up, heading)
  float rl = length(r);
  r = rl > 1e-4 ? r / rl : vec3(1.0, 0.0, 0.0);
  vec3 u = cross(h, r);
  float cr = cos(iP.w), sr = sin(iP.w);
  vec3 rr = r * cr + u * sr, uu = u * cr - r * sr;       // bank about the heading
  vec3 l = aV.xyz;
  if (aV.w > 0.0) {
    l.z -= abs(l.x) * 0.9 * uSweep;                      // stoop: wings swept back and folded
    l.x *= 1.0 - 0.55 * uSweep;
    float a = amp * (0.95 * sin(iH.w) + 0.18) * aV.w;    // wingbeat (flex bends the tip further)
    l.y += abs(l.x) * sin(a);
    l.x *= cos(a);
  }
  vec4 c = uVP * vec4(pos, 1.0);
  float span = uScale * uSpan * uFocal / max(c.w, 0.5);  // wingspan in target pixels
  float k = max(1.0, uMinPx / span);
  vec3 wp = pos + (rr * l.x + uu * l.y + h * l.z) * (uScale * k);
  vec3 v = pos - uCam;
  float dist = length(v);
  vA = exp(-dist * uFog) / (k * k);
  vG = uGlow * pow(max(dot(v / dist, uSun), 0.0), 14.0);
  if (uMirror > 0.5) wp.y = -wp.y;
  gl_Position = uVP * vec4(wp, 1.0);
}`;

  const FS_COVER = HEAD + `
in float vA;
in float vG;
out vec4 o;
void main() { o = vec4(vA, vG * vA, 0.0, vA); }`;

  // ---------------------------------------------------------------------
  // Foreground reeds: billboarded stalks with drooping Phragmites plumes and
  // a hanging leaf, swaying in a gusty wind.
  const VS_REED = HEAD + NOISE + `
layout(location = 0) in vec3 aR;     // part (0 stalk, 1 plume, 2 leaf), u along, v across
layout(location = 1) in vec4 iA;     // x, z, height, phase
layout(location = 2) in vec4 iB;     // lean, plume length, leaf seed, stalk width
uniform mat4 uVP;
uniform vec3 uCam, uCamRight, uCamFwd, uSun;
uniform float uTime, uWind, uMirror, uFocal, uMinPx, uGlow;
out float vA;
out float vG;
out float vV;
flat out int vPart;
const vec3 WIND = vec3(0.96, 0.0, 0.28);
vec3 stalk(float t, float bend, float H) { return vec3(iA.x, t * H, iA.y) + WIND * (bend * H * t * t); }
void main() {
  float H = iA.z;
  float gust = fbm(vec2(uTime * 0.35 + iA.x * 0.07, iA.y * 0.05), 3);
  float sway = uWind * (0.35 + 0.9 * gust) + uWind * 0.08 * sin(uTime * 2.6 + iA.w);
  float bend = iB.x + 0.16 * sway;
  int part = int(aR.x + 0.5);
  float u = aR.y, v = aR.z;
  vec3 side = uCamRight;
  vec3 p;
  float w;
  float a = 1.0;
  float g = 0.04;
  if (part == 0) {
    p = stalk(u, bend, H);
    w = iB.w * (1.0 - 0.6 * u);
    vec3 tng = normalize(vec3(0.0, H, 0.0) + WIND * (2.0 * bend * H * u));
    side = normalize(cross(tng, uCamFwd));
  } else if (part == 1) {
    vec3 top = stalk(1.0, bend, H);
    float L = iB.y;
    vec3 ax = normalize(WIND * (0.55 + 0.6 * bend + 0.25 * sway) + vec3(0.0, 0.8, 0.0));
    p = top + ax * (u * L) - vec3(0.0, u * u * L * 0.55, 0.0);
    w = L * 0.26 * pow(sin(3.14159 * min(u * 1.08, 1.0)), 0.7) + 0.004;
    a = 0.9;
    g = 0.55;
  } else {
    float t0 = 0.28 + 0.34 * fract(iB.z * 7.13);
    vec3 root = stalk(t0, bend, H);
    float dir = fract(iB.z * 3.7) < 0.5 ? -1.0 : 1.0;
    float L = H * (0.2 + 0.1 * fract(iB.z * 5.3));
    p = root + uCamRight * (dir * u * L * 0.6) + vec3(0.0, (u * 0.35 - u * u * 1.1) * L, 0.0)
        + WIND * (u * u * L * 0.5 * (0.6 + sway));
    w = 0.028 * sin(3.14159 * min(u * 1.05 + 0.15, 1.0));
    side = vec3(0.0, 1.0, 0.0);
    g = 0.05;
  }
  float depth = max(dot(p - uCam, uCamFwd), 0.5);
  float px = w * uFocal / depth;
  float k = max(1.0, uMinPx / max(px, 1e-4));
  p += side * (v * w * 0.5 * k);
  vA = a / k;
  vec3 vd = normalize(p - uCam);
  vG = uGlow * g * pow(max(dot(vd, uSun), 0.0), 7.0);
  vV = v;
  vPart = part;
  if (uMirror > 0.5) p.y = -p.y;
  gl_Position = uVP * vec4(p, 1.0);
}`;

  const FS_REED = HEAD + `
in float vA;
in float vG;
in float vV;
flat in int vPart;
out vec4 o;
void main() {
  float a = vA;
  if (vPart == 1) a *= smoothstep(1.0, 0.25, abs(vV));   // feathery plume edges
  o = vec4(a, vG * a, 0.0, a);
}`;

  // ---------------------------------------------------------------------
  // Composite + bloom + final grade.
  // Birds are far fewer than in a real murmuration and each is a crisp mark,
  // so dense regions would read as stipple. A blurred copy of the coverage
  // (a mip of the layer) fills in only where birds are already crowded,
  // the way motion-blurred wings and countless sub-pixel birds merge into
  // smoke, while sparse edges and single birds stay sharp.
  const COMPOSITE = `
uniform sampler2D uBg, uLayer;
uniform vec3 uInk, uGlowC;
uniform float uHaze, uHazeLod;
vec3 sceneAt(vec2 uv) {
  vec3 b = texture(uBg, uv).rgb;
  vec2 l = texture(uLayer, uv).rg;
  float lb = textureLod(uLayer, uv, uHazeLod).r;
  float a = 1.0 - (1.0 - l.r) * (1.0 - uHaze * smoothstep(0.05, 0.4, lb) * min(1.0, lb * 1.8));
  return b * (1.0 - a) + uInk * a + uGlowC * l.g;
}`;

  const FS_PREFILTER = HEAD + COMPOSITE + `
in vec2 vUv;
out vec4 o;
uniform vec2 uTexel;
uniform float uThresh, uKnee;
void main() {
  vec2 t = uTexel;
  vec3 a = sceneAt(vUv + t * vec2(-2.0, -2.0)), b = sceneAt(vUv + t * vec2(0.0, -2.0)), c = sceneAt(vUv + t * vec2(2.0, -2.0));
  vec3 d = sceneAt(vUv + t * vec2(-1.0, -1.0)), e = sceneAt(vUv + t * vec2(1.0, -1.0));
  vec3 f = sceneAt(vUv + t * vec2(-2.0, 0.0)), g = sceneAt(vUv), h = sceneAt(vUv + t * vec2(2.0, 0.0));
  vec3 i = sceneAt(vUv + t * vec2(-1.0, 1.0)), j = sceneAt(vUv + t * vec2(1.0, 1.0));
  vec3 k = sceneAt(vUv + t * vec2(-2.0, 2.0)), l = sceneAt(vUv + t * vec2(0.0, 2.0)), m = sceneAt(vUv + t * vec2(2.0, 2.0));
  vec3 s = (d + e + i + j) * 0.125 + (a + b + f + g + b + c + g + h + f + g + k + l + g + h + l + m) * 0.03125;
  float br = max(s.r, max(s.g, s.b));
  float soft = clamp(br - uThresh + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  o = vec4(s * (max(soft, br - uThresh) / max(br, 1e-4)), 1.0);
}`;

  const FS_DOWN = HEAD + `
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel;
vec3 tap(vec2 off) { return texture(uSrc, vUv + uTexel * off).rgb; }
void main() {
  vec3 a = tap(vec2(-2.0, -2.0)), b = tap(vec2(0.0, -2.0)), c = tap(vec2(2.0, -2.0));
  vec3 d = tap(vec2(-1.0, -1.0)), e = tap(vec2(1.0, -1.0));
  vec3 f = tap(vec2(-2.0, 0.0)), g = tap(vec2(0.0)), h = tap(vec2(2.0, 0.0));
  vec3 i = tap(vec2(-1.0, 1.0)), j = tap(vec2(1.0, 1.0));
  vec3 k = tap(vec2(-2.0, 2.0)), l = tap(vec2(0.0, 2.0)), m = tap(vec2(2.0, 2.0));
  o = vec4((d + e + i + j) * 0.125 + (a + b + f + g + b + c + g + h + f + g + k + l + g + h + l + m) * 0.03125, 1.0);
}`;

  const FS_UP = HEAD + `
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel;
vec3 tap(vec2 off) { return texture(uSrc, vUv + uTexel * off).rgb; }
void main() {
  vec3 s = tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0));
  s += 2.0 * (tap(vec2(0.0, -1.0)) + tap(vec2(-1.0, 0.0)) + tap(vec2(1.0, 0.0)) + tap(vec2(0.0, 1.0)));
  s += 4.0 * tap(vec2(0.0));
  o = vec4(s / 16.0, 1.0);
}`;

  const FS_FINAL = HEAD + COMPOSITE + `
in vec2 vUv;
out vec4 o;
uniform sampler2D uBloom;
uniform float uExposure, uBloomAmt, uFrame, uVignette, uSat;
uniform vec2 uRes;
uniform vec3 uShadow, uHigh;
float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
// Narkowicz's fit of the ACES filmic curve
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec3 c = sceneAt(vUv) + texture(uBloom, vUv).rgb * uBloomAmt;
  c = aces(c * uExposure);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSat);
  c *= mix(uShadow, uHigh, smoothstep(0.0, 0.7, l));      // cool shadows, warm highlights
  vec2 q = vUv - 0.5;
  q.x *= uRes.x / uRes.y;
  c *= 1.0 - uVignette * smoothstep(0.3, 1.15, length(q));
  c = pow(c, vec3(1.0 / 2.2));
  // triangular dither against banding, doubling as a whisper of film grain
  vec2 fc = gl_FragCoord.xy + uFrame * vec2(37.0, 17.0);
  c += (hash(fc) + hash(fc + 71.3) - 1.0) * (1.6 / 255.0);
  o = vec4(c, 1.0);
}`;

  // ---------------------------------------------------------------------
  // Meshes (metres; x right, y up, z forward; w = wing flex)
  function birdMesh(body, tail, wing) {
    const v = [];
    const p = (x, y, z, w) => v.push(x, y, z, w);
    const [nose, side, back, up, down] = body;
    // crossed horizontal and vertical diamonds keep the body visible edge-on
    p(0, 0, nose, 0); p(-side[0], 0, side[1], 0); p(0, 0, back, 0);
    p(0, 0, nose, 0); p(0, 0, back, 0); p(side[0], 0, side[1], 0);
    p(0, 0, nose, 0); p(0, up, side[1], 0); p(0, 0, back, 0);
    p(0, 0, nose, 0); p(0, 0, back, 0); p(0, -down, side[1], 0);
    // tail: a tapered quad
    const [tr, tw, tl] = tail;   // root half-width, tip half-width, tip z
    p(-tr, 0, back - 0.01, 0); p(tr, 0, back - 0.01, 0); p(tw, 0, tl, 0);
    p(-tr, 0, back - 0.01, 0); p(tw, 0, tl, 0); p(-tw, 0, tl, 0);
    for (const s of [-1, 1]) {
      const q = (pt, flex) => p(pt[0] * s, 0, pt[1], flex);
      q(wing.rle, 0); q(wing.wr, 1); q(wing.mte, 1);
      q(wing.rle, 0); q(wing.mte, 1); q(wing.rte, 0);
      q(wing.wr, 1); q(wing.tip, 1.4); q(wing.mte, 1);
    }
    return new Float32Array(v);
  }
  // European starling: short tail, short pointed triangular wings, span ~0.4 m
  const STARLING = birdMesh([0.11, [0.028, 0.02], -0.07, 0.026, 0.02], [0.012, 0.03, -0.13],
    { rle: [0.02, 0.045], wr: [0.1, 0.03], tip: [0.205, -0.055], mte: [0.095, -0.045], rte: [0.02, -0.035] });
  // Peregrine: long pointed "anchor" wings and a longer tail, span ~1.05 m
  const FALCON = birdMesh([0.22, [0.065, 0.05], -0.14, 0.06, 0.05], [0.032, 0.06, -0.37],
    { rle: [0.04, 0.09], wr: [0.22, 0.055], tip: [0.52, -0.17], mte: [0.2, -0.07], rte: [0.045, -0.07] });
  const STARLING_SPAN = 0.41, FALCON_SPAN = 1.04;

  // (part, u along, v across) for a ribbon of quads per part
  function reedMesh() {
    const v = [];
    const strip = (part, segs) => {
      for (let s = 0; s < segs; s++) {
        const u0 = s / segs, u1 = (s + 1) / segs;
        v.push(part, u0, -1, part, u1, -1, part, u1, 1);
        v.push(part, u0, -1, part, u1, 1, part, u0, 1);
      }
    };
    strip(0, 7);   // stalk
    strip(1, 7);   // plume
    strip(2, 5);   // leaf
    return new Float32Array(v);
  }

  // Phragmites clumps framing the bottom corners (seeded, so identical every load).
  function reedField() {
    let s = 0x2545f491;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
    const clumps = [
      // azimuth (deg), distance (m), radius (m), count, height scale
      [-29, 10, 2.6, 22, 1.0], [-22, 21, 2.4, 9, 0.9], [-39, 13, 3.5, 20, 1.05], [-52, 10, 3.0, 18, 1.0],
      [30, 9.5, 2.2, 16, 1.0], [40, 13, 3.2, 16, 1.05], [24, 27, 2.2, 7, 0.85], [51, 10, 3, 16, 1.0],
      [-14, 50, 3.0, 9, 0.8],
    ];
    const out = [];
    for (const [azD, dist, rad, count, hs] of clumps) {
      const az = azD * Math.PI / 180;
      const cx = Math.sin(az) * dist, cz = Math.cos(az) * dist;
      for (let i = 0; i < count; i++) {
        const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * rad;
        out.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r * 0.6, (1.55 + rnd() * 0.75) * hs, rnd() * 6.283,
          0.04 + rnd() * 0.12, rnd() < 0.82 ? 0.2 + rnd() * 0.16 : 0.0, rnd(), 0.009 + rnd() * 0.006);
      }
    }
    return new Float32Array(out);
  }

  // ---------------------------------------------------------------------
  // Time-of-day palette: sRGB keys, interpolated in linear light.
  const KEYS = [
    { t: 0.0, sun: 7.5, sunI: 22, exposure: 0.42, stars: 0, mist: 0.2,
      zen: '#2a52a0', mid: '#5f88c8', hor: '#f0c096', glow: '#ffa040', sunC: '#ffe0b8', cloudL: '#f8d2a4', cloudD: '#56608a',
      far: '#7c84a2', tree: '#1e2638', water: '#14203a', mistC: '#e2c8b0', ink: '#090b13', glowC: '#ffc070' },
    { t: 0.4, sun: 0.9, sunI: 26, exposure: 0.5, stars: 0, mist: 0.32,
      zen: '#0f1f4c', mid: '#30508c', hor: '#df7c58', glow: '#ff6a24', sunC: '#ffbf80', cloudL: '#ff8a58', cloudD: '#2a2546',
      far: '#4c4468', tree: '#13121d', water: '#0a0e1c', mistC: '#b88480', ink: '#040509', glowC: '#ff9050' },
    { t: 0.72, sun: -3.4, sunI: 0, exposure: 0.72, stars: 0.3, mist: 0.28,
      zen: '#0c1736', mid: '#26386c', hor: '#c46a52', glow: '#d0502c', sunC: '#ff7a40', cloudL: '#b0606a', cloudD: '#20253f',
      far: '#2c3050', tree: '#0b0c16', water: '#060a16', mistC: '#3e3c5c', ink: '#04050a', glowC: '#ff6a4a' },
    { t: 1.0, sun: -8.5, sunI: 0, exposure: 0.95, stars: 1, mist: 0.24,
      zen: '#040a1e', mid: '#0e1940', hor: '#2a2c4e', glow: '#4a2232', sunC: '#5a2a1c', cloudL: '#2c2c48', cloudD: '#0b0e1c',
      far: '#141830', tree: '#04050a', water: '#03060e', mistC: '#1a1e36', ink: '#020305', glowC: '#904a4a' },
  ];
  const COLOR_KEYS = ['zen', 'mid', 'hor', 'glow', 'sunC', 'cloudL', 'cloudD', 'far', 'tree', 'water', 'mistC', 'ink', 'glowC'];
  // palette entries the sky shader reads, paired with their uniform names
  const SKY_COLORS = COLOR_KEYS.filter((n) => n !== 'glowC').map((n) => [n, 'u' + n[0].toUpperCase() + n.slice(1)]);
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const hexLin = (h) => [1, 3, 5].map((i) => toLinear(parseInt(h.slice(i, i + 2), 16) / 255));
  const LIN = KEYS.map((k) => Object.fromEntries(COLOR_KEYS.map((n) => [n, hexLin(k[n])])));
  const smooth = (x) => x * x * (3 - 2 * x);

  function palette(T, out) {
    let i = 0;
    while (i < KEYS.length - 2 && T > KEYS[i + 1].t) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const f = smooth(Math.min(1, Math.max(0, (T - a.t) / (b.t - a.t))));
    for (const n of COLOR_KEYS) {
      const ca = LIN[i][n], cb = LIN[i + 1][n], o = out[n];
      o[0] = ca[0] + (cb[0] - ca[0]) * f; o[1] = ca[1] + (cb[1] - ca[1]) * f; o[2] = ca[2] + (cb[2] - ca[2]) * f;
    }
    for (const n of ['sun', 'sunI', 'exposure', 'stars', 'mist']) out[n] = a[n] + (b[n] - a[n]) * f;
    return out;
  }

  // ---------------------------------------------------------------------
  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('Shader compile failed: ' + log);
    }
    return s;
  }
  function program(gl, vs, fs) {
    const p = gl.createProgram();
    const a = compile(gl, gl.VERTEX_SHADER, vs), b = compile(gl, gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, a); gl.attachShader(p, b);
    gl.linkProgram(p);
    gl.deleteShader(a); gl.deleteShader(b);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      u[name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  class Renderer {
    constructor(canvas) {
      const gl = canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
      });
      if (!gl) throw new Error('WebGL2 unavailable');
      this.canvas = canvas;
      this.gl = gl;
      this.pal = Object.fromEntries(COLOR_KEYS.map((n) => [n, [0, 0, 0]]));
      this.vp = new Float32Array(16);
      this.targets = null;
      this.init();
    }

    init() {
      const gl = this.gl;
      this.floatRT = !!gl.getExtension('EXT_color_buffer_float');
      this.samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) | 0);
      this.progSky = program(gl, VS_FULL, FS_SKY);
      this.progBird = program(gl, VS_BIRD, FS_COVER);
      this.progReed = program(gl, VS_REED, FS_REED);
      this.progPre = program(gl, VS_FULL, FS_PREFILTER);
      this.progDown = program(gl, VS_FULL, FS_DOWN);
      this.progUp = program(gl, VS_FULL, FS_UP);
      this.progFinal = program(gl, VS_FULL, FS_FINAL);

      this.emptyVao = gl.createVertexArray();
      this.instBuf = gl.createBuffer();
      this.instCap = 0;
      this.falconBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.falconBuf);
      gl.bufferData(gl.ARRAY_BUFFER, 32, gl.DYNAMIC_DRAW);
      this.birdVao = this.meshVao(STARLING, 4, this.instBuf);
      this.falconVao = this.meshVao(FALCON, 4, this.falconBuf);
      this.birdVerts = STARLING.length / 4;
      this.falconVerts = FALCON.length / 4;
      const reeds = reedField();
      this.reedBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.reedBuf);
      gl.bufferData(gl.ARRAY_BUFFER, reeds, gl.STATIC_DRAW);
      const reedVerts = reedMesh();
      this.reedVao = this.meshVao(reedVerts, 3, this.reedBuf);
      this.reedVerts = reedVerts.length / 3;
      this.reedCount = reeds.length / 8;
      gl.bindVertexArray(null);
      this.targets = null;
    }

    // mesh (size floats per vertex) in attribute 0, two vec4 instance attributes in 1 and 2
    meshVao(mesh, size, instBuf) {
      const gl = this.gl;
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, size, gl.FLOAT, false, size * 4, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
      for (let a = 1; a <= 2; a++) {
        gl.enableVertexAttribArray(a);
        gl.vertexAttribPointer(a, 4, gl.FLOAT, false, 32, (a - 1) * 16);
        gl.vertexAttribDivisor(a, 1);
      }
      gl.bindVertexArray(null);
      return vao;
    }

    ensureInstances(maxN) {
      if (maxN <= this.instCap) return;
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, maxN * 32, gl.DYNAMIC_DRAW);
      this.instCap = maxN;
    }

    texture(w, h, internal, format, type) {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    target(w, h, internal, format, type) {
      const gl = this.gl;
      const tex = this.texture(w, h, internal, format, type);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb, w, h };
    }
    // RG8 coverage target with a short mip chain (sampled blurred for the haze)
    mipTarget(w, h) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 4, gl.RG8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 3);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb, w, h };
    }
    hdrTarget(w, h) {
      const gl = this.gl;
      return this.floatRT ? this.target(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT) : this.target(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    }

    freeTargets() {
      const gl = this.gl, t = this.targets;
      if (!t) return;
      const all = [t.bg, t.layer, t.refl, ...t.bloom];
      for (const r of all) { gl.deleteTexture(r.tex); gl.deleteFramebuffer(r.fb); }
      if (t.ms) { gl.deleteRenderbuffer(t.ms.rb); gl.deleteFramebuffer(t.ms.fb); }
      this.targets = null;
    }

    // w, h: drawing-buffer size; bgScale: sky resolution relative to it
    resize(w, h, bgScale) {
      const gl = this.gl;
      this.canvas.width = w;
      this.canvas.height = h;
      this.freeTargets();
      const bw = Math.max(16, Math.round(w * bgScale)), bh = Math.max(16, Math.round(h * bgScale));
      const t = {
        w, h,
        bg: this.hdrTarget(bw, bh),
        layer: this.mipTarget(w, h),
        refl: this.target(Math.max(8, Math.round(bw / 2)), Math.max(8, Math.round(bh / 2)), gl.R8, gl.RED, gl.UNSIGNED_BYTE),
        bloom: [],
        ms: null,
      };
      if (this.samples > 1) {
        const rb = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.RG8, w, h);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
        t.ms = { rb, fb };
      }
      let mw = Math.round(w / 2), mh = Math.round(h / 2);
      for (let i = 0; i < 6 && mw >= 4 && mh >= 4; i++) {
        t.bloom.push(this.hdrTarget(mw, mh));
        mw = Math.round(mw / 2); mh = Math.round(mh / 2);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.targets = t;
    }

    setTime(T) { palette(T, this.pal); return this.pal; }

    // camera: { pos, fwd, right, up, tanX, tanY }
    viewProj(cam) {
      const m = this.vp, [cx, cy, cz] = cam.pos;
      const n = 0.3, f = 6000, A = (f + n) / (f - n), B = -2 * f * n / (f - n);
      const R = cam.right, U = cam.up, F = cam.fwd, ix = 1 / cam.tanX, iy = 1 / cam.tanY;
      const dr = R[0] * cx + R[1] * cy + R[2] * cz, du = U[0] * cx + U[1] * cy + U[2] * cz, df = F[0] * cx + F[1] * cy + F[2] * cz;
      // column-major
      m[0] = R[0] * ix; m[4] = R[1] * ix; m[8] = R[2] * ix; m[12] = -dr * ix;
      m[1] = U[0] * iy; m[5] = U[1] * iy; m[9] = U[2] * iy; m[13] = -du * iy;
      m[2] = F[0] * A; m[6] = F[1] * A; m[10] = F[2] * A; m[14] = -df * A + B;
      m[3] = F[0]; m[7] = F[1]; m[11] = F[2]; m[15] = -df;
      return m;
    }

    drawFull() {
      const gl = this.gl;
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    bind(unit, tex) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }

    // Birds, falcon and reeds as coverage into whatever target is bound.
    drawCoverage(s, mirror, targetH) {
      const gl = this.gl, cam = s.cam;
      const focal = targetH * 0.5 / cam.tanY;
      // reeds
      let P = this.progReed;
      gl.useProgram(P.p);
      gl.uniformMatrix4fv(P.u.uVP, false, this.vp);
      gl.uniform3fv(P.u.uCam, cam.pos);
      gl.uniform3f(P.u.uCamRight, cam.right[0], 0, cam.right[2]);
      gl.uniform3fv(P.u.uCamFwd, cam.fwd);
      gl.uniform3fv(P.u.uSun, s.sunDir);
      gl.uniform1f(P.u.uTime, s.time);
      gl.uniform1f(P.u.uWind, s.wind);
      gl.uniform1f(P.u.uMirror, mirror);
      gl.uniform1f(P.u.uFocal, focal);
      gl.uniform1f(P.u.uMinPx, mirror ? 0.7 : 1.1);
      gl.uniform1f(P.u.uGlow, s.reedGlow);
      gl.bindVertexArray(this.reedVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, this.reedVerts, this.reedCount);
      // starlings, then the falcon
      P = this.progBird;
      gl.useProgram(P.p);
      gl.uniformMatrix4fv(P.u.uVP, false, this.vp);
      gl.uniform3fv(P.u.uCam, cam.pos);
      gl.uniform3fv(P.u.uSun, s.sunDir);
      gl.uniform1f(P.u.uFocal, focal);
      gl.uniform1f(P.u.uMinPx, mirror ? 1.0 : s.minPx);
      gl.uniform1f(P.u.uMirror, mirror);
      gl.uniform1f(P.u.uFog, s.fog);
      gl.uniform1f(P.u.uLead, s.lead);
      gl.uniform1f(P.u.uScale, s.birdScale);
      gl.uniform1f(P.u.uSpan, STARLING_SPAN);
      gl.uniform1f(P.u.uSweep, 0);
      gl.uniform1f(P.u.uGlow, s.birdGlow);
      if (s.n > 0) {
        gl.bindVertexArray(this.birdVao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, this.birdVerts, s.n);
      }
      gl.uniform1f(P.u.uLead, s.falconLead);
      gl.uniform1f(P.u.uScale, s.falconScale);
      gl.uniform1f(P.u.uSpan, FALCON_SPAN);
      gl.uniform1f(P.u.uSweep, s.falconSweep);
      gl.uniform1f(P.u.uGlow, s.birdGlow);
      gl.bindVertexArray(this.falconVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, this.falconVerts, 1);
    }

    // s: per-frame scene state assembled by script.js
    render(s) {
      const gl = this.gl, t = this.targets, pal = this.pal, cam = s.cam;
      if (!t) return;
      this.viewProj(cam);

      // instance data
      if (s.n > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.inst, 0, s.n * 8);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.falconBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.falconInst);

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);

      // 1. reflection coverage
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.refl.fb);
      gl.viewport(0, 0, t.refl.w, t.refl.h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.drawCoverage(s, 1, t.refl.h);
      gl.disable(gl.BLEND);

      // 2. sky + marsh (HDR)
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.bg.fb);
      gl.viewport(0, 0, t.bg.w, t.bg.h);
      let P = this.progSky;
      gl.useProgram(P.p);
      gl.uniform3fv(P.u.uFwd, cam.fwd);
      gl.uniform3f(P.u.uRight, cam.right[0] * cam.tanX, cam.right[1] * cam.tanX, cam.right[2] * cam.tanX);
      gl.uniform3f(P.u.uUp, cam.up[0] * cam.tanY, cam.up[1] * cam.tanY, cam.up[2] * cam.tanY);
      gl.uniform3fv(P.u.uSun, s.sunDir);
      gl.uniform1f(P.u.uTime, s.time);
      gl.uniform1f(P.u.uCamH, cam.pos[1]);
      gl.uniform1f(P.u.uPix, 2 * cam.tanY / t.bg.h);
      gl.uniform1f(P.u.uStars, pal.stars);
      gl.uniform1f(P.u.uSunI, pal.sunI);
      gl.uniform1f(P.u.uMist, pal.mist);
      gl.uniform1f(P.u.uDusk, Math.min(1, Math.max(0, -pal.sun / 5)));
      gl.uniform1i(P.u.uRefl, 0);
      for (let i = 0; i < SKY_COLORS.length; i++) gl.uniform3fv(P.u[SKY_COLORS[i][1]], pal[SKY_COLORS[i][0]]);
      this.bind(0, t.refl.tex);
      this.drawFull();

      // 3. coverage layer (multisampled, then resolved)
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.ms ? t.ms.fb : t.layer.fb);
      gl.viewport(0, 0, t.w, t.h);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.drawCoverage(s, 0, t.h);
      gl.disable(gl.BLEND);
      if (t.ms) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.ms.fb);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.layer.fb);
        gl.blitFramebuffer(0, 0, t.w, t.h, 0, 0, t.w, t.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.bind(1, t.layer.tex);
      gl.generateMipmap(gl.TEXTURE_2D);

      // 4. bloom
      const B = t.bloom;
      P = this.progPre;
      gl.useProgram(P.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, B[0].fb);
      gl.viewport(0, 0, B[0].w, B[0].h);
      gl.uniform1i(P.u.uBg, 0);
      gl.uniform1i(P.u.uLayer, 1);
      gl.uniform3fv(P.u.uInk, pal.ink);
      gl.uniform3fv(P.u.uGlowC, pal.glowC);
      gl.uniform1f(P.u.uHaze, s.haze);
      gl.uniform1f(P.u.uHazeLod, s.hazeLod);
      gl.uniform2f(P.u.uTexel, 1 / t.w, 1 / t.h);
      gl.uniform1f(P.u.uThresh, s.bloomThreshold);
      gl.uniform1f(P.u.uKnee, s.bloomThreshold * 0.5);
      this.bind(0, t.bg.tex);
      this.bind(1, t.layer.tex);
      this.drawFull();
      P = this.progDown;
      gl.useProgram(P.p);
      gl.uniform1i(P.u.uSrc, 0);
      for (let i = 1; i < B.length; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, B[i].fb);
        gl.viewport(0, 0, B[i].w, B[i].h);
        gl.uniform2f(P.u.uTexel, 1 / B[i - 1].w, 1 / B[i - 1].h);
        this.bind(0, B[i - 1].tex);
        this.drawFull();
      }
      P = this.progUp;
      gl.useProgram(P.p);
      gl.uniform1i(P.u.uSrc, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = B.length - 1; i > 0; i--) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, B[i - 1].fb);
        gl.viewport(0, 0, B[i - 1].w, B[i - 1].h);
        gl.uniform2f(P.u.uTexel, 1 / B[i].w, 1 / B[i].h);
        this.bind(0, B[i].tex);
        this.drawFull();
      }
      gl.disable(gl.BLEND);

      // 5. final
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, t.w, t.h);
      P = this.progFinal;
      gl.useProgram(P.p);
      gl.uniform1i(P.u.uBg, 0);
      gl.uniform1i(P.u.uLayer, 1);
      gl.uniform1i(P.u.uBloom, 2);
      gl.uniform3fv(P.u.uInk, pal.ink);
      gl.uniform3fv(P.u.uGlowC, pal.glowC);
      gl.uniform1f(P.u.uHaze, s.haze);
      gl.uniform1f(P.u.uHazeLod, s.hazeLod);
      gl.uniform1f(P.u.uExposure, pal.exposure);
      gl.uniform1f(P.u.uBloomAmt, s.bloom / B.length);
      gl.uniform1f(P.u.uFrame, s.frame % 64);
      gl.uniform1f(P.u.uVignette, 0.32);
      gl.uniform1f(P.u.uSat, 1.06);
      gl.uniform2f(P.u.uRes, t.w, t.h);
      gl.uniform3f(P.u.uShadow, 0.9, 0.98, 1.12);
      gl.uniform3f(P.u.uHigh, 1.04, 1.0, 0.95);
      this.bind(0, t.bg.tex);
      this.bind(1, t.layer.tex);
      this.bind(2, B[0].tex);
      this.drawFull();
      gl.bindVertexArray(null);
    }
  }

  root.Murmur = root.Murmur || {};
  root.Murmur.Renderer = Renderer;
})(window);
