/* =====================================================================
   Collision · shaders.js — GLSL ES 3.00 sources (classic script).
   ===================================================================== */
(function (root) {
  'use strict';

  // ---- star integration (transform feedback, rasterizer discarded) -------
  // Kick–drift–kick leapfrog in the field of up to three moving galaxies.
  // Core positions at every step boundary come from the CPU orbit integrator
  // through a small RGBA32F "path" texture: texel (k, g) = galaxy g at step k.
  const integrateVS = `#version 300 es
precision highp float;
precision highp sampler2D;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aVel;
uniform sampler2D uPath;
uniform vec4 uMass[3];   // bulge mass, bulge softening², halo mass, halo scale²
uniform int uSteps;
uniform float uH;
out vec3 vPos;
out vec3 vVel;

vec3 accel(vec3 p, int k) {
  vec3 a = vec3(0.0);
  for (int g = 0; g < 3; g++) {
    vec4 m = uMass[g];
    vec3 d = texelFetch(uPath, ivec2(k, g), 0).xyz - p;
    float r2 = dot(d, d);
    float ib = inversesqrt(r2 + m.y);
    float ih = inversesqrt(r2 + m.w);
    // two Plummer spheres: a = M r / (r² + ε²)^(3/2)
    a += d * (m.x * ib * ib * ib + m.z * ih * ih * ih);
  }
  return a;
}

void main() {
  vec3 p = aPos;
  vec3 v = aVel;
  vec3 a = accel(p, 0);
  for (int k = 1; k <= uSteps; k++) {
    v += 0.5 * uH * a;
    p += uH * v;
    a = accel(p, k);
    v += 0.5 * uH * a;
  }
  vPos = p;
  vVel = v;
}`;

  const discardFS = `#version 300 es
precision mediump float;
out vec4 o;
void main() { o = vec4(0.0); }`;

  // ---- star / dust sprites -------------------------------------------------
  // Each particle is a soft Gaussian whose flux scales as (focal / depth)²,
  // so surface brightness stays constant with distance like a real galaxy.
  // Sprites are clamped between a minimum and maximum width in pixels,
  // preserving flux. The two-armed spiral is a density wave: brightness is
  // modulated by the star's phase relative to a rigidly rotating logarithmic
  // spiral in its home disk (old stars gently, young stars and HII regions
  // strongly and just downstream, dust just upstream on the concave side).
  const spriteVS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 2) in vec4 aInfo;   // population, galaxy, luminosity, seed
uniform mat4 uView;
uniform mat4 uProj;
uniform float uFocal;       // pixels per kpc at unit depth
uniform float uGain;
uniform float uRefDepth;
uniform vec2 uSigmaPx;      // min / max Gaussian sigma in pixels
uniform vec3 uGalC[3];
uniform vec3 uGalU[3];
uniform vec3 uGalV[3];
uniform vec3 uGalTint[3];
uniform vec4 uGalArm[3];    // pattern angle, cot(pitch), strength, disk radius
uniform float uGalInner[3];
uniform vec2 uBoost;        // starburst gain for young stars, HII regions
uniform float uTag;         // per-galaxy tint, 0 … 1
out vec3 vCol;

const float SIGMA[5] = float[5](0.30, 0.20, 0.07, 0.05, 0.30);

void main() {
  int pop = int(aInfo.x + 0.5);
  int g = int(aInfo.y + 0.5);
  float seed = aInfo.w;
  vec4 vp = uView * vec4(aPos, 1.0);
  float depth = max(-vp.z, 0.05);
  gl_Position = uProj * vp;

  // position in the home disk's frame
  vec3 d = aPos - uGalC[g];
  vec3 n = cross(uGalU[g], uGalV[g]);
  float x = dot(d, uGalU[g]);
  float y = dot(d, uGalV[g]);
  float R = length(vec2(x, y)) + 1e-4;
  vec4 arm = uGalArm[g];
  float w = arm.z
    * smoothstep(0.45, 1.3, R / uGalInner[g])
    * (1.0 - smoothstep(0.85, 1.25, R / arm.w))
    * (1.0 - smoothstep(0.5, 2.0, abs(dot(d, n))));
  float psi = 2.0 * (atan(y, x) + arm.y * log(R) - arm.x);
  // flocculent sub-structure: a weaker, more open three-armed pattern
  float psi3 = 3.0 * (atan(y, x) + 0.55 * arm.y * log(R) - 0.6 * arm.x) + 6.2832 * seed * 0.15;

  float lum = aInfo.z;
#ifdef DUST
  vec3 col = vec3(1.0);
  lum *= mix(1.0, exp(4.0 * (cos(psi + 0.4) - 1.0)) * 4.831, w);
#else
  vec3 col;
  if (pop == 0) {
    col = mix(vec3(1.0, 0.58, 0.30), vec3(1.0, 0.76, 0.50), seed);
  } else if (pop == 1) {
    col = mix(vec3(1.0, 0.74, 0.50), vec3(0.85, 0.88, 1.0), seed * seed);
    lum *= 1.0 + w * (0.42 * cos(psi) + 0.12 * cos(psi3));
  } else if (pop == 2) {
    col = mix(vec3(0.30, 0.50, 1.0), vec3(0.62, 0.76, 1.0), seed);
    float wave = exp(4.0 * (cos(psi - 0.45) - 1.0)) * 4.831;
    lum *= uBoost.x * mix(1.0, wave * (0.8 + 0.4 * cos(psi3)), w);
  } else {
    col = mix(vec3(1.0, 0.18, 0.40), vec3(1.0, 0.32, 0.62), seed);
    float wave = exp(6.0 * (cos(psi - 0.7) - 1.0)) * 6.0;
    lum *= uBoost.y * mix(1.0, wave, w);
  }
  vec3 tint = uGalTint[g];
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, tint * (l / dot(tint, vec3(0.2126, 0.7152, 0.0722))), uTag);
#endif

  // flux ∝ (focal / depth)²; sprites shrink a little when seen up close
  float k = uFocal / max(depth, 2.0);
  float sigma = SIGMA[pop] * (0.7 + 0.6 * seed) * (uFocal / depth) * clamp(sqrt(depth / uRefDepth), 0.4, 1.0);
  float s = clamp(sigma, uSigmaPx.x, uSigmaPx.y);
  gl_PointSize = 6.0 * s;
  vCol = col * (lum * uGain * k * k / (6.2832 * s * s));
}`;

  const spriteFS = `#version 300 es
