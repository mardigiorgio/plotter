/* geometry.js — builds THREE objects from compiled evaluators.
 * All builders take (…, win, style) where win = {xmin..zmax, diag} and
 * style = {color, opacity, mesh}.
 */
(function () {
  'use strict';
  var P = window.P = window.P || {};
  var G = P.geom = {};

  function surfaceMaterial(style) {
    var mat = new THREE.MeshPhongMaterial({
      color: style.color,
      side: THREE.DoubleSide,
      transparent: style.opacity < 1,
      opacity: style.opacity,
      shininess: 45,
      specular: 0x222222,
      depthWrite: style.opacity >= 0.99
    });
    mat._styleOpacity = true; // participates in live opacity adjustment
    return mat;
  }
  function solidMaterial(style, shininess) {
    var op = style.opacity !== undefined ? style.opacity : 1;
    var mat = new THREE.MeshPhongMaterial({
      color: style.color, shininess: shininess || 40,
      transparent: op < 1, opacity: op
    });
    mat._styleOpacity = true;
    return mat;
  }

  /* ---------- generic parametric grid surface ---------- */
  // fn(u,v) → [x,y,z]; invalid (non-finite / far outside) vertices break the mesh there.
  // Window handling: vertices moderately outside the box are clamped onto its
  // walls; cells whose 4 corners are ALL clamped are dropped (so surfaces end
  // cleanly at the box instead of smearing across it); vertices far outside
  // (asymptotes) are invalid so no cell bridges the box.
  G.clampBox = function (p, win) {
    // returns 0 = inside, 1 = clamped onto wall, 2 = far outside
    var state = 0, lo, hi, far, v;
    lo = win.xmin; hi = win.xmax; far = (hi - lo) * 0.5; v = p[0];
    if (v < lo - far || v > hi + far) return 2;
    if (v < lo) { p[0] = lo; state = 1; } else if (v > hi) { p[0] = hi; state = 1; }
    lo = win.ymin; hi = win.ymax; far = (hi - lo) * 0.5; v = p[1];
    if (v < lo - far || v > hi + far) return 2;
    if (v < lo) { p[1] = lo; state = 1; } else if (v > hi) { p[1] = hi; state = 1; }
    lo = win.zmin; hi = win.zmax; far = (hi - lo) * 0.5; v = p[2];
    if (v < lo - far || v > hi + far) return 2;
    if (v < lo) { p[2] = lo; state = 1; } else if (v > hi) { p[2] = hi; state = 1; }
    return state;
  };

  G.paramSurface = function (fn, u0, u1, v0, v1, nu, nv, win, style) {
    var nverts = (nu + 1) * (nv + 1);
    var pos = new Float32Array(nverts * 3);
    var valid = new Uint8Array(nverts);   // 1 = usable
    var clamped = new Uint8Array(nverts); // 1 = pressed onto a wall
    var i, j, k = 0;

    for (j = 0; j <= nv; j++) {
      var vv = v0 + (v1 - v0) * j / nv;
      for (i = 0; i <= nu; i++, k++) {
        var uu = u0 + (u1 - u0) * i / nu;
        var p;
        try { p = fn(uu, vv); } catch (e) { p = null; }
        if (!p || !isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2])) continue;
        var st = G.clampBox(p, win);
        if (st === 2) continue;
        if (st === 1) clamped[k] = 1;
        pos[k * 3] = p[0]; pos[k * 3 + 1] = p[1]; pos[k * 3 + 2] = p[2];
        valid[k] = 1;
      }
    }
    // Domain-edge refinement: an unusable vertex next to a usable one is
    // snapped to the last usable parameter (found by bisection), so surfaces
    // with asymptotes or domain boundaries (ln, 1/x, sqrt) reach the box
    // instead of stopping at the nearest grid column.
    var usable = function (uu, vv, out) {
      var p;
      try { p = fn(uu, vv); } catch (e) { return false; }
      if (!p || !isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2])) return false;
      var st = G.clampBox(p, win);
      if (st === 2) return false;
      out.p = p;
      out.cl = st === 1;
      return true;
    };
    var valid0 = valid.slice();
    var out = {};
    var refine = nu > 24 && nv > 24; // skip during coarse gesture rebuilds
    for (j = 0; refine && j <= nv; j++) {
      for (i = 0; i <= nu; i++) {
        k = j * (nu + 1) + i;
        if (valid0[k]) continue;
        var ni = -1, nj = -1;
        if (i > 0 && valid0[k - 1]) { ni = i - 1; nj = j; }
        else if (i < nu && valid0[k + 1]) { ni = i + 1; nj = j; }
        else if (j > 0 && valid0[k - (nu + 1)]) { ni = i; nj = j - 1; }
        else if (j < nv && valid0[k + (nu + 1)]) { ni = i; nj = j + 1; }
        if (ni === -1) continue;
        var au = u0 + (u1 - u0) * ni / nu, av = v0 + (v1 - v0) * nj / nv; // usable end
        var bu = u0 + (u1 - u0) * i / nu, bv = v0 + (v1 - v0) * j / nv;  // unusable end
        for (var it = 0; it < 18; it++) {
          var mu = (au + bu) / 2, mv = (av + bv) / 2;
          if (usable(mu, mv, out)) { au = mu; av = mv; }
          else { bu = mu; bv = mv; }
        }
        if (usable(au, av, out)) {
          pos[k * 3] = out.p[0]; pos[k * 3 + 1] = out.p[1]; pos[k * 3 + 2] = out.p[2];
          valid[k] = 1;
          clamped[k] = out.cl ? 1 : 0;
        }
      }
    }

    var indices = [];
    for (j = 0; j < nv; j++) {
      for (i = 0; i < nu; i++) {
        var a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
        if (valid[a] && valid[b] && valid[c] && valid[d] &&
            (clamped[a] + clamped[b] + clamped[c] + clamped[d] < 4)) {
          indices.push(a, b, d, a, d, c);
        }
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    var mesh = new THREE.Mesh(geo, surfaceMaterial(style));
    var group = new THREE.Group();
    group.add(mesh);
    if (style.mesh) group.add(G.gridLines(fn, u0, u1, v0, v1, win, nu <= 24 || nv <= 24));
    return group;
  };

  /* coarse parameter-space grid lines drawn on the surface */
  G.gridLines = function (fn, u0, u1, v0, v1, win, coarse) {
    var pts = [];
    var NL = coarse ? 6 : 12, NS = coarse ? 16 : 48; // lines each way, segments per line
    function sample(uu, vv) {
      var p;
      try { p = fn(uu, vv); } catch (e) { return null; }
      if (!p || !isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2])) return null;
      var st = G.clampBox(p, win);
      if (st === 2) return null;
      return { p: p, cl: st === 1 };
    }
    function addLine(fixedU, t) {
      var prev = null;
      for (var s = 0; s <= NS; s++) {
        var q = s / NS;
        var smp = fixedU ? sample(t, v0 + (v1 - v0) * q) : sample(u0 + (u1 - u0) * q, t);
        if (smp && prev && !(smp.cl && prev.cl)) {
          pts.push(prev.p[0], prev.p[1], prev.p[2], smp.p[0], smp.p[1], smp.p[2]);
        }
        prev = smp;
      }
    }
    for (var li = 0; li <= NL; li++) {
      addLine(true, u0 + (u1 - u0) * li / NL);
      addLine(false, v0 + (v1 - v0) * li / NL);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    var mat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 });
    return new THREE.LineSegments(geo, mat);
  };

  /* ---------- spec-specific surface builders ---------- */
  G.graph = function (fn, axis, mode, win, style, res) {
    var n = res || 64;
    if (mode === 'polar') {
      var rmax = Math.hypot(Math.max(Math.abs(win.xmin), win.xmax), Math.max(Math.abs(win.ymin), win.ymax));
      return G.paramSurface(function (s, th) {
        return [s * Math.cos(th), s * Math.sin(th), fn(s, th)];
      }, 0, rmax, 0, 2 * Math.PI, n, n, win, style);
    }
    if (axis === 'z') return G.paramSurface(function (x, y) { return [x, y, fn(x, y)]; }, win.xmin, win.xmax, win.ymin, win.ymax, n, n, win, style);
    if (axis === 'x') return G.paramSurface(function (y, z) { return [fn(y, z), y, z]; }, win.ymin, win.ymax, win.zmin, win.zmax, n, n, win, style);
    return G.paramSurface(function (x, z) { return [x, fn(x, z), z]; }, win.xmin, win.xmax, win.zmin, win.zmax, n, n, win, style);
  };

  G.cyl = function (fn, win, style, res) { // r = f(theta, z)
    var n = res || 64;
    return G.paramSurface(function (th, z) {
      var r = fn(th, z);
      return [r * Math.cos(th), r * Math.sin(th), z];
    }, 0, 2 * Math.PI, win.zmin, win.zmax, n, n, win, style);
  };

  G.thetaSurf = function (fn, win, style, res) { // theta = f(r, z)
    var n = res || 48;
    var rmax = Math.hypot(Math.max(Math.abs(win.xmin), win.xmax), Math.max(Math.abs(win.ymin), win.ymax));
    return G.paramSurface(function (s, z) {
      var th = fn(s, z);
      return [s * Math.cos(th), s * Math.sin(th), z];
    }, 0, rmax, win.zmin, win.zmax, n, n, win, style);
  };

  G.sph = function (fn, win, style, res) { // rho = f(phi, theta)
    var n = res || 64;
    return G.paramSurface(function (ph, th) {
      var rho = fn(ph, th);
      var sp = Math.sin(ph);
      return [rho * sp * Math.cos(th), rho * sp * Math.sin(th), rho * Math.cos(ph)];
    }, 0, Math.PI, 0, 2 * Math.PI, n, n, win, style);
  };

  G.phiSurf = function (fn, win, style, res) { // phi = f(rho, theta)
    var n = res || 48;
    var rmax = win.diag * 0.6;
    return G.paramSurface(function (s, th) {
      var ph = fn(s, th);
      var sp = Math.sin(ph);
      return [s * sp * Math.cos(th), s * sp * Math.sin(th), s * Math.cos(ph)];
    }, 0, rmax, 0, 2 * Math.PI, n, n, win, style);
  };

  G.psurf = function (fn, dom, win, style, res) { // (x(u,v), y(u,v), z(u,v))
    var n = res || 64;
    return G.paramSurface(function (u, v) { return fn(u, v); },
      dom.u0, dom.u1, dom.v0, dom.v1, n, n, win, style);
  };

  /* ---------- space curve ---------- */
  G.curve = function (fn, t0, t1, win, style, segs, flat) {
    var N = segs ? 120 : 400, limit = win.diag * 2.5;
    var samples = [], allOk = true;
    for (var i = 0; i <= N; i++) {
      var t = t0 + (t1 - t0) * i / N, p;
      try { p = fn(t); } catch (e) { p = null; }
      var ok = p && isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]) &&
               Math.abs(p[0]) < limit && Math.abs(p[1]) < limit && Math.abs(p[2]) < limit;
      samples.push(ok ? p : null);
      if (!ok) allOk = false;
    }
    if (allOk && flat) {
      var planar = true;
      for (var fi = 0; fi <= N && planar; fi++) {
        if (Math.abs(samples[fi][2]) > win.diag * 1e-6) planar = false;
      }
      if (planar) return G.flatRibbon([samples], 2, 0, win, style);
    }
    if (allOk) {
      var curveObj = new THREE.Curve();
      // lerp the samples we already have instead of re-calling fn
      curveObj.getPoint = function (q, target) {
        var x = q * N, i0 = Math.min(Math.floor(x), N - 1), f = x - i0;
        var a2 = samples[i0], b2 = samples[i0 + 1];
        return (target || new THREE.Vector3()).set(
          a2[0] + (b2[0] - a2[0]) * f, a2[1] + (b2[1] - a2[1]) * f, a2[2] + (b2[2] - a2[2]) * f);
      };
      curveObj.arcLengthDivisions = segs ? 60 : 200;
      var tube = new THREE.TubeGeometry(curveObj, segs || 300, win.diag * 0.0022, segs ? 6 : 8, false);
      return new THREE.Mesh(tube, surfaceMaterial({ color: style.color, opacity: style.opacity }));
    }
    // gaps → polyline segments
    var pts = [];
    for (var j = 0; j < N; j++) {
      if (samples[j] && samples[j + 1]) {
        pts.push(samples[j][0], samples[j][1], samples[j][2],
                 samples[j + 1][0], samples[j + 1][1], samples[j + 1][2]);
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: style.color, transparent: style.opacity < 1, opacity: style.opacity }));
  };

  /* ---------- point / label ---------- */
  G.point = function (p, win, style) {
    var geo = new THREE.SphereGeometry(win.diag * 0.011, 20, 14);
    var mesh = new THREE.Mesh(geo, solidMaterial(style, 60));
    mesh.position.set(p[0], p[1], p[2]);
    return mesh;
  };

  var spriteCache = new Map(); // text+style → {tex, w, h}; textures are shared
  G.clearSpriteCache = function () {
    spriteCache.forEach(function (e) { e.tex.dispose(); });
    spriteCache.clear();
  };
  G.textSprite = function (text, opts) {
    opts = opts || {};
    var key = text + '|' + (opts.italic ? 1 : 0) + (opts.serif ? 1 : 0) + '|' +
      (opts.color || '') + '|' + (opts.haloColor || '');
    var entry = spriteCache.get(key);
    if (!entry) {
      var fontPx = 46;
      var font = opts.italic ? 'italic 500 ' + fontPx + 'px Georgia, serif'
        : opts.serif ? '500 ' + fontPx + 'px Georgia, serif'
        : '500 ' + fontPx + 'px system-ui, sans-serif';
      var canvas = document.createElement('canvas');
      var c2 = canvas.getContext('2d');
      c2.font = font;
      var w = Math.ceil(c2.measureText(text).width) + 16;
      var h = fontPx + 18;
      canvas.width = w; canvas.height = h;
      c2 = canvas.getContext('2d');
      c2.font = font;
      c2.textBaseline = 'middle';
      if (opts.halo !== false) {
        c2.lineWidth = 8; c2.strokeStyle = opts.haloColor || 'rgba(255,255,255,0.9)';
        c2.strokeText(text, 8, h / 2);
      }
      c2.fillStyle = opts.color || '#333';
      c2.fillText(text, 8, h / 2);
      var tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearFilter;
      tex._shared = true; // never disposed by scene teardown, only by clearSpriteCache
      if (spriteCache.size > 400) G.clearSpriteCache();
      entry = { tex: tex, w: w, h: h };
      spriteCache.set(key, entry);
    }
    var mat = new THREE.SpriteMaterial({ map: entry.tex, depthTest: false, transparent: true });
    var sp = new THREE.Sprite(mat);
    var worldH = (opts.worldH || 0.36);
    sp.scale.set(worldH * entry.w / entry.h, worldH, 1);
    sp.renderOrder = 999;
    return sp;
  };

  G.pointLabel = function (p, text, win, style) {
    var sp = G.textSprite(text, { color: style.color, worldH: win.diag * 0.028 });
    sp.position.set(p[0], p[1], p[2]);
    sp.center.set(-0.12, -0.25); // offset label up-right of the point
    return sp;
  };

  /* ---------- vector arrow ---------- */
  G.arrow = function (from, to, win, style, thin) {
    var group = new THREE.Group();
    var dir = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    var len = dir.length();
    if (len < 1e-9) return group;
    dir.normalize();
    var q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    var headLen = Math.min(len * 0.35, win.diag * 0.03);
    var shaftR = win.diag * (thin ? 0.0035 : 0.005);
    var mat = solidMaterial(style, 40);
    var shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, len - headLen, 8), mat);
    shaft.quaternion.copy(q);
    shaft.position.set(
      from[0] + dir.x * (len - headLen) / 2,
      from[1] + dir.y * (len - headLen) / 2,
      from[2] + dir.z * (len - headLen) / 2);
    var head = new THREE.Mesh(new THREE.ConeGeometry(headLen * 0.45, headLen, 12), mat);
    head.quaternion.copy(q);
    head.position.set(
      from[0] + dir.x * (len - headLen / 2),
      from[1] + dir.y * (len - headLen / 2),
      from[2] + dir.z * (len - headLen / 2));
    group.add(shaft, head);
    return group;
  };

  /* ---------- vector field ---------- */
  G.vfield = function (fn, is2D, win, style, density) {
    var n = density || 6;
    var xs = [], ys = [], zs = [];
    for (var i = 0; i < n; i++) {
      xs.push(win.xmin + (win.xmax - win.xmin) * (i + 0.5) / n);
      ys.push(win.ymin + (win.ymax - win.ymin) * (i + 0.5) / n);
      zs.push(win.zmin + (win.zmax - win.zmin) * (i + 0.5) / n);
    }
    if (is2D) zs = [0];
    var samples = [];
    var maxMag = 0;
    xs.forEach(function (x) {
      ys.forEach(function (y) {
        zs.forEach(function (z) {
          var v;
          try { v = is2D ? fn(x, y) : fn(x, y, z); } catch (e) { v = null; }
          if (!v) return;
          var vx = v[0], vy = v[1], vz = is2D ? (v[2] || 0) : v[2];
          if (is2D && v.length === 2) vz = 0;
          if (!isFinite(vx) || !isFinite(vy) || !isFinite(vz)) return;
          var m = Math.sqrt(vx * vx + vy * vy + vz * vz);
          if (m > maxMag) maxMag = m;
          samples.push([x, y, z, vx, vy, vz, m]);
        });
      });
    });
    var group = new THREE.Group();
    if (!samples.length || maxMag === 0) return group;
    var cell = Math.min((win.xmax - win.xmin), (win.ymax - win.ymin), (win.zmax - win.zmin)) / n;
    var scale = cell * 0.9 / maxMag;
    var minLen = cell * 0.12;

    var count = samples.length;
    var mat = solidMaterial(style, 30);
    var shaftGeo = new THREE.CylinderGeometry(1, 1, 1, 6);
    shaftGeo.translate(0, 0.5, 0); // base at origin, +Y unit length
    var headGeo = new THREE.ConeGeometry(1, 1, 8);
    headGeo.translate(0, 0.5, 0);
    var shafts = new THREE.InstancedMesh(shaftGeo, mat, count);
    var heads = new THREE.InstancedMesh(headGeo, mat, count);
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0),
        d = new THREE.Vector3(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
    var shaftR = Math.max(win.diag * 0.0022, cell * 0.012);
    for (var k = 0; k < count; k++) {
      var s = samples[k];
      var len = Math.max(s[6] * scale, minLen);
      d.set(s[3], s[4], s[5]).normalize();
      q.setFromUnitVectors(up, d);
      var headLen = Math.min(len * 0.4, cell * 0.28);
      var shaftLen = len - headLen;
      pos.set(s[0] - d.x * len / 2, s[1] - d.y * len / 2, s[2] - d.z * len / 2); // centered on sample
      scl.set(shaftR, shaftLen, shaftR);
      m4.compose(pos, q, scl);
      shafts.setMatrixAt(k, m4);
      pos.set(s[0] + d.x * (len / 2 - headLen), s[1] + d.y * (len / 2 - headLen), s[2] + d.z * (len / 2 - headLen));
      scl.set(headLen * 0.42, headLen, headLen * 0.42);
      m4.compose(pos, q, scl);
      heads.setMatrixAt(k, m4);
    }
    group.add(shafts, heads);
    return group;
  };

  /* ---------- implicit surfaces & regions: marching tetrahedra ---------- */
  // F(x,y,z) compiled; returns BufferGeometry of F = 0 within window (pad cells for regions).
  G.marchingTetra = function (F, win, N, pad) {
    N = N || 40;
    var padCells = pad ? 1 : 0;
    var nx = N + 1 + 2 * padCells;
    var hx = (win.xmax - win.xmin) / N, hy = (win.ymax - win.ymin) / N, hz = (win.zmax - win.zmin) / N;
    var x0 = win.xmin - padCells * hx, y0 = win.ymin - padCells * hy, z0 = win.zmin - padCells * hz;
    var vals = new Float32Array(nx * nx * nx);
    var i, j, k, idx = 0;
    for (k = 0; k < nx; k++) {
      var z = z0 + k * hz;
      for (j = 0; j < nx; j++) {
        var y = y0 + j * hy;
        for (i = 0; i < nx; i++, idx++) {
          var v;
          try { v = F(x0 + i * hx, y, z); } catch (e) { v = NaN; }
          vals[idx] = v;
        }
      }
    }
    function at(i2, j2, k2) { return vals[(k2 * nx + j2) * nx + i2]; }

    var positions = [];
    // cube corner offsets
    var CO = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
    var TETS = [[0,1,2,6],[0,2,3,6],[0,3,7,6],[0,7,4,6],[0,4,5,6],[0,5,1,6]];
    var cp = new Float64Array(24), cv = new Float64Array(8);

    function interp(a, b) {
      var va = cv[a], vb = cv[b];
      var t = va / (va - vb);
      if (!isFinite(t)) t = 0.5;
      t = Math.max(0, Math.min(1, t));
      positions.push(
        cp[a * 3] + (cp[b * 3] - cp[a * 3]) * t,
        cp[a * 3 + 1] + (cp[b * 3 + 1] - cp[a * 3 + 1]) * t,
        cp[a * 3 + 2] + (cp[b * 3 + 2] - cp[a * 3 + 2]) * t);
    }
    function tri(a1, b1, a2, b2, a3, b3) { interp(a1, b1); interp(a2, b2); interp(a3, b3); }

    for (k = 0; k < nx - 1; k++) {
      for (j = 0; j < nx - 1; j++) {
        for (i = 0; i < nx - 1; i++) {
          var m, bad = false, allNeg = true, allPos = true;
          for (m = 0; m < 8; m++) {
            var vv = at(i + CO[m][0], j + CO[m][1], k + CO[m][2]);
            if (!isFinite(vv)) { bad = true; break; }
            cv[m] = vv;
            if (vv < 0) allPos = false; else allNeg = false;
          }
          if (bad || allNeg || allPos) continue;
          for (m = 0; m < 8; m++) {
            cp[m * 3] = x0 + (i + CO[m][0]) * hx;
            cp[m * 3 + 1] = y0 + (j + CO[m][1]) * hy;
            cp[m * 3 + 2] = z0 + (k + CO[m][2]) * hz;
          }
          for (var tIdx = 0; tIdx < 6; tIdx++) {
            var T = TETS[tIdx];
            var a = T[0], b = T[1], c = T[2], d = T[3];
            var code = (cv[a] < 0 ? 1 : 0) | (cv[b] < 0 ? 2 : 0) | (cv[c] < 0 ? 4 : 0) | (cv[d] < 0 ? 8 : 0);
            switch (code) {
              case 0: case 15: break;
              case 1: case 14: tri(a, b, a, c, a, d); break;
              case 2: case 13: tri(b, a, b, c, b, d); break;
              case 4: case 11: tri(c, a, c, b, c, d); break;
              case 8: case 7: tri(d, a, d, b, d, c); break;
              case 3: case 12: // a,b vs c,d
                tri(a, c, a, d, b, d); tri(a, c, b, d, b, c); break;
              case 5: case 10: // a,c vs b,d
                tri(a, b, a, d, c, d); tri(a, b, c, d, c, b); break;
              case 9: case 6: // a,d vs b,c
                tri(a, b, d, b, d, c); tri(a, b, d, c, a, c); break;
            }
          }
        }
      }
    }

    var n = positions.length / 3;
    var posArr = new Float32Array(positions);
    var normArr = new Float32Array(positions.length);
    var eps = Math.min(hx, hy, hz) * 0.5;
    // gradient at lattice node via central differences of the sampled field
    var nodeGrad = function (i2, j2, k2, out2) {
      var ia = i2 > 0 ? i2 - 1 : i2, ib = i2 < nx - 1 ? i2 + 1 : i2;
      var ja = j2 > 0 ? j2 - 1 : j2, jb = j2 < nx - 1 ? j2 + 1 : j2;
      var ka = k2 > 0 ? k2 - 1 : k2, kb = k2 < nx - 1 ? k2 + 1 : k2;
      var vxa = at(ia, j2, k2), vxb = at(ib, j2, k2);
      var vya = at(i2, ja, k2), vyb = at(i2, jb, k2);
      var vza = at(i2, j2, ka), vzb = at(i2, j2, kb);
      if (!isFinite(vxa) || !isFinite(vxb) || !isFinite(vya) || !isFinite(vyb) ||
          !isFinite(vza) || !isFinite(vzb)) return false;
      out2[0] = (vxb - vxa) / ((ib - ia) * hx);
      out2[1] = (vyb - vya) / ((jb - ja) * hy);
      out2[2] = (vzb - vza) / ((kb - ka) * hz);
      return true;
    };
    var cg = [0, 0, 0];
    for (var vI = 0; vI < n; vI++) {
      var px = posArr[vI * 3], py = posArr[vI * 3 + 1], pz = posArr[vI * 3 + 2];
      var gx = 0, gy = 0, gz = 0;
      // trilinear blend of the 8 surrounding lattice-node gradients (no F calls)
      var fx2 = (px - x0) / hx, fy2 = (py - y0) / hy, fz2 = (pz - z0) / hz;
      var i0g = Math.max(0, Math.min(nx - 2, Math.floor(fx2)));
      var j0g = Math.max(0, Math.min(nx - 2, Math.floor(fy2)));
      var k0g = Math.max(0, Math.min(nx - 2, Math.floor(fz2)));
      var tx = Math.max(0, Math.min(1, fx2 - i0g));
      var ty = Math.max(0, Math.min(1, fy2 - j0g));
      var tz = Math.max(0, Math.min(1, fz2 - k0g));
      var okAll = true;
      for (var c8 = 0; c8 < 8 && okAll; c8++) {
        var di = c8 & 1, dj = (c8 >> 1) & 1, dk = (c8 >> 2) & 1;
        var w8 = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz);
        if (w8 === 0) continue;
        if (!nodeGrad(i0g + di, j0g + dj, k0g + dk, cg)) { okAll = false; break; }
        gx += w8 * cg[0]; gy += w8 * cg[1]; gz += w8 * cg[2];
      }
      if (!okAll) {
        // rare: field undefined nearby; fall back to direct evaluation
        try {
          gx = F(px + eps, py, pz) - F(px - eps, py, pz);
          gy = F(px, py + eps, pz) - F(px, py - eps, pz);
          gz = F(px, py, pz + eps) - F(px, py, pz - eps);
        } catch (e) { gx = gy = gz = NaN; }
      }
      var gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
      if (!isFinite(gl) || gl === 0) { gx = 0; gy = 0; gz = 1; gl = 1; }
      normArr[vI * 3] = gx / gl; normArr[vI * 3 + 1] = gy / gl; normArr[vI * 3 + 2] = gz / gl;
    }
    // consistent winding: face normal must agree with the field gradient,
    // otherwise DoubleSide shading flips normals on half the triangles (speckle)
    for (var tI = 0; tI + 8 < posArr.length; tI += 9) {
      var e1x = posArr[tI + 3] - posArr[tI], e1y = posArr[tI + 4] - posArr[tI + 1], e1z = posArr[tI + 5] - posArr[tI + 2];
      var e2x = posArr[tI + 6] - posArr[tI], e2y = posArr[tI + 7] - posArr[tI + 1], e2z = posArr[tI + 8] - posArr[tI + 2];
      var fnx = e1y * e2z - e1z * e2y, fny = e1z * e2x - e1x * e2z, fnz = e1x * e2y - e1y * e2x;
      var gsx = normArr[tI] + normArr[tI + 3] + normArr[tI + 6];
      var gsy = normArr[tI + 1] + normArr[tI + 4] + normArr[tI + 7];
      var gsz = normArr[tI + 2] + normArr[tI + 5] + normArr[tI + 8];
      if (fnx * gsx + fny * gsy + fnz * gsz < 0) {
        for (var sw = 0; sw < 3; sw++) {
          var tmp = posArr[tI + 3 + sw]; posArr[tI + 3 + sw] = posArr[tI + 6 + sw]; posArr[tI + 6 + sw] = tmp;
          tmp = normArr[tI + 3 + sw]; normArr[tI + 3 + sw] = normArr[tI + 6 + sw]; normArr[tI + 6 + sw] = tmp;
        }
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
    return geo;
  };

  G.implicit = function (F, win, style, res) {
    var geo = G.marchingTetra(F, win, res || 44, false);
    var mesh = new THREE.Mesh(geo, surfaceMaterial(style));
    if (style.mesh) {
      var wf = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x000000, wireframe: true, transparent: true, opacity: 0.08 }));
      var grp = new THREE.Group(); grp.add(mesh, wf); return grp;
    }
    return mesh;
  };

  /* flat stroked line in the plane {axes[axIdx]=c0}: a thin unlit ribbon */
  G.flatRibbon = function (polylines, axIdx, c0, win, style) {
    // width relative to the VISIBLE vertical range: constant on-screen stroke
    var vy = win.visYr || (win.ymax - win.ymin);
    var w = vy * 0.0012;
    var lift = c0 + vy * 0.0005; // avoid z-fighting the grid plane
    var ia = axIdx === 0 ? 1 : 0;      // in-plane axis a
    var ib = axIdx === 2 ? 1 : 2;      // in-plane axis b
    var positions = [], indices = [];
    polylines.forEach(function (poly) {
      var n = poly.length;
      if (n < 2) return;
      var closed = n > 3 && Math.hypot(
        poly[0][ia] - poly[n - 1][ia], poly[0][ib] - poly[n - 1][ib]) < win.diag * 0.01;
      if (closed) { poly = poly.slice(0, n - 1); n = poly.length; }
      var base = positions.length / 3;
      for (var i = 0; i < n; i++) {
        var ip = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
        var inx = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
        var ta = poly[inx][ia] - poly[ip][ia];
        var tb = poly[inx][ib] - poly[ip][ib];
        var tl = Math.hypot(ta, tb) || 1;
        var na = -tb / tl, nb = ta / tl;
        var pt = [0, 0, 0];
        pt[axIdx] = lift;
        pt[ia] = poly[i][ia] + na * w; pt[ib] = poly[i][ib] + nb * w;
        positions.push(pt[0], pt[1], pt[2]);
        pt[ia] = poly[i][ia] - na * w; pt[ib] = poly[i][ib] - nb * w;
        positions.push(pt[0], pt[1], pt[2]);
      }
      var segCount = closed ? n : n - 1;
      for (var s2 = 0; s2 < segCount; s2++) {
        var a0 = base + s2 * 2, b0 = base + ((s2 + 1) % n) * 2;
        indices.push(a0, a0 + 1, b0 + 1, a0, b0 + 1, b0);
      }
    });
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setIndex(indices);
    var op = style.opacity !== undefined ? style.opacity : 1;
    var mat = new THREE.MeshBasicMaterial({
      color: style.color, side: THREE.DoubleSide,
      transparent: op < 1, opacity: op
    });
    mat._styleOpacity = true;
    return new THREE.Mesh(geo, mat);
  };

  /* triangulated plane at freeVar = 0 (clamped into the window), for 2D traces */
  G.gridPlane = function (freeVar, win, n) {
    var lim = { x: [win.xmin, win.xmax], y: [win.ymin, win.ymax], z: [win.zmin, win.zmax] };
    var axes = ['x', 'y', 'z'].filter(function (a) { return a !== freeVar; });
    var A = lim[axes[0]], B = lim[axes[1]];
    var c = Math.max(lim[freeVar][0], Math.min(lim[freeVar][1], 0));
    var idxMap = { x: 0, y: 1, z: 2 };
    var ia = idxMap[axes[0]], ib = idxMap[axes[1]], ic = idxMap[freeVar];
    var pos = new Float32Array((n + 1) * (n + 1) * 3);
    var k = 0;
    for (var j = 0; j <= n; j++) {
      for (var i = 0; i <= n; i++, k++) {
        pos[k * 3 + ia] = A[0] + (A[1] - A[0]) * i / n;
        pos[k * 3 + ib] = B[0] + (B[1] - B[0]) * j / n;
        pos[k * 3 + ic] = c;
      }
    }
    var indices = [];
    for (j = 0; j < n; j++) {
      for (i = 0; i < n; i++) {
        var a2 = j * (n + 1) + i, b2 = a2 + 1, c2 = a2 + n + 1, d2 = c2 + 1;
        indices.push(a2, b2, d2, a2, d2, c2);
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(indices);
    return geo;
  };

  /* ---------- curve of intersection ----------
   * F: implicit form of surface A; geometry: rendered mesh of surface B.
   * Zero-crossings of F over B's triangles → segments → chained polylines → tubes. */
  G.intersectionCurve = function (F, geometry, win, style) {
    var pos = geometry.getAttribute('position');
    var idx = geometry.getIndex();
    var triCount = idx ? idx.count / 3 : pos.count / 3;
    // evaluate F once per unique vertex
    var fv = new Float64Array(pos.count);
    for (var vi = 0; vi < pos.count; vi++) {
      var val;
      try { val = F(pos.getX(vi), pos.getY(vi), pos.getZ(vi)); } catch (e) { val = NaN; }
      fv[vi] = isFinite(val) ? val : NaN;
    }
    var vidx = function (t, k) { return idx ? idx.getX(t * 3 + k) : t * 3 + k; };
    var segs = [];
    var ids = [0, 0, 0];
    for (var t = 0; t < triCount; t++) {
      ids[0] = vidx(t, 0); ids[1] = vidx(t, 1); ids[2] = vidx(t, 2);
      if (isNaN(fv[ids[0]]) || isNaN(fv[ids[1]]) || isNaN(fv[ids[2]])) continue;
      var cross = [];
      for (var k = 0; k < 3; k++) {
        var ia = ids[k], ib = ids[(k + 1) % 3];
        var fa = fv[ia], fb = fv[ib];
        if ((fa < 0) !== (fb < 0)) {
          var s = fa / (fa - fb);
          cross.push([
            pos.getX(ia) + (pos.getX(ib) - pos.getX(ia)) * s,
            pos.getY(ia) + (pos.getY(ib) - pos.getY(ia)) * s,
            pos.getZ(ia) + (pos.getZ(ib) - pos.getZ(ia)) * s]);
        }
      }
      if (cross.length === 2) segs.push([cross[0], cross[1]]);
    }

    var group = new THREE.Group();
    if (!segs.length) return group;

    // chain segments into polylines via quantized endpoints
    var q = win.diag * 1e-5;
    var key = function (p2) {
      return Math.round(p2[0] / q) + ',' + Math.round(p2[1] / q) + ',' + Math.round(p2[2] / q);
    };
    var links = {}; // endpoint key → [{seg, end}]
    segs.forEach(function (seg, si) {
      [0, 1].forEach(function (end) {
        var kk = key(seg[end]);
        (links[kk] = links[kk] || []).push({ si: si, end: end });
      });
    });
    var used = new Uint8Array(segs.length);
    var polylines = [];
    for (var si = 0; si < segs.length; si++) {
      if (used[si]) continue;
      used[si] = 1;
      var line = [segs[si][0], segs[si][1]];
      var extend = function (fromFront) {
        for (;;) {
          var tip = fromFront ? line[0] : line[line.length - 1];
          var cands = links[key(tip)] || [];
          var found = null;
          for (var c = 0; c < cands.length; c++) {
            if (!used[cands[c].si]) { found = cands[c]; break; }
          }
          if (!found) break;
          used[found.si] = 1;
          var nxt = segs[found.si][1 - found.end];
          if (fromFront) line.unshift(nxt); else line.push(nxt);
        }
      };
      extend(false); extend(true);
      polylines.push(line);
    }

    if (style.flatAxis !== undefined) {
      return G.flatRibbon(polylines, style.flatAxis, style.flatC0 || 0, win, style);
    }
    var mat = solidMaterial(style, 50);
    polylines.forEach(function (line) {
      if (line.length < 2) return;
      var first = line[0], last = line[line.length - 1];
      var closed = line.length > 3 &&
        Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]) < win.diag * 0.01;
      var pts = line.map(function (p3) { return new THREE.Vector3(p3[0], p3[1], p3[2]); });
      if (closed) pts.pop();
      if (pts.length < 2) return;
      if (pts.length < 4) {
        var lg = new THREE.BufferGeometry().setFromPoints(pts);
        group.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color: style.color })));
        return;
      }
      var curve = new THREE.CatmullRomCurve3(pts, closed);
      var tube = new THREE.TubeGeometry(curve, Math.min(600, pts.length * 2), win.diag * 0.0026, 8, closed);
      group.add(new THREE.Mesh(tube, mat));
    });
    return group;
  };

  G.region = function (F, win, style, res) {
    // clip to window: G = max(F, plane distances) → closed solid
    var Fw = function (x, y, z) {
      var f = F(x, y, z);
      var w = Math.max(win.xmin - x, x - win.xmax, win.ymin - y, y - win.ymax, win.zmin - z, z - win.zmax);
      return Math.max(f, w);
    };
    var geo = G.marchingTetra(Fw, win, res || 40, true);
    var st = { color: style.color, opacity: Math.min(style.opacity, 0.5), mesh: false };
    return new THREE.Mesh(geo, surfaceMaterial(st));
  };
})();
