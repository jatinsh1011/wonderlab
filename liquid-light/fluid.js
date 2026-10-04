/* =====================================================================
   Liquid Light · fluid.js
   A GPU solver for the incompressible Navier–Stokes equations, after Jos
   Stam's "Stable Fluids" (1999), plus the renderer that makes the dye
   read as light. Velocity lives on a coarse grid and the dye on a much
   finer one. Each step: curl → vorticity confinement → divergence →
   pressure (Jacobi iterations) → projection → advection.
   Classic script; exposes window.LiquidFluid.create(canvas).
   ===================================================================== */
(function (root) {
  'use strict';

  const HEAD = '#version 300 es\nprecision highp float;\nprecision highp sampler2D;\n';

  const VERT = HEAD + `
in vec2 aPos;
uniform vec2 uTexel;
out vec2 vUv;
out vec2 vL;
out vec2 vR;
out vec2 vT;
out vec2 vB;
void main() {
  vUv = aPos * 0.5 + 0.5;
  vL = vUv - vec2(uTexel.x, 0.0);
  vR = vUv + vec2(uTexel.x, 0.0);
  vT = vUv + vec2(0.0, uTexel.y);
  vB = vUv - vec2(0.0, uTexel.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  // Fragment shader with the shared header; `neighbours` adds the four stencil taps.
  const frag = (body, neighbours) => HEAD + 'in vec2 vUv;\n' +
    (neighbours ? 'in vec2 vL;\nin vec2 vR;\nin vec2 vT;\nin vec2 vB;\n' : '') + 'out vec4 o;\n' + body;

  const SHADERS = {
    copy: frag(`uniform sampler2D uTex;
void main() { o = texture(uTex, vUv); }`),

    scale: frag(`uniform sampler2D uTex;
uniform float uValue;
void main() { o = uValue * texture(uTex, vUv); }`),

    // Additive Gaussian splat (drawn with ONE/ONE blending inside a scissor box).
    splat: frag(`uniform float uAspect;
uniform vec3 uColor;
uniform vec2 uPoint;
uniform float uRadius;
void main() {
  vec2 p = vUv - uPoint;
  p.x *= uAspect;
  o = vec4(exp(-dot(p, p) / uRadius) * uColor, 0.0);
}`),

    advect: frag(`uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uVelTexel;
uniform float uDt;
uniform float uDissipation;
void main() {
  // Semi-Lagrangian: trace back along the flow and take what was there.
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uVelTexel;
  o = texture(uSource, coord) / (1.0 + uDissipation * uDt);
}`),

    divergence: frag(`uniform sampler2D uVelocity;
void main() {
  vec2 c = texture(uVelocity, vUv).xy;
  float l = texture(uVelocity, vL).x;
  float r = texture(uVelocity, vR).x;
  float t = texture(uVelocity, vT).y;
  float b = texture(uVelocity, vB).y;
  // Solid walls: mirror the normal velocity at the edges.
  if (vL.x < 0.0) l = -c.x;
  if (vR.x > 1.0) r = -c.x;
  if (vT.y > 1.0) t = -c.y;
  if (vB.y < 0.0) b = -c.y;
  o = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);
}`, true),

    curl: frag(`uniform sampler2D uVelocity;
void main() {
  float l = texture(uVelocity, vL).y;
  float r = texture(uVelocity, vR).y;
  float t = texture(uVelocity, vT).x;
  float b = texture(uVelocity, vB).x;
  o = vec4(0.5 * (r - l - t + b), 0.0, 0.0, 1.0);
}`, true),

    vorticity: frag(`uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float uStrength;
uniform float uDt;
void main() {
  float l = texture(uCurl, vL).x;
  float r = texture(uCurl, vR).x;
  float t = texture(uCurl, vT).x;
  float b = texture(uCurl, vB).x;
  float c = texture(uCurl, vUv).x;
  // Vorticity confinement: nudge the flow along the gradient of |curl| so the
  // small eddies that numerical diffusion would smear out keep spinning.
  vec2 force = 0.5 * vec2(abs(t) - abs(b), abs(r) - abs(l));
  force /= length(force) + 1e-4;
  force *= uStrength * c;
  force.y = -force.y;
  vec2 vel = texture(uVelocity, vUv).xy + force * uDt;
  o = vec4(clamp(vel, -1000.0, 1000.0), 0.0, 1.0);
}`, true),

    pressure: frag(`uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main() {
  float l = texture(uPressure, vL).x;
  float r = texture(uPressure, vR).x;
  float t = texture(uPressure, vT).x;
  float b = texture(uPressure, vB).x;
  // One Jacobi iteration of the Poisson equation  ∇²p = ∇·u.
  o = vec4((l + r + t + b - texture(uDivergence, vUv).x) * 0.25, 0.0, 0.0, 1.0);
}`, true),

    gradient: frag(`uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main() {
  float l = texture(uPressure, vL).x;
  float r = texture(uPressure, vR).x;
  float t = texture(uPressure, vT).x;
  float b = texture(uPressure, vB).x;
  // Projection: subtracting ∇p leaves a divergence-free (incompressible) flow.
  o = vec4(texture(uVelocity, vUv).xy - 0.5 * vec2(r - l, t - b), 0.0, 1.0);
}`, true),

    bloomPrefilter: frag(`uniform sampler2D uTex;
uniform vec3 uCurve;
uniform float uThreshold;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uCurve.x, 0.0, uCurve.y);
  soft = uCurve.z * soft * soft;
  o = vec4(c * max(soft, br - uThreshold) / max(br, 1e-4), 0.0);
}`),

    bloomBlur: frag(`uniform sampler2D uTex;