precision mediump float;
in vec3 vCol;
out vec4 o;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;   // the sprite spans ±3 sigma
  float g = max(exp(-4.5 * dot(q, q)) - 0.0111, 0.0) * 1.0112;
  o = vec4(vCol * g, 0.0);
}`;

  // ---- deep-field backdrop: stars, diffraction-spiked foreground stars and
  // faint background galaxies, all at infinity -------------------------------
  const skyVS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aDir;
layout(location = 1) in vec3 aCol;
layout(location = 2) in vec4 aShape;   // kind, size (px at scale 1), angle, axis ratio
uniform mat4 uSky;                     // projection × camera rotation
uniform float uPx;                     // buffer pixels per CSS pixel
out vec3 vCol;
flat out vec4 vShape;
void main() {
  gl_Position = uSky * vec4(aDir, 1.0);
  gl_PointSize = aShape.y * uPx;
  vCol = aCol;
  vShape = vec4(aShape.x, aShape.y * uPx, aShape.z, aShape.w);
}`;

  const skyFS = `#version 300 es
precision highp float;
in vec3 vCol;
flat in vec4 vShape;
uniform float uSpike;   // spike angle
out vec4 o;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  vec3 c;
  if (vShape.x < 0.5) {
    c = vCol * max(exp(-4.5 * r2) - 0.0111, 0.0);
  } else if (vShape.x < 1.5) {
    // bright foreground star: core, halo and four diffraction spikes from the
    // telescope's secondary-mirror supports, fixed to the image axes
    vec2 px = q * 0.5 * vShape.y;
    float ca = cos(uSpike), sa = sin(uSpike);
    vec2 p = vec2(ca * px.x + sa * px.y, -sa * px.x + ca * px.y);
    float r = length(px);
    float half_ = 0.5 * vShape.y;
    float spike = exp(-0.5 * p.y * p.y / 0.5) * pow(max(1.0 - abs(p.x) / half_, 0.0), 2.5)
                + exp(-0.5 * p.x * p.x / 0.5) * pow(max(1.0 - abs(p.y) / half_, 0.0), 2.5);
    float core = exp(-r * r / 2.2) * 9.0 + exp(-r / 2.5) * 0.9 + exp(-r / (0.12 * half_)) * 0.06;
    c = vCol * (core + 1.6 * spike) * (1.0 - smoothstep(0.75, 1.0, sqrt(r2)));
  } else {
    // distant galaxy: a rotated, flattened bulge + disk smudge
    float ca = cos(vShape.z), sa = sin(vShape.z);
    vec2 p = vec2(ca * q.x + sa * q.y, -sa * q.x + ca * q.y);
    p.y /= vShape.w;
    float rr = dot(p, p);
    c = vCol * (exp(-rr * 9.0) + 1.4 * exp(-dot(q, q) * 60.0)) * (1.0 - smoothstep(0.6, 1.0, sqrt(r2)));
  }
  o = vec4(c, 0.0);
}`;

  // ---- full-screen passes -------------------------------------------------
  const fullVS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

  // Galactic nuclei: projected Plummer profiles I ∝ (1 + r²/a²)⁻².
  const nucleiFS = `#version 300 es
precision highp float;
uniform vec4 uNuc[3];   // buffer-pixel position, core radius (px), peak
out vec4 o;
void main() {
  float s = 0.0;
  for (int i = 0; i < 3; i++) {
    vec4 n = uNuc[i];
    vec2 d = gl_FragCoord.xy - n.xy;
    float u = 1.0 + dot(d, d) / (n.z * n.z);
    s += n.w / (u * u);
  }
  o = vec4(vec3(1.0, 0.86, 0.68) * s, 0.0);
}`;

  // Dual-filter bloom. The first downsample also applies dust extinction.
  const downFS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform sampler2D uDust;
