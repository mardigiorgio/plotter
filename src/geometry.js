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

  /* Two-pass surface: ONE geometry drawn twice — BackSide first, FrontSide
   * second — so a translucent solid composites its own two layers in a fixed
   * order from every angle (no within-mesh speckle). scene.js sortTransparent
   * re-sorts the pairs of all rows by camera distance each rendered frame.
   * The back pass is slightly darker so interiors read as interiors. */
  var rimHook = function (shader) {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n' +
      '\ttotalEmissiveRadiance += vec3(0.07) * pow(1.0 - abs(dot(normalize(vViewPosition), normal)), 3.0);');
  };
  function surfacePair(geo, style) {
    var mk = function (side) {
      var m = new THREE.MeshPhongMaterial({
        color: style.color, side: side,
        transparent: style.opacity < 1, opacity: style.opacity,
        shininess: 45, specular: 0x222222,
        depthWrite: style.opacity >= 0.99,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
      });
      m._styleOpacity = true;
      return m;
    };
    var back = new THREE.Mesh(geo, mk(THREE.BackSide));
    back.material.color.multiplyScalar(0.86);
    var front = new THREE.Mesh(geo, mk(THREE.FrontSide));
    front.material.onBeforeCompile = rimHook; // gentle fresnel rim: curvature reads
    back._transRole = 0; front._transRole = 1;
    var g = new THREE.Group();
    g._transPair = [back, front];
    g.add(back, front);
    return g;
  }
  G.surfacePair = surfacePair;

  // BufferGeometry from the mesher's plain arrays
  function meshGeo(m) {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.pos), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(m.nrm), 3));
    geo.setIndex(m.idx);
    return geo;
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

  // classify a point against the box WITHOUT mutating it:
  // 0 = strictly inside, 1 = within half a range of a wall, 2 = far beyond.
  G.clampState = function (p, win) {
    var mn = [win.xmin, win.ymin, win.zmin], mx = [win.xmax, win.ymax, win.zmax];
    var st = 0;
    for (var ax = 0; ax < 3; ax++) {
      var lo = mn[ax], hi = mx[ax], far = (hi - lo) * 0.5, v = p[ax];
      if (v < lo - far || v > hi + far) return 2;
      if (v < lo || v > hi) st = 1;
    }
    return st;
  };

  // Sutherland–Hodgman clip of a convex ring against the 6 box faces. Each ring
  // vertex is {p:[x,y,z], n:[x,y,z]} (n carried so the cut edge stays smoothly
  // shaded). Returns a fan-triangulable ring, or [] if fully outside.
  G.clipToBox = function (ring, win) {
    var faces = [
      [0, 1, win.xmin], [0, -1, win.xmax],
      [1, 1, win.ymin], [1, -1, win.ymax],
      [2, 1, win.zmin], [2, -1, win.zmax]
    ];
    for (var f = 0; f < 6 && ring.length; f++) {
      var ax = faces[f][0], sgn = faces[f][1], val = faces[f][2];
      var out = [], n = ring.length;
      for (var i = 0; i < n; i++) {
        var A = ring[i], B = ring[(i + 1) % n];
        var da = (A.p[ax] - val) * sgn, db = (B.p[ax] - val) * sgn; // >= 0 is inside
        if (da >= 0) out.push(A);
        if ((da >= 0) !== (db >= 0)) {
          var t = da / (da - db);
          out.push({
            p: [A.p[0] + (B.p[0] - A.p[0]) * t, A.p[1] + (B.p[1] - A.p[1]) * t, A.p[2] + (B.p[2] - A.p[2]) * t],
            n: [A.n[0] + (B.n[0] - A.n[0]) * t, A.n[1] + (B.n[1] - A.n[1]) * t, A.n[2] + (B.n[2] - A.n[2]) * t]
          });
        }
      }
      ring = out;
    }
    return ring;
  };

  // Sample a parametric surface into a mesh that reaches the box faces cleanly.
  // Vertices keep their TRUE positions; interior triangles stay indexed (shared,
  // smoothly shaded), boundary triangles are CLIPPED to the box so asymptote
  // walls (ln, 1/x, tan) end on a crisp intersection edge instead of a smeared
  // ledge. Triangles that span an asymptote (a huge jump across one grid cell)
  // are dropped so the two branches never bridge — the 3D analogue of the 2D
  // planar sampler's pole splitting.
  G.paramSurface = function (fn, u0, u1, v0, v1, nu, nv, win, style) {
    var W = nu + 1, np = W * (nv + 1);
    var vx = new Float64Array(np * 3);
    var fin = new Uint8Array(np);   // finite sample
    var ins = new Uint8Array(np);   // finite AND strictly inside the box
    var i, j, k = 0;
    for (j = 0; j <= nv; j++) {
      var vv = v0 + (v1 - v0) * j / nv;
      for (i = 0; i <= nu; i++, k++) {
        var uu = u0 + (u1 - u0) * i / nu, p;
        try { p = fn(uu, vv); } catch (e) { p = null; }
        if (!p || !isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2])) continue;
        vx[k * 3] = p[0]; vx[k * 3 + 1] = p[1]; vx[k * 3 + 2] = p[2];
        fin[k] = 1;
        ins[k] = G.clampState(p, win) === 0 ? 1 : 0;
      }
    }
    // per-vertex normals from finite neighbours (central differences)
    var nrm = new Float32Array(np * 3);
    var vp = function (kk, c) { return vx[kk * 3 + c]; };
    for (j = 0; j <= nv; j++) for (i = 0; i <= nu; i++) {
      k = j * W + i;
      if (!fin[k]) continue;
      var iu = (i < nu && fin[k + 1]) ? k + 1 : k, il = (i > 0 && fin[k - 1]) ? k - 1 : k;
      var ju = (j < nv && fin[k + W]) ? k + W : k, jl = (j > 0 && fin[k - W]) ? k - W : k;
      var ax2 = vp(iu, 0) - vp(il, 0), ay = vp(iu, 1) - vp(il, 1), az = vp(iu, 2) - vp(il, 2);
      var bx = vp(ju, 0) - vp(jl, 0), by = vp(ju, 1) - vp(jl, 1), bz = vp(ju, 2) - vp(jl, 2);
      var nx = ay * bz - az * by, ny = az * bx - ax2 * bz, nz = ax2 * by - ay * bx;
      var nl = Math.hypot(nx, ny, nz) || 1;
      nrm[k * 3] = nx / nl; nrm[k * 3 + 1] = ny / nl; nrm[k * 3 + 2] = nz / nl;
    }
    // surface normal at any parameter (finite differences of fn)
    var hu = (u1 - u0) / nu * 0.02, hv = (v1 - v0) / nv * 0.02;
    var normalAt = function (uu, vv) {
      var a1, a0, b1, b0;
      try { a1 = fn(uu + hu, vv); a0 = fn(uu - hu, vv); b1 = fn(uu, vv + hv); b0 = fn(uu, vv - hv); } catch (e) { }
      if (!a1 || !a0 || !b1 || !b0) return [0, 0, 1];
      var ex = a1[0] - a0[0], ey = a1[1] - a0[1], ez = a1[2] - a0[2];
      var gx = b1[0] - b0[0], gy = b1[1] - b0[1], gz = b1[2] - b0[2];
      var nx = ey * gz - ez * gy, ny = ez * gx - ex * gz, nz = ex * gy - ey * gx;
      var nl = Math.hypot(nx, ny, nz);
      return nl ? [nx / nl, ny / nl, nz / nl] : [0, 0, 1];
    };
    // Walk a cell edge from an INSIDE parameter toward a not-inside one and
    // return the last point still inside the box (bisection) — the exact spot
    // where an asymptote wall meets the box face, or where the domain ends.
    // Done PER CELL EDGE, so each side of a pole reaches the face on its own; a
    // single shared grid vertex could only ever be pulled toward one branch.
    var crossing = function (iu, iv, ou, ov) {
      var au = iu, av = iv, bu = ou, bv = ov, best = null;
      for (var it = 0; it < 32; it++) {
        var mu = (au + bu) / 2, mv = (av + bv) / 2, q;
        try { q = fn(mu, mv); } catch (e) { q = null; }
        if (q && isFinite(q[0]) && isFinite(q[1]) && isFinite(q[2]) && G.clampState(q, win) === 0) { au = mu; av = mv; best = q; }
        else { bu = mu; bv = mv; }
      }
      return best ? { p: best, n: normalAt(au, av) } : null;
    };
    // assemble
    var pos = [], nor = [], idx = [];
    for (k = 0; k < np; k++) {
      pos.push(vx[k * 3], vx[k * 3 + 1], vx[k * 3 + 2]);
      nor.push(nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2]);
    }
    var far = [(win.xmax - win.xmin) * 3, (win.ymax - win.ymin) * 3, (win.zmax - win.zmin) * 3];
    var spans = function (poly) { // guard: a patch reaching > 3 ranges would bridge an asymptote
      for (var ax = 0; ax < 3; ax++) {
        var lo = Infinity, hi = -Infinity;
        for (var q = 0; q < poly.length; q++) { var vv = poly[q].p[ax]; if (vv < lo) lo = vv; if (vv > hi) hi = vv; }
        if (hi - lo > far[ax]) return true;
      }
      return false;
    };
    var gridV = function (kk) { return { p: [vx[kk * 3], vx[kk * 3 + 1], vx[kk * 3 + 2]], n: [nrm[kk * 3], nrm[kk * 3 + 1], nrm[kk * 3 + 2]] }; };
    var pushV = function (v) { pos.push(v.p[0], v.p[1], v.p[2]); nor.push(v.n[0], v.n[1], v.n[2]); return pos.length / 3 - 1; };
    var uAt = function (ii) { return u0 + (u1 - u0) * ii / nu; };
    var vAt = function (jj) { return v0 + (v1 - v0) * jj / nv; };
    // Marching-squares over the "strictly inside the box" corner field: fully
    // interior cells stay indexed (smooth, shared); a cell straddling the box
    // face or a domain edge is cut to the inside polygon, its cut vertices found
    // by per-edge bisection so asymptote walls reach the faces cleanly and each
    // branch of a pole is built on its own side.
    for (j = 0; j < nv; j++) for (i = 0; i < nu; i++) {
      var cA = j * W + i, cB = cA + 1, cC = cA + W, cD = cC + 1;
      if (ins[cA] && ins[cB] && ins[cC] && ins[cD]) { idx.push(cA, cB, cD, cA, cD, cC); continue; }
      if (!(ins[cA] || ins[cB] || ins[cC] || ins[cD])) continue; // nothing inside this cell
      var ring = [
        { k: cA, i: i, j: j }, { k: cB, i: i + 1, j: j },
        { k: cD, i: i + 1, j: j + 1 }, { k: cC, i: i, j: j + 1 }
      ];
      var poly = [];
      for (var e = 0; e < 4; e++) {
        var An = ring[e], Bn = ring[(e + 1) % 4];
        var ai = ins[An.k], bi = ins[Bn.k];
        if (ai) poly.push(gridV(An.k));
        if (ai !== bi) {
          var In = ai ? An : Bn, Out = ai ? Bn : An;
          var cr = crossing(uAt(In.i), vAt(In.j), uAt(Out.i), vAt(Out.j));
          if (cr) poly.push(cr);
        }
      }
      if (poly.length < 3 || spans(poly)) continue;
      var ids = poly.map(pushV);
      for (var t = 1; t + 1 < ids.length; t++) idx.push(ids[0], ids[t], ids[t + 1]);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    geo.setIndex(idx);
    var group = new THREE.Group();
    group.add(surfacePair(geo, style));
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
    var mat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18, depthWrite: false });
    var lines = new THREE.LineSegments(geo, mat);
    lines.renderOrder = 500; // after the translucent surface passes
    return lines;
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
      // r is a radius: negative values are outside the coordinate's domain.
      // Mapping them through anyway would reflect the point across the origin
      // and draw a ghost sheet. Invalid instead — the sampler ends the
      // surface cleanly on the r = 0 boundary.
      if (!(r >= 0)) return null;
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
      // rho >= 0 by definition; negative values would reflect through the
      // origin and double-cover the surface (z-fighting ghost sheet)
      if (!(rho >= 0)) return null;
      var sp = Math.sin(ph);
      return [rho * sp * Math.cos(th), rho * sp * Math.sin(th), rho * Math.cos(ph)];
    }, 0, Math.PI, 0, 2 * Math.PI, n, n, win, style);
  };

  G.phiSurf = function (fn, win, style, res) { // phi = f(rho, theta)
    var n = res || 48;
    var rmax = win.diag * 0.6;
    return G.paramSurface(function (s, th) {
      var ph = fn(s, th);
      // phi is the angle from +z, defined on [0, pi]; values outside flip
      // sin(phi) negative, which is the same reflected-ghost trap as r < 0
      if (!(ph >= 0 && ph <= Math.PI)) return null;
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

  /* ---------- implicit surfaces & region solids (mesher.js core) ---------- */
  function niceStepG(range) {
    var raw = range / 6;
    var pow = Math.pow(10, Math.floor(Math.log10(raw)));
    var cands = [1, 2, 5, 10];
    for (var i = 0; i < cands.length; i++) {
      if (cands[i] * pow >= raw - 1e-12) return cands[i] * pow;
    }
    return 10 * pow;
  }
  /* z-elevation contour lines on a mesher output — the clean replacement for
   * the old triangle-soup wireframe overlay on implicit surfaces */
  G.isoLines = function (m, win) {
    var step = niceStepG(win.zmax - win.zmin);
    var levels = [];
    for (var c = Math.ceil(win.zmin / step) * step; c <= win.zmax + 1e-9; c += step) levels.push(c);
    var pts = [];
    var pos = m.pos, idx = m.idx;
    for (var t = 0; t < idx.length; t += 3) {
      var A = idx[t] * 3, B = idx[t + 1] * 3, C = idx[t + 2] * 3;
      var z0 = pos[A + 2], z1 = pos[B + 2], z2 = pos[C + 2];
      var lo = Math.min(z0, z1, z2), hi = Math.max(z0, z1, z2);
      if (lo === hi) continue;
      for (var li = 0; li < levels.length; li++) {
        var cz = levels[li];
        if (cz < lo || cz > hi) continue;
        var cut = [];
        var edge = function (ia, ib, za, zb) {
          if ((za < cz) === (zb < cz)) return;
          var s = (cz - za) / (zb - za);
          if (!isFinite(s)) return;
          cut.push([pos[ia] + (pos[ib] - pos[ia]) * s,
                    pos[ia + 1] + (pos[ib + 1] - pos[ia + 1]) * s, cz]);
        };
        edge(A, B, z0, z1); edge(B, C, z1, z2); edge(C, A, z2, z0);
        if (cut.length === 2) {
          pts.push(cut[0][0], cut[0][1], cut[0][2], cut[1][0], cut[1][1], cut[1][2]);
        }
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    var mat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.15, depthWrite: false });
    var lines = new THREE.LineSegments(geo, mat);
    lines.renderOrder = 500;
    return lines;
  };

  G.implicit = function (F, win, style, res, fast) {
    var m = P.mesher.polygonize(F, win, res || 48, { refine: !fast, gradF: !fast });
    var grp = new THREE.Group();
    grp.add(surfacePair(meshGeo(m), style));
    if (style.mesh && !fast) grp.add(G.isoLines(m, win));
    return grp;
  };

  /* Region solid: the raw field is marched over exactly the window (never
   * max()-ed with the walls), then the box faces get analytic caps that reuse
   * the surface's refined crossings — flat caps, crisp seams. parts (the
   * individual constraint fields behind a chained/region3 max) give each side
   * of an interior crease its own smooth normals. */
  G.region = function (F, win, style, res, parts, fast) {
    var N = res || 44;
    // A constraint that coincides exactly with a window face (z < 4 in a ±4
    // window) samples as F = 0 there — neither inside nor crossed, so the face
    // would neither cap nor mesh. Evaluating through a hair-inward shrink of
    // space about the window center lands boundary samples just inside the
    // solid; the ~1e-6 relative shift of the isosurface is far below a pixel.
    var kk = 1 - 1e-6;
    var cx = (win.xmin + win.xmax) / 2, cy = (win.ymin + win.ymax) / 2, cz = (win.zmin + win.zmax) / 2;
    var wrap = function (fn) {
      return function (x, y, z) {
        return fn(cx + (x - cx) * kk, cy + (y - cy) * kk, cz + (z - cz) * kk);
      };
    };
    var m = P.mesher.polygonize(wrap(F), win, N, {
      refine: !fast, gradF: !fast, parts: parts ? parts.map(wrap) : null
    });
    var caps = P.mesher.buildCaps(win, N, m.cache);
    var grp = new THREE.Group();
    // curved surface FIRST: meshGeometryFor / the 2D slicer must find it, not caps
    if (m.idx.length) grp.add(surfacePair(meshGeo(m), style));
    if (caps.idx.length) grp.add(surfacePair(meshGeo(caps), style));
    if (style.mesh && !fast && m.idx.length) grp.add(G.isoLines(m, win));
    return grp;
  };

  /* 2D inequality: translucent fill + boundary stroke (dashed when strict).
   * Fill and stroke come from the same sampling, so they coincide exactly. */
  G.regionFill2D = function (f, win, style, baseRes, refine, strict, c0) {
    var r = P.mesher.fillRegion2D(f, win, baseRes, refine);
    var grp = new THREE.Group();
    var vy = win.visYr || (win.ymax - win.ymin);
    if (r.idx.length) {
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(r.pos), 3));
      geo.setIndex(r.idx);
      var op = style.opacity !== undefined ? style.opacity : 1;
      var mat = new THREE.MeshBasicMaterial({
        color: style.color, transparent: true, opacity: op * 0.25, depthWrite: false,
        side: THREE.DoubleSide // flat fills must not vanish seen from below in 3D
      });
      mat._styleOpacity = true;
      mat._opacityMul = 0.25; // applyOpacityLive keeps the fill/stroke ratio
      var fillMesh = new THREE.Mesh(geo, mat);
      fillMesh.position.z = c0 || 0;
      fillMesh.renderOrder = 1;
      grp.add(fillMesh);
    }
    var polys = r.contours;
    if (strict) polys = P.mesher.dashPolylines(polys, vy * 0.014, vy * 0.009);
    if (polys.length) {
      var ribbon = G.flatRibbon(polys, 2, c0 || 0, win, style);
      ribbon.renderOrder = 2;
      grp.add(ribbon);
    }
    return grp;
  };

  /* marching-squares core lives in mesher.js (THREE-free, gjs-tested) */
  var msCells = P.mesher.msCells;
  var msChain = P.mesher.chainSegs;

  /* Adaptive marching squares (the quadtree idea Desmos-style plotters use): a
   * coarse base grid locates the curve, then ONLY the cells it passes through
   * are subdivided and re-sampled, so a small feature keeps fine detail however
   * far you zoom out. Cost scales with curve length, not viewport area. baseRes
   * finds the curve; effective resolution near it is baseRes * 2^refine. */
  G.marchingSquaresAdaptive = function (f, win, baseRes, refine) {
    var n = Math.max(8, baseRes || 128);
    var x0 = win.xmin, x1 = win.xmax, y0 = win.ymin, y1 = win.ymax;
    var bx = new Float64Array(n + 1), by = new Float64Array(n + 1), i, j;
    for (i = 0; i <= n; i++) bx[i] = x0 + (x1 - x0) * i / n;
    for (j = 0; j <= n; j++) by[j] = y0 + (y1 - y0) * j / n;
    var bv = new Float64Array((n + 1) * (n + 1));
    for (j = 0; j <= n; j++) {
      for (i = 0; i <= n; i++) {
        var v;
        try { v = f(bx[i], by[j]); } catch (e) { v = NaN; }
        bv[j * (n + 1) + i] = isFinite(v) ? v : NaN;
      }
    }
    var active = [];
    for (j = 0; j < n; j++) {
      for (i = 0; i < n; i++) {
        var g00 = bv[j * (n + 1) + i], g10 = bv[j * (n + 1) + i + 1];
        var g01 = bv[(j + 1) * (n + 1) + i], g11 = bv[(j + 1) * (n + 1) + i + 1];
        if (isNaN(g00) || isNaN(g10) || isNaN(g01) || isNaN(g11)) continue;
        var neg = g00 < 0;
        if ((g10 < 0) !== neg || (g01 < 0) !== neg || (g11 < 0) !== neg) active.push(j * n + i);
      }
    }
    if (!active.length) return [];
    var sub = 1 << Math.max(1, refine || 3);
    var maxSub = Math.max(2, Math.floor(Math.sqrt(60000 / active.length)));
    if (sub > maxSub) sub = maxSub;
    var segs = [];
    for (var a = 0; a < active.length; a++) {
      var ci = active[a] % n, cj = (active[a] - ci) / n;
      msCells(f, bx[ci], bx[ci + 1], by[cj], by[cj + 1], sub, sub, segs);
    }
    return msChain(segs, Math.max(x1 - x0, y1 - y0) / (n * sub) * 1e-3);
  };

  /* zero contour of f(x,y) over the window's xy-rectangle, as chained
   * polylines of [x,y,0] points; cells with a non-finite corner are skipped */
  G.marchingSquares = function (f, win, res) {
    var n = Math.max(8, res || 96);
    var segs = [];
    msCells(f, win.xmin, win.xmax, win.ymin, win.ymax, n, n, segs);
    return msChain(segs, Math.max(win.xmax - win.xmin, win.ymax - win.ymin) / n * 1e-3);
  };

  /* Chaikin corner-cutting: turns a coarse contour into a smooth curve without
   * any extra function evaluations, so grid-resolution facets stop reading as
   * straight edges. Open polylines keep their endpoints; closed loops (first
   * point == last) stay closed. Points move at most one edge-length inward, so
   * the smoothed curve hugs the original. */
  G.smoothContours = function (polylines, iters) {
    iters = iters || 2;
    return polylines.map(function (poly) {
      if (poly.length < 3) return poly;
      var n0 = poly.length;
      var closed = n0 > 3 &&
        Math.abs(poly[0][0] - poly[n0 - 1][0]) < 1e-9 &&
        Math.abs(poly[0][1] - poly[n0 - 1][1]) < 1e-9;
      var pts = closed ? poly.slice(0, n0 - 1) : poly.slice();
      for (var it = 0; it < iters; it++) {
        var out = [], n = pts.length, i, p, q;
        if (!closed) out.push(pts[0]);
        var last = closed ? n : n - 1;
        for (i = 0; i < last; i++) {
          p = pts[i]; q = pts[(i + 1) % n];
          out.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1], 0]);
          out.push([0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1], 0]);
        }
        if (!closed) out.push(pts[n - 1]);
        pts = out;
      }
      if (closed) pts.push([pts[0][0], pts[0][1], 0]);
      return pts;
    });
  };

  /* 2D overscan bookkeeping: content is computed over factor x the visible
   * window so gestures can move only the camera. During a gesture (force
   * falsy) a rebuild is needed only when the window nears the overscan edge
   * or outgrows it; at settle (force truthy) it also recenters earlier and
   * resamples after enough zoom-in that sample density has degraded. */
  G.overscanNeed = function (w, o, force) {
    if (!o) return true;
    var xr = w.xmax - w.xmin, yr = w.ymax - w.ymin;
    var ow = o.xmax - o.xmin;
    var m = force ? 0.25 : 0.1;
    return w.xmin < o.xmin + xr * m || w.xmax > o.xmax - xr * m ||
      w.ymin < o.ymin + yr * m || w.ymax > o.ymax - yr * m ||
      xr > ow / 1.4 ||
      (!!force && xr < ow / (2.5 * 1.5));
  };
  G.overscanMake = function (w, F) {
    var xr = w.xmax - w.xmin, yr = w.ymax - w.ymin;
    var xc = (w.xmin + w.xmax) / 2, yc = (w.ymin + w.ymax) / 2;
    var nw = {
      xmin: xc - xr * F / 2, xmax: xc + xr * F / 2,
      ymin: yc - yr * F / 2, ymax: yc + yr * F / 2,
      zmin: w.zmin, zmax: w.zmax
    };
    nw.diag = Math.hypot(nw.xmax - nw.xmin, nw.ymax - nw.ymin, nw.zmax - nw.zmin);
    nw.visYr = yr;
    return nw;
  };

  /* ---------- planar (xy-plane) curve sampler ----------
   * Samples a map t↦[x,y,0] over t∈[a,b] into window-clipped polylines with
   * correct vertical asymptotes: domain-edge tails (ln, log) and poles (1/x,
   * tan) are carried straight out to the screen edge, and a pole splits the
   * curve into separate branches instead of being bridged by a fake riser.
   * Cost is bounded by N (≈ one sample per screen column) plus a little
   * bisection per asymptote, so it stays live at any zoom. opts: {N, param}.
   * param=true (closed polar curves) disables pole splitting, which would
   * misfire on legitimate axis crossings. */
  G.planarSample = function (map, a, b, win, opts) {
    opts = opts || {};
    var N = Math.max(2, Math.round(opts.N || 700));
    var xr = win.xmax - win.xmin, yr = win.ymax - win.ymin;
    // clip box: a quarter-window of margin so near-vertical parts run off
    // cleanly and tails can be snapped just past the visible edge
    var xlo = win.xmin - xr * 0.25, xhi = win.xmax + xr * 0.25;
    var ylo = win.ymin - yr * 0.25, yhi = win.ymax + yr * 0.25;
    var xr2 = xhi - xlo, yr2 = yhi - ylo;
    var yCap = Math.max(Math.abs(yhi), Math.abs(ylo));

    var raw = function (t) { var p; try { p = map(t); } catch (e) { p = null; } return p; };
    var good = function (p) {
      return !!p && isFinite(p[0]) && isFinite(p[1]) &&
        p[0] >= xlo && p[0] <= xhi && p[1] >= ylo && p[1] <= yhi;
    };
    var sample = function (t) { var p = raw(t); return good(p) ? p : null; };

    // Odd pole between two in-box samples of opposite sign: 1/y crosses zero
    // there. Returns the pole parameter, or NaN if |y| stays bounded (a mere
    // steep-but-finite crossing, not an asymptote).
    var yOf = function (t) { var p = raw(t); return p ? p[1] : NaN; };
    var findPole = function (t0, y0, t1) {
      var lo = t0, hi = t1, gLo = 1 / y0;
      for (var it = 0; it < 60; it++) {
        var m = (lo + hi) / 2;
        if (m === lo || m === hi) break;
        var gm = 1 / yOf(m);
        if (!isFinite(gm)) { hi = m; continue; }        // landed on the pole
        if ((gm < 0) === (gLo < 0)) { lo = m; gLo = gm; } else { hi = m; }
      }
      var tp = (lo + hi) / 2, near = raw(tp);
      if (near && isFinite(near[1]) && Math.abs(near[1]) < yCap * 4) return NaN;
      return tp;
    };

    // sample stream: base grid, with a null injected at any hidden pole
    var ts = [], ps = [];
    var prevT = a, prevP = sample(a);
    ts.push(a); ps.push(prevP);
    for (var i = 1; i <= N; i++) {
      var t = a + (b - a) * i / N;
      var p = sample(t);
      if (!opts.param && p && prevP && (prevP[1] < 0) !== (p[1] < 0)) {
        var dy = Math.abs(p[1] - prevP[1]) / (yr || 1);
        var dx = Math.abs(p[0] - prevP[0]) / (xr || 1);
        if (dy > 0.05 && dy > dx * 6) {
          var tp = findPole(prevT, prevP[1], t);
          if (tp === tp) { ts.push(tp); ps.push(null); }  // tp===tp ⇒ not NaN
        }
      }
      ts.push(t); ps.push(p);
      prevT = t; prevP = p;
    }

    // The ladder bottoms out near double precision (|y| ≈ ln|Δx|), which falls
    // far short of the clip edge once the window is large. If the tail is still
    // DIVERGING there — |y| growing as we approach the boundary — it is a true
    // asymptote, so extend it straight to the edge (pixel-correct). A finite
    // domain edge (sqrt) instead CONVERGES (|y| shrinks toward the boundary),
    // so its tail is left to end naturally. The test is scale-independent: it
    // compares the two outermost samples, never an absolute fraction of the
    // window, so it fires identically at every zoom level.
    var snapEdge = function (arr, atStart) {
      if (arr.length < 2) return;
      var q0 = atStart ? arr[0] : arr[arr.length - 1];       // outermost sample
      var q1 = atStart ? arr[1] : arr[arr.length - 2];       // one step inward
      var dx2 = q0[0] - q1[0], dy2 = q0[1] - q1[1];
      var eps = 1e-9;
      var pt = null;
      if (Math.abs(dy2) / yr2 > Math.abs(dx2) / xr2) {
        if (Math.abs(q0[1]) > Math.abs(q1[1]) + yr2 * eps) pt = [q0[0], dy2 < 0 ? ylo : yhi, 0];
      } else if (Math.abs(q0[0]) > Math.abs(q1[0]) + xr2 * eps) {
        pt = [dx2 < 0 ? xlo : xhi, q0[1], 0];
      }
      if (pt) { if (atStart) arr.unshift(pt); else arr.push(pt); }
    };
    // converge on the domain/box boundary between a good t and a null t
    var boundary = function (goodT, badT) {
      for (var it = 0; it < 90; it++) {
        var m = (goodT + badT) / 2;
        if (m === goodT || m === badT) break;
        if (sample(m)) goodT = m; else badT = m;
      }
      return badT;
    };
    // log-spaced samples from the boundary edgeT outward toward farT, so the
    // tail curves down as far as double precision allows before snapEdge
    var LADDER = 22;
    var ladder = function (edgeT, farT) {
      var span = Math.abs(farT - edgeT);
      if (!(span > 0)) return [];
      var d0 = Math.max(span * 1e-14, 5e-324);
      var dirn = farT > edgeT ? 1 : -1;
      var out = [];
      for (var k = 0; k <= LADDER; k++) {
        var off = k === 0 ? 0 : d0 * Math.pow(span / d0, k / LADDER);
        var pp = sample(edgeT + dirn * off);
        if (pp) out.push(pp);
      }
      return out;
    };

    var polys = [], cur = null;
    for (var s = 0; s < ts.length; s++) {
      var P = ps[s];
      if (P) {
        if (!cur) {
          // entering the domain: carve the incoming tail from the boundary
          // (the ladder already ends at this sample, so don't re-add it)
          if (s > 0) {
            cur = ladder(boundary(ts[s], ts[s - 1]), ts[s]);
            snapEdge(cur, true);
          }
          if (!cur || !cur.length) cur = [P];
        } else {
          cur.push(P);
        }
      } else if (cur) {
        // leaving the domain: carve the outgoing tail, then close the branch
        // (its far end re-hits the last good sample, already in cur — drop it)
        var down = ladder(boundary(ts[s - 1], ts[s]), ts[s - 1]);
        down.reverse();
        cur = cur.concat(down.length ? down.slice(1) : down);
        snapEdge(cur, false);
        if (cur.length > 1) polys.push(cur);
        cur = null;
      }
    }
    if (cur && cur.length > 1) polys.push(cur);
    return polys;
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
      var closed = !poly.open && n > 3 && Math.hypot(
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

})();
