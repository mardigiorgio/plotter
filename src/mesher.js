/* mesher.js — THREE-free polygonization core: implicit surfaces, region
 * solids with analytic box caps, and 2D inequality fills. Pure math on plain
 * arrays so the whole module runs headless under gjs.
 *
 * Convention everywhere: a point is INSIDE the solid where F < 0. NaN is
 * outside; cells touching a NaN sample are skipped.
 */
(function () {
  'use strict';
  var P = window.P = window.P || {};
  var M = P.mesher = {};

  var REFINE_EDGE_CAP = 60000; // beyond this many crossings, refinement is off

  /* ---------- 3D polygonizer ----------
   * Table-free marching cubes: within each active cell the isosurface cross-
   * section is one or more closed loops. Each cell face contributes marching-
   * squares segments (with a cached face-center sample deciding saddles); a
   * crossing edge lies on exactly two faces of the cell, so segments chain
   * into loops with no case table to get wrong — and the SAME face segments
   * are reused by the box-cap builder, so caps meet the surface exactly.
   *
   * opts: { refine: true → secant/bisection zero refinement per crossing edge
   *         gradF:  true → normals from central differences at the vertex
   *                 (else trilinear blend of lattice-node gradients — free)
   *         parts:  [g1,g2,…] when F = max(gᵢ): per-triangle active
   *                 constraint; vertices split per constraint so region3
   *                 creases get crisp two-sided shading }
   * Returns { pos, nrm, idx, cache } — cache feeds M.buildCaps so caps share
   * refined crossings and saddle deciders with the surface.
   */
  M.polygonize = function (F, win, N, opts) {
    opts = opts || {};
    var nx = N + 1, nx2 = nx * nx, nn = nx2 * nx;
    var hx = (win.xmax - win.xmin) / N, hy = (win.ymax - win.ymin) / N, hz = (win.zmax - win.zmin) / N;
    var xs = new Float64Array(nx), ys = new Float64Array(nx), zs = new Float64Array(nx);
    var i, j, k;
    for (i = 0; i < nx; i++) {
      xs[i] = win.xmin + i * hx; ys[i] = win.ymin + i * hy; zs[i] = win.zmin + i * hz;
    }
    var vals = new Float64Array(nn);
    var idx0 = 0;
    for (k = 0; k < nx; k++) {
      for (j = 0; j < nx; j++) {
        for (i = 0; i < nx; i++, idx0++) {
          var v;
          try { v = F(xs[i], ys[j], zs[k]); } catch (e) { v = NaN; }
          // ±Infinity (1/x poles) must not count as a signed sample, or the
          // pole meshes as a spurious full-window wall
          vals[idx0] = isFinite(v) ? v : NaN;
        }
      }
    }
    var node = function (i2, j2, k2) { return (k2 * nx + j2) * nx + i2; };

    // cached face-center decider; faceKey = axis * nn + lowNodeIndex. NaN
    // center counts as outside, which cuts off the inside corners — the
    // self-consistent choice for the fill/cap builders.
    var faceDec = new Map();
    var faceCenterInside = function (axis, ni) {
      var key = axis * nn + ni;
      var d = faceDec.get(key);
      if (d !== undefined) return d;
      var ii = ni % nx, jj = ((ni - ii) / nx) % nx, kk = Math.floor(ni / nx2);
      var v;
      try {
        v = F(xs[ii] + (axis === 0 ? 0 : hx / 2),
              ys[jj] + (axis === 1 ? 0 : hy / 2),
              zs[kk] + (axis === 2 ? 0 : hz / 2));
      } catch (e) { v = NaN; }
      d = v < 0;
      faceDec.set(key, d);
      return d;
    };

    // refined crossing position per lattice edge; edgeKey = nodeIndex*3 + axis
    var crossPos = new Map(); // edgeKey → [x,y,z]
    var ends = new Float64Array(6);
    var edgeEnds = function (ekey) { // fills ends = [x0,y0,z0, x1,y1,z1]
      var axis = ekey % 3, ni = (ekey - axis) / 3;
      var ii = ni % nx, jj = ((ni - ii) / nx) % nx, kk = Math.floor(ni / nx2);
      ends[0] = xs[ii]; ends[1] = ys[jj]; ends[2] = zs[kk];
      ends[3] = xs[ii + (axis === 0 ? 1 : 0)];
      ends[4] = ys[jj + (axis === 1 ? 1 : 0)];
      ends[5] = zs[kk + (axis === 2 ? 1 : 0)];
    };
    var refineOn = !!opts.refine;
    var crossingOf = function (ekey, va, vb) {
      if (crossPos.has(ekey)) return;
      var t = va / (va - vb);
      if (!isFinite(t)) t = 0.5;
      t = Math.max(0, Math.min(1, t));
      edgeEnds(ekey);
      if (refineOn && crossPos.size < REFINE_EDGE_CAP) {
        // Illinois-method false position: plain regula falsi stalls at an
        // endpoint whose value is tiny (the region inset creates exactly
        // that), so a retained endpoint gets its stored value halved. The
        // sample with the smallest |F| wins; if even that is no better than
        // the endpoints, the sign flip is a pole, not a zero — keep linear t.
        var lo = 0, hi = 1, flo = va, fhi = vb, side = 0;
        var lastT = t, bestMag = Infinity;
        for (var it = 0; it < 12; it++) {
          // Four bisection steps first: false position stalls on a wildly
          // imbalanced bracket (the region inset makes boundary samples ~1e-6
          // against interior values ~1, and max() fields sit near zero across
          // whole plateaus). Bisection homes onto the sign change regardless;
          // Illinois false position then polishes quickly.
          var tt;
          if (it < 4) tt = (lo + hi) / 2;
          else {
            tt = lo + (hi - lo) * (flo / (flo - fhi));
            if (!isFinite(tt) || tt <= lo || tt >= hi) tt = (lo + hi) / 2;
          }
          var fm;
          try {
            fm = F(ends[0] + (ends[3] - ends[0]) * tt,
                   ends[1] + (ends[4] - ends[1]) * tt,
                   ends[2] + (ends[5] - ends[2]) * tt);
          } catch (e) { fm = NaN; }
          if (!isFinite(fm)) break;
          lastT = tt; // the bracket iterate converges to the crossing…
          var am = Math.abs(fm);
          if (am < bestMag) bestMag = am; // …|F| alone can NOT pick it: a max()
          if (am === 0) break;            // field is near-zero across its whole
          if ((fm < 0) === (flo < 0)) {   // plateau, not just at the crossing
            lo = tt; flo = fm;
            if (side === -1) fhi *= 0.5;
            side = -1;
          } else {
            hi = tt; fhi = fm;
            if (side === 1) flo *= 0.5;
            side = 1;
          }
        }
        // pole guard: near a pole |F| explodes between the endpoints, so no
        // sample gets anywhere near zero on the endpoints' scale. (Comparing
        // against the SMALLER endpoint is wrong: the region inset legitimately
        // makes one endpoint ~1e-6 while the true crossing sits mid-edge.)
        if (bestMag <= Math.max(Math.abs(va), Math.abs(vb)) * 1e-3 ||
            bestMag <= Math.min(Math.abs(va), Math.abs(vb))) t = lastT;
      }
      crossPos.set(ekey, [
        ends[0] + (ends[3] - ends[0]) * t,
        ends[1] + (ends[4] - ends[1]) * t,
        ends[2] + (ends[5] - ends[2]) * t]);
    };

    // trilinear blend of lattice-node gradients (no F evals) — fast-mode normals
    var latticeGrad = function (p, out) {
      var fx = (p[0] - win.xmin) / hx, fy = (p[1] - win.ymin) / hy, fz = (p[2] - win.zmin) / hz;
      var i0 = Math.max(0, Math.min(nx - 2, Math.floor(fx)));
      var j0 = Math.max(0, Math.min(nx - 2, Math.floor(fy)));
      var k0 = Math.max(0, Math.min(nx - 2, Math.floor(fz)));
      var tx = Math.max(0, Math.min(1, fx - i0)), ty = Math.max(0, Math.min(1, fy - j0)), tz = Math.max(0, Math.min(1, fz - k0));
      var gx = 0, gy = 0, gz = 0, wsum = 0;
      for (var c = 0; c < 8; c++) {
        var di = c & 1, dj = (c >> 1) & 1, dk = (c >> 2) & 1;
        var w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz);
        if (w === 0) continue;
        var ii = i0 + di, jj = j0 + dj, kk = k0 + dk;
        var ia = ii > 0 ? ii - 1 : ii, ib = ii < nx - 1 ? ii + 1 : ii;
        var ja = jj > 0 ? jj - 1 : jj, jb = jj < nx - 1 ? jj + 1 : jj;
        var ka = kk > 0 ? kk - 1 : kk, kb = kk < nx - 1 ? kk + 1 : kk;
        var dxv = (vals[node(ib, jj, kk)] - vals[node(ia, jj, kk)]) / ((ib - ia) * hx);
        var dyv = (vals[node(ii, jb, kk)] - vals[node(ii, ja, kk)]) / ((jb - ja) * hy);
        var dzv = (vals[node(ii, jj, kb)] - vals[node(ii, jj, ka)]) / ((kb - ka) * hz);
        if (!isFinite(dxv) || !isFinite(dyv) || !isFinite(dzv)) continue;
        gx += w * dxv; gy += w * dyv; gz += w * dzv; wsum += w;
      }
      if (!wsum) { out[0] = 0; out[1] = 0; out[2] = 1; return; }
      out[0] = gx; out[1] = gy; out[2] = gz;
    };
    var gradExact = !!opts.gradF;
    var heps = Math.min(hx, hy, hz) * 0.01;
    var gradAt = function (fn, p, out) {
      if (gradExact) {
        var inv2h = 1 / (2 * heps); // TRUE gradient scale — the crease snap
        try {                       // solves with these, not just normalizes
          out[0] = (fn(p[0] + heps, p[1], p[2]) - fn(p[0] - heps, p[1], p[2])) * inv2h;
          out[1] = (fn(p[0], p[1] + heps, p[2]) - fn(p[0], p[1] - heps, p[2])) * inv2h;
          out[2] = (fn(p[0], p[1], p[2] + heps) - fn(p[0], p[1], p[2] - heps)) * inv2h;
        } catch (e) { out[0] = NaN; }
        if (isFinite(out[0]) && isFinite(out[1]) && isFinite(out[2]) &&
            (out[0] !== 0 || out[1] !== 0 || out[2] !== 0)) return;
      }
      latticeGrad(p, out);
    };

    var parts = opts.parts && opts.parts.length > 1 ? opts.parts : null;
    var K = parts ? parts.length : 1;
    var pos = [], nrm = [], idx = [];
    var vmap = new Map(); // edgeKey*K + aid → vertex index
    var g3 = [0, 0, 0];
    var vertexOf = function (ekey, aid) {
      var vk = ekey * K + aid;
      var vi = vmap.get(vk);
      if (vi !== undefined) return vi;
      var p = crossPos.get(ekey);
      gradAt(parts ? parts[aid] : F, p, g3);
      var gl = Math.hypot(g3[0], g3[1], g3[2]);
      if (!isFinite(gl) || gl === 0) { g3[0] = 0; g3[1] = 0; g3[2] = 1; gl = 1; }
      vi = pos.length / 3;
      pos.push(p[0], p[1], p[2]);
      nrm.push(g3[0] / gl, g3[1] / gl, g3[2] / gl);
      vmap.set(vk, vi);
      return vi;
    };
    // active constraint at a point: argmax over parts (ties → lowest index)
    var activeId = function (px, py, pz) {
      var best = 0, bv = -Infinity;
      for (var pi = 0; pi < K; pi++) {
        var pv;
        try { pv = parts[pi](px, py, pz); } catch (e) { pv = -Infinity; }
        if (isFinite(pv) && pv > bv) { bv = pv; best = pi; }
      }
      return best;
    };
    var emitLoop = function (loop) {
      // fan-triangulate; per-triangle active constraint keeps creases crisp
      var p0 = crossPos.get(loop[0]);
      for (var t = 1; t + 1 < loop.length; t++) {
        var aid = 0;
        if (parts) {
          var pa = crossPos.get(loop[t]), pb = crossPos.get(loop[t + 1]);
          aid = activeId((p0[0] + pa[0] + pb[0]) / 3, (p0[1] + pa[1] + pb[1]) / 3, (p0[2] + pa[2] + pb[2]) / 3);
        }
        idx.push(vertexOf(loop[0], aid), vertexOf(loop[t], aid), vertexOf(loop[t + 1], aid));
      }
    };

    /* cell faces: for face normal axis a the in-plane axes are (b, c); the 4
     * corners run CCW in (b,c): (0,0) (1,0) (1,1) (0,1). */
    var AXB = [1, 0, 0], AXC = [2, 2, 1];
    var off = [0, 0, 0];
    var segsA = [], segsB = []; // per-cell scratch: segment endpoint edgeKeys
    var loopScratch = [];
    var cellLoops = function (ci, cj, ck) {
      segsA.length = 0; segsB.length = 0;
      var a, s;
      for (a = 0; a < 3; a++) {
        var b = AXB[a], c = AXC[a];
        for (s = 0; s <= 1; s++) {
          off[0] = ci; off[1] = cj; off[2] = ck;
          off[a] += s;
          var n0 = node(off[0], off[1], off[2]);
          var db = b === 0 ? 1 : b === 1 ? nx : nx2;
          var dc = c === 0 ? 1 : c === 1 ? nx : nx2;
          var n1 = n0 + db, n2 = n0 + db + dc, n3 = n0 + dc;
          var v0 = vals[n0], v1 = vals[n1], v2 = vals[n2], v3 = vals[n3];
          var b0 = v0 < 0, b1 = v1 < 0, b2 = v2 < 0, b3 = v3 < 0;
          var e01 = b0 !== b1 ? n0 * 3 + b : -1;
          var e12 = b1 !== b2 ? n1 * 3 + c : -1;
          var e32 = b3 !== b2 ? n3 * 3 + b : -1;
          var e03 = b0 !== b3 ? n0 * 3 + c : -1;
          if (e01 >= 0) crossingOf(e01, v0, v1);
          if (e12 >= 0) crossingOf(e12, v1, v2);
          if (e32 >= 0) crossingOf(e32, v3, v2);
          if (e03 >= 0) crossingOf(e03, v0, v3);
          var cnt = (e01 >= 0 ? 1 : 0) + (e12 >= 0 ? 1 : 0) + (e32 >= 0 ? 1 : 0) + (e03 >= 0 ? 1 : 0);
          if (cnt === 2) {
            var p1 = e01 >= 0 ? e01 : e12 >= 0 ? e12 : e32;
            var p2 = e03 >= 0 ? e03 : e32 >= 0 && p1 !== e32 ? e32 : e12;
            segsA.push(p1); segsB.push(p2);
          } else if (cnt === 4) {
            // saddle: the (cached) center sample decides the pairing
            if (faceCenterInside(a, n0) === b0) { segsA.push(e01, e32); segsB.push(e12, e03); }
            else { segsA.push(e03, e12); segsB.push(e01, e32); }
          }
        }
      }
      if (!segsA.length) return;
      // chain the segments (each crossing has degree exactly 2) into loops
      var links = new Map(); // edgeKey → [nbr, nbr]
      var m;
      for (m = 0; m < segsA.length; m++) {
        var la = links.get(segsA[m]); if (!la) links.set(segsA[m], la = []);
        la.push(segsB[m]);
        var lb = links.get(segsB[m]); if (!lb) links.set(segsB[m], lb = []);
        lb.push(segsA[m]);
      }
      var used = new Set();
      links.forEach(function (nbrs, start) {
        if (used.has(start)) return;
        loopScratch.length = 0;
        loopScratch.push(start);
        used.add(start);
        var cur = start, prev = -1;
        for (;;) {
          var ln = links.get(cur);
          var nxt = ln[0] === prev ? ln[1] : ln[0];
          if (nxt === undefined || nxt === start || used.has(nxt)) break;
          loopScratch.push(nxt);
          used.add(nxt);
          prev = cur; cur = nxt;
        }
        if (loopScratch.length >= 3) emitLoop(loopScratch);
      });
    };

    for (k = 0; k < N; k++) {
      for (j = 0; j < N; j++) {
        for (i = 0; i < N; i++) {
          var bad = false, allIn = true, allOut = true;
          for (var c8 = 0; c8 < 8; c8++) {
            var vv = vals[node(i + (c8 & 1), j + ((c8 >> 1) & 1), k + ((c8 >> 2) & 1))];
            if (isNaN(vv)) { bad = true; break; }
            if (vv < 0) allOut = false; else allIn = false;
          }
          if (bad || allIn || allOut) continue;
          cellLoops(i, j, k);
        }
      }
    }

    // Snap crease vertices onto the true constraint intersection: linear-interp
    // MC chamfers interior max() creases at cell scale. A vertex welded under
    // two different constraints sits on such a crease; two or three Newton
    // steps toward gᵢ = gⱼ = 0 straighten the edge. All copies share the moved
    // position, so the mesh stays watertight. Vertices on a window face stay
    // put (the cap rim must remain planar and seam-exact).
    var snapStats = { cand: 0, onFace: 0, gated: 0, noPair: 0, diverged: 0, moved: 0 };
    if (parts && refineOn) {
      var byEdge = new Map(); // edgeKey → [[aid, vertIndex], …]
      vmap.forEach(function (vi, vk) {
        var ek = Math.floor(vk / K);
        var arr = byEdge.get(ek);
        if (!arr) byEdge.set(ek, arr = []);
        arr.push([vk % K, vi]);
      });
      var gA = [0, 0, 0], gB = [0, 0, 0];
      var eps2 = 1e-9 * Math.max(win.xmax - win.xmin, win.ymax - win.ymin, win.zmax - win.zmin);
      var maxStep = 0.75 * Math.max(hx, hy, hz);
      byEdge.forEach(function (copies, ek) {
        if (copies.length < 2) return;
        snapStats.cand++;
        var p = crossPos.get(ek);
        if (Math.abs(p[0] - win.xmin) < eps2 || Math.abs(p[0] - win.xmax) < eps2 ||
            Math.abs(p[1] - win.ymin) < eps2 || Math.abs(p[1] - win.ymax) < eps2 ||
            Math.abs(p[2] - win.zmin) < eps2 || Math.abs(p[2] - win.zmax) < eps2) { snapStats.onFace++; return; }
        // the two most-active constraints at the vertex
        var best = -1, second = -1, bv = -Infinity, sv = -Infinity;
        for (var pi = 0; pi < K; pi++) {
          var pv;
          try { pv = parts[pi](p[0], p[1], p[2]); } catch (e) { pv = -Infinity; }
          if (!isFinite(pv)) continue;
          if (pv > bv) { sv = bv; second = best; bv = pv; best = pi; }
          else if (pv > sv) { sv = pv; second = pi; }
        }
        if (best < 0 || second < 0) { snapStats.noPair++; return; }
        var ga = parts[best], gb = parts[second];
        // only vertices genuinely within a cell of the crease may move: the
        // second constraint must be near zero relative to its own gradient.
        // (Triangles in the tie zone can carry a split copy much further out;
        // dragging those would dent the smooth surface instead of cleaning
        // the edge.)
        gradAt(gb, p, gB);
        var gbn = Math.hypot(gB[0], gB[1], gB[2]);
        if (!isFinite(gbn) || gbn === 0 || Math.abs(sv) > 1.5 * gbn * maxStep) { snapStats.gated++; return; }
        var q = [p[0], p[1], p[2]];
        var f0 = Math.max(Math.abs(bv), Math.abs(sv));
        for (var it = 0; it < 3; it++) {
          var va, vb2;
          try { va = ga(q[0], q[1], q[2]); vb2 = gb(q[0], q[1], q[2]); } catch (e) { snapStats.diverged++; return; }
          if (!isFinite(va) || !isFinite(vb2)) { snapStats.diverged++; return; }
          if (Math.abs(va) < 1e-10 && Math.abs(vb2) < 1e-10) break;
          gradAt(ga, q, gA); gradAt(gb, q, gB);
          var aa = gA[0] * gA[0] + gA[1] * gA[1] + gA[2] * gA[2];
          var ab = gA[0] * gB[0] + gA[1] * gB[1] + gA[2] * gB[2];
          var bb = gB[0] * gB[0] + gB[1] * gB[1] + gB[2] * gB[2];
          var det = aa * bb - ab * ab;
          if (!(det > 1e-9 * aa * bb)) { snapStats.noPair++; return; } // near-parallel: no crease here
          // minimum-norm step d with gA·d = −va, gB·d = −vb2
          var la = (-va * bb + vb2 * ab) / det, lb = (-vb2 * aa + va * ab) / det;
          var dx = la * gA[0] + lb * gB[0], dy = la * gA[1] + lb * gB[1], dz = la * gA[2] + lb * gB[2];
          var dl = Math.hypot(dx, dy, dz);
          if (!isFinite(dl) || dl === 0) break;
          if (dl > maxStep) { var sc = maxStep / dl; dx *= sc; dy *= sc; dz *= sc; }
          q[0] += dx; q[1] += dy; q[2] += dz;
        }
        var fa2, fb2;
        try { fa2 = ga(q[0], q[1], q[2]); fb2 = gb(q[0], q[1], q[2]); } catch (e) { snapStats.diverged++; return; }
        if (!isFinite(fa2) || !isFinite(fb2) ||
            Math.max(Math.abs(fa2), Math.abs(fb2)) > f0 + 1e-12) { snapStats.diverged++; return; } // diverged
        q[0] = Math.max(win.xmin, Math.min(win.xmax, q[0]));
        q[1] = Math.max(win.ymin, Math.min(win.ymax, q[1]));
        q[2] = Math.max(win.zmin, Math.min(win.zmax, q[2]));
        p[0] = q[0]; p[1] = q[1]; p[2] = q[2]; // caps see the snapped position too
        copies.forEach(function (ca) {
          var vi3 = ca[1] * 3;
          pos[vi3] = q[0]; pos[vi3 + 1] = q[1]; pos[vi3 + 2] = q[2];
          gradAt(parts[ca[0]], q, g3);
          var gl = Math.hypot(g3[0], g3[1], g3[2]);
          if (!isFinite(gl) || gl === 0) { g3[0] = 0; g3[1] = 0; g3[2] = 1; gl = 1; }
          nrm[vi3] = g3[0] / gl; nrm[vi3 + 1] = g3[1] / gl; nrm[vi3 + 2] = g3[2] / gl;
        });
        snapStats.moved++;
      });
    }

    // consistent winding: face normal must agree with the vertex gradients
    for (var t3 = 0; t3 < idx.length; t3 += 3) {
      var A = idx[t3] * 3, B = idx[t3 + 1] * 3, C = idx[t3 + 2] * 3;
      var e1x = pos[B] - pos[A], e1y = pos[B + 1] - pos[A + 1], e1z = pos[B + 2] - pos[A + 2];
      var e2x = pos[C] - pos[A], e2y = pos[C + 1] - pos[A + 1], e2z = pos[C + 2] - pos[A + 2];
      var fnx = e1y * e2z - e1z * e2y, fny = e1z * e2x - e1x * e2z, fnz = e1x * e2y - e1y * e2x;
      var gsx = nrm[A] + nrm[B] + nrm[C], gsy = nrm[A + 1] + nrm[B + 1] + nrm[C + 1], gsz = nrm[A + 2] + nrm[B + 2] + nrm[C + 2];
      if (fnx * gsx + fny * gsy + fnz * gsz < 0) {
        var tmp = idx[t3 + 1]; idx[t3 + 1] = idx[t3 + 2]; idx[t3 + 2] = tmp;
      }
    }

    return {
      pos: pos, nrm: nrm, idx: idx,
      cache: { vals: vals, nx: nx, xs: xs, ys: ys, zs: zs, hx: hx, hy: hy, hz: hz,
               crossPos: crossPos, faceDec: faceDec, F: F, snapStats: snapStats }
    };
  };

  /* ---------- box-face caps for region solids ----------
   * For each window face, fill F<0 over the face's lattice slice: full cells
   * become quads, boundary cells are clipped using the SAME refined crossings
   * (cache.crossPos) and the SAME saddle deciders (cache.faceDec) as the 3D
   * pass, so the cap rim is vertex-identical with the surface rim. Caps are
   * exactly planar with hard outward face normals.
   */
  M.buildCaps = function (win, N, cache) {
    var nx = cache.nx, nx2 = nx * nx, nn = nx2 * nx;
    var xs = cache.xs, ys = cache.ys, zs = cache.zs;
    var pos = [], nrm = [], idx = [];
    // in-plane axes must be RIGHT-HANDED (b̂×ĉ = +â) for every axis, or the
    // flip logic below inverts a pair of caps: (y,z) for x-faces, (z,x) for
    // y-faces, (x,y) for z-faces
    var AXB = [1, 2, 0], AXC = [2, 0, 1];
    for (var a = 0; a < 3; a++) {
      var b = AXB[a], c = AXC[a];
      var db = b === 0 ? 1 : b === 1 ? nx : nx2;
      var dc = c === 0 ? 1 : c === 1 ? nx : nx2;
      var da = a === 0 ? 1 : a === 1 ? nx : nx2;
      for (var s = 0; s <= 1; s++) {
        var base = s === 0 ? 0 : N * da;
        var onx = a === 0 ? (s ? 1 : -1) : 0;
        var ony = a === 1 ? (s ? 1 : -1) : 0;
        var onz = a === 2 ? (s ? 1 : -1) : 0;
        var flip = s === 0; // CCW in (b,c) faces +a; min faces face −a
        var vmap = new Map(); // nodeIndex → vert, or -1-edgeKey → vert
        var pushV = function (px, py, pz) {
          pos.push(px, py, pz);
          nrm.push(onx, ony, onz);
          return pos.length / 3 - 1;
        };
        var cornerV = function (ni) {
          var vi = vmap.get(ni);
          if (vi !== undefined) return vi;
          var ii = ni % nx, jj = ((ni - ii) / nx) % nx, kk = Math.floor(ni / nx2);
          vi = pushV(xs[ii], ys[jj], zs[kk]);
          vmap.set(ni, vi);
          return vi;
        };
        var crossV = function (ekey, va, vb) {
          var mk = -1 - ekey;
          var vi = vmap.get(mk);
          if (vi !== undefined) return vi;
          var p = cache.crossPos.get(ekey);
          if (!p) { // untouched by the 3D pass (degenerate NaN neighborhood)
            var t = va / (va - vb);
            if (!isFinite(t)) t = 0.5;
            t = Math.max(0, Math.min(1, t));
            var axis = ekey % 3, ni = (ekey - axis) / 3;
            var ii = ni % nx, jj = ((ni - ii) / nx) % nx, kk = Math.floor(ni / nx2);
            p = [xs[ii], ys[jj], zs[kk]];
            if (axis === 0) p[0] = xs[ii] + (xs[ii + 1] - xs[ii]) * t;
            else if (axis === 1) p[1] = ys[jj] + (ys[jj + 1] - ys[jj]) * t;
            else p[2] = zs[kk] + (zs[kk + 1] - zs[kk]) * t;
          }
          vi = pushV(p[0], p[1], p[2]);
          vmap.set(mk, vi);
          return vi;
        };
        var emitPoly = function (poly) {
          for (var t2 = 1; t2 + 1 < poly.length; t2++) {
            if (flip) idx.push(poly[0], poly[t2 + 1], poly[t2]);
            else idx.push(poly[0], poly[t2], poly[t2 + 1]);
          }
        };
        // a fully-inside face (the region covers this whole window slab) is
        // one quad, not N² cell quads — a plain box otherwise floods the
        // scene with tens of thousands of coplanar triangles
        var allIn = true;
        for (var q1 = 0; q1 <= N && allIn; q1++) {
          for (var q2 = 0; q2 <= N; q2++) {
            if (!(cache.vals[base + q1 * db + q2 * dc] < 0)) { allIn = false; break; }
          }
        }
        if (allIn) {
          emitPoly([cornerV(base), cornerV(base + N * db),
                    cornerV(base + N * db + N * dc), cornerV(base + N * dc)]);
          continue;
        }
        for (var jc = 0; jc < N; jc++) {
          for (var ib = 0; ib < N; ib++) {
            var n0 = base + ib * db + jc * dc;
            var n1 = n0 + db, n2 = n0 + db + dc, n3 = n0 + dc;
            var v0 = cache.vals[n0], v1 = cache.vals[n1], v2 = cache.vals[n2], v3 = cache.vals[n3];
            if (isNaN(v0) || isNaN(v1) || isNaN(v2) || isNaN(v3)) continue;
            var b0 = v0 < 0, b1 = v1 < 0, b2 = v2 < 0, b3 = v3 < 0;
            var nIn = (b0 ? 1 : 0) + (b1 ? 1 : 0) + (b2 ? 1 : 0) + (b3 ? 1 : 0);
            if (nIn === 0) continue;
            if (nIn === 4) {
              emitPoly([cornerV(n0), cornerV(n1), cornerV(n2), cornerV(n3)]);
              continue;
            }
            var e01 = n0 * 3 + b, e12 = n1 * 3 + c, e32 = n3 * 3 + b, e03 = n0 * 3 + c;
            if (nIn === 2 && b0 === b2) {
              // saddle: same decider as the 3D pass (compute + cache if new)
              var dkey = a * nn + n0;
              var dec = cache.faceDec.get(dkey);
              if (dec === undefined) {
                var ii0 = n0 % nx, jj0 = ((n0 - ii0) / nx) % nx, kk0 = Math.floor(n0 / nx2);
                var vC;
                try {
                  vC = cache.F(xs[ii0] + (a === 0 ? 0 : cache.hx / 2),
                               ys[jj0] + (a === 1 ? 0 : cache.hy / 2),
                               zs[kk0] + (a === 2 ? 0 : cache.hz / 2));
                } catch (e) { vC = NaN; }
                dec = vC < 0;
                cache.faceDec.set(dkey, dec);
              }
              if (!dec) { // center outside → two isolated corner triangles
                if (b0) emitPoly([cornerV(n0), crossV(e01, v0, v1), crossV(e03, v0, v3)]);
                if (b2) emitPoly([cornerV(n2), crossV(e32, v3, v2), crossV(e12, v1, v2)]);
                if (b1) emitPoly([cornerV(n1), crossV(e12, v1, v2), crossV(e01, v0, v1)]);
                if (b3) emitPoly([cornerV(n3), crossV(e03, v0, v3), crossV(e32, v3, v2)]);
                continue;
              } // center inside → perimeter walk gives the hex band
            }
            var poly = [];
            var corners = [n0, n1, n2, n3];
            var insV = [b0, b1, b2, b3], valsC = [v0, v1, v2, v3];
            var edges = [e01, e12, e32, e03];            // edge d: corner d → d+1
            var lowFirst = [true, true, false, false];   // e32/e03 run opposite the walk
            for (var d = 0; d < 4; d++) {
              if (insV[d]) poly.push(cornerV(corners[d]));
              var dn = (d + 1) % 4;
              if (insV[d] !== insV[dn]) {
                poly.push(lowFirst[d] ? crossV(edges[d], valsC[d], valsC[dn])
                                      : crossV(edges[d], valsC[dn], valsC[d]));
              }
            }
            if (poly.length >= 3) emitPoly(poly);
          }
        }
      }
    }
    return { pos: pos, nrm: nrm, idx: idx };
  };

  /* ---------- 2D marching-squares core (shared with geometry.js) ---------- */
  M.msLerp = function (xa, ya, fa, xb, yb, fb) {
    var s = fa / (fa - fb);
    if (!isFinite(s)) s = 0.5;
    s = Math.max(0, Math.min(1, s));
    return [xa + (xb - xa) * s, ya + (yb - ya) * s, 0];
  };
  // raw zero-crossing segments of f over a uniform nx*ny grid on [x0,x1]x[y0,y1]
  M.msCells = function (f, x0, x1, y0, y1, nx, ny, segs) {
    M.msCellsFill(f, x0, x1, y0, y1, nx, ny, segs, null);
  };
  // same sampling; when fill is an array, also emits the inside (f<0) polygon
  // of every cell — from the SAME corner values and the SAME saddle
  // center-sample, so the fill edge and the stroke contour coincide exactly.
  // Saddle rule: center sample decides; a NaN center counts as outside (cuts
  // the inside corners apart), consistently for segments and fill.
  M.msCellsFill = function (f, x0, x1, y0, y1, nx, ny, segs, fill) {
    var i, j;
    var xs = new Float64Array(nx + 1), ys = new Float64Array(ny + 1);
    for (i = 0; i <= nx; i++) xs[i] = x0 + (x1 - x0) * i / nx;
    for (j = 0; j <= ny; j++) ys[j] = y0 + (y1 - y0) * j / ny;
    var vals = new Float64Array((nx + 1) * (ny + 1));
    for (j = 0; j <= ny; j++) {
      for (i = 0; i <= nx; i++) {
        var v;
        try { v = f(xs[i], ys[j]); } catch (e) { v = NaN; }
        vals[j * (nx + 1) + i] = isFinite(v) ? v : NaN;
      }
    }
    // walk a finite→NaN edge to the domain boundary (sqrt/ln edges)
    var domainEdge = function (ax2, ay2, bx3, by3) {
      for (var it2 = 0; it2 < 10; it2++) {
        var mx = (ax2 + bx3) / 2, my = (ay2 + by3) / 2, fm2;
        try { fm2 = f(mx, my); } catch (e3) { fm2 = NaN; }
        if (isFinite(fm2)) { ax2 = mx; ay2 = my; } else { bx3 = mx; by3 = my; }
      }
      return [ax2, ay2, 0];
    };
    for (j = 0; j < ny; j++) {
      for (i = 0; i < nx; i++) {
        var f00 = vals[j * (nx + 1) + i], f10 = vals[j * (nx + 1) + i + 1];
        var f01 = vals[(j + 1) * (nx + 1) + i], f11 = vals[(j + 1) * (nx + 1) + i + 1];
        var cx0 = xs[i], cx1 = xs[i + 1], cy0 = ys[j], cy1 = ys[j + 1];
        if (isNaN(f00) || isNaN(f10) || isNaN(f01) || isNaN(f11)) {
          // NaN corners count as outside for the FILL so regions reach their
          // domain edge (fill only — a stroke along the domain boundary would
          // be a phantom curve). Inside↔NaN crossings bisect to the boundary.
          if (!fill) continue;
          var cornersN = [[cx0, cy0, 0], [cx1, cy0, 0], [cx1, cy1, 0], [cx0, cy1, 0]];
          var valsN = [f00, f10, f11, f01];
          var insN = [f00 < 0, f10 < 0, f11 < 0, f01 < 0];
          if (!insN[0] && !insN[1] && !insN[2] && !insN[3]) continue;
          var polyN = [];
          for (var dN = 0; dN < 4; dN++) {
            var dn2 = (dN + 1) % 4;
            if (insN[dN]) polyN.push(cornersN[dN]);
            if (insN[dN] !== insN[dn2]) {
              var A2 = cornersN[insN[dN] ? dN : dn2], B2 = cornersN[insN[dN] ? dn2 : dN];
              var vA = valsN[insN[dN] ? dN : dn2], vB = valsN[insN[dN] ? dn2 : dN];
              polyN.push(isNaN(vB) ? domainEdge(A2[0], A2[1], B2[0], B2[1])
                                   : M.msLerp(A2[0], A2[1], vA, B2[0], B2[1], vB));
            }
          }
          if (polyN.length >= 3) fill.push(polyN);
          continue;
        }
        var b00 = f00 < 0, b10 = f10 < 0, b01 = f01 < 0, b11 = f11 < 0;
        var nIn = (b00 ? 1 : 0) + (b10 ? 1 : 0) + (b01 ? 1 : 0) + (b11 ? 1 : 0);
        if (nIn === 0) continue;
        if (nIn === 4) {
          if (fill) fill.push([[cx0, cy0, 0], [cx1, cy0, 0], [cx1, cy1, 0], [cx0, cy1, 0]]);
          continue;
        }
        // crossings on the perimeter edges: bottom, right, top, left
        var cB = b00 !== b10 ? M.msLerp(cx0, cy0, f00, cx1, cy0, f10) : null;
        var cR = b10 !== b11 ? M.msLerp(cx1, cy0, f10, cx1, cy1, f11) : null;
        var cT = b01 !== b11 ? M.msLerp(cx0, cy1, f01, cx1, cy1, f11) : null;
        var cL = b00 !== b01 ? M.msLerp(cx0, cy0, f00, cx0, cy1, f01) : null;
        if (nIn === 2 && b00 === b11) {
          // saddle
          var fc;
          try { fc = f((cx0 + cx1) / 2, (cy0 + cy1) / 2); } catch (e2) { fc = NaN; }
          var centerIn = fc < 0; // NaN → outside
          if (centerIn === b00) { segs.push([cB, cR]); segs.push([cT, cL]); }
          else { segs.push([cL, cB]); segs.push([cR, cT]); }
          if (fill && !centerIn) { // two isolated corner triangles
            if (b00) fill.push([[cx0, cy0, 0], cB, cL]);
            if (b11) fill.push([[cx1, cy1, 0], cT, cR]);
            if (b10) fill.push([[cx1, cy0, 0], cR, cB]);
            if (b01) fill.push([[cx0, cy1, 0], cL, cT]);
          }
          if (!fill || !centerIn) continue;
          // center inside → the perimeter walk below yields the hex band
        } else {
          // non-saddle mixed cell: exactly two crossings → one segment
          var segA = null, segB2 = null;
          if (cB) segA = cB;
          if (cR) { if (segA) segB2 = cR; else segA = cR; }
          if (cT) { if (segA) { if (!segB2) segB2 = cT; } else segA = cT; }
          if (cL) { if (!segB2) segB2 = cL; }
          if (segA && segB2) segs.push([segA, segB2]);
        }
        if (fill) {
          var corners = [[cx0, cy0, 0], [cx1, cy0, 0], [cx1, cy1, 0], [cx0, cy1, 0]];
          var ins = [b00, b10, b11, b01];
          var crossD = [cB, cR, cT, cL]; // crossing on edge d: corner d → d+1
          var poly = [];
          for (var d = 0; d < 4; d++) {
            if (ins[d]) poly.push(corners[d]);
            if (ins[d] !== ins[(d + 1) % 4]) poly.push(crossD[d]);
          }
          if (poly.length >= 3) fill.push(poly);
        }
      }
    }
  };

  // chain raw segments into polylines by snapping coincident endpoints
  M.chainSegs = function (segs, q) {
    if (!segs.length) return [];
    var key = function (p) { return Math.round(p[0] / q) + ',' + Math.round(p[1] / q); };
    var links = {};
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
      if (line.length > 1) polylines.push(line);
    }
    return polylines;
  };

  /* ---------- 2D inequality fill ----------
   * Adaptive: full-inside base cells become two triangles on the shared
   * lattice; mixed cells are subdivided and filled via msCellsFill, so the
   * fill edge uses the very crossings the stroke contour is chained from.
   * Returns { pos, idx, contours } with z = 0 (the caller lifts the mesh).
   */
  M.fillRegion2D = function (f, win, baseRes, refine) {
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
    var pos = [], idx = [];
    var nodeV = new Map();
    var nodeVert = function (ii, jj) {
      var nk = jj * (n + 1) + ii;
      var vi = nodeV.get(nk);
      if (vi !== undefined) return vi;
      vi = pos.length / 3;
      pos.push(bx[ii], by[jj], 0);
      nodeV.set(nk, vi);
      return vi;
    };
    var active = [];
    for (j = 0; j < n; j++) {
      for (i = 0; i < n; i++) {
        var g00 = bv[j * (n + 1) + i], g10 = bv[j * (n + 1) + i + 1];
        var g01 = bv[(j + 1) * (n + 1) + i], g11 = bv[(j + 1) * (n + 1) + i + 1];
        if (isNaN(g00) || isNaN(g10) || isNaN(g01) || isNaN(g11)) {
          // domain-edge cells (sqrt, ln) refine instead of vanishing, so the
          // fill reaches within a sub-cell of the boundary and stops shimmering
          if (g00 < 0 || g10 < 0 || g01 < 0 || g11 < 0) active.push(j * n + i);
          continue;
        }
        var nIn = (g00 < 0 ? 1 : 0) + (g10 < 0 ? 1 : 0) + (g01 < 0 ? 1 : 0) + (g11 < 0 ? 1 : 0);
        if (nIn === 4) {
          idx.push(nodeVert(i, j), nodeVert(i + 1, j), nodeVert(i + 1, j + 1),
                   nodeVert(i, j), nodeVert(i + 1, j + 1), nodeVert(i, j + 1));
        } else if (nIn > 0) {
          active.push(j * n + i);
        }
      }
    }
    var segs = [], fillPolys = [], sub = 1;
    if (active.length) {
      sub = 1 << Math.max(1, refine || 3);
      var maxSub = Math.max(2, Math.floor(Math.sqrt(60000 / active.length)));
      if (sub > maxSub) sub = maxSub;
      for (var a2 = 0; a2 < active.length; a2++) {
        var ci = active[a2] % n, cj = (active[a2] - ci) / n;
        M.msCellsFill(f, bx[ci], bx[ci + 1], by[cj], by[cj + 1], sub, sub, segs, fillPolys);
      }
    }
    // weld refined-cell polygon vertices by quantized position so shared
    // sub-edges stay crack-free
    var q2 = Math.max(x1 - x0, y1 - y0) * 1e-9;
    var pmap = new Map();
    var polyVert = function (p) {
      var kk = Math.round(p[0] / q2) + ',' + Math.round(p[1] / q2);
      var vi = pmap.get(kk);
      if (vi !== undefined) return vi;
      vi = pos.length / 3;
      pos.push(p[0], p[1], 0);
      pmap.set(kk, vi);
      return vi;
    };
    for (var fp = 0; fp < fillPolys.length; fp++) {
      var poly = fillPolys[fp];
      var v0i = polyVert(poly[0]);
      for (var t = 1; t + 1 < poly.length; t++) {
        idx.push(v0i, polyVert(poly[t]), polyVert(poly[t + 1]));
      }
    }
    var contours = M.chainSegs(segs, Math.max(x1 - x0, y1 - y0) / (n * sub) * 1e-3);
    return { pos: pos, idx: idx, contours: contours };
  };

  /* split polylines into dash segments by arc length (strict inequalities).
   * Pattern boundaries are computed as ABSOLUTE arc lengths (n·period,
   * n·period+dash) — an incremental phase walk stalls forever once float
   * drift makes the remaining step smaller than one ulp of the accumulator. */
  M.dashPolylines = function (polys, dashLen, gapLen) {
    var period = dashLen + gapLen;
    if (!(dashLen > 0) || !(period > dashLen * 0.5)) return polys;
    var out = [];
    polys.forEach(function (poly) {
      var cur = [], acc = 0;
      // dashes are open BY CONSTRUCTION; without the flag, flatRibbon's
      // endpoint-distance heuristic sees every short dash as a closed loop
      // and wraps it onto itself
      var emit = function () { if (cur.length > 1) { cur.open = true; out.push(cur); } cur = []; };
      for (var i = 0; i + 1 < poly.length; i++) {
        var ax = poly[i][0], ay = poly[i][1], bx2 = poly[i + 1][0], by2 = poly[i + 1][1];
        var seg = Math.hypot(bx2 - ax, by2 - ay);
        if (!(seg > 0)) continue;
        var s0 = acc, s1 = acc + seg;
        // pattern boundaries strictly inside (s0, s1)
        var cuts = [];
        for (var n = Math.floor(s0 / period); n * period < s1; n++) {
          var dashEnd = n * period + dashLen, gapEnd = (n + 1) * period;
          if (dashEnd > s0 && dashEnd < s1) cuts.push(dashEnd);
          if (gapEnd > s0 && gapEnd < s1) cuts.push(gapEnd);
        }
        cuts.push(s1);
        var from = s0;
        for (var c = 0; c < cuts.length; c++) {
          var to = cuts[c];
          if (to <= from) continue;
          var mid = (from + to) / 2;
          var inDash = (mid - Math.floor(mid / period) * period) < dashLen;
          if (inDash) {
            var ta = (from - s0) / seg, tb = (to - s0) / seg;
            if (!cur.length) cur.push([ax + (bx2 - ax) * ta, ay + (by2 - ay) * ta, 0]);
            cur.push([ax + (bx2 - ax) * tb, ay + (by2 - ay) * tb, 0]);
          } else emit();
          from = to;
        }
        acc = s1;
      }
      emit();
    });
    return out;
  };
})();