uniform vec2 uTexel;
uniform float uDustK;   // 0 after the first level
out vec4 o;
vec3 tap(vec2 uv) {
  vec3 c = min(texture(uSrc, uv).rgb, vec3(6e4));
  return c * exp(-texture(uDust, uv).r * uDustK * vec3(0.72, 1.0, 1.32));
}
void main() {
  vec3 s = tap(vUv) * 4.0;
  s += tap(vUv + vec2(-uTexel.x, -uTexel.y));
  s += tap(vUv + vec2(uTexel.x, -uTexel.y));
  s += tap(vUv + vec2(-uTexel.x, uTexel.y));
  s += tap(vUv + vec2(uTexel.x, uTexel.y));
  o = vec4(s * 0.125, 1.0);
}`;

  const upFS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uGain;
out vec4 o;
void main() {
  vec2 h = uTexel;
  vec3 s = texture(uSrc, vUv + vec2(-2.0 * h.x, 0.0)).rgb;
  s += texture(uSrc, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(0.0, 2.0 * h.y)).rgb;
  s += texture(uSrc, vUv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(2.0 * h.x, 0.0)).rgb;
  s += texture(uSrc, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(0.0, -2.0 * h.y)).rgb;
  s += texture(uSrc, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  o = vec4(s * (uGain / 12.0), 1.0);
}`;

  // Final grade: dust extinction (and reddening), bloom, exposure, a
  // hue-preserving asinh stretch (Lupton et al. 2004) with a soft roll-off
  // to white, a touch of contrast, vignette, sRGB encoding and dithering.
  const compositeFS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uDust;
uniform sampler2D uBloom;
uniform float uDustK;
uniform float uBloomK;
uniform float uExposure;
uniform float uStretch;
uniform float uFade;
uniform vec2 uAspect;
uniform float uSeed;
out vec4 o;

float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423) + uSeed);
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

void main() {
  vec3 c = texture(uScene, vUv).rgb;
  c *= exp(-texture(uDust, vUv).r * uDustK * vec3(0.72, 1.0, 1.32));
  c += texture(uBloom, vUv).rgb * uBloomK;
  c *= uExposure;

  float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 col = c * (asinh(uStretch * L) / (asinh(uStretch) * max(L, 1e-6)));
  float m = max(max(col.r, col.g), col.b);
  col = mix(col / max(m, 1.0), vec3(1.0), 1.0 - exp(-0.9 * max(m - 1.0, 0.0)));
  col = max(mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, 1.18), 0.0);
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.22);

  vec2 v = (vUv - 0.5) * uAspect;
  col *= mix(1.0, smoothstep(1.15, 0.2, length(v)), 0.42);
  col *= uFade;

  col = mix(col * 12.92, 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, col));
  col += (hash(gl_FragCoord.xy) + hash(gl_FragCoord.xy + 17.3) - 1.0) / 255.0;
  o = vec4(col, 1.0);
}`;

  root.CollisionShaders = Object.freeze({
    integrateVS, discardFS, spriteVS, spriteFS, skyVS, skyFS,
    fullVS, nucleiFS, downFS, upFS, compositeFS,
  });
})(window);
