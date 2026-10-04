/* =====================================================================
   Collision · render.js — WebGL2 engine: transform-feedback star
   integration (ping-pong buffers), HDR sprite rendering, dust extinction,
   dual-filter bloom and the final grade. Exposes window.CollisionRenderer.
   ===================================================================== */
(function (root) {
  'use strict';

  const SH = root.CollisionShaders;
  const MAX_PATH = root.CollisionSim.MAX_PATH;
  const BLOOM_LEVELS = 6;
  const STATE_STRIDE = 24; // vec3 position + vec3 velocity
  const INFO_STRIDE = 16;  // vec4 population, galaxy, luminosity, seed

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('Shader compile failed: ' + log);
    }
    return sh;
  }

  function makeProgram(gl, vsSrc, fsSrc, varyings) {
    const p = gl.createProgram();
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    if (varyings) gl.transformFeedbackVaryings(p, varyings, gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(p);
    gl.detachShader(p, vs);
    gl.detachShader(p, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
    }
    const cache = new Map();
    const u = (name) => {
      if (!cache.has(name)) cache.set(name, gl.getUniformLocation(p, name));
      return cache.get(name);
    };
    return { p, u };
  }

  const withDefine = (src, def) => src.replace('#version 300 es\n', `#version 300 es\n#define ${def}\n`);

  // ---- procedural deep-field backdrop --------------------------------------
  function buildSky(rand) {
    const stars = 1500, bright = 6, gals = 220;
    const n = stars + bright + gals;
    const data = new Float32Array(n * 10);
    let o = 0;
    const dir = () => {
      const z = rand() * 2 - 1, a = rand() * Math.PI * 2, s = Math.sqrt(1 - z * z);
      data[o] = s * Math.cos(a); data[o + 1] = z; data[o + 2] = s * Math.sin(a);
    };
    const put = (r, g, b, kind, size, angle, ratio) => {
      data[o + 3] = r; data[o + 4] = g; data[o + 5] = b;
      data[o + 6] = kind; data[o + 7] = size; data[o + 8] = angle; data[o + 9] = ratio;
      o += 10;
    };
    // stellar colours from cool orange through white to hot blue-white
    const temp = (t, k) => {
      if (t < 0.5) { const u = t * 2; return [k, k * (0.68 + 0.27 * u), k * (0.45 + 0.45 * u)]; }
      const u = (t - 0.5) * 2;
      return [k * (1 - 0.22 * u), k * (0.95 - 0.08 * u), k * (0.9 + 0.1 * u)];
    };
    for (let i = 0; i < stars; i++) {
      dir();
      const k = 0.006 * Math.pow(1 - rand(), -1.1);
      const c = temp(rand(), Math.min(k, 0.6));
      put(c[0], c[1], c[2], 0, 4.2 + 1.6 * rand(), 0, 1);
    }
    for (let i = 0; i < bright; i++) {
      dir();
      const c = temp(0.25 + 0.7 * rand(), 0.5 + 1.2 * rand());
      put(c[0], c[1], c[2], 1, 70 + 90 * rand(), 0, 1);
    }
    for (let i = 0; i < gals; i++) {
      dir();
      const t = rand(), k = 0.02 + 0.08 * Math.pow(rand(), 2);
      const c = t < 0.45 ? [k, k * 0.74, k * 0.5] : t < 0.8 ? [k * 0.78, k * 0.84, k] : [k, k * 0.55, k * 0.42];
      put(c[0], c[1], c[2], 2, 3.2 + 7 * Math.pow(rand(), 3), rand() * Math.PI, 0.25 + 0.75 * rand());
    }
    return { data, count: n };
  }

  function create(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) return { error: 'webgl2' };
    const floatRT = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
    if (!floatRT) return { error: 'float' };

    // ---- render targets ------------------------------------------------------
    function makeTarget(w, h) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fbo, w, h, ok };
    }
    function freeTarget(t) {
      if (!t) return;
      gl.deleteFramebuffer(t.fbo);
      gl.deleteTexture(t.tex);
    }
    const probe = makeTarget(4, 4);
    freeTarget(probe);
    if (!probe.ok) return { error: 'float' };

    let progs;
    try {
      progs = {
        integrate: makeProgram(gl, SH.integrateVS, SH.discardFS, ['vPos', 'vVel']),
        stars: makeProgram(gl, SH.spriteVS, SH.spriteFS),
        dust: makeProgram(gl, withDefine(SH.spriteVS, 'DUST'), SH.spriteFS),
        sky: makeProgram(gl, SH.skyVS, SH.skyFS),
        nuclei: makeProgram(gl, SH.fullVS, SH.nucleiFS),
        down: makeProgram(gl, SH.fullVS, SH.downFS),
        up: makeProgram(gl, SH.fullVS, SH.upFS),
        composite: makeProgram(gl, SH.fullVS, SH.compositeFS),
      };
    } catch (err) {
      return { error: 'shader', detail: String(err && err.message) };
    }

    // ---- particle buffers ------------------------------------------------------
    const state = [gl.createBuffer(), gl.createBuffer()];
    const info = gl.createBuffer();
    const vaoInt = [gl.createVertexArray(), gl.createVertexArray()];
    const vaoDraw = [gl.createVertexArray(), gl.createVertexArray()];
    const tf = gl.createTransformFeedback();
    let capacity = 0, cur = 0;

    function allocate(n) {
      capacity = n;
      cur = 0;
      for (let i = 0; i < 2; i++) {
        gl.bindBuffer(gl.ARRAY_BUFFER, state[i]);
        gl.bufferData(gl.ARRAY_BUFFER, n * STATE_STRIDE, gl.DYNAMIC_COPY);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, info);
      gl.bufferData(gl.ARRAY_BUFFER, n * INFO_STRIDE, gl.STATIC_DRAW);
      for (let i = 0; i < 2; i++) {
        gl.bindVertexArray(vaoInt[i]);
        gl.bindBuffer(gl.ARRAY_BUFFER, state[i]);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STATE_STRIDE, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STATE_STRIDE, 12);
        gl.bindVertexArray(vaoDraw[i]);
        gl.bindBuffer(gl.ARRAY_BUFFER, state[i]);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STATE_STRIDE, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, info);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 4, gl.FLOAT, false, INFO_STRIDE, 0);
      }
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    // Write particles [start, start + count) into the live buffer.
    function upload(start, stateData, infoData, count) {
      gl.bindBuffer(gl.ARRAY_BUFFER, state[cur]);
      gl.bufferSubData(gl.ARRAY_BUFFER, start * STATE_STRIDE, stateData, start * 6, count * 6);
      gl.bindBuffer(gl.ARRAY_BUFFER, info);
      gl.bufferSubData(gl.ARRAY_BUFFER, start * INFO_STRIDE, infoData, start * 4, count * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    // ---- core path texture ---------------------------------------------------
    const pathTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, pathTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, MAX_PATH, 3);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // Advance stars [0, count) by `steps` leapfrog steps of length h.
    function integrate(path, masses, steps, h, count) {
      gl.bindTexture(gl.TEXTURE_2D, pathTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_PATH, 3, gl.RGBA, gl.FLOAT, path);
      const P = progs.integrate;
      gl.useProgram(P.p);
      gl.uniform1i(P.u('uPath'), 0);
      gl.uniform4fv(P.u('uMass'), masses);
      gl.uniform1i(P.u('uSteps'), steps);
      gl.uniform1f(P.u('uH'), h);
      gl.bindVertexArray(vaoInt[cur]);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, state[1 - cur]);
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.endTransformFeedback();
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      gl.bindVertexArray(null);
      cur = 1 - cur;
    }

    // ---- sky -------------------------------------------------------------------
    const sky = buildSky(root.CollisionSim.rng(20250704));
    const skyBuf = gl.createBuffer();
    const vaoSky = gl.createVertexArray();
    gl.bindVertexArray(vaoSky);
    gl.bindBuffer(gl.ARRAY_BUFFER, skyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, sky.data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 40, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 40, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 40, 24);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const vaoEmpty = gl.createVertexArray();

    // ---- targets: HDR scene, half-res dust opacity, bloom pyramid -----------
    let W = 0, H = 0, scene = null, dust = null, bloom = [];
    function resize(w, h) {
      w = Math.max(16, w | 0);
      h = Math.max(16, h | 0);
      if (w === W && h === H) return;
      W = w; H = h;
      canvas.width = w;
      canvas.height = h;
      freeTarget(scene);
      freeTarget(dust);
      bloom.forEach(freeTarget);
      scene = makeTarget(w, h);
      dust = makeTarget(Math.max(8, w >> 1), Math.max(8, h >> 1));
      bloom = [];
      for (let i = 1; i <= BLOOM_LEVELS; i++) bloom.push(makeTarget(Math.max(4, w >> i), Math.max(4, h >> i)));
    }

    function bindTarget(t) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
      gl.viewport(0, 0, t ? t.w : W, t ? t.h : H);
    }
    function drawFull() {
      gl.bindVertexArray(vaoEmpty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    function setSpriteUniforms(P, f) {
      gl.uniformMatrix4fv(P.u('uView'), false, f.view);
      gl.uniformMatrix4fv(P.u('uProj'), false, f.proj);
      gl.uniform1f(P.u('uFocal'), f.focal);
      gl.uniform1f(P.u('uGain'), f.gain);
      gl.uniform1f(P.u('uRefDepth'), f.refDepth);
      gl.uniform2f(P.u('uSigmaPx'), f.sigmaMin, f.sigmaMax);
      gl.uniform3fv(P.u('uGalC'), f.galC);
      gl.uniform3fv(P.u('uGalU'), f.galU);
      gl.uniform3fv(P.u('uGalV'), f.galV);
      gl.uniform3fv(P.u('uGalTint'), f.galTint);
      gl.uniform4fv(P.u('uGalArm'), f.galArm);
      gl.uniform1fv(P.u('uGalInner'), f.galInner);
      gl.uniform2f(P.u('uBoost'), f.boostYoung, f.boostHII);
      gl.uniform1f(P.u('uTag'), f.tag);
    }

    // f: per-frame description assembled by the app (persistent, mutated in place).
    function render(f) {
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);

      // 1. HDR scene: backdrop, stars, nuclei (additive)
      bindTarget(scene);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      let P = progs.sky;
      gl.useProgram(P.p);
      gl.uniformMatrix4fv(P.u('uSky'), false, f.sky);
      gl.uniform1f(P.u('uPx'), f.pxScale);
      gl.uniform1f(P.u('uSpike'), 0.42);
      gl.bindVertexArray(vaoSky);
      gl.drawArrays(gl.POINTS, 0, sky.count);

      P = progs.stars;
      gl.useProgram(P.p);
      setSpriteUniforms(P, f);
      gl.bindVertexArray(vaoDraw[cur]);
      for (let i = 0; i < f.ranges.length; i++) {
        const r = f.ranges[i];
        if (r.on) gl.drawArrays(gl.POINTS, r.start, r.stars);
      }

      P = progs.nuclei;
      gl.useProgram(P.p);
      gl.uniform4fv(P.u('uNuc'), f.nuclei);
      drawFull();

      // 2. dust opacity at half resolution
      bindTarget(dust);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (f.dustK > 0) {
        P = progs.dust;
        gl.useProgram(P.p);
        setSpriteUniforms(P, f);
        gl.uniform1f(P.u('uFocal'), f.focal * dust.w / W);
        gl.bindVertexArray(vaoDraw[cur]);
        for (let i = 0; i < f.ranges.length; i++) {
          const r = f.ranges[i];
          if (r.on && r.dust > 0) gl.drawArrays(gl.POINTS, r.start + r.stars, r.dust);
        }
      }
      gl.disable(gl.BLEND);

      // 3. bloom pyramid: downsample (with extinction on the first level) …
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, dust.tex);
      gl.activeTexture(gl.TEXTURE0);
      P = progs.down;
      gl.useProgram(P.p);
      gl.uniform1i(P.u('uSrc'), 0);
      gl.uniform1i(P.u('uDust'), 1);
      let src = scene;
      for (let i = 0; i < BLOOM_LEVELS; i++) {
        bindTarget(bloom[i]);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.uniform2f(P.u('uTexel'), 1 / src.w, 1 / src.h);
        gl.uniform1f(P.u('uDustK'), i === 0 ? f.dustK : 0);
        drawFull();
        src = bloom[i];
      }
      // … then upsample, adding each level onto the next larger one
      P = progs.up;
      gl.useProgram(P.p);
      gl.uniform1i(P.u('uSrc'), 0);
      gl.uniform1f(P.u('uGain'), 1);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
        bindTarget(bloom[i - 1]);
        gl.bindTexture(gl.TEXTURE_2D, bloom[i].tex);
        gl.uniform2f(P.u('uTexel'), 0.5 / bloom[i].w, 0.5 / bloom[i].h);
        drawFull();
      }
      gl.disable(gl.BLEND);

      // 4. composite to the canvas
      bindTarget(null);
      P = progs.composite;
      gl.useProgram(P.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, scene.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, dust.tex);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, bloom[0].tex);
      gl.uniform1i(P.u('uScene'), 0);
      gl.uniform1i(P.u('uDust'), 1);
      gl.uniform1i(P.u('uBloom'), 2);
      gl.uniform1f(P.u('uDustK'), f.dustK);
      gl.uniform1f(P.u('uBloomK'), f.bloomK);
      gl.uniform1f(P.u('uExposure'), f.exposure);
      gl.uniform1f(P.u('uStretch'), f.stretch);
      gl.uniform1f(P.u('uFade'), f.fade);
      gl.uniform2f(P.u('uAspect'), W / Math.max(W, H), H / Math.max(W, H));
      gl.uniform1f(P.u('uSeed'), f.seed);
      drawFull();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindVertexArray(null);
    }

    function dispose() {
      freeTarget(scene);
      freeTarget(dust);
      bloom.forEach(freeTarget);
      [state[0], state[1], info, skyBuf].forEach((b) => gl.deleteBuffer(b));
      [vaoInt[0], vaoInt[1], vaoDraw[0], vaoDraw[1], vaoSky, vaoEmpty].forEach((v) => gl.deleteVertexArray(v));
      gl.deleteTransformFeedback(tf);
      gl.deleteTexture(pathTex);
      Object.values(progs).forEach((P) => gl.deleteProgram(P.p));
    }

    return {
      gl, allocate, upload, integrate, resize, render, dispose,
      get capacity() { return capacity; },
      get width() { return W; },
      get height() { return H; },
    };
  }

  root.CollisionRenderer = Object.freeze({ create });
})(window);
