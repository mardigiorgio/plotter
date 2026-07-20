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
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor(0x000000, 0); // CSS gradient shows through
    container.appendChild(this.renderer.domElement);

    this.theme = P.THEMES.light;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 4000);
    this.camera.up.set(0, 0, 1);

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
    // the wheel zooms the WINDOW (axis ranges), not the camera; see onWheelZoom
    this.controls.enableZoom = false;
    this.renderer.domElement.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      if (self.onWheelZoom) self.onWheelZoom(Math.exp(ev.deltaY * 0.0012));
    }, { passive: false });

    this.showAxes = true; this.showGrid = true; this.showBox = true;

    this.resize = function () {
      var w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      self.renderer.setSize(w, h);
      self.camera.aspect = w / h;
      self.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', this.resize);
    if (window.ResizeObserver) new ResizeObserver(this.resize).observe(container);

    var loop = function () {
      requestAnimationFrame(loop);
      self.controls.update();
      if (self._pops.length) {
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
      self.renderer.render(self.scene, self.camera);
    };
    this.resize();
    loop();
  };

  P.Viewport.prototype = {
    setTheme: function (name) {
      var T = this.theme = P.THEMES[name] || P.THEMES.light;
      this._hemi.color.setHex(T.hemiSky);
      this._hemi.groundColor.setHex(T.hemiGround);
      this._hemi.intensity = T.hemiInt;
      this._dl1.intensity = T.dl1;
      this._dl2.intensity = T.dl2;
      if (this.win) this.rebuildDecor();
    },

    setWindow: function (win) {
      this.win = win;
      var cx = (win.xmin + win.xmax) / 2, cy = (win.ymin + win.ymax) / 2, cz = (win.zmin + win.zmax) / 2;
      this.center = new THREE.Vector3(cx, cy, cz);
      this.controls.target.copy(this.center);
      this.rebuildDecor();
    },

    home: function () {
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
    },

    rebuildDecor: function () {
      var win = this.win, self = this;
      this._decorScale = 1;
      this.decor.scale.setScalar(1);
      this.decor.position.set(0, 0, 0);
      while (this.decor.children.length) {
        var dc = this.decor.children[0];
        dc.traverse(function (o) {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            if (o.material.map) o.material.map.dispose();
            o.material.dispose();
          }
        });
        this.decor.remove(dc);
      }
      var d = win.diag;
      var T = this.theme;
      this.scene.fog = new THREE.Fog(T.fog, d * 1.6, d * 4.5);

      function line(pts, color, opacity) {
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
        var mat = new THREE.LineBasicMaterial({ color: color, transparent: opacity < 1, opacity: opacity });
        return new THREE.LineSegments(geo, mat);
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

      if (this.showBox) {
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

    setObject: function (id, obj) {
      var isNew = !this.objects[id];
      this.removeObject(id);
      if (obj) {
        this.objects[id] = obj;
        this.plots.add(obj);
        if (isNew && !P.reducedMotion) this._pops.push({ obj: obj, t0: performance.now() });
      }
    },
    removeObject: function (id) {
      var old = this.objects[id];
      if (old) {
        this.plots.remove(old);
        old.traverse(function (o) {
          if (o.isInstancedMesh) o.dispose(); // frees instanceMatrix GL buffers
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            if (o.material.map) o.material.map.dispose();
            o.material.dispose();
          }
        });
        delete this.objects[id];
      }
    },
    setVisible: function (id, on) {
      if (this.objects[id]) this.objects[id].visible = on;
    },

    /* focus dimming: focused row's object full strength, others faded */
    focus: function (id) {
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
