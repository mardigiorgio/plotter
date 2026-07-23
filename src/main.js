/* main.js — App orchestration: env building, recompute pipeline, persistence. */
(function () {
  'use strict';
  var P = window.P = window.P || {};
  var el = function (t, c, p) { return P.el(t, c, p); };

  var GREEK_LATEX = { theta: '\\theta', rho: '\\rho', phi: '\\phi', tau: '\\tau', alpha: '\\alpha', beta: '\\beta', gamma: '\\gamma', delta: '\\delta', lambda: '\\lambda', mu: '\\mu', sigma: '\\sigma', omega: '\\omega', epsilon: '\\epsilon', psi: '\\psi', nu: '\\nu' };
  function nameLatex(name) {
    var parts = name.split('_');
    var base = GREEK_LATEX[parts[0]] ? GREEK_LATEX[parts[0]] + ' ' : parts[0];
    return parts.length > 1 ? base.trim() + '_{' + parts.slice(1).join('_') + '}' : base;
  }
  function sliderFmt(v) {
    if (!isFinite(v)) return '0';
    if (Math.abs(v) > 1e15) v = Math.sign(v) * 1e15;
    if (Number.isInteger(v)) return String(v);
    var s = String(parseFloat(v.toPrecision(6)));
    if (s.indexOf('e') !== -1 || s.indexOf('E') !== -1) s = v.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }
  function fmtTuple(p) {
    return '(' + p.map(P.fmtNum).join(', ') + ')';
  }
  var READABLE_GREEK = { theta: 'θ', rho: 'ρ', phi: 'φ', pi: 'π', tau: 'τ' };
  function latexReadable(lx) {
    var s = lx
      .replace(/\\operatorname\{([a-zA-Z]+)\}/g, '$1')
      .replace(/\\left|\\right/g, '')
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2')
      .replace(/\\(theta|rho|phi|pi|tau)\s?/g, function (m, n) { return READABLE_GREEK[n]; })
      .replace(/\\cdot ?/g, '·')
      .replace(/\\le ?/g, '≤').replace(/\\ge ?/g, '≥')
      .replace(/\\([a-zA-Z]+) ?/g, '$1')
      .replace(/[{}]/g, '');
    return s.length > 24 ? s.slice(0, 24) + '…' : s;
  }
  var SURFACE_TYPES = ['graph', 'cyl', 'thetaSurf', 'sph', 'phiSurf', 'implicit', 'region', 'psurf'];

  var STORAGE_KEY = 'plotter3d.state.v1';

  function App() {
    var self = this;
    P.initMQ();
    this.rows = [];
    this.rowsEl = document.getElementById('rows');
    this.viewport = new P.Viewport(document.getElementById('canvaswrap'));
    this.env = { constVals: {}, funcs: {}, funcJS: {} };
    this.envErrors = {};   // rowId → message
    this.constOrder = [];  // [{name, rhs, isTuple, row}]
    this._buildKeys = {};    // rowId → key
    this._contentKeys = {};  // rowId → window-independent key (gesture reuse)
    this._recomputeTimer = null;
    this._playing = new Set();

    var saved = this.load();
    this.mode2d = !!(saved && saved.view && saved.view.mode2d);
    this.themeName = (saved && saved.view && saved.view.theme === 'dark') ? 'dark' : 'light';
    this.applyTheme(this.themeName, true);
    this.viewport.onWheelZoom = function (f) { self.wheelZoom(f); };
    this.viewport.onPan2d = function (dx, dy) { self.pan2d(dx, dy); };
    this.viewport.onResize2d = function () {
      clearTimeout(self._aspectTimer);
      self._aspectTimer = setTimeout(function () { if (self.mode2d) self.applyAspect2d(); }, 250);
    };
    if (this.mode2d) this.viewport.setMode2d(true);
    this.setWindow(saved && saved.window ? saved.window : { xmin: -4, xmax: 4, ymin: -4, ymax: 4, zmin: -4, zmax: 4 }, true);
    if (saved && saved.view) {
      this.viewport.showAxes = saved.view.axes !== false;
      this.viewport.showGrid = saved.view.grid !== false;
      this.viewport.showBox = saved.view.box !== false;
      this.viewport.rebuildDecor();
    }
    this.viewport.home();

    if (saved && saved.rows && saved.rows.length) {
      saved.rows.forEach(function (rs) { self.appendRow(new P.Row(self, rs)); });
      // resolve saved intersection targets (persisted as row indices)
      this.rows.forEach(function (r) {
        var is = r.state.isect;
        if (!is) return;
        if (typeof is.a === 'number' && self.rows[is.a]) { r._isectA = self.rows[is.a]; r._isectUserA = true; }
        if (typeof is.b === 'number' && self.rows[is.b]) { r._isectB = self.rows[is.b]; r._isectUserB = true; }
      });
    } else {
      this.appendRow(new P.Row(this, {}));
    }

    this.buildChrome();
    this.recompute();
    if (this.rows.length === 1 && !this.rows[0].state.latex) this.rows[0].mf.focus();

    // slider animation loop
    var lastLatexUpdate = 0;
    var tick = function (now) {
      requestAnimationFrame(tick);
      if (!self._playing.size) return;
      var updLatex = now - lastLatexUpdate > 100;
      if (updLatex) lastLatexUpdate = now;
      self._playing.forEach(function (entry) {
        // drop stale entries (row deleted or no longer this slider)
        var spec = entry.row.spec;
        if (!spec || spec.type !== 'slider' || spec.name !== entry.name || self.rows.indexOf(entry.row) === -1) {
          self._playing.delete(entry);
          entry.row.playing = false;
          return;
        }
        var b = entry.bounds();
        var span = b.hi - b.lo;
        if (span <= 0) return;
        var v = self.env.constVals[entry.name] + entry.dir * span / (60 * 6);
        if (v >= b.hi) { v = b.hi; entry.dir = -1; }
        if (v <= b.lo) { v = b.lo; entry.dir = 1; }
        self.env.constVals[entry.name] = v;
        entry.row.updateSliderPosition(v);
        // never clobber the field while the user is editing this row
        if (updLatex && !entry.row.dom.contains(document.activeElement)) {
          entry.row._squelch = true;
          entry.row.mf.latex(nameLatex(entry.name) + '=' + sliderFmt(v));
          entry.row._squelch = false;
          entry.row.state.latex = entry.row.mf.latex();
        }
      });
      self.interactFast();
      self.refreshDerived();
      self.buildAllGeom();
      self.updateValues();
    };
    requestAnimationFrame(tick);
  }

  App.prototype = {
    /* ---------------- rows ---------------- */
    appendRow: function (row, afterRow) {
      var idx = afterRow ? this.rows.indexOf(afterRow) + 1 : this.rows.length;
      this.rows.splice(idx, 0, row);
      if (afterRow && afterRow.dom.nextSibling) this.rowsEl.insertBefore(row.dom, afterRow.dom.nextSibling);
      else this.rowsEl.appendChild(row.dom);
      this.renumber();
      return row;
    },
    insertRowAfter: function (row) {
      var r = this.appendRow(new P.Row(this, {}), row);
      r.mf.focus();
      this.saveSoon();
    },
    deleteRow: function (row, viaKeyboard) {
      var i = this.rows.indexOf(row);
      if (i === -1) return;
      this._playing.forEach(function (e) { if (e.row === row) this._playing.delete(e); }, this);
      row.playing = false;
      if (this.rows.length === 1) {
        row._squelch = true; row.mf.latex(''); row._squelch = false;
        row.state.latex = '';
        this.recompute();
        row.mf.focus();
        this.saveSoon();
        return;
      }
      this.viewport.removeObject(row.id);
      this.rows.splice(i, 1);
      row.dom.remove();
      this.renumber();
      this.recompute();
      var target = this.rows[Math.max(0, i - 1)];
      if (viaKeyboard && target) target.mf.focus();
      this.saveSoon();
    },
    focusAdjacent: function (row, dir) {
      var i = this.rows.indexOf(row) + dir;
      if (i >= 0 && i < this.rows.length) this.rows[i].mf.focus();
    },
    renumber: function () {
      this.rows.forEach(function (r, i) { r.setIndex(i); });
      this.updateEmptyHint();
    },
    onRowFocus: function (row) {
      this.rows.forEach(function (r) { r.dom.classList.toggle('focused', r === row); });
      if (this.viewport.objects[row.id]) this.viewport.focus(row.id);
    },
    onRowBlur: function () {
      this.rows.forEach(function (r) { r.dom.classList.remove('focused'); });
      this.viewport.unfocus();
    },
    closeAllSettings: function () {
      this.rows.forEach(function (r) { r.settingsEl.classList.add('hiddenb'); });
    },
    closeAllFlyouts: function () {
      this.rows.forEach(function (r) { r.closeFlyout(); });
    },

    applyTheme: function (name, skipSave) {
      this.themeName = name;
      document.documentElement.dataset.theme = name;
      this.viewport.setTheme(name);
      if (!skipSave) this.saveSoon();
    },

    // curves are sampled directly over the visible window (see planarPolylines /
    // the implicit sampler), never an overscan region
    plotWin: function () {
      return this.win;
    },
    // 2D interaction (wheel/pan) just mutates the window, then asks for a
    // resample. Cost is bounded by screen resolution, not the world zoom level,
    // so this runs live at any zoom. Coalesced to one rebuild per animation
    // frame; camera + geometry + grid are refreshed together so the curve is
    // always pinned exactly to the grid (it never lags or drifts).
    rebuild2dSoon: function () {
      var self = this;
      if (this._raf2d) return;
      this._raf2d = requestAnimationFrame(function () {
        self._raf2d = null;
        self.viewport.update2dCamera();
        self.buildAllGeom();
        self.viewport.rebuildDecor();
      });
    },
    // cancel any queued 2D rebuild (e.g. on a switch back to 3D)
    resetGestures2d: function () {
      if (this._raf2d) { cancelAnimationFrame(this._raf2d); this._raf2d = null; }
      clearTimeout(this._wheelTimer); this._wheelTimer = null;
      clearTimeout(this._panTimer); this._panTimer = null;
      this._fastMode = false;
    },

    // during continuous interaction (slider drag / play), rebuild coarse and
    // sharpen shortly after the interaction pauses
    interactFast: function () {
      var self = this;
      this._fastMode = true;
      clearTimeout(this._sharpenTimer);
      this._sharpenTimer = setTimeout(function () {
        self._fastMode = false;
        self.buildAllGeom();
      }, 260);
    },

    /* live opacity: mutate materials, no re-tessellation. _opacityMul lets a
     * material keep a fixed ratio to the row opacity (2D region fills). */
    applyOpacityLive: function (row, v) {
      row.state.opacity = v;
      var obj = this.viewport.objects[row.id];
      if (!obj) return;
      obj.traverse(function (o) {
        if (!o.material || !o.material._styleOpacity) return;
        var vv = v * (o.material._opacityMul || 1);
        o.material.opacity = vv;
        o.material.transparent = vv < 1;
        o.material.depthWrite = vv >= 0.99;
        if (o.material._baseOpacity !== undefined) {
          o.material._baseOpacity = vv;
          o.material._baseTransparent = vv < 1;
        }
      });
      this.viewport.requestRender();
    },
    addSliderRowFor: function (row, name) {
      var r = new P.Row(this, { latex: nameLatex(name) + '=1' });
      this.appendRow(r, row);
      this.recompute();
      this.saveSoon();
    },

    /* ---------------- environment ---------------- */
    buildEnv: function () {
      var self = this;
      var env = this.env = { constVals: {}, funcs: {}, funcJS: {} };
      this.envErrors = {};
      var candidates = {};  // name → {row, rhs}
      var seen = {};

      this.rows.forEach(function (row) {
        var st = row.stmt;
        if (!st || st.kind !== 'rel' || st.op !== '=') return;
        var lhs = st.lhs;
        if (lhs.t === 'apply' && lhs.args.length && lhs.args.every(function (a) { return a.t === 'var'; }) &&
            !P.RESERVED.has(lhs.head)) {
          if (seen[lhs.head]) { self.envErrors[row.id] = '"' + P.prettyName(lhs.head) + '" is already defined'; return; }
          seen[lhs.head] = true;
          env.funcs[lhs.head] = {
            params: lhs.args.map(function (a) { return a.name; }),
            body: st.rhs,
            isTuple: st.rhs.t === 'tuple'
          };
        } else if (lhs.t === 'var' && !P.RESERVED.has(lhs.name) &&
                   !['x', 'y', 'z', 'r', 'theta', 'rho', 'phi'].includes(lhs.name)) {
          if (seen[lhs.name]) { self.envErrors[row.id] = '"' + P.prettyName(lhs.name) + '" is already defined'; return; }
          // tuples depending on t/u/v are curves, not constants
          var f0 = P.freeVars(st.rhs, { constVals: {}, funcs: env.funcs }, new Set());
          var usesParams = ['t', 'u', 'v', 'x', 'y', 'z', 'r', 'theta', 'rho', 'phi'].some(function (n) { return f0.has(n); });
          if (usesParams) return; // classify() will handle (curve / error)
          seen[lhs.name] = true;
          candidates[lhs.name] = { row: row, rhs: st.rhs };
          env.constVals[lhs.name] = NaN; // reserve the name
        }
      });

      // compile functions FIRST (constants may call them, e.g. a = f(3));
      // compiled closures read constants lazily through __C, so this order is safe
      var fstate = {};
      var fnRows = {};
      this.rows.forEach(function (row) {
        var st = row.stmt;
        if (st && st.kind === 'rel' && st.op === '=' && st.lhs.t === 'apply' && env.funcs[st.lhs.head]) fnRows[st.lhs.head] = row;
      });
      var compileFn = function (name) {
        if (fstate[name] === 'done') return;
        if (fstate[name] === 'compiling') throw new Error('circular definition of ' + P.prettyName(name));
        fstate[name] = 'compiling';
        var def = env.funcs[name];
        P.usedFuncs(def.body, env).forEach(function (g) { if (g !== name) compileFn(g); });
        if (P.usedFuncs(def.body, env).has(name)) throw new Error(P.prettyName(name) + ' cannot call itself');
        env.funcJS[name] = def.isTuple
          ? P.makeTupleFn(def.body, def.params, env)
          : P.makeFn(def.body, def.params, env);
        fstate[name] = 'done';
      };
      Object.keys(env.funcs).forEach(function (name) {
        try { compileFn(name); }
        catch (e) {
          fstate[name] = 'done';
          env.funcJS[name] = function () { return NaN; };
          if (fnRows[name]) self.envErrors[fnRows[name].id] = self.envErrors[fnRows[name].id] || e.message;
        }
      });

      // evaluate constants in dependency order (through function bodies too)
      var state = {};
      this.constOrder = [];
      var evalName = function (name) {
        if (state[name] === 'done') return;
        if (state[name] === 'evaluating') throw new Error('circular definition of "' + P.prettyName(name) + '"');
        state[name] = 'evaluating';
        var cand = candidates[name];
        var deps = P.usedConsts(cand.rhs, env);
        var seenFn = new Set();
        (function addFnDeps(node) {
          P.usedFuncs(node, env).forEach(function (g) {
            if (seenFn.has(g)) return;
            seenFn.add(g);
            P.usedConsts(env.funcs[g].body, env).forEach(function (d) { deps.add(d); });
            addFnDeps(env.funcs[g].body);
          });
        })(cand.rhs);
        if (deps.has(name)) throw new Error('circular definition of "' + P.prettyName(name) + '"');
        deps.forEach(function (d) { if (candidates[d]) evalName(d); });
        var isTuple = cand.rhs.t === 'tuple' ||
          (cand.rhs.t === 'apply' && env.funcs[cand.rhs.head] && env.funcs[cand.rhs.head].isTuple) ||
          (cand.rhs.t === 'var' && Array.isArray(env.constVals[cand.rhs.name]));
        var cfn = isTuple ? P.makeTupleConstFn(cand.rhs, env) : P.makeFn(cand.rhs, [], env);
        env.constVals[name] = cfn();
        self.constOrder.push({ name: name, rhs: cand.rhs, isTuple: isTuple, row: cand.row, fn: cfn });
        state[name] = 'done';
      };
      Object.keys(candidates).forEach(function (name) {
        if (state[name] === 'done') return;
        try { evalName(name); }
        catch (e) {
          state[name] = 'done';
          self.envErrors[candidates[name].row.id] = self.envErrors[candidates[name].row.id] || e.message;
        }
      });
    },

    refreshDerived: function () {
      var env = this.env;
      this.constOrder.forEach(function (entry) {
        var st = entry.row.stmt;
        if (st.kind === 'rel' && st.rhs === entry.rhs && (st.rhs.t === 'num' || (st.rhs.t === 'neg' && st.rhs.a.t === 'num'))) return; // slider: value set by drag
        try {
          env.constVals[entry.name] = entry.fn();
        } catch (e) { env.constVals[entry.name] = NaN; }
      });
    },

    /* transitive slider/const dependencies of an AST (through function calls) */
    depValues: function (nodes) {
      var env = this.env, out = {}, seenFn = new Set();
      var visit = function (node) {
        if (!node) return;
        P.usedConsts(node, env).forEach(function (c) { out[c] = env.constVals[c]; });
        P.usedFuncs(node, env).forEach(function (f) {
          if (seenFn.has(f)) return;
          seenFn.add(f);
          // a definition edit must dirty every row that calls it
          out['fn:' + f] = JSON.stringify([env.funcs[f].params, env.funcs[f].body]);
          visit(env.funcs[f].body);
        });
      };
      nodes.forEach(visit);
      return out;
    },

    /* ---------------- intersections ---------------- */
    isectCandidates: function (exceptRow) {
      var out = [];
      this.rows.forEach(function (r, i) {
        if (r === exceptRow) return;
        var spec = r.spec && r.spec.type === 'definition' ? r.spec.render : r.spec;
        if (spec && SURFACE_TYPES.indexOf(spec.type) !== -1) {
          out.push({ row: r, label: (i + 1) + ':  ' + latexReadable(r.state.latex) });
        }
      });
      return out;
    },
    // Only selections the user made by hand are sticky; auto picks are
    // recomputed every time so new surfaces are adopted as they appear.
    resolveIsect: function (row) {
      var cands = this.isectCandidates(row).map(function (c) { return c.row; });
      var valid = function (r) { return r && cands.indexOf(r) !== -1; };
      if (row._isectUserA && !valid(row._isectA)) row._isectUserA = false;
      if (row._isectUserB && !valid(row._isectB)) row._isectUserB = false;
      var a = (row._isectUserA && valid(row._isectA)) ? row._isectA : null;
      var b = (row._isectUserB && valid(row._isectB)) ? row._isectB : null;

      var myIdx = this.rows.indexOf(row);
      var above = cands.filter(function (r) { return this.rows.indexOf(r) < myIdx; }, this);
      var pool = above.length >= 2 ? above : cands;
      var pick = function (exclude) {
        for (var i = pool.length - 1; i >= 0; i--) {
          if (pool[i] !== exclude) return pool[i];
        }
        return null;
      };
      if (!b) b = pick(a);
      if (!a) a = pick(b);
      row._isectA = a;
      row._isectB = b;
      if (!a || !b || a === b) return null;
      return [a, b];
    },
    // implicit form F(x,y,z) of a surface row, or null (parametric surfaces)
    implicitFnFor: function (row) {
      var spec = row.spec && row.spec.type === 'definition' ? row.spec.render : row.spec;
      if (!spec) return null;
      var env = this.env, RT = P.RT;
      try {
        switch (spec.type) {
          case 'graph': {
            if (spec.mode === 'polar') {
              var fp = P.makeFn(spec.expr, ['r', 'theta'], env);
              return function (x, y, z) { return z - fp(Math.hypot(x, y), Math.atan2(y, x)); };
            }
            if (spec.axis === 'z') {
              var fz = P.makeFn(spec.expr, ['x', 'y'], env);
              return function (x, y, z) { return z - fz(x, y); };
            }
            if (spec.axis === 'x') {
              var fx = P.makeFn(spec.expr, ['y', 'z'], env);
              return function (x, y, z) { return x - fx(y, z); };
            }
            var fy = P.makeFn(spec.expr, ['x', 'z'], env);
            return function (x, y, z) { return y - fy(x, z); };
          }
          case 'cyl': {
            var fc = P.makeFn(spec.expr, ['theta', 'z'], env);
            return function (x, y, z) { return Math.hypot(x, y) - fc(Math.atan2(y, x), z); };
          }
          case 'sph': {
            var fs = P.makeFn(spec.expr, ['phi', 'theta'], env);
            return function (x, y, z) { return Math.hypot(x, y, z) - fs(RT.phiOf(x, y, z), Math.atan2(y, x)); };
          }
          case 'thetaSurf': {
            if (!spec.isConst) return null;
            var tc = P.evalConst(spec.expr, env);
            return function (x, y, z) {
              var d = Math.atan2(y, x) - tc;
              while (d > Math.PI) d -= 2 * Math.PI;
              while (d < -Math.PI) d += 2 * Math.PI;
              return d;
            };
          }
          case 'phiSurf': {
            if (!spec.isConst) return null;
            var pc = P.evalConst(spec.expr, env);
            return function (x, y, z) { return RT.phiOf(x, y, z) - pc; };
          }
          case 'implicit': case 'region':
            return P.makeFn(spec.F, ['x', 'y', 'z'], env, { subst: P.CART_SUBST });
        }
      } catch (e) { return null; }
      return null;
    },
    /* which cartesian variable (if any) the surface does not use, e.g. z for y=x */
    flat2dInfo: function (row) {
      var spec = row.spec && row.spec.type === 'definition' ? row.spec.render : row.spec;
      if (!spec) return null;
      var env = this.env;
      var MAP = { x: ['x'], y: ['y'], z: ['z'], r: ['x', 'y'], theta: ['x', 'y'], rho: ['x', 'y', 'z'], phi: ['x', 'y', 'z'] };
      var used = new Set();
      var addFrees = function (node, extra) {
        (extra || []).forEach(function (v) { used.add(v); });
        if (!node) return;
        P.freeVars(node, env, new Set()).forEach(function (n) {
          (MAP[n] || []).forEach(function (v) { used.add(v); });
        });
      };
      switch (spec.type) {
        case 'graph':
          if (spec.mode === 'polar') return null;
          addFrees(spec.expr, [spec.axis]);
          break;
        case 'cyl': addFrees(spec.expr, ['x', 'y']); break;
        case 'thetaSurf':
          if (!spec.isConst) return null;
          addFrees(spec.expr, ['x', 'y']);
          break;
        case 'implicit': case 'region': addFrees(spec.F, []); break;
        default: return null;
      }
      if (!used.has('z')) return 'z';
      if (!used.has('y')) return 'y';
      if (!used.has('x')) return 'x';
      return null;
    },

    // Solve an xy-plane form into a map t↦[x,y,0], then hand it to
    // G.planarSample, which samples once per screen column across the VISIBLE
    // window (Desmos-style): bounded by screen resolution, not zoom level, so
    // it stays fast at any zoom and pins the curve exactly to the grid, while
    // carrying vertical-asymptote tails out to the edge and splitting poles.
    planarPolylines: function (spec, env, pw) {
      var map = null, a = 0, b = 1, param = false;
      try {
        if (spec.type === 'graph' && spec.axis === 'y' && spec.mode === 'cart') {
          var fy = P.makeFn(spec.expr, ['x', 'z'], env);
          a = pw.xmin; b = pw.xmax;
          map = function (t) { return [t, fy(t, 0), 0]; };
        } else if (spec.type === 'graph' && spec.axis === 'x' && spec.mode === 'cart') {
          var fx = P.makeFn(spec.expr, ['y', 'z'], env);
          a = pw.ymin; b = pw.ymax;
          map = function (t) { return [fx(t, 0), t, 0]; };
        } else if (spec.type === 'cyl') {
          var fr = P.makeFn(spec.expr, ['theta', 'z'], env);
          a = 0; b = 2 * Math.PI; param = true;
          map = function (t) {
            var r = fr(t, 0);
            // r >= 0 by definition; negative r would reflect across the origin
            if (!(r >= 0)) return null;
            return [r * Math.cos(t), r * Math.sin(t), 0];
          };
        } else if (spec.type === 'thetaSurf' && spec.isConst) {
          var tc = P.evalConst(spec.expr, env);
          var R = Math.hypot(Math.max(Math.abs(pw.xmin), pw.xmax), Math.max(Math.abs(pw.ymin), pw.ymax));
          return [[[0, 0, 0], [R * Math.cos(tc), R * Math.sin(tc), 0]]];
        }
      } catch (e) { return null; }
      if (!map) return null;

      var W = 1200;
      try { W = this.viewport.renderer.domElement.clientWidth || 1200; } catch (e) { }
      // one sample per (fraction of a) screen pixel; closed polar curves get a
      // fixed high count since they don't scan the x-axis. During a gesture,
      // sample coarser so the rebuild stays live.
      var N = param ? 720 : Math.max(400, Math.min(4000, Math.round(W * 1.5)));
      if (this._fastMode) N = Math.max(300, Math.round(N * 0.5));
      // asymptote tails (ln, 1/x, tan) are carried to the screen edge and poles
      // split the curve instead of being bridged — see G.planarSample
      return P.geom.planarSample(map, a, b, pw, { N: N, param: param });
    },

    meshGeometryFor: function (row) {
      var obj = this.viewport.objects[row.id];
      if (!obj) return null;
      var geo = null;
      obj.traverse(function (o) {
        if (!geo && o.isMesh && o.geometry && o.geometry.getAttribute('position')) geo = o.geometry;
      });
      return geo;
    },

    /* ---------------- recompute pipeline ---------------- */
    scheduleRecompute: function () {
      var self = this;
      clearTimeout(this._recomputeTimer);
      this._recomputeTimer = setTimeout(function () { self.recompute(); }, 160);
    },

    recompute: function () {
      var self = this;
      this.rows.forEach(function (row) {
        try { row.stmt = P.parse(row.state.latex); row.parseError = null; }
        catch (e) { row.stmt = { kind: 'empty' }; row.parseError = e.message; }
      });
      this.buildEnv();
      // intersect rows classify last so their surface pickers see fresh specs
      this.rows.forEach(function (row) {
        if (!row.stmt || row.stmt.kind !== 'intersection') self.classifyRow(row);
      });
      this.rows.forEach(function (row) {
        if (row.stmt && row.stmt.kind === 'intersection') self.classifyRow(row);
      });
      this.buildAllGeom();
      this.renumber();
    },

    // intersections build in a second pass so target meshes are fresh
    buildAllGeom: function () {
      var self = this;
      this.rows.forEach(function (r) { if (!r.spec || r.spec.type !== 'intersect') self.buildGeomIfDirty(r); });
      this.rows.forEach(function (r) { if (r.spec && r.spec.type === 'intersect') self.buildGeomIfDirty(r); });
    },

    classifyRow: function (row) {
      var env = this.env;
      row.setError(null);

      var spec, errMsg = null, errSliders = null;
      if (row.parseError) {
        spec = { type: 'error', message: row.parseError };
        // soften "still typing" errors on the focused row
        var focusedNow = row.dom.classList.contains('focused');
        if (!(focusedNow && /incomplete/.test(row.parseError))) errMsg = row.parseError;
      } else if (this.envErrors[row.id]) {
        var msg = this.envErrors[row.id];
        spec = { type: 'error', message: msg };
        errMsg = msg;
        if (row.stmt && row.stmt.kind === 'rel' && /unknown variable/.test(msg)) {
          errSliders = [];
          P.freeVars(row.stmt.rhs, env, new Set()).forEach(function (n) {
            if (!P.RESERVED.has(n) &&
                !Object.prototype.hasOwnProperty.call(env.constVals, n)) errSliders.push(n);
          });
        }
      } else {
        try { spec = P.classify(row.stmt, env); }
        catch (e) { spec = { type: 'error', message: e.message }; }
        if (spec.type === 'error') { errMsg = spec.message; errSliders = spec.addSliders; }
      }
      row.spec = spec;

      // solids default translucent: a FRESH row (no saved opacity, untouched
      // at 1) that classifies as a region drops to 0.45 once; explicit user
      // choices — including saved full opacity — always stick
      if ((spec.type === 'region' || spec.type === 'region3') &&
          !row._opacityExplicit && row.state.opacity === 1 && !row._regionOpacityDefaulted) {
        row._regionOpacityDefaulted = true;
        row.state.opacity = 0.45;
      }

      // rows with nothing to render drop their geometry
      var renderless = ['empty', 'error', 'slider', 'constdef', 'constExpr'].indexOf(spec.type) !== -1 ||
        (spec.type === 'definition' && !spec.render);
      if (renderless) {
        this.viewport.removeObject(row.id);
        delete this._buildKeys[row.id];
        delete this._contentKeys[row.id];
      }

      // substrip: rebuild only when its KIND changes, so recomputes triggered by
      // other rows don't destroy inputs the user is typing in
      var self = this;
      var kind = 'none';
      switch (spec.type) {
        case 'error': kind = 'err'; break;
        case 'slider': kind = 'slider:' + spec.name; break;
        case 'constdef': case 'namedPoint': kind = 'val:' + spec.name; break;
        case 'constExpr': kind = 'val:expr'; break;
        case 'curve': kind = 'dom:t'; break;
        case 'psurf': kind = 'dom:u,v'; break;
        case 'definition':
          if (spec.render && spec.render.type === 'curve') kind = 'dom:t';
          else if (spec.render && spec.render.type === 'psurf') kind = 'dom:u,v';
          break;
        case 'intersect': {
          var cands = this.isectCandidates(row);
          this.resolveIsect(row);
          kind = 'isect:' + cands.map(function (c) { return c.row.id + c.label; }).join(';') +
            '|' + (row._isectA ? row._isectA.id : '') + ',' + (row._isectB ? row._isectB.id : '');
          break;
        }
        // stable kind: the fields persist across recomputes; bound edits rebuild
        // the geometry (buildKey), not the substrip, so typing keeps focus
        case 'region3': kind = 'region3'; break;
      }

      if (errMsg) {
        row._subKind = 'err';
        row.clearSub();
        row.valueKind = null; row._valEl = null;
        row.setError(errMsg, errSliders);
      } else if (kind !== row._subKind) {
        row._subKind = kind;
        row.clearSub();
        row.valueKind = null; row._valEl = null;
        switch (spec.type) {
          case 'slider':
            env.constVals[spec.name] = spec.value;
            row.showSlider(spec.name, spec.value);
            break;
          case 'constdef': case 'namedPoint':
            row.valueKind = 'const'; row.valueName = spec.name;
            var pv = env.constVals[spec.name];
            row.showValue(Array.isArray(pv) ? fmtTuple(pv) : P.fmtNum(pv));
            break;
          case 'constExpr':
            row.valueKind = 'expr';
            try { row.showValue(P.fmtNum(P.evalConst(spec.expr, env))); }
            catch (e) { row.setError(e.message); row._subKind = 'err'; }
            break;
          case 'curve': row.showDomains(['t']); break;
          case 'psurf': row.showDomains(['u', 'v']); break;
          case 'definition':
            if (kind === 'dom:t') row.showDomains(['t']);
            else if (kind === 'dom:u,v') row.showDomains(['u', 'v']);
            break;
          case 'intersect':
            row.showIsect(this.isectCandidates(row), row._isectA, row._isectB, function (which, target) {
              if (which === 'a') { row._isectA = target; row._isectUserA = !!target; }
              else { row._isectB = target; row._isectUserB = !!target; }
              self.recompute();
              self.saveSoon();
            });
            break;
          case 'region3':
            row.showRegionBounds(row.state.regionBounds, function () {
              self.recompute();
              self.saveSoon();
            });
            break;
        }
      } else {
        // same kind — refresh values in place
        if (spec.type === 'slider') {
          env.constVals[spec.name] = spec.value;
          row.updateSliderPosition(spec.value);
        } else if (spec.type === 'constdef' || spec.type === 'namedPoint') {
          row.valueKind = 'const'; row.valueName = spec.name;
          var v2 = env.constVals[spec.name];
          if (row._valEl) row._valEl.textContent = '= ' + (Array.isArray(v2) ? fmtTuple(v2) : P.fmtNum(v2));
        } else if (spec.type === 'constExpr') {
          row.valueKind = 'expr';
          try { if (row._valEl) row._valEl.textContent = '= ' + P.fmtNum(P.evalConst(spec.expr, env)); }
          catch (e) { row.setError(e.message); }
        }
      }
      row.renderSwatch();
    },

    updateValues: function () {
      var self = this;
      this.rows.forEach(function (row) {
        if (!row._valEl) return;
        if (row.valueKind === 'const') {
          var v = self.env.constVals[row.valueName];
          row._valEl.textContent = '= ' + (Array.isArray(v) ? fmtTuple(v) : P.fmtNum(v));
        } else if (row.valueKind === 'expr' && row.spec.expr) {
          try { row._valEl.textContent = '= ' + P.fmtNum(P.evalConst(row.spec.expr, self.env)); } catch (e) {}
        }
      });
    },

    // contentOnly blanks the window and fast-mode slots: comparing content
    // keys detects gesture rebuilds where ONLY the window moved, so the
    // existing full-quality mesh can be kept until settle.
    buildKey: function (row, contentOnly) {
      var spec = row.spec, s = row.state, w = contentOnly ? null : this.plotWin();
      if (spec.type === 'intersect') {
        var pair = this.resolveIsect(row) || [];
        var extras = pair.map(function (r2) {
          var sp = r2.spec && r2.spec.type === 'definition' ? r2.spec.render : (r2.spec || {});
          var nodes2 = [];
          if (sp.expr) nodes2.push(sp.expr);
          if (sp.F) nodes2.push(sp.F);
          return [r2.id, r2.state.latex, r2.state.res, r2.state.domains, this.depValues(nodes2)];
        }, this);
        return JSON.stringify(['isect', extras, w, s.color, s.mesh]);
      }
      var nodes = [];
      if (spec.expr) nodes.push(spec.expr);
      if (spec.F) nodes.push(spec.F);
      if (spec.body) nodes.push(spec.body);
      if (spec.args) nodes = nodes.concat(spec.args);
      if (spec.render && spec.render.expr) nodes.push(spec.render.expr);
      // region3 geometry comes from the bound fields — their slider/const
      // deps must dirty the key too (parsed nodes cached per bounds text)
      if (spec.type === 'region3' && s.regionBounds) {
        var bKey = s.regionBounds.join('|');
        if (row._boundsKey !== bKey) {
          row._boundsKey = bKey;
          row._boundNodes = [];
          s.regionBounds.forEach(function (str) {
            str = (str || '').trim();
            if (!str) return;
            try { row._boundNodes = row._boundNodes.concat(P.regionConstraints(P.parse(str))); }
            catch (e) { /* invalid bound: buildObject reports it */ }
          });
        }
        nodes = nodes.concat(row._boundNodes || []);
      }
      var deps = this.depValues(nodes);
      // evaluated domain bounds may reference sliders — key on the values, not the strings
      var domVals = {};
      ['t', 'u', 'v'].forEach(function (n) {
        if (s.domains && (s.domains[n + '0'] !== undefined || s.domains[n + '1'] !== undefined)) {
          domVals[n] = row.getDomain(n, 0, 2 * Math.PI);
        }
      });
      // note: opacity is intentionally NOT in the key — it is applied live to materials
      return JSON.stringify([s.latex, spec.type, w, s.color, s.mesh, s.res, s.density, s.label,
        s.domains, domVals, deps, this.viewport.showBox, (s.flat2d || this.mode2d) ? '2d' : '3d',
        contentOnly ? '' : (this._fastMode ? 'fast' : 'full'), s.regionBounds]);
    },

    buildGeomIfDirty: function (row) {
      var spec = row.spec;
      var renderable = ['graph', 'cyl', 'thetaSurf', 'sph', 'phiSurf', 'implicit', 'region', 'region3',
        'curve', 'psurf', 'point', 'namedPoint', 'vector', 'vfield', 'intersect'].indexOf(spec.type) !== -1 ||
        (spec.type === 'definition' && spec.render);
      if (!renderable) return;
      // Gestures move only the window/camera: a row whose CONTENT is
      // unchanged keeps its full-quality mesh (the settle pass re-fits it to
      // the new window ~200ms later). Rebuilding coarse per wheel frame made
      // every surface visibly chunky mid-zoom. Slider-driven changes still
      // rebuild here because the field itself is morphing.
      if (this._fastMode) {
        if (spec.type === 'intersect' || row.state.flat2d) return;
        if (this._contentKeys[row.id] === this.buildKey(row, true) &&
            this.viewport.objects[row.id]) return;
      }
      // the 2D view only draws objects that live in the xy-plane
      if (this.mode2d) {
        var eff = spec.type === 'definition' ? spec.render : spec;
        var t2 = eff.type;
        var ok2d =
          t2 === 'point' || t2 === 'namedPoint' || t2 === 'vector' ||
          t2 === 'curve' || t2 === 'psurf' || spec.type === 'intersect' ||
          (t2 === 'vfield' && eff.params && eff.params.length === 2) ||
          (SURFACE_TYPES.indexOf(t2) !== -1 && this.flat2dInfo(row) === 'z');
        if (!ok2d) {
          this.viewport.removeObject(row.id);
          delete this._buildKeys[row.id];
        delete this._contentKeys[row.id];
          row.setError('3D object. Press the 3D button to see it');
          return;
        }
      }
      var key = this.buildKey(row);
      if (this._buildKeys[row.id] === key && this.viewport.objects[row.id]) return;
      this._buildKeys[row.id] = key;
      this._contentKeys[row.id] = this.buildKey(row, true);
      try {
        var obj = this.buildObject(row, spec.type === 'definition' ? spec.render : spec);
        this.viewport.setObject(row.id, obj);
        this.viewport.setVisible(row.id, !row.state.hidden);
      } catch (e) {
        this.viewport.removeObject(row.id);
        row.setError(e.message);
      }
    },

    rebuildRow: function (row) { this.buildGeomIfDirty(row); this.saveSoon(); },
    rebuildRowSoon: function (row) {
      var self = this;
      clearTimeout(row._rbTimer);
      row._rbTimer = setTimeout(function () { self.buildGeomIfDirty(row); }, 120);
    },

    buildObject: function (row, spec) {
      var env = this.env, win = this.plotWin(), G = P.geom;
      var s = row.state;
      var style = { color: s.color, opacity: s.opacity, mesh: s.mesh };
      var res = s.res || 64;
      if (this._fastMode) {
        var slow = (this._lastFastMs || 0) > 9;
        res = Math.min(res, this.mode2d ? (slow ? 32 : 48) : (slow ? 16 : 24));
      }

      // "show in 2D" (or global 2D mode): xy-plane curves with a solved form
      // sample directly as 1D polylines (fast, straight past the window edge)
      if (s.flat2d || this.mode2d) {
        var fv = this.flat2dInfo(row);
        if (fv === 'z') {
          var polys = this.planarPolylines(spec, env, win);
          if (polys) return G.flatRibbon(polys, 2, 0, win, style);
          // unsolvable planar implicits/regions: contour the xy-plane slice
          // directly instead of building and slicing a throwaway 3D mesh.
          // F is z-independent here (fv === 'z'), so evaluate on the same
          // z-clamped plane the old sliced-mesh path drew the trace on.
          if (spec.type === 'implicit' || spec.type === 'region') {
            // adaptive sampling: refines only along the boundary, so it stays
            // smooth however small the feature is on screen
            var baseRes = s.res ? Math.max(64, Math.min(256, s.res * 2)) : 128;
            var refine = 3;
            if (this._fastMode) { baseRes = Math.min(baseRes, 80); refine = 2; }
            var c0 = Math.max(win.zmin, Math.min(win.zmax, 0));
            var Fxy = P.makeFn(spec.F, ['x', 'y', 'z'], env, { subst: P.CART_SUBST });
            var fxy = function (x, y) { return Fxy(x, y, c0); };
            if (spec.type === 'region') {
              // Desmos-style translucent fill + stroke (dashed when strict)
              return G.regionFill2D(fxy, win, style, baseRes, refine, spec.strict, c0);
            }
            var msPolys = G.marchingSquaresAdaptive(fxy, win, baseRes, refine);
            return G.flatRibbon(msPolys, 2, c0, win, style);
          }
        }
        if (fv) {
          var hadFlat = s.flat2d, hadMode = this.mode2d;
          s.flat2d = false; this.mode2d = false;
          var obj3d = null;
          try { obj3d = this.buildObject(row, spec); }
          finally { s.flat2d = hadFlat; this.mode2d = hadMode; }
          var meshGeo = null;
          if (obj3d) {
            obj3d.traverse(function (o) {
              if (!meshGeo && o.isMesh && o.geometry.getAttribute('position')) meshGeo = o.geometry;
            });
          }
          if (meshGeo) {
            var lim = { x: [win.xmin, win.xmax], y: [win.ymin, win.ymax], z: [win.zmin, win.zmax] }[fv];
            var c0 = Math.max(lim[0], Math.min(lim[1], 0));
            var ci = { x: 0, y: 1, z: 2 }[fv];
            var Fc = ci === 0 ? function (x) { return x - c0; }
              : ci === 1 ? function (x, y) { return y - c0; }
              : function (x, y, z) { return z - c0; };
            var flatStyle = { color: style.color, opacity: style.opacity, flatAxis: ci, flatC0: c0 };
            var curve = G.intersectionCurve(Fc, meshGeo, win, flatStyle);
            obj3d.traverse(function (o) {
              if (o.geometry) o.geometry.dispose();
              if (o.material) {
                if (o.material.map) o.material.map.dispose();
                o.material.dispose();
              }
            });
            return curve;
          }
        }
      }
      var assertFinite = function (p, what) {
        if (!p || !p.every(isFinite)) throw new Error(what + ' is undefined');
        return p;
      };
      switch (spec.type) {
        case 'graph': {
          var params = spec.mode === 'polar' ? ['r', 'theta']
            : spec.axis === 'z' ? ['x', 'y'] : spec.axis === 'x' ? ['y', 'z'] : ['x', 'z'];
          return G.graph(P.makeFn(spec.expr, params, env), spec.axis, spec.mode, win, style, res);
        }
        case 'cyl': return G.cyl(P.makeFn(spec.expr, ['theta', 'z'], env), win, style, res);
        case 'thetaSurf': return G.thetaSurf(P.makeFn(spec.expr, ['r', 'z'], env), win, style, res);
        case 'sph': return G.sph(P.makeFn(spec.expr, ['phi', 'theta'], env), win, style, res);
        case 'phiSurf': return G.phiSurf(P.makeFn(spec.expr, ['rho', 'theta'], env), win, style, res);
        case 'implicit': {
          var iRes = s.res ? Math.max(20, Math.min(96, Math.round(s.res * 0.75))) : 48;
          if (this._fastMode) iRes = (this._lastFastMs || 0) > 9 ? 12 : 16;
          return G.implicit(P.makeFn(spec.F, ['x', 'y', 'z'], env, { subst: P.CART_SUBST }), win, style, iRes, this._fastMode);
        }
        case 'region': {
          var rRes = s.res ? Math.max(20, Math.min(80, Math.round(s.res * 0.6))) : 44;
          if (this._fastMode) rRes = (this._lastFastMs || 0) > 9 ? 12 : 16;
          var rParts = null;
          if (spec.parts && spec.parts.length > 1 && !this._fastMode) {
            rParts = spec.parts.map(function (nd) {
              return P.makeFn(nd, ['x', 'y', 'z'], env, { subst: P.CART_SUBST });
            });
          }
          return G.region(P.makeFn(spec.F, ['x', 'y', 'z'], env, { subst: P.CART_SUBST }), win, style, rRes, rParts, this._fastMode);
        }
        case 'region3': {
          // one solid from up to three inequality fields (each may be chained,
          // e.g. x²+y² < z < 4). All constraints intersect: F = max(gᵢ) ≤ 0.
          var nodes = [];
          (s.regionBounds || []).forEach(function (str, bi) {
            str = (str || '').trim();
            if (!str) return;
            var bst, bc;
            try { bst = P.parse(str); } catch (e) { throw new Error('bound ' + (bi + 1) + ': ' + e.message); }
            try { bc = P.regionConstraints(bst); } catch (e2) { throw new Error('bound ' + (bi + 1) + ': ' + e2.message); }
            nodes = nodes.concat(bc);
          });
          if (!nodes.length) throw new Error('define at least one bound, e.g. -2 < x < 2');
          var RF = P.regionF(nodes);
          var bad = [];
          P.freeVars(RF, env, new Set()).forEach(function (n) {
            if (['x', 'y', 'z', 'r', 'theta', 'rho', 'phi'].indexOf(n) === -1) bad.push(n);
          });
          if (bad.length) throw new Error('unknown ' + (bad.length > 1 ? 'variables' : 'variable') + ': ' + bad.join(', '));
          var r3Res = s.res ? Math.max(20, Math.min(80, Math.round(s.res * 0.6))) : 44;
          if (this._fastMode) r3Res = (this._lastFastMs || 0) > 9 ? 12 : 16;
          var r3Parts = null;
          if (nodes.length > 1 && !this._fastMode) {
            r3Parts = nodes.map(function (nd) {
              return P.makeFn(nd, ['x', 'y', 'z'], env, { subst: P.CART_SUBST });
            });
          }
          return G.region(P.makeFn(RF, ['x', 'y', 'z'], env, { subst: P.CART_SUBST }), win, style, r3Res, r3Parts, this._fastMode);
        }
        case 'curve': {
          var td = row.getDomain('t', 0, 2 * Math.PI);
          return G.curve(P.makeTupleFn(spec.expr, ['t'], env), td[0], td[1], win, style,
            this._fastMode ? 100 : 0, this.mode2d);
        }
        case 'psurf': {
          var ud = row.getDomain('u', 0, 2 * Math.PI), vd = row.getDomain('v', 0, 2 * Math.PI);
          return G.psurf(P.makeTupleFn(spec.expr, ['u', 'v'], env),
            { u0: ud[0], u1: ud[1], v0: vd[0], v1: vd[1] }, win, style, res);
        }
        case 'point': case 'namedPoint': {
          var p = spec.type === 'point' ? P.evalTupleConst(spec.expr, env) : env.constVals[spec.name];
          assertFinite(p, 'point');
          var grp = new THREE.Group();
          grp.add(G.point(p, win, style));
          if (s.label) grp.add(G.pointLabel(p, s.label, win, style));
          return grp;
        }
        case 'vector': {
          var a = [0, 0, 0], b;
          if (spec.args.length === 2) {
            a = assertFinite(P.evalTupleConst(spec.args[0], env), 'vector tail');
            b = assertFinite(P.evalTupleConst(spec.args[1], env), 'vector tip');
          } else {
            b = assertFinite(P.evalTupleConst(spec.args[0], env), 'vector tip');
          }
          return G.arrow(a, b, win, style);
        }
        case 'vfield': {
          var fparams = spec.params;
          return G.vfield(P.makeTupleFn(spec.expr, fparams, env), fparams.length === 2, win, style, s.density);
        }
        case 'intersect': {
          var pair = this.resolveIsect(row);
          if (!pair) {
            throw new Error(this.isectCandidates(row).length < 2
              ? 'needs two surfaces. Add more surface rows first'
              : 'pick two different surfaces');
          }
          var FA = this.implicitFnFor(pair[0]);
          var meshRow = pair[1];
          if (!FA) { FA = this.implicitFnFor(pair[1]); meshRow = pair[0]; }
          if (!FA) throw new Error('two parametric surfaces cannot be intersected. One needs an equation form');
          var geoB = this.meshGeometryFor(meshRow);
          if (!geoB) throw new Error('surface ' + (this.rows.indexOf(meshRow) + 1) + ' has nothing to intersect');
          return G.intersectionCurve(FA, geoB, win, style);
        }
      }
      return null;
    },

    /* ---------------- sliders ---------------- */
    setSliderValue: function (row, name, v) {
      this.env.constVals[name] = v;
      row._squelch = true;
      row.mf.latex(nameLatex(name) + '=' + sliderFmt(v));
      row._squelch = false;
      row.state.latex = row.mf.latex();
      var self = this;
      if (!this._dragRAF) {
        this._dragRAF = requestAnimationFrame(function () {
          self._dragRAF = null;
          self.interactFast();
          self.refreshDerived();
          self.buildAllGeom();
          self.updateValues();
        });
      }
      this.saveSoon();
    },
    setPlaying: function (row, name, on, bounds) {
      var found = null;
      this._playing.forEach(function (e) { if (e.row === row) found = e; });
      if (found) this._playing.delete(found);
      if (on) this._playing.add({ row: row, name: name, bounds: bounds, dir: 1 });
    },

    /* ---------------- window & chrome ---------------- */
    setWindow: function (w, skipRecompute) {
      w.diag = Math.hypot(w.xmax - w.xmin, w.ymax - w.ymin, w.zmax - w.zmin);
      this.win = w;
      this.viewport.setWindow(w, null);
      if (this._winInputs) {
        for (var k in this._winInputs) this._winInputs[k].value = P.fmtNum(w[k]);
      }
      if (!skipRecompute) {
        this.recompute();
        this.saveSoon();
      }
    },

    // zoom rescales the axis ranges about their center; camera framing follows
    scaleWindow: function (f) {
      var w = this.win;
      var span = (w.xmax - w.xmin) * f;
      if (span < 1e-3 || span > 1e5) return;
      var flat = this.mode2d;
      // 3D zooms about the origin so the box stays centered on the axes; 2D
      // zooms about the current view center
      var cx = flat ? (w.xmin + w.xmax) / 2 : 0;
      var cy = flat ? (w.ymin + w.ymax) / 2 : 0, cz = 0;
      if (!flat) this.viewport.scaleView(f);
      this.setWindow({
        xmin: cx + (w.xmin - cx) * f, xmax: cx + (w.xmax - cx) * f,
        ymin: cy + (w.ymin - cy) * f, ymax: cy + (w.ymax - cy) * f,
        zmin: flat ? w.zmin : cz + (w.zmin - cz) * f,
        zmax: flat ? w.zmax : cz + (w.zmax - cz) * f
      });
      this.flashWindowSize();
    },

    // drag-pan in 2D: move the window and resample for it (screen-bounded, live)
    pan2d: function (dx, dy) {
      var w = this.win;
      w.xmin += dx; w.xmax += dx; w.ymin += dy; w.ymax += dy;
      this.viewport.win = w;
      this.rebuild2dSoon();
      this.saveSoon();
    },

    // in 2D the window must match the viewport shape so the grid is edge-to-edge
    applyAspect2d: function () {
      var elc = this.viewport.renderer.domElement;
      var aspect = elc.clientWidth / Math.max(1, elc.clientHeight);
      var w = this.win;
      var yr = w.ymax - w.ymin, xc = (w.xmin + w.xmax) / 2, xr = yr * aspect;
      w.xmin = xc - xr / 2;
      w.xmax = xc + xr / 2;
      w.diag = Math.hypot(w.xmax - w.xmin, w.ymax - w.ymin, w.zmax - w.zmin);
      this.win = w; this.viewport.win = w;
      this.viewport.update2dCamera();
      this.buildAllGeom();
      this.viewport.rebuildDecor();
      this.saveSoon();
    },

    // Gesture-speed window step: geometry only, at coarse resolution.
    // No parsing, no env rebuild, no decor rebuild, no saving.
    scaleWindowFast: function (f) {
      var w = this.win;
      var span = (w.xmax - w.xmin) * f;
      if (span < 1e-3 || span > 1e5) return;
      var flat = this.mode2d;
      // 3D zooms about the origin; 2D about the current view center
      var cx = flat ? (w.xmin + w.xmax) / 2 : 0;
      var cy = flat ? (w.ymin + w.ymax) / 2 : 0, cz = 0;
      var nw = {
        xmin: cx + (w.xmin - cx) * f, xmax: cx + (w.xmax - cx) * f,
        ymin: cy + (w.ymin - cy) * f, ymax: cy + (w.ymax - cy) * f,
        zmin: flat ? w.zmin : cz + (w.zmin - cz) * f,
        zmax: flat ? w.zmax : cz + (w.zmax - cz) * f
      };
      nw.diag = Math.hypot(nw.xmax - nw.xmin, nw.ymax - nw.ymin, nw.zmax - nw.zmin);
      this.win = nw;
      this.viewport.win = nw;
      if (flat) {
        this.viewport.update2dCamera();
      } else {
        this.viewport.scaleView(f);
        this.viewport.scaleDecor(f);
      }
      this.buildAllGeom();
      this.flashWindowSize();
    },

    // scroll wheel: coarse geometry-only steps per frame, one full rebuild at the end.
    // In 2D only the camera moves; content is precomputed over the overscan.
    wheelZoom: function (f) {
      var self = this;
      if (this.mode2d) {
        var w = this.win;
        var span2 = (w.xmax - w.xmin) * f;
        if (span2 < 1e-3 || span2 > 1e7) return;
        var cx = (w.xmin + w.xmax) / 2, cy = (w.ymin + w.ymax) / 2;
        w.xmin = cx + (w.xmin - cx) * f; w.xmax = cx + (w.xmax - cx) * f;
        w.ymin = cy + (w.ymin - cy) * f; w.ymax = cy + (w.ymax - cy) * f;
        w.diag = Math.hypot(w.xmax - w.xmin, w.ymax - w.ymin, w.zmax - w.zmin);
        this.viewport.win = w;
        this.flashWindowSize();
        this.rebuild2dSoon(); // resample directly for the new window — pinned, no lag
        this.saveSoon();
        return;
      }
      var acc = (this._wheelAccum || 1) * f;
      var span = this.win.xmax - this.win.xmin;
      if (span * acc < 1e-3) acc = 1e-3 / span;
      if (span * acc > 1e5) acc = 1e5 / span;
      this._wheelAccum = acc;
      if (!this._wheelRAF) {
        this._wheelRAF = requestAnimationFrame(function () {
          self._wheelRAF = null;
          var step = self._wheelAccum || 1;
          self._wheelAccum = 1;
          if (Math.abs(Math.log(step)) > 0.001) {
            self._fastMode = true;
            var t0 = performance.now();
            self.scaleWindowFast(step);
            self._lastFastMs = performance.now() - t0;
          }
        });
      }
      clearTimeout(this._wheelTimer);
      this._wheelTimer = setTimeout(function () {
        self._wheelTimer = null;
        var rem = self._wheelAccum || 1;
        self._wheelAccum = 1;
        if (Math.abs(Math.log(rem)) > 0.001) {
          self._fastMode = true;
          self.scaleWindowFast(rem);
        }
        // sharpen: full-quality rebuild, fresh decor, persisted window
        self._fastMode = false;
        self.setWindow(self.win);
      }, 200);
    },

    flashWindowSize: function (previewF) {
      var now = performance.now();
      if (this._lastFlash && now - this._lastFlash < 80) return;
      this._lastFlash = now;
      var w = this.win, f = previewF || 1;
      var short = function (v) { return String(parseFloat((v * f).toPrecision(3))); };
      var sym = w.xmin === -w.xmax && w.ymin === -w.ymax && w.zmin === -w.zmax &&
        w.xmax === w.ymax && w.ymax === w.zmax;
      var text = sym ? 'window ±' + short(w.xmax)
        : 'window ' + short(w.xmin) + ' to ' + short(w.xmax) + ' (x)';
      if (!this._toast) this._toast = el('div', 'wintoast', document.getElementById('view'));
      this._toast.textContent = text;
      this._toast.classList.add('show');
      clearTimeout(this._toastTimer);
      var self = this;
      this._toastTimer = setTimeout(function () { self._toast.classList.remove('show'); }, 1300);
    },

    buildChrome: function () {
      var self = this;
      document.getElementById('addrow').addEventListener('click', function () {
        var last = self.rows[self.rows.length - 1];
        if (last && last.state.latex === '') { last.mf.focus(); return; }
        self.insertRowAfter(last);
      });
      document.getElementById('themebtn').addEventListener('click', function () {
        self.applyTheme(self.themeName === 'dark' ? 'light' : 'dark');
      });
      var dim = document.getElementById('dimbtn');
      var syncDim = function () {
        dim.textContent = self.mode2d ? '3D' : '2D';
        dim.title = self.mode2d ? 'back to the 3D view' : 'flat top-down 2D view';
      };
      syncDim();
      dim.addEventListener('click', function () {
        // drop any in-flight 2D gesture work so a leaked refill/settle can't
        // fire after the switch and rebuild the other view's scene coarse
        self.resetGestures2d();
        self.mode2d = !self.mode2d;
        self.viewport.setMode2d(self.mode2d);
        syncDim();
        if (self.mode2d) self.applyAspect2d();
        else {
          // re-square the window: 2D stretched x to the viewport aspect
          self._overWin = null;
          var w2 = self.win;
          // 2D only tracks the z=0 plane, so return to 3D as a cube centered on
          // the origin (at the current 2D zoom level) — the box frames the axes
          // instead of drifting off wherever the 2D view was panned/zoomed
          var r = (w2.ymax - w2.ymin) / 2;
          w2.xmin = -r; w2.xmax = r;
          w2.ymin = -r; w2.ymax = r;
          w2.zmin = -r; w2.zmax = r;
          self.setWindow(w2);
          self.viewport.home(); // reframe the 3D camera on the re-centered cube
        }
        self.saveSoon();
      });
      var zi = document.getElementById('zoomin'), zo = document.getElementById('zoomout');
      zi.title = 'zoom the window in';
      zo.title = 'zoom the window out to show more space';
      zi.addEventListener('click', function () { self.scaleWindow(0.5); });
      zo.addEventListener('click', function () { self.scaleWindow(2); });
      document.getElementById('zoomhome').addEventListener('click', function () { self.viewport.home(); });
      document.getElementById('gsettings').title = 'window & display settings';

      /* global settings */
      var gp = document.getElementById('gpanel');
      var mkNum = function (label, key) {
        var wr = el('div', 'gitem', gp);
        el('label', '', wr).textContent = label;
        var inp = el('input', 'gnum', wr);
        inp.value = P.fmtNum(self.win[key]);
        inp.addEventListener('change', function () {
          try {
            var v = P.miniEval(inp.value, self.env);
            var w = Object.assign({}, self.win);
            w[key] = v;
            if (w.xmin < w.xmax && w.ymin < w.ymax && w.zmin < w.zmax) self.setWindow(w);
            else inp.value = P.fmtNum(self.win[key]);
          } catch (e) { inp.value = P.fmtNum(self.win[key]); }
        });
        return inp;
      };
      el('div', 'gtitle', gp).textContent = 'Window';
      this._winInputs = {};
      [['x min', 'xmin'], ['x max', 'xmax'], ['y min', 'ymin'], ['y max', 'ymax'], ['z min', 'zmin'], ['z max', 'zmax']]
        .forEach(function (pair) { self._winInputs[pair[1]] = mkNum(pair[0], pair[1]); });
      el('div', 'gtitle', gp).textContent = 'Display';
      [['axes', 'showAxes'], ['grid', 'showGrid'], ['box', 'showBox']].forEach(function (pair) {
        var wr = el('div', 'gitem', gp);
        el('label', '', wr).textContent = pair[0];
        var chk = el('input', '', wr);
        chk.type = 'checkbox';
        chk.checked = self.viewport[pair[1]];
        chk.addEventListener('change', function () {
          self.viewport[pair[1]] = chk.checked;
          self.viewport.rebuildDecor();
          if (pair[1] === 'showBox') self.rows.forEach(function (r) { self.buildGeomIfDirty(r); });
          self.saveSoon();
        });
      });
      var clr = el('button', 'gclear', gp);
      clr.textContent = 'Delete all expressions';
      clr.addEventListener('click', function () {
        if (!clr.classList.contains('arm')) {
          clr.classList.add('arm');
          clr.textContent = 'Click again to delete everything';
          setTimeout(function () { clr.classList.remove('arm'); clr.textContent = 'Delete all expressions'; }, 2500);
          return;
        }
        clr.classList.remove('arm');
        clr.textContent = 'Delete all expressions';
        self.rows.slice().forEach(function (r) { self.viewport.removeObject(r.id); r.dom.remove(); r.playing = false; });
        self.rows = [];
        self._playing.clear();
        self.appendRow(new P.Row(self, {}));
        self.recompute();
        self.rows[0].mf.focus();
        self.saveSoon();
      });

      var toggle = function (btnId, panel) {
        document.getElementById(btnId).addEventListener('click', function (ev) {
          ev.stopPropagation();
          var was = panel.classList.contains('hiddenb');
          document.querySelectorAll('.popover').forEach(function (p) { p.classList.add('hiddenb'); });
          if (was) panel.classList.remove('hiddenb');
        });
      };
      toggle('gsettings', gp);

      /* docs drawer */
      var drawer = document.getElementById('docsdrawer');
      var openDocs = function (ev) {
        if (ev) ev.stopPropagation();
        drawer.classList.remove('hiddenb');
        // MathQuill measures 0×0 inside the hidden drawer — reflow once visible
        if (!self._docsReflowed) {
          self._docsReflowed = true;
          (self._helpStatics || []).forEach(function (m) { try { m.latex(m.latex()); } catch (e) {} });
        }
      };
      var closeDocs = function () { drawer.classList.add('hiddenb'); };
      document.getElementById('helpbtn').addEventListener('click', openDocs);
      document.getElementById('docsclose').addEventListener('click', closeDocs);
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') closeDocs();
      });

      document.addEventListener('mousedown', function (ev) {
        if (!ev.target.closest('.popover') && !ev.target.closest('#gsettings')) {
          document.querySelectorAll('.popover').forEach(function (p) { p.classList.add('hiddenb'); });
        }
        if (!ev.target.closest('#docsdrawer') && !ev.target.closest('#helpbtn')) closeDocs();
        if (!ev.target.closest('.rowsettings') && !ev.target.closest('.gear')) self.closeAllSettings();
        if (!ev.target.closest('.styleflyout') && !ev.target.closest('.swatch')) self.closeAllFlyouts();
      });

      this.buildDocs();
      this.buildEmptyHint();
    },

    buildEmptyHint: function () {
      var self = this;
      var eh = document.getElementById('emptyhint');
      el('div', 'ehtitle', eh).textContent = 'Type an equation';
      el('div', 'ehsub', eh).textContent = 'The object type is detected from the math itself. Try one of these:';
      var chips = el('div', 'ehchips', eh);
      [
        ['r = 1', 'r=1'],
        ['\u03c1 = 2cos \u03c6', '\\rho =2\\cos \\left(\\phi \\right)'],
        ['z = sin x + cos y', 'z=\\sin \\left(x\\right)+\\cos \\left(y\\right)'],
        ['x\u00b2 + y\u00b2 + z\u00b2 = 9', 'x^{2}+y^{2}+z^{2}=9']
      ].forEach(function (pair) {
        var chipEl = el('button', 'chip', chips);
        chipEl.textContent = pair[0];
        chipEl.addEventListener('click', function () {
          var row = self.rows[0];
          row._squelch = true;
          row.mf.latex(pair[1]);
          row._squelch = false;
          row.state.latex = row.mf.latex();
          self.recompute();
          self.saveSoon();
          row.mf.focus();
        });
      });
      this.updateEmptyHint();
    },
    updateEmptyHint: function () {
      var eh = document.getElementById('emptyhint');
      if (!eh) return;
      var empty = this.rows.length === 1 && !this.rows[0].state.latex;
      eh.classList.toggle('hiddenb', !empty);
      if (empty) this.rowsEl.appendChild(eh); // keep it right below the row
    },

    buildDocs: function () {
      var self = this;
      var hp = document.getElementById('docsbody');
      var section = function (title) {
        el('div', 'docsec', hp).textContent = title;
      };
      var refs = function (pairs) {
        var box = el('div', 'reflist', hp);
        pairs.forEach(function (pr) {
          var row = el('div', 'refrow', box);
          el('span', 'refk', row).innerHTML = pr[0];
          el('span', 'refv', row).innerHTML = pr[1];
        });
      };

      section('Typing');
      refs([
        ['<b>rho theta phi pi</b>', '\u03c1 \u03b8 \u03c6 \u03c0'],
        ['<b>/</b> and <b>^</b>', 'fraction, exponent'],
        ['<b>sqrt</b>, <b>nthroot</b>', 'roots'],
        ['<b>log</b> then <b>_2</b>', 'log base 2'],
        ['<b>Enter</b>', 'new row'],
        ['<b>\u2191 \u2193</b>', 'move between rows'],
        ['<b>\u232b</b> on an empty row', 'delete it']
      ]);

      section('Plot anything (click to insert)');
      var EXAMPLES = [
        ['cylinder', 'r=1'],
        ['half-plane', '\\theta =\\frac{\\pi }{4}'],
        ['sphere (spherical)', '\\rho =2\\cos \\left(\\phi \\right)'],
        ['surface z = f(x, y)', 'z=\\sin \\left(x\\right)+\\cos \\left(y\\right)'],
        ['polar surface', 'z=\\frac{r^{2}}{4}'],
        ['cone', '\\phi =\\frac{\\pi }{6}'],
        ['implicit surface', 'x^{2}+y^{2}+z^{2}=9'],
        ['space curve', '\\left(3\\cos \\left(t\\right),3\\sin \\left(t\\right),\\frac{t}{2}\\right)'],
        ['torus (parametric)', '\\left(\\left(2+\\cos \\left(v\\right)\\right)\\cos \\left(u\\right),\\left(2+\\cos \\left(v\\right)\\right)\\sin \\left(u\\right),\\sin \\left(v\\right)\\right)'],
        ['point', '\\left(1,2,3\\right)'],
        ['vector', '\\operatorname{vector}\\left(\\left(0,0,0\\right),\\left(1,2,2\\right)\\right)'],
        ['vector field', 'F\\left(x,y,z\\right)=\\left(y,-x,\\frac{z}{2}\\right)'],
        ['vector field (2D)', 'G\\left(x,y\\right)=\\left(-y,x\\right)'],
        ['region (solid)', 'z\\le 4-x^{2}-y^{2}'],
        ['slider', 'a=1'],
        ['function definition', 'f\\left(x,y\\right)=x\\cdot y\\cdot e^{-x^{2}-y^{2}}'],
        ['curve of intersection', '\\operatorname{intersection}']
      ];
      var tbl = el('div', 'extable', hp);
      this._helpStatics = [];
      EXAMPLES.forEach(function (ex) {
        var rowEl = el('div', 'exrow', tbl);
        var lab = el('span', 'exlab', rowEl);
        lab.textContent = ex[0];
        var b = el('button', 'extry', rowEl);
        var span = el('span', '', b);
        if (ex[1].indexOf('intersection') !== -1) {
          span.textContent = 'intersection';
          span.className = 'exword';
        } else {
          var sm = P.initMQ().StaticMath(span);
          sm.latex(ex[1]);
          self._helpStatics.push(sm);
        }
        b.title = 'add this expression';
        b.addEventListener('click', function () {
          var last = self.rows[self.rows.length - 1];
          var target = (last && last.state.latex === '') ? last : self.appendRow(new P.Row(self, {}), last);
          target._squelch = true;
          target.mf.latex(ex[1]);
          target._squelch = false;
          target.state.latex = target.mf.latex();
          self.recompute();
          self.saveSoon();
        });
      });
      section('Coordinates');
      refs([
        ['z axis', 'points up'],
        ['\u03b8', 'atan2(y, x)'],
        ['\u03c6', 'angle from the +z axis'],
        ['curves', 'parameter <b>t</b>'],
        ['parametric surfaces', '<b>u</b> and <b>v</b>'],
        ['2-part tuples', 'drawn in the xy plane'],
        ['unsolved equations', 'implicit surfaces, any coords']
      ]);

      section('Sliders and names');
      refs([
        ['<b>a = 1</b>', 'slider, \u25b6 animates'],
        ['unknown letter', 'one-click add slider'],
        ['<b>f(x,y) = \u2026</b>', 'function, usable anywhere'],
        ['<b>c = 2a</b>, <b>P = (1,2,3)</b>', 'constant, named point']
      ]);

      section('Intersections');
      refs([
        ['type <b>intersection</b>', 'two surface pickers appear'],
        ['hide both surfaces', 'study the curve alone'],
        ['limit', 'one of the pair needs an equation form']
      ]);

      section('View');
      refs([
        ['<b>2D</b>', 'flat top-down view for polar and xy graphs'],
        ['scroll or <b>+ \u2212</b>', 'zoom the window, axes rescale'],
        ['drag, right-drag', 'orbit, pan'],
        ['<b>\u2302</b>', 'reset the view'],
        ['<b>\u2699</b>', 'exact ranges, axes, grid, box']
      ]);

      section('Rows');
      refs([
        ['click the circle', 'show or hide the plot'],
        ['right-click the circle', 'color and opacity'],
        ['gear', 'detail, mesh, labels, show in 2D'],
        ['everything', 'autosaves in this browser']
      ]);
    },

    /* ---------------- persistence ---------------- */
    saveSoon: function () {
      var self = this;
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(function () { self.save(); }, 400);
    },
    save: function () {
      try {
        var state = {
          window: { xmin: this.win.xmin, xmax: this.win.xmax, ymin: this.win.ymin, ymax: this.win.ymax, zmin: this.win.zmin, zmax: this.win.zmax },
          view: { axes: this.viewport.showAxes, grid: this.viewport.showGrid, box: this.viewport.showBox, theme: this.themeName, mode2d: this.mode2d },
          rows: this.rows.map(function (r) { return r.serialize(); })
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) { /* private mode etc. */ }
    },
    load: function () {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); }
      catch (e) { return null; }
    }
  };

  window.addEventListener('DOMContentLoaded', function () { window.app = new App(); });
})();
