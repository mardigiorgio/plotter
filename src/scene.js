/* scene.js — Three.js viewport: z-up axes, ticks, grid, box, lights, controls. */
(function () {
  'use strict';
  var P = window.P = window.P || {};

  P.reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  P.THEMES = {
    light: {
      axis: 0x3a3f4a, grid: 0xe8eaee, box: 0xd8dbe0,
      tick: '#565d6b', label: '#1a2030', halo: 'rgba(255,255,255,0.9)',
      fog: 0xf2f4f7, hemiSky: 0xffffff, hemiGround: 0x556677, hemiInt: 0.85,
      dl1: 0.65, dl2: 0.25
    },
    dark: {
      axis: 0xcdd5e4, grid: 0x2a313d, box: 0x394253,
      tick: '#9aa4b8', label: '#e8ecf5', halo: 'rgba(16,20,26,0.85)',
      fog: 0x10141a, hemiSky: 0xdfe8ff, hemiGround: 0x1a2028, hemiInt: 0.9,
      dl1: 0.75, dl2: 0.3
    }
  };

  function niceStep(range) {
    var raw = range / 6;
    var pow = Math.pow(10, Math.floor(Math.log10(raw)));
    var cands = [1, 2, 5, 10];
    for (var i = 0; i < cands.length; i++) {
      if (cands[i] * pow >= raw - 1e-12) return cands[i] * pow;
    }
    return 10 * pow;
  }
  function fmtTick(v) {
    var s = (Math.abs(v) < 1e-10 ? 0 : v).toPrecision(10);
    return String(parseFloat(s));
  }

  P.Viewport = function (container) {
    var self = this;
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor(P.THEMES.light.fog, 1); // opaque: no compositor blend
    container.appendChild(this.renderer.domElement);

    this.theme = P.THEMES.light;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 4000);
    this.camera.up.set(0, 0, 1);

    this.camera2d = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    this.camera2d.up.set(0, 1, 0);
    this._hemi = new THREE.HemisphereLight(0xffffff, 0x556677, 0.85);
    this.scene.add(this._hemi);
    this._dl1 = new THREE.DirectionalLight(0xffffff, 0.65);
    this._dl1.position.set(1.5, -2.5, 3);
    this.scene.add(this._dl1);
    this._dl2 = new THREE.DirectionalLight(0xffffff, 0.25);
    this._dl2.position.set(-2, 2, -1.5);
    this.scene.add(this._dl2);
    this._pops = [];

    this.decor = new THREE.Group();   // axes, grid, box
    this.plots = new THREE.Group();   // user objects
    this.scene.add(this.decor, this.plots);
    this.objects = {};                // rowId → Object3D

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.75;
    this._needsRender = true;
    this.controls.addEventListener('change', function () { self._needsRender = true; });
    // the wheel zooms the WINDOW (axis ranges), not the camera; see onWheelZoom
    this.controls.enableZoom = false;
    this.renderer.domElement.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      if (self.onWheelZoom) self.onWheelZoom(Math.exp(ev.deltaY * 0.0012));
    }, { passive: false });
    var panLast = null;
    this.renderer.domElement.addEventListener('pointerdown', function (ev) {
      if (self.mode2d && ev.button === 0) {
        panLast = [ev.clientX, ev.clientY];
        self.renderer.domElement.setPointerCapture(ev.pointerId);
      }
    });
    this.renderer.domElement.addEventListener('pointermove', function (ev) {
      if (self.mode2d && panLast && self.onPan2d) {
        var wEl = self.renderer.domElement.clientWidth, hEl = self.renderer.domElement.clientHeight;
        var dx = (ev.clientX - panLast[0]) / wEl * (self.win.xmax - self.win.xmin);
        var dy = (ev.clientY - panLast[1]) / hEl * (self.win.ymax - self.win.ymin);
        panLast = [ev.clientX, ev.clientY];
        self.onPan2d(-dx, dy);
      }
    });
    ['pointerup', 'pointercancel'].forEach(function (evn) {
      self.renderer.domElement.addEventListener(evn, function () { panLast = null; });
    });

    this.showAxes = true; this.showGrid = true; this.showBox = true;

    this.resize = function () {
      var w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      self.renderer.setSize(w, h);
      self.camera.aspect = w / h;
      self.camera.updateProjectionMatrix();
      if (self.mode2d && self.onResize2d) self.onResize2d();
      self._needsRender = true;
    };
    window.addEventListener('resize', this.resize);
    if (window.ResizeObserver) new ResizeObserver(this.resize).observe(container);

    var loop = function () {
      requestAnimationFrame(loop);
      var moved = self.controls.update();
      if (self._pops.length) {
        self._needsRender = true;
        var now = performance.now();
        for (var pi = self._pops.length - 1; pi >= 0; pi--) {
          var pp = self._pops[pi];
          var k = (now - pp.t0) / 180;
          if (k >= 1 || !self.center) {
            pp.obj.scale.setScalar(1);
            pp.obj.position.set(0, 0, 0);
            self._pops.splice(pi, 1);
            continue;
          }
          var e = 1 - (1 - k) * (1 - k);
          var sc = 0.94 + 0.06 * e;
          pp.obj.scale.setScalar(sc);
          pp.obj.position.set(self.center.x * (1 - sc), self.center.y * (1 - sc), self.center.z * (1 - sc));
        }
      }
      if (moved || self._needsRender) {
        self.sortTransparent();
        self.renderer.render(self.scene, self.mode2d ? self.camera2d : self.camera);
        self._needsRender = false;
      }
    };
    this.resize();
    loop();
  };

  P.Viewport.prototype = {
    requestRender: function () { this._needsRender = true; },

    /* Depth-sort every translucent plot mesh far-to-near each rendered frame:
     * surface pairs (geometry.js surfacePair — back pass always right before
     * its front pass) and single translucent meshes (tubes, points, ribbons,
     * 2D fills) share one ordering. three.js's own transparent sort is
     * useless here because all plot objects sit at the origin. Depth is the
     * camera-space view axis, which is also correct for the 2D ortho camera
     * (plain point distance is not). */
    sortTransparent: function () {
      var cam = this.mode2d ? this.camera2d : this.camera;
      cam.updateMatrixWorld();
      // matrixWorldInverse is only refreshed inside renderer.render — invert here
      var mi = this._sortMat || (this._sortMat = new THREE.Matrix4());
      mi.copy(cam.matrixWorld).invert();
      var me = mi.elements;
      var items = [];
      var depth = function (o) {
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        var ctr = o.geometry.boundingSphere.center;
        // camera-space z is negative in front; more negative = farther
        return ctr.x * me[2] + ctr.y * me[6] + ctr.z * me[10] + me[14];
      };
      var objs = this.objects;
      for (var id in objs) {
        objs[id].traverse(function (o) {
          if (!o.isMesh || !o.material || !o.material.transparent || !o.geometry) return;
          if (o._transRole === 0) return;                    // back pass rides with its front
          if (o._transRole === 1) items.push({ list: o.parent._transPair, d: depth(o) });
          else items.push({ list: [o], d: depth(o) });
        });
      }
      if (!items.length) return;
      items.sort(function (a, b) { return a.d - b.d; }); // farthest (most negative) first
      var order = 10;
      for (var i = 0; i < items.length; i++) {
        for (var m = 0; m < items[i].list.length; m++) items[i].list[m].renderOrder = order++;
      }
    },

    setMode2d: function (on) {
      this.mode2d = on;
      this.controls.enabled = !on;
      if (this.win) {
        if (on) this.update2dCamera();
        else { this.camera.up.set(0, 0, 1); this.home(); }
        this.rebuildDecor();
      }
      this._needsRender = true;
    },

    // the ortho frustum IS the window: world units map 1:1 onto the screen
    update2dCamera: function () {
      var w = this.win, c = this.camera2d;
      var cx = (w.xmin + w.xmax) / 2, cy = (w.ymin + w.ymax) / 2;
      // Frustum is symmetric about the camera position (the window center);
      // the camera then sits at that center. Using absolute bounds here AND a
      // centered position would offset the view twice — fine at the origin,
      // but shifts everything once the window is panned off-centre.
      var hx = (w.xmax - w.xmin) / 2, hy = (w.ymax - w.ymin) / 2;
      c.left = -hx; c.right = hx; c.top = hy; c.bottom = -hy;
      c.position.set(cx, cy, 100);
      c.lookAt(cx, cy, 0);
      c.updateProjectionMatrix();
      this._needsRender = true;
    },

    setTheme: function (name) {
      var T = this.theme = P.THEMES[name] || P.THEMES.light;
      P.geom.clearSpriteCache();
      this.renderer.setClearColor(T.fog, 1);
      this._hemi.color.setHex(T.hemiSky);
      this._hemi.groundColor.setHex(T.hemiGround);
      this._hemi.intensity = T.hemiInt;
      this._dl1.intensity = T.dl1;
      this._dl2.intensity = T.dl2;
      if (this.win) this.rebuildDecor();
      this._needsRender = true;
    },

    setWindow: function (win, plotWin2d) {
      this.win = win;
      this.plotWin2d = plotWin2d || null;
      var cx = (win.xmin + win.xmax) / 2, cy = (win.ymin + win.ymax) / 2, cz = (win.zmin + win.zmax) / 2;
      this.center = new THREE.Vector3(cx, cy, cz);
      this.controls.target.copy(this.center);
      if (this.mode2d) this.update2dCamera();
      this.rebuildDecor();
    },

    home: function () {
      if (this.mode2d) { this.update2dCamera(); return; }
      this._needsRender = true;
      var d = this.win.diag;
      this.camera.position.set(
        this.center.x + d * 0.85,
        this.center.y - d * 1.05,
        this.center.z + d * 0.65);
      this.controls.target.copy(this.center);
      this.camera.lookAt(this.center);
    },

    zoomBy: function (f) {
      var v = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
      v.multiplyScalar(f);
      this.camera.position.copy(this.controls.target).add(v);
      this._needsRender = true;
    },

    // scale camera distance about the target so window rescaling keeps the framing
    scaleView: function (f) {
      this.zoomBy(f);
    },


    // cheap live scaling of the existing axes/grid/box during zoom gestures
    // (tick label values lag until the real rebuild at gesture end)
    scaleDecor: function (f) {
      this._decorScale = (this._decorScale || 1) * f;
      var s = this._decorScale, c = this.center;
      this.decor.scale.setScalar(s);
      this.decor.position.set(c.x * (1 - s), c.y * (1 - s), c.z * (1 - s));
      this._needsRender = true;
    },

    rebuildDecor: function () {
      var win = this.win, self = this;
      this._needsRender = true;
      this._decorScale = 1;
      this.decor.scale.setScalar(1);
      this.decor.position.set(0, 0, 0);
      while (this.decor.children.length) {
        var dc = this.decor.children[0];
        dc.traverse(function (o) {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            if (o.material.map && !o.material.map._shared) o.material.map.dispose();
            o.material.dispose();
          }
        });
        this.decor.remove(dc);
      }
      var d = win.diag;
      var T = this.theme;
      this.scene.fog = this.mode2d ? null : new THREE.Fog(T.fog, d * 1.6, d * 4.5);

      function line(pts, color, opacity) {
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
        var mat = new THREE.LineBasicMaterial({ color: color, transparent: opacity < 1, opacity: opacity });
        return new THREE.LineSegments(geo, mat);
      }

      if (this.mode2d) {
        this.build2dDecor(line);
        return;
      }

      if (this.showGrid) {
        var pts = [];
        var sx = niceStep(win.xmax - win.xmin), sy = niceStep(win.ymax - win.ymin);
        // zero lines coincide with the axes; drawing both makes them z-fight
        var yAxisDrawn = this.showAxes && win.ymin <= 0 && win.ymax >= 0;
        var xAxisDrawn = this.showAxes && win.xmin <= 0 && win.xmax >= 0;
        for (var gx = Math.ceil(win.xmin / sx) * sx; gx <= win.xmax + 1e-9; gx += sx) {
          if (yAxisDrawn && Math.abs(gx) < sx * 0.001) continue;
          pts.push(gx, win.ymin, 0, gx, win.ymax, 0);
        }
        for (var gy = Math.ceil(win.ymin / sy) * sy; gy <= win.ymax + 1e-9; gy += sy) {
          if (xAxisDrawn && Math.abs(gy) < sy * 0.001) continue;
          pts.push(win.xmin, gy, 0, win.xmax, gy, 0);
        }
        if (win.zmin <= 0 && win.zmax >= 0) this.decor.add(line(pts, T.grid, 1));
      }

      if (this.showBox && !this.mode2d) {
        var bg = new THREE.BoxGeometry(win.xmax - win.xmin, win.ymax - win.ymin, win.zmax - win.zmin);
        var edges = new THREE.LineSegments(new THREE.EdgesGeometry(bg),
          new THREE.LineBasicMaterial({ color: T.box }));
        edges.position.copy(this.center);
        this.decor.add(edges);
      }

      if (this.showAxes) {
        var axInfo = [
          { dir: [1, 0, 0], min: win.xmin, max: win.xmax, label: 'x', tickDir: [0, 1, 0] },
          { dir: [0, 1, 0], min: win.ymin, max: win.ymax, label: 'y', tickDir: [1, 0, 0] },
          { dir: [0, 0, 1], min: win.zmin, max: win.zmax, label: 'z', tickDir: [1, 0, 0] }
        ];
        if (this.mode2d) axInfo = axInfo.slice(0, 2);
        var tickLen = d * 0.008;
        axInfo.forEach(function (ax) {
          if (ax.min > 0 || ax.max < 0) return; // axis line only if it passes through window
          var over = (ax.max - ax.min) * 0.06;
          var a = ax.dir.map(function (c) { return c * (ax.min - over * 0); });
          var b = ax.dir.map(function (c) { return c * (ax.max + over); });
          self.decor.add(line([a[0], a[1], a[2], b[0], b[1], b[2]], T.axis, 1));
          // arrow head
          var head = new THREE.Mesh(new THREE.ConeGeometry(d * 0.008, d * 0.028, 10),
            new THREE.MeshBasicMaterial({ color: T.axis }));
          head.position.set(b[0], b[1], b[2]);
          head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(ax.dir[0], ax.dir[1], ax.dir[2]));
          self.decor.add(head);
          // axis letter
          var lab = P.geom.textSprite(ax.label, { color: T.label, worldH: d * 0.034, italic: true, haloColor: T.halo });
          lab.position.set(b[0] + ax.dir[0] * d * 0.035, b[1] + ax.dir[1] * d * 0.035, b[2] + ax.dir[2] * d * 0.035);
          self.decor.add(lab);
          // ticks + numbers
          var step = niceStep(ax.max - ax.min);
          var tickPts = [];
          for (var t = Math.ceil(ax.min / step) * step; t <= ax.max + 1e-9; t += step) {
            if (Math.abs(t) < step / 2) continue;
            var p = ax.dir.map(function (c) { return c * t; });
            tickPts.push(
              p[0] - ax.tickDir[0] * tickLen, p[1] - ax.tickDir[1] * tickLen, p[2] - ax.tickDir[2] * tickLen,
              p[0] + ax.tickDir[0] * tickLen, p[1] + ax.tickDir[1] * tickLen, p[2] + ax.tickDir[2] * tickLen);
            var num = P.geom.textSprite(fmtTick(t), { color: T.tick, worldH: d * 0.022, serif: true, haloColor: T.halo });
            num.position.set(
              p[0] + ax.tickDir[0] * d * 0.03,
              p[1] + ax.tickDir[1] * d * 0.03,
              p[2] + ax.tickDir[2] * d * 0.03 - (ax.label !== 'z' ? d * 0.012 : 0));
            self.decor.add(num);
          }
          self.decor.add(line(tickPts, T.axis, 1));
        });
      }
    },

    // flat Desmos-style plane over the OVERSCAN region: grid and labels stay
    // put while the camera pans, and are re-centered when the gesture settles
    build2dDecor: function (line) {
      var win = this.win, T = this.theme;
      var pw = this.plotWin2d || win;
      var xr = win.xmax - win.xmin, yr = win.ymax - win.ymin;
      var step = niceStep(yr); // spacing from the VISIBLE zoom level
      var minor = step / 5;
      var minorPts = [], majorPts = [];
      var g0;
      if (this.showGrid) {
        for (g0 = Math.ceil(pw.xmin / minor) * minor; g0 <= pw.xmax + 1e-9; g0 += minor) {
          var isMaj = Math.abs(g0 / step - Math.round(g0 / step)) < 1e-6;
          (isMaj ? majorPts : minorPts).push(g0, pw.ymin, 0, g0, pw.ymax, 0);
        }
        for (g0 = Math.ceil(pw.ymin / minor) * minor; g0 <= pw.ymax + 1e-9; g0 += minor) {
          var isMaj2 = Math.abs(g0 / step - Math.round(g0 / step)) < 1e-6;
          (isMaj2 ? majorPts : minorPts).push(pw.xmin, g0, 0, pw.xmax, g0, 0);
        }
        this.decor.add(line(minorPts, T.grid, 0.45));
        this.decor.add(line(majorPts, T.grid, 1));
      }
      if (!this.showAxes) return;
      if (pw.ymin <= 0 && pw.ymax >= 0) this.decor.add(line([pw.xmin, 0, 0, pw.xmax, 0, 0], T.axis, 1));
      if (pw.xmin <= 0 && pw.xmax >= 0) this.decor.add(line([0, pw.ymin, 0, 0, pw.ymax, 0], T.axis, 1));
      // numbers at majors across the overscan, pinned near the axes
      var wh = yr * 0.023;
      var ay = Math.max(win.ymin + yr * 0.03, Math.min(win.ymax - yr * 0.03, 0));
      var ax = Math.max(win.xmin + xr * 0.02, Math.min(win.xmax - xr * 0.02, 0));
      for (g0 = Math.ceil(pw.xmin / step) * step; g0 <= pw.xmax + 1e-9; g0 += step) {
        if (Math.abs(g0) < step / 2) continue;
        var nx = P.geom.textSprite(fmtTick(g0), { color: T.tick, worldH: wh, serif: true, haloColor: T.halo });
        nx.position.set(g0, ay - yr * 0.022, 0.01);
        this.decor.add(nx);
      }
      for (g0 = Math.ceil(pw.ymin / step) * step; g0 <= pw.ymax + 1e-9; g0 += step) {
        if (Math.abs(g0) < step / 2) continue;
        var ny = P.geom.textSprite(fmtTick(g0), { color: T.tick, worldH: wh, serif: true, haloColor: T.halo });
        ny.position.set(ax - xr * 0.016, g0, 0.01);
        this.decor.add(ny);
      }
    },

    setObject: function (id, obj) {
      var isNew = !this.objects[id];
      this.removeObject(id);
      if (obj) {
        this.objects[id] = obj;
        this.plots.add(obj);
        if (isNew && !P.reducedMotion) this._pops.push({ obj: obj, t0: performance.now() });
      }
      this._needsRender = true;
    },
    removeObject: function (id) {
      var old = this.objects[id];
      this._needsRender = true;
      if (old) {
        this.plots.remove(old);
        old.traverse(function (o) {
          if (o.isInstancedMesh) o.dispose(); // frees instanceMatrix GL buffers
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            if (o.material.map && !o.material.map._shared) o.material.map.dispose();
            o.material.dispose();
          }
        });
        delete this.objects[id];
      }
    },
    setVisible: function (id, on) {
      if (this.objects[id]) this.objects[id].visible = on;
      this._needsRender = true;
    },

    /* focus dimming: focused row's object full strength, others faded */
    focus: function (id) {
      this._needsRender = true;
      var objs = this.objects;
      Object.keys(objs).forEach(function (key) {
        objs[key].traverse(function (o) {
          if (!o.material || o.material._noDim) return;
          if (o.material._baseOpacity === undefined) {
            o.material._baseOpacity = o.material.opacity;
            o.material._baseTransparent = o.material.transparent;
          }
          if (key === id) {
            o.material.opacity = o.material._baseOpacity;
            o.material.transparent = o.material._baseTransparent;
          } else {
            o.material.opacity = o.material._baseOpacity * 0.35;
            o.material.transparent = true;
          }
        });
      });
    },
    unfocus: function () {
      this._needsRender = true;
      Object.keys(this.objects).forEach(function (key) {
        this.objects[key].traverse(function (o) {
          if (!o.material || o.material._baseOpacity === undefined) return;
          o.material.opacity = o.material._baseOpacity;
          o.material.transparent = o.material._baseTransparent;
        });
      }, this);
    }
  };
})();
