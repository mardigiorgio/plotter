/* ui.js — expression rows (MathQuill), sliders, domains, per-row settings. */
(function () {
  'use strict';
  var P = window.P = window.P || {};
  var MQ = null;
  P.initMQ = function () { MQ = MathQuill.getInterface(2); return MQ; };

  P.PALETTE = ['#c74440', '#2d70b3', '#388c46', '#6042a6', '#fa7e19', '#000000'];

  P.fmtNum = function (v) {
    if (!isFinite(v)) return String(v);
    if (v === 0) return '0';
    var av = Math.abs(v);
    if (av >= 1e6 || av < 1e-4) return v.toExponential(4).replace(/e\+?/, 'ᴇ');
    return String(parseFloat(v.toPrecision(8)));
  };

  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  P.el = el;

  /* evaluate a plain-text mini expression ("2pi", "-5", "pi/2", "2a") */
  P.miniEval = function (str, env) {
    var s = String(str).trim();
    if (!s) throw new Error('empty');
    // allow a preceding digit ("2pi") but not a letter or backslash
    s = s.replace(/π/g, 'pi')
      .replace(/(^|[^a-zA-Z\\])pi(?![a-zA-Z])/g, '$1\\pi ')
      .replace(/(^|[^a-zA-Z\\])tau(?![a-zA-Z])/g, '$1(2\\pi )');
    var stmt = P.parse(s);
    if (stmt.kind !== 'expr') throw new Error('expected a number');
    return P.evalConst(stmt.expr, env);
  };

  var MQ_CONFIG_BASE = {
    spaceBehavesLikeTab: true,
    restrictMismatchedBrackets: true,
    autoSubscriptNumerals: true,
    sumStartsWithNEquals: true,
    charsThatBreakOutOfSupSub: '+-=<>',
    autoCommands: 'pi theta rho phi tau sqrt nthroot',
    autoOperatorNames: 'sin cos tan sec csc cot arcsin arccos arctan asin acos atan sinh cosh tanh asinh acosh atanh ln log exp abs min max floor ceil round sign mod vector intersection region'
  };

  /* =============================== Row =============================== */
  var nextId = 1;

  P.Row = function (app, state) {
    var self = this;
    this.app = app;
    this.id = 'row' + (nextId++);
    state = state || {};
    // saved rows carry an explicit opacity; only fresh rows may be given the
    // translucent region default later (classifyRow)
    this._opacityExplicit = state.opacity !== undefined;
    this.state = {
      latex: state.latex || '',
      hidden: !!state.hidden,
      color: state.color || null, // assigned on renumber if null
      opacity: state.opacity !== undefined ? state.opacity : 1,
      mesh: state.mesh !== undefined ? state.mesh : true,
      res: state.res || 0,       // 0 = default
      density: state.density || 6,
      label: state.label || '',
      domains: state.domains || {}, // {t0,t1,u0,u1,v0,v1} strings
      slider: state.slider || { min: '-10', max: '10', step: '' },
      isect: state.isect || null,  // {a: rowIndex, b: rowIndex} (persistence only)
      regionBounds: state.regionBounds || [''], // inequality latex per bound (region object)
      flat2d: !!state.flat2d       // draw the flat trace instead of the extruded sheet
    };
    this._isectA = null; // live row references, resolved by the app
    this._isectB = null;
    this.spec = { type: 'empty' };
    this.error = null;
    this.playing = false;
    this._squelch = false;

    /* DOM */
    var root = this.dom = el('div', 'row');
    root.dataset.id = this.id;
    var gutter = el('div', 'gutter', root);
    this.idxEl = el('div', 'idx', gutter);
    this.swatch = el('button', 'swatch', gutter);
    this.swatch.title = 'Click to show or hide. Right-click for color and opacity.';
    this.swatch.addEventListener('click', function () {
      if (self._lpFired) { self._lpFired = false; return; }
      self.state.hidden = !self.state.hidden;
      self.renderSwatch();
      self.app.viewport.setVisible(self.id, !self.state.hidden);
      self.app.saveSoon();
    });
    this.swatch.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      self.openFlyout();
    });
    var lpTimer = null;
    this.swatch.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType === 'touch') {
        lpTimer = setTimeout(function () { self._lpFired = true; self.openFlyout(); }, 550);
      }
    });
    ['pointerup', 'pointerleave'].forEach(function (evn) {
      self.swatch.addEventListener(evn, function () { clearTimeout(lpTimer); });
    });
    this.flyout = el('div', 'styleflyout hiddenb', gutter);

    var main = el('div', 'rowmain', root);
    var mqspan = el('span', 'mq', main);
    this.substrip = el('div', 'substrip', main);

    var side = el('div', 'rowside', root);
    this.badge = el('div', 'badge hiddenb', side);
    this.gear = el('button', 'gear', side);
    this.gear.innerHTML = '&#9881;';
    this.gear.title = 'style & settings';
    this.gear.addEventListener('click', function (ev) { ev.stopPropagation(); self.toggleSettings(); });
    var del = el('button', 'del', side);
    del.innerHTML = '&times;';
    del.title = 'delete';
    del.addEventListener('click', function () { self.app.deleteRow(self); });

    this.settingsEl = el('div', 'rowsettings hiddenb', root);

    var cfg = Object.assign({}, MQ_CONFIG_BASE, {
      handlers: {
        edit: function () {
          if (self._squelch) return;
          self.state.latex = self.mf.latex();
          self.app.scheduleRecompute();
          self.app.saveSoon();
        },
        enter: function () { self.app.insertRowAfter(self); },
        upOutOf: function () { self.app.focusAdjacent(self, -1); },
        downOutOf: function () { self.app.focusAdjacent(self, +1); },
        deleteOutOf: function (dir) {
          if (dir === MQ.L) {
            if (self.state.latex === '') self.app.deleteRow(self, true);
            else self.app.focusAdjacent(self, -1);
          }
        }
      }
    });
    this.mf = MQ.MathField(mqspan, cfg);
    if (this.state.latex) {
      this._squelch = true;
      this.mf.latex(this.state.latex);
      this._squelch = false;
    }

    mqspan.addEventListener('focusin', function () { self.app.onRowFocus(self); });
    mqspan.addEventListener('focusout', function () { self.app.onRowBlur(self); });
    root.addEventListener('mousedown', function (ev) {
      if (ev.target === root || ev.target === main) { self.mf.focus(); ev.preventDefault(); }
    });
  };

  P.Row.prototype = {
    setIndex: function (i) {
      this.idxEl.textContent = i + 1;
      if (!this.state.color) this.state.color = P.PALETTE[i % P.PALETTE.length];
      this.renderSwatch();
    },
    renderSwatch: function () {
      var t = this.spec.type;
      var showsObject = ['empty', 'slider', 'constdef', 'constExpr', 'error'].indexOf(t) === -1 &&
        !(t === 'definition' && !this.spec.render);
      this._renderable = showsObject;
      this.swatch.style.setProperty('--c', this.state.color);
      this.swatch.classList.toggle('off', this.state.hidden);
      this.swatch.classList.toggle('inert', !showsObject);
      // rows that draw nothing have no style settings either
      this.gear.classList.toggle('hiddenb', !showsObject);
      if (!showsObject) this.settingsEl.classList.add('hiddenb');
    },
    setError: function (msg, sliders) {
      this.error = msg;
      var self = this;
      if (!msg) {
        this.badge.classList.add('hiddenb');
        this.badge.innerHTML = '';
        return;
      }
      this.badge.classList.remove('hiddenb');
      this.badge.innerHTML = '<span class="err" title="' + msg.replace(/"/g, '&quot;') + '">!</span>';
      if (sliders && sliders.length) {
        var strip = this.substrip;
        strip.innerHTML = '';
        var wrap = P.el('div', 'addsliders', strip);
        wrap.appendChild(document.createTextNode('add slider: '));
        sliders.forEach(function (name) {
          var b = P.el('button', 'addslider', wrap);
          b.textContent = P.prettyName(name);
          b.addEventListener('click', function () { self.app.addSliderRowFor(self, name); });
        });
      }
    },

    /* -------- substrip (slider / domains / value) -------- */
    clearSub: function () { this.substrip.innerHTML = ''; },

    showValue: function (text) {
      this.clearSub();
      var v = el('div', 'valdisp', this.substrip);
      v.textContent = '= ' + text;
      this._valEl = v;
    },

    showSlider: function (name, value) {
      var self = this, st = this.state.slider;
      this.clearSub();
      var wrap = el('div', 'sliderstrip', this.substrip);
      var minI = el('input', 'sbound', wrap);
      minI.value = st.min;
      var range = el('input', 'srange', wrap);
      range.type = 'range';
      var maxI = el('input', 'sbound', wrap);
      maxI.value = st.max;
      var play = el('button', 'splay', wrap);
      play.innerHTML = this.playing ? '&#9632;' : '&#9654;';
      var stepI = el('input', 'sstep', wrap);
      stepI.placeholder = 'step';
      stepI.value = st.step;
      stepI.title = 'step (empty = continuous)';

      function bounds() {
        var lo = -10, hi = 10, step = 'any';
        try { lo = P.miniEval(st.min, self.app.env); } catch (e) {}
        try { hi = P.miniEval(st.max, self.app.env); } catch (e) {}
        if (hi <= lo) hi = lo + 1;
        if (st.step) { try { var s = P.miniEval(st.step, self.app.env); if (s > 0) step = s; } catch (e) {} }
        return { lo: lo, hi: hi, step: step };
      }
      function syncRange() {
        var b = bounds();
        range.min = b.lo; range.max = b.hi; range.step = b.step === 'any' ? (b.hi - b.lo) / 1000 : b.step;
        range.value = value;
      }
      syncRange();
      range.addEventListener('input', function () {
        var v = parseFloat(range.value);
        value = v;
        self.app.setSliderValue(self, name, v);
      });
      function onBound() {
        st.min = minI.value; st.max = maxI.value; st.step = stepI.value;
        syncRange();
        self.app.saveSoon();
      }
      minI.addEventListener('change', onBound);
      maxI.addEventListener('change', onBound);
      stepI.addEventListener('change', onBound);
      play.addEventListener('click', function () {
        self.playing = !self.playing;
        play.innerHTML = self.playing ? '&#9632;' : '&#9654;';
        self.app.setPlaying(self, name, self.playing, bounds);
      });
      this._sliderRange = range;
    },

    updateSliderPosition: function (v) {
      if (this._sliderRange) this._sliderRange.value = v;
    },

    showDomains: function (vars) {
      var self = this;
      this.clearSub();
      var wrap = el('div', 'domstrip', this.substrip);
      vars.forEach(function (name) {
        var d = self.state.domains;
        var lo = d[name + '0'] !== undefined ? d[name + '0'] : '0';
        var hi = d[name + '1'] !== undefined ? d[name + '1'] : '2π';
        var box = el('span', 'dom', wrap);
        var loI = el('input', 'dbound', box);
        loI.value = lo;
        var lab = el('span', 'dlab', box);
        lab.innerHTML = ' &le; ' + P.prettyName(name) + ' &le; ';
        var hiI = el('input', 'dbound', box);
        hiI.value = hi;
        function onCh() {
          d[name + '0'] = loI.value; d[name + '1'] = hiI.value;
          self.app.scheduleRecompute();
          self.app.saveSoon();
        }
        loI.addEventListener('change', onCh);
        hiI.addEventListener('change', onCh);
      });
    },

    /* -------- style flyout (right-click on the swatch) -------- */
    openFlyout: function () {
      if (!this._renderable) return;
      var self = this, s = this.state, box = this.flyout;
      this.app.closeAllFlyouts();
      this.app.closeAllSettings();
      box.innerHTML = '';
      box.classList.remove('hiddenb');
      var dots = el('div', 'flycolors', box);
      P.PALETTE.forEach(function (c) {
        var b = el('button', 'colorbtn', dots);
        b.style.background = c;
        if (c === s.color) b.classList.add('sel');
        b.addEventListener('click', function () {
          s.color = c;
          self.renderSwatch();
          self.app.rebuildRow(self);
          self.openFlyout();
        });
      });
      var orow = el('div', 'flyop', box);
      el('span', 'setlab', orow).textContent = 'opacity';
      var inp = el('input', '', orow);
      inp.type = 'range'; inp.min = 0.05; inp.max = 1; inp.step = 0.05; inp.value = s.opacity;
      inp.addEventListener('input', function () { self.app.applyOpacityLive(self, parseFloat(inp.value)); });
      inp.addEventListener('change', function () { self.app.saveSoon(); });
    },
    closeFlyout: function () { this.flyout.classList.add('hiddenb'); },

    /* -------- intersection pickers -------- */
    // cands: [{row, label}]
    showIsect: function (cands, selA, selB, onChange) {
      this.clearSub();
      var wrap = el('div', 'isectstrip', this.substrip);
      var mk = function (labelText, sel, which) {
        var box = el('span', 'isel', wrap);
        el('span', 'ilab', box).textContent = labelText + ' ';
        var s = el('select', 'ipick', box);
        if (!cands.length) {
          var o0 = el('option', '', s);
          o0.textContent = '(no surfaces)';
          s.disabled = true;
          return;
        }
        if (!sel) {
          var ph = el('option', '', s);
          ph.textContent = 'choose…';
          ph.disabled = true;
          ph.selected = true;
        }
        cands.forEach(function (c) {
          var o = el('option', '', s);
          o.value = c.row.id;
          o.textContent = c.label;
          if (sel && c.row === sel) o.selected = true;
        });
        s.addEventListener('change', function () {
          var hit = null;
          cands.forEach(function (c) { if (c.row.id === s.value) hit = c.row; });
          onChange(which, hit);
        });
      };
      mk('of', selA, 'a');
      mk('and', selB, 'b');
    },

    /* -------- region bound fields --------
     * Typed math like everywhere else in the app: each bound is a MathQuill
     * field (so <= becomes ≤ while typing and Greek autocompletes), bounds
     * can be added and removed freely, edits apply live, and a bound that
     * does not parse is underlined without killing the others. */
    showRegionBounds: function (bounds, onChange) {
      var self = this;
      this.clearSub();
      var wrap = el('div', 'rgnstrip', this.substrip);
      var list = el('div', 'rgnlist', wrap);
      var foot = el('div', 'rgnfoot', wrap);
      var add = el('button', 'rgnadd', foot);
      add.textContent = '+ bound';
      add.title = 'add another bound; all bounds combine by intersection';
      var hint = el('span', 'rgnhint', foot);
      hint.textContent = 'bounds intersect, e.g. -2 < x < 2 and x²+y² ≤ z';
      var fields = [];
      var squelch = false;
      var sync = function () {
        self.state.regionBounds = fields.map(function (f) { return f.mf.latex(); });
        fields.forEach(function (f) {
          var ok = true;
          try { P.parseBound(f.mf.latex()); } catch (e) { ok = false; }
          f.box.classList.toggle('rgnbad', !ok);
        });
        onChange();
      };
      var addField = function (latex, focus) {
        var box = el('span', 'rgnb', list);
        var span = el('span', 'rgnmq', box);
        var f = { box: box, mf: null };
        f.mf = MQ.MathField(span, Object.assign({}, MQ_CONFIG_BASE, {
          handlers: { edit: function () { if (!squelch) sync(); } }
        }));
        var rm = el('button', 'rgnrm', box);
        rm.innerHTML = '&times;';
        rm.title = 'remove this bound';
        rm.addEventListener('click', function () {
          if (fields.length <= 1) {
            squelch = true; f.mf.latex(''); squelch = false;
            sync();
            return;
          }
          fields.splice(fields.indexOf(f), 1);
          box.remove();
          sync();
        });
        if (latex) {
          squelch = true;
          // legacy plain-text saves: show <= / >= as real ≤ / ≥
          f.mf.latex(latex.replace(/<=/g, '\\le ').replace(/>=/g, '\\ge '));
          squelch = false;
        }
        fields.push(f);
        if (focus) f.mf.focus();
        return f;
      };
      ((bounds && bounds.length ? bounds : ['']).filter(function (b, i, arr) {
        // drop saved trailing blanks (the old UI always kept three fields)
        return b || i === 0 || arr.slice(i).some(function (x) { return x; });
      })).forEach(function (b) { addField(b || '', false); });
      add.addEventListener('click', function () { addField('', true); });
    },

    getDomain: function (name, defLo, defHi) {
      var d = this.state.domains;
      var lo = defLo, hi = defHi;
      try { if (d[name + '0'] !== undefined && d[name + '0'] !== '') lo = P.miniEval(d[name + '0'], this.app.env); } catch (e) {}
      try { if (d[name + '1'] !== undefined && d[name + '1'] !== '') hi = P.miniEval(d[name + '1'], this.app.env); } catch (e) {}
      if (!(hi > lo)) { lo = defLo; hi = defHi; }
      return [lo, hi];
    },

    /* -------- settings popover -------- */
    toggleSettings: function () {
      var open = !this.settingsEl.classList.contains('hiddenb');
      this.app.closeAllSettings();
      if (!open) this.buildSettings();
    },
    buildSettings: function () {
      if (!this._renderable) return;
      var self = this, s = this.state, box = this.settingsEl;
      box.innerHTML = '';
      box.classList.remove('hiddenb');

      var swrow = el('div', 'setrow', box);
      P.PALETTE.forEach(function (c) {
        var b = el('button', 'colorbtn', swrow);
        b.style.background = c;
        if (c === s.color) b.classList.add('sel');
        b.addEventListener('click', function () {
          s.color = c;
          self.renderSwatch();
          self.app.rebuildRow(self);
          self.buildSettings();
          self.app.saveSoon();
        });
      });

      var type = this.spec.type;
      var surfaceLike = ['graph', 'cyl', 'thetaSurf', 'sph', 'phiSurf', 'psurf', 'implicit', 'region', 'curve'].indexOf(type) !== -1 ||
        (type === 'definition' && this.spec.render && this.spec.render.type !== 'vfield');

      function slider(label, min, max, step, val, cb) {
        var r = el('div', 'setrow', box);
        el('span', 'setlab', r).textContent = label;
        var inp = el('input', '', r);
        inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = val;
        inp.addEventListener('input', function () { cb(parseFloat(inp.value)); });
        inp.addEventListener('change', function () { self.app.saveSoon(); });
        return inp;
      }

      slider('opacity', 0.05, 1, 0.05, s.opacity, function (v) {
        self.app.applyOpacityLive(self, v);
      });

      if (surfaceLike) {
        slider('detail', 16, 128, 4, s.res || 64, function (v) {
          s.res = v;
          self.app.rebuildRowSoon(self);
        });
        var mr = el('div', 'setrow', box);
        el('span', 'setlab', mr).textContent = 'mesh lines';
        var chk = el('input', '', mr);
        chk.type = 'checkbox'; chk.checked = s.mesh;
        chk.addEventListener('change', function () {
          s.mesh = chk.checked;
          self.app.rebuildRow(self);
          self.app.saveSoon();
        });
      }

      // surfaces with an unused variable (y = x leaves z free) can draw flat
      if (this.app.flat2dInfo(this)) {
        var f2r = el('div', 'setrow', box);
        el('span', 'setlab', f2r).textContent = 'show in 2D';
        var f2chk = el('input', '', f2r);
        f2chk.type = 'checkbox'; f2chk.checked = !!s.flat2d;
        f2chk.addEventListener('change', function () {
          s.flat2d = f2chk.checked;
          self.app.rebuildRow(self);
          self.app.saveSoon();
        });
      }

      if (type === 'vfield' || (type === 'definition' && this.spec.render && this.spec.render.type === 'vfield')) {
        slider('density', 3, 10, 1, s.density, function (v) {
          s.density = v;
          self.app.rebuildRowSoon(self);
        });
      }

      if (type === 'point' || type === 'namedPoint') {
        var lr = el('div', 'setrow', box);
        el('span', 'setlab', lr).textContent = 'label';
        var li = el('input', 'labelin', lr);
        li.type = 'text'; li.value = s.label; li.placeholder = 'text shown by the point';
        li.addEventListener('input', function () {
          s.label = li.value;
          self.app.rebuildRowSoon(self);
          self.app.saveSoon();
        });
      }
    },

    serialize: function () {
      var out = {
        latex: this.state.latex, hidden: this.state.hidden, color: this.state.color,
        opacity: this.state.opacity, mesh: this.state.mesh, res: this.state.res,
        density: this.state.density, label: this.state.label,
        domains: this.state.domains, slider: this.state.slider,
        flat2d: this.state.flat2d
      };
      if (this.state.regionBounds && this.state.regionBounds.some(function (b) { return b; })) {
        out.regionBounds = this.state.regionBounds;
      }
      if (this._isectA || this._isectB) {
        out.isect = {
          a: this._isectA ? this.app.rows.indexOf(this._isectA) : null,
          b: this._isectB ? this.app.rows.indexOf(this._isectB) : null
        };
      }
      return out;
    }
  };
})();