void main() {
  o = 0.25 * (texture(uTex, vL) + texture(uTex, vR) + texture(uTex, vT) + texture(uTex, vB));
}`, true),

    bloomFinal: frag(`uniform sampler2D uTex;
uniform float uIntensity;
void main() {
  o = 0.25 * uIntensity * (texture(uTex, vL) + texture(uTex, vR) + texture(uTex, vT) + texture(uTex, vB));
}`, true),

    display: frag(`uniform sampler2D uDye;
uniform sampler2D uBloom;
uniform vec2 uDyeTexel;
uniform vec3 uBg;
uniform float uPaper;
uniform float uBloomOn;
uniform float uExposure;
uniform float uRelief;
uniform float uAspect;
uniform float uTime;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 dye = max(texture(uDye, vUv).rgb, 0.0);
  // Treat the dye's density as a height field and light it like a liquid surface.
  float hl = length(texture(uDye, vUv - vec2(uDyeTexel.x, 0.0)).rgb);
  float hr = length(texture(uDye, vUv + vec2(uDyeTexel.x, 0.0)).rgb);
  float ht = length(texture(uDye, vUv + vec2(0.0, uDyeTexel.y)).rgb);
  float hb = length(texture(uDye, vUv - vec2(0.0, uDyeTexel.y)).rgb);
  vec3 n = normalize(vec3(hl - hr, hb - ht, uRelief));
  float diffuse = clamp(n.z + 0.72, 0.72, 1.0);
  vec3 halfway = normalize(normalize(vec3(-0.34, 0.52, 0.78)) + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, halfway), 0.0), 64.0);
  float amount = smoothstep(0.015, 0.3, max(dye.r, max(dye.g, dye.b)));

  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
  float vig = smoothstep(1.4, 0.2, length(q));
  vec3 col;
  if (uPaper > 0.5) {
    // Ink on paper: the dye is absorbance, so colours mix subtractively (Beer–Lambert).
    col = uBg * exp(-dye * 1.7) * diffuse;
    col += spec * amount * 0.2;
    col *= 0.968 + 0.032 * hash(floor(gl_FragCoord.xy * 0.7));
    col *= mix(0.88, 1.0, vig);
  } else {
    vec3 light = dye * diffuse + spec * amount * (0.15 + dye) * 0.45;
    light += texture(uBloom, vUv).rgb * uBloomOn;
    // a touch of extra saturation keeps overlapping colours vivid instead of muddy
    float luma = dot(light, vec3(0.2126, 0.7152, 0.0722));
    light = max(mix(vec3(luma), light, 1.18), 0.0);
    col = uBg * mix(0.5, 1.0, vig) + aces(light * uExposure);
    col *= mix(0.8, 1.0, vig);
  }
  col += (hash(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0; // dither: no banding
  o = vec4(col, 1.0);
}`),
  };

  function create(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, depth: false, stencil: false, antialias: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) return { error: 'webgl2' };
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_color_buffer_half_float');

    // ---- render-target formats (fall back to wider formats where needed) ----
    function renderable(internal, format) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, format, gl.HALF_FLOAT, null);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(f);
      gl.deleteTexture(t);
      return ok ? { internal, format } : null;
    }
    const RGBA = renderable(gl.RGBA16F, gl.RGBA);
    if (!RGBA) return { error: 'float' };
    const RG = renderable(gl.RG16F, gl.RG) || RGBA;
    const R = renderable(gl.R16F, gl.RED) || RG;

    // ---- programs ----
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, VERT);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) throw new Error('Vertex shader: ' + gl.getShaderInfoLog(vs));
    function program(src) {
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, src);
      gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error('Fragment shader: ' + gl.getShaderInfoLog(fs));
      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
      gl.deleteShader(fs);
      const u = {};
      const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const name = gl.getActiveUniform(p, i).name;
        u[name] = gl.getUniformLocation(p, name);
      }
      return { p, u: (name) => u[name] || null };
    }
    const P = {};
    for (const key of Object.keys(SHADERS)) P[key] = program(SHADERS[key]);
    const use = (prog) => { gl.useProgram(prog.p); return prog.u; };

    // ---- one full-screen quad, bound for the lifetime of the context ----
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    function blit(target) {
      if (target) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
        gl.viewport(0, 0, target.w, target.h);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }

    // ---- render targets ----
    function target(w, h, fmt, filter) {
      gl.activeTexture(gl.TEXTURE0);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, fmt.format, gl.HALF_FLOAT, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return {
        tex, fb, w, h, fmt, filter, texel: [1 / w, 1 / h],
        attach(unit) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); return unit; },
      };
    }
    const destroy = (t) => { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); } };
    function pair(w, h, fmt, filter) {
      return { read: target(w, h, fmt, filter), write: target(w, h, fmt, filter), swap() { const t = this.read; this.read = this.write; this.write = t; } };
    }
    // Resize a pair, resampling its contents so a window resize doesn't wipe the painting.
    function resizePair(old, w, h) {
      if (old.read.w === w && old.read.h === h) return old;
      const next = pair(w, h, old.read.fmt, old.read.filter);
      const u = use(P.copy);
      gl.uniform1i(u('uTex'), old.read.attach(0));
      blit(next.read);
      destroy(old.read);
      destroy(old.write);
      return next;
    }

    const params = {
      curl: 30,
      velocityDissipation: 0.2,
      dyeDissipation: 0.9,
      pressureDecay: 0.8,
      pressureIterations: 22,
      radius: 0.25,
      simResolution: 192,
      dyeResolution: 1024,
      bloom: true,
      bloomIntensity: 1.0,
      bloomThreshold: 0.3,
      bloomKnee: 0.7,
      bloomResolution: 256,
      bloomIterations: 7,
      paper: false,
      bg: [0, 0, 0],
      exposure: 2.3,
      relief: 0.045,
    };

    let velocity, dye, pressure, divergence, curl, bloom, bloomMips = [];
    let lastW = 0, lastH = 0;

    function size(base) {
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      let aspect = w / h;
      if (aspect < 1) aspect = 1 / aspect;
      const lo = Math.max(16, Math.round(base)), hi = Math.round(lo * aspect);
      return w > h ? { w: hi, h: lo } : { w: lo, h: hi };
    }

    function buildTargets() {
      gl.disable(gl.BLEND);
      const sim = size(params.simResolution), dr = size(params.dyeResolution), br = size(params.bloomResolution);
      dye = dye ? resizePair(dye, dr.w, dr.h) : pair(dr.w, dr.h, RGBA, gl.LINEAR);
      velocity = velocity ? resizePair(velocity, sim.w, sim.h) : pair(sim.w, sim.h, RG, gl.LINEAR);
      if (pressure) { destroy(pressure.read); destroy(pressure.write); }
      pressure = pair(sim.w, sim.h, R, gl.NEAREST);
      destroy(divergence);
      divergence = target(sim.w, sim.h, R, gl.NEAREST);
      destroy(curl);
      curl = target(sim.w, sim.h, R, gl.NEAREST);
      destroy(bloom);
      bloomMips.forEach(destroy);
      bloom = target(br.w, br.h, RGBA, gl.LINEAR);
      bloomMips = [];
      for (let i = 0; i < params.bloomIterations; i++) {
        const w = br.w >> (i + 1), h = br.h >> (i + 1);
        if (w < 2 || h < 2) break;
        bloomMips.push(target(w, h, RGBA, gl.LINEAR));
      }
      lastW = gl.drawingBufferWidth;
      lastH = gl.drawingBufferHeight;
    }

    function resize() {
      if (gl.drawingBufferWidth !== lastW || gl.drawingBufferHeight !== lastH) buildTargets();
    }

    function setResolution(sim, dyeRes) {
      params.simResolution = sim;
      params.dyeResolution = dyeRes;
      buildTargets();
    }

    // ---- simulation step ----
    function step(dt) {
      gl.disable(gl.BLEND);
      const vt = velocity.read.texel;

      let u = use(P.curl);
      gl.uniform2fv(u('uTexel'), vt);
      gl.uniform1i(u('uVelocity'), velocity.read.attach(0));
      blit(curl);

      u = use(P.vorticity);
      gl.uniform2fv(u('uTexel'), vt);
      gl.uniform1i(u('uVelocity'), velocity.read.attach(0));
      gl.uniform1i(u('uCurl'), curl.attach(1));
      gl.uniform1f(u('uStrength'), params.curl);
      gl.uniform1f(u('uDt'), dt);
      blit(velocity.write);
      velocity.swap();

      u = use(P.divergence);
      gl.uniform2fv(u('uTexel'), vt);
      gl.uniform1i(u('uVelocity'), velocity.read.attach(0));
      blit(divergence);

      u = use(P.scale);
      gl.uniform1i(u('uTex'), pressure.read.attach(0));
      gl.uniform1f(u('uValue'), params.pressureDecay);
      blit(pressure.write);
      pressure.swap();

      u = use(P.pressure);
      gl.uniform2fv(u('uTexel'), vt);
      gl.uniform1i(u('uDivergence'), divergence.attach(0));
      for (let i = 0; i < params.pressureIterations; i++) {
        gl.uniform1i(u('uPressure'), pressure.read.attach(1));
        blit(pressure.write);
        pressure.swap();
      }

      u = use(P.gradient);
      gl.uniform2fv(u('uTexel'), vt);
      gl.uniform1i(u('uPressure'), pressure.read.attach(0));
      gl.uniform1i(u('uVelocity'), velocity.read.attach(1));
      blit(velocity.write);
      velocity.swap();

      u = use(P.advect);
      gl.uniform2fv(u('uVelTexel'), vt);
      gl.uniform1f(u('uDt'), dt);
      gl.uniform1i(u('uVelocity'), velocity.read.attach(0));
      gl.uniform1i(u('uSource'), velocity.read.attach(0));
      gl.uniform1f(u('uDissipation'), params.velocityDissipation);
      blit(velocity.write);
      velocity.swap();

      gl.uniform1i(u('uVelocity'), velocity.read.attach(0));
      gl.uniform1i(u('uSource'), dye.read.attach(1));
      gl.uniform1f(u('uDissipation'), params.dyeDissipation);
      blit(dye.write);
      dye.swap();
    }

    // ---- splats: additive, and only inside the box where the Gaussian is visible ----
    function scissorTo(t, x, y, ex, ey) {
      const x0 = Math.max(0, Math.floor((x - ex) * t.w)), y0 = Math.max(0, Math.floor((y - ey) * t.h));
      const x1 = Math.min(t.w, Math.ceil((x + ex) * t.w)), y1 = Math.min(t.h, Math.ceil((y + ey) * t.h));
      gl.scissor(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
    }
    function splat(x, y, dx, dy, color, radiusScale) {
      const aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
      let r = (params.radius * (radiusScale || 1)) / 100;
      if (aspect < 1) r *= aspect * aspect; // size relative to the short side on portrait screens
      const ext = 3.1 * Math.sqrt(r);      // beyond this the Gaussian is below 1e-4
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.enable(gl.SCISSOR_TEST);
      const u = use(P.splat);
      gl.uniform1f(u('uAspect'), aspect);
      gl.uniform2f(u('uPoint'), x, y);
      gl.uniform1f(u('uRadius'), r);
      gl.uniform3f(u('uColor'), dx, dy, 0);
      scissorTo(velocity.read, x, y, ext / aspect, ext);
      blit(velocity.read);
      gl.uniform3f(u('uColor'), color[0], color[1], color[2]);
      scissorTo(dye.read, x, y, ext / aspect, ext);
      blit(dye.read);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
    }

    // ---- bloom: threshold, blur down a mip chain, add back up ----
    function applyBloom() {
      let u = use(P.bloomPrefilter);
      const k = params.bloomThreshold * params.bloomKnee + 1e-4;
      gl.uniform3f(u('uCurve'), params.bloomThreshold - k, k * 2, 0.25 / k);
      gl.uniform1f(u('uThreshold'), params.bloomThreshold);
      gl.uniform1i(u('uTex'), dye.read.attach(0));
      blit(bloom);

      u = use(P.bloomBlur);
      let last = bloom;
      for (const mip of bloomMips) {
        gl.uniform2fv(u('uTexel'), last.texel);
        gl.uniform1i(u('uTex'), last.attach(0));
        blit(mip);
        last = mip;
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = bloomMips.length - 2; i >= 0; i--) {
        gl.uniform2fv(u('uTexel'), last.texel);
        gl.uniform1i(u('uTex'), last.attach(0));
        blit(bloomMips[i]);
        last = bloomMips[i];
      }
      gl.disable(gl.BLEND);

      u = use(P.bloomFinal);
      gl.uniform2fv(u('uTexel'), last.texel);
      gl.uniform1i(u('uTex'), last.attach(0));
      gl.uniform1f(u('uIntensity'), params.bloomIntensity);
      blit(bloom);
    }

    function render(time) {
      const bloomOn = params.bloom && !params.paper && bloomMips.length > 0;
      if (bloomOn) applyBloom();
      gl.disable(gl.BLEND);
      const u = use(P.display);
      gl.uniform1i(u('uDye'), dye.read.attach(0));
      gl.uniform1i(u('uBloom'), bloom.attach(1));
      gl.uniform2fv(u('uDyeTexel'), dye.read.texel);
      gl.uniform3fv(u('uBg'), params.bg);
      gl.uniform1f(u('uPaper'), params.paper ? 1 : 0);
      gl.uniform1f(u('uBloomOn'), bloomOn ? 1 : 0);
      gl.uniform1f(u('uExposure'), params.exposure);
      gl.uniform1f(u('uRelief'), params.relief);
      gl.uniform1f(u('uAspect'), gl.drawingBufferWidth / gl.drawingBufferHeight);
      gl.uniform1f(u('uTime'), time);
      blit(null);
    }

    function clear() {
      gl.clearColor(0, 0, 0, 1);
      for (const t of [dye.read, dye.write, velocity.read, velocity.write, pressure.read, pressure.write]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }

    buildTargets();

    return {
      gl, params, step, splat, render, resize, setResolution, clear,
      get simShort() { return Math.min(velocity.read.w, velocity.read.h); },
    };
  }

  root.LiquidFluid = Object.freeze({ create });
})(window);
