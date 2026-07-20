/* compile.js — AST → JS closures; free-variable analysis; coordinate substitution.
 *
 * env shape (built in main.js):
 *   env.constVals : { name: number | [x,y,z] }   — live-mutated on slider drag
 *   env.funcs     : { name: {params:[...], body:AST} }
 *   env.funcJS    : { name: compiled function }
 */
(function () {
  'use strict';
  var P = window.P = window.P || {};

  var RT = {
    sec: function (x) { return 1 / Math.cos(x); },
    csc: function (x) { return 1 / Math.sin(x); },
    cot: function (x) { return Math.cos(x) / Math.sin(x); },
    nthroot: function (x, n) {
      if (x < 0 && Math.abs(n % 2) === 1) return -Math.pow(-x, 1 / n);
      return Math.pow(x, 1 / n);
    },
    logb: function (x, b) { return Math.log(x) / Math.log(b); },
    mod: function (a, b) { return ((a % b) + b) % b; },
    // real-root semantics: (-8)^(1/3) = -2, matching nthroot (Desmos behavior)
    pow: function (x, p) {
      if (x >= 0 || !isFinite(p) || Number.isInteger(p)) return Math.pow(x, p);
      for (var q = 3; q <= 25; q += 2) {
        var pq = p * q;
        if (Math.abs(pq - Math.round(pq)) < 1e-9) {
          return (Math.round(pq) % 2 === 0 ? 1 : -1) * Math.pow(-x, p);
        }
      }
      return Math.pow(x, p);
    },
    phiOf: function (x, y, z) {
      var r = Math.sqrt(x * x + y * y + z * z);
      return r === 0 ? 0 : Math.acos(Math.max(-1, Math.min(1, z / r)));
    }
  };
  P.RT = RT;

  var CALLMAP = {
    sin: 'Math.sin', cos: 'Math.cos', tan: 'Math.tan',
    asin: 'Math.asin', acos: 'Math.acos', atan: 'Math.atan',
    arcsin: 'Math.asin', arccos: 'Math.acos', arctan: 'Math.atan',
    sinh: 'Math.sinh', cosh: 'Math.cosh', tanh: 'Math.tanh',
    asinh: 'Math.asinh', acosh: 'Math.acosh', atanh: 'Math.atanh',
    sec: '__RT.sec', csc: '__RT.csc', cot: '__RT.cot',
    ln: 'Math.log', log: 'Math.log10', exp: 'Math.exp',
    abs: 'Math.abs', sqrt: 'Math.sqrt', cbrt: 'Math.cbrt',
    nthroot: '__RT.nthroot', logb: '__RT.logb',
    floor: 'Math.floor', ceil: 'Math.ceil', round: 'Math.round', sign: 'Math.sign',
    min: 'Math.min', max: 'Math.max', mod: '__RT.mod', atan2: 'Math.atan2'
  };
  var ARITY = { // fixed arities where they matter (null = variadic ≥1)
    nthroot: 2, logb: 2, mod: 2, atan2: 2, min: null, max: null
  };

  function cErr(msg) { var e = new Error(msg); e.isCompile = true; throw e; }

  /* ---- free variables (vars not bound by params, env, or built-in constants) ---- */
  P.freeVars = function (node, env, bound) {
    var free = new Set();
    bound = bound || new Set();
    (function walk(n) {
      if (!n) return;
      switch (n.t) {
        case 'num': case 'const': return;
        case 'var':
          if (bound.has(n.name)) return;
          if (env.constVals && Object.prototype.hasOwnProperty.call(env.constVals, n.name)) return;
          if (n.name === 'e') return;
          free.add(n.name);
          return;
        case 'bin': walk(n.a); walk(n.b); return;
        case 'neg': case 'abs': walk(n.a); return;
        case 'call': n.args.forEach(walk); return;
        case 'apply':
          if (!(env.funcs && env.funcs[n.head])) {
            // not a known function: if 1 arg it's implicit multiplication → head is a variable
            if (n.args.length === 1) {
              if (!bound.has(n.head) &&
                  !(env.constVals && Object.prototype.hasOwnProperty.call(env.constVals, n.head)) &&
                  n.head !== 'e') free.add(n.head);
            } else {
              free.add(n.head); // unknown function — surfaces as an error later
            }
          }
          n.args.forEach(walk);
          return;
        case 'tuple': n.items.forEach(walk); return;
      }
    })(node);
    return free;
  };

  /* names of user functions referenced (for dependency tracking) */
  P.usedFuncs = function (node, env) {
    var used = new Set();
    (function walk(n) {
      if (!n) return;
      if (n.t === 'apply' && env.funcs && env.funcs[n.head]) used.add(n.head);
      if (n.t === 'bin') { walk(n.a); walk(n.b); }
      else if (n.t === 'neg' || n.t === 'abs') walk(n.a);
      else if (n.t === 'call') n.args.forEach(walk);
      else if (n.t === 'apply') n.args.forEach(walk);
      else if (n.t === 'tuple') n.items.forEach(walk);
    })(node);
    return used;
  };

  /* names of constants (sliders) referenced */
  P.usedConsts = function (node, env) {
    var used = new Set();
    (function walk(n) {
      if (!n) return;
      if ((n.t === 'var') && env.constVals && Object.prototype.hasOwnProperty.call(env.constVals, n.name)) used.add(n.name);
      if (n.t === 'apply' && !(env.funcs && env.funcs[n.head]) &&
          env.constVals && Object.prototype.hasOwnProperty.call(env.constVals, n.head)) used.add(n.head);
      if (n.t === 'bin') { walk(n.a); walk(n.b); }
      else if (n.t === 'neg' || n.t === 'abs') walk(n.a);
      else if (n.t === 'call' || n.t === 'apply') n.args.forEach(walk);
      else if (n.t === 'tuple') n.items.forEach(walk);
    })(node);
    return used;
  };

  /* ---- code generation ---- */
  function gen(node, ctx) {
    switch (node.t) {
      case 'num':
        return node.v === Infinity ? 'Infinity' : String(node.v);
      case 'const':
        return node.name === 'pi' ? 'Math.PI' : 'Math.E';
      case 'var': {
        var name = node.name;
        if (ctx.params.has(name)) return '_' + name;
        if (ctx.subst && ctx.subst[name]) return ctx.subst[name];
        if (Object.prototype.hasOwnProperty.call(ctx.env.constVals, name)) {
          if (Array.isArray(ctx.env.constVals[name]))
            cErr(P.prettyName(name) + ' is a point, so it cannot be used inside a number expression');
          return '__C[' + JSON.stringify(name) + ']';
        }
        if (name === 'e') return 'Math.E';
        cErr('unknown variable "' + P.prettyName(name) + '"');
      }
      case 'bin': {
        var a = gen(node.a, ctx), b = gen(node.b, ctx);
        switch (node.op) {
          case '+': return '(' + a + '+' + b + ')';
          case '-': return '(' + a + '-' + b + ')';
          case '*': return '(' + a + '*' + b + ')';
          case '/': return '(' + a + '/' + b + ')';
          case '^': return '__RT.pow(' + a + ',' + b + ')';
        }
        cErr('bad operator');
      }
      case 'neg': return '(-' + gen(node.a, ctx) + ')';
      case 'abs': return 'Math.abs(' + gen(node.a, ctx) + ')';
      case 'call': {
        if (node.name === 'vector') cErr('vector(…) can only be used on its own row');
        var f = CALLMAP[node.name];
        if (!f) cErr('unsupported function ' + node.name);
        var ar = ARITY[node.name];
        if (ar === undefined) ar = 1;
        if (ar !== null && node.args.length !== ar) cErr(node.name + ' expects ' + ar + ' argument' + (ar > 1 ? 's' : ''));
        if (ar === null && node.args.length < 1) cErr(node.name + ' needs arguments');
        return f + '(' + node.args.map(function (x) { return gen(x, ctx); }).join(',') + ')';
      }
      case 'apply': {
        var fn = ctx.env.funcs[node.head];
        if (fn) {
          if (node.args.length !== fn.params.length)
            cErr(P.prettyName(node.head) + ' expects ' + fn.params.length + ' argument' + (fn.params.length > 1 ? 's' : ''));
          if (fn.isTuple) cErr(P.prettyName(node.head) + ' returns a point, so it cannot be used inside a number expression');
          return '__FN[' + JSON.stringify(node.head) + '](' + node.args.map(function (x) { return gen(x, ctx); }).join(',') + ')';
        }
        if (node.args.length === 1) {
          // implicit multiplication: a(b+1)
          return '(' + gen({ t: 'var', name: node.head }, ctx) + '*' + gen(node.args[0], ctx) + ')';
        }
        cErr('"' + P.prettyName(node.head) + '" is not a function');
      }
      case 'tuple': cErr('a point cannot appear inside a number expression');
    }
    cErr('bad expression');
  }

  /* substitutions to express cylindrical/spherical coords in cartesian x,y,z params */
  P.CART_SUBST = {
    r: 'Math.sqrt(_x*_x+_y*_y)',
    theta: 'Math.atan2(_y,_x)',
    rho: 'Math.sqrt(_x*_x+_y*_y+_z*_z)',
    phi: '__RT.phiOf(_x,_y,_z)'
  };

  /* Compile scalar expression → function(...params) → number.
   * opts: { subst } */
  P.makeFn = function (node, paramNames, env, opts) {
    var ctx = { params: new Set(paramNames), env: env, subst: opts && opts.subst };
    var code = gen(node, ctx);
    var args = paramNames.map(function (p) { return '_' + p; });
    var src = 'return function(' + args.join(',') + '){return ' + code + ';};';
    /* eslint-disable no-new-func */
    return new Function('__C', '__FN', '__RT', src)(env.constVals, env.funcJS, RT);
  };

  /* Compile 3-tuple expression → function(...params) → [x,y,z].
   * Accepts a tuple node, or an apply of a tuple-valued user function. */
  P.makeTupleFn = function (node, paramNames, env) {
    if (node.t === 'tuple') {
      if (node.items.length !== 3 && node.items.length !== 2) cErr('expected 2 or 3 components ( , , )');
      // one fused function: single compile, one array per call, no apply hops
      var ctx = { params: new Set(paramNames), env: env };
      var parts = node.items.map(function (item) { return gen(item, ctx); });
      if (parts.length === 2) parts.push('0'); // 2-component tuples live in the xy-plane
      var args = paramNames.map(function (p2) { return '_' + p2; });
      var src = 'return function(' + args.join(',') + '){return [' + parts.join(',') + '];};';
      /* eslint-disable no-new-func */
      return new Function('__C', '__FN', '__RT', src)(env.constVals, env.funcJS, RT);
    }
    if (node.t === 'apply' && env.funcs[node.head] && env.funcs[node.head].isTuple) {
      var fname = node.head, fdef = env.funcs[fname];
      if (node.args.length !== fdef.params.length) cErr(P.prettyName(fname) + ' expects ' + fdef.params.length + ' arguments');
      var argFns = node.args.map(function (a) { return P.makeFn(a, paramNames, env); });
      var target = env.funcJS;
      return function () {
        var args = [], i;
        for (i = 0; i < argFns.length; i++) args.push(argFns[i].apply(null, arguments));
        return target[fname].apply(null, args);
      };
    }
    cErr('expected 3 components ( , , )');
  };

  /* Evaluate a constant scalar (no free coordinate vars). */
  P.evalConst = function (node, env) {
    return P.makeFn(node, [], env)();
  };

  /* Evaluate a constant 3-tuple; vars may reference tuple-valued constants (named points). */
  P.evalTupleConst = function (node, env) {
    if (node.t === 'var' && Array.isArray(env.constVals[node.name])) {
      return env.constVals[node.name].slice();
    }
    if (node.t === 'tuple') {
      if (node.items.length !== 3 && node.items.length !== 2) cErr('a point needs 2 or 3 coordinates');
      var vals = node.items.map(function (item) { return P.evalConst(item, env); });
      if (vals.length === 2) vals.push(0);
      return vals;
    }
    if (node.t === 'apply' && env.funcs[node.head] && env.funcs[node.head].isTuple) {
      var vals = node.args.map(function (a) { return P.evalConst(a, env); });
      return env.funcJS[node.head].apply(null, vals);
    }
    cErr('expected a point (a, b, c)');
  };

  /* constant evaluator compiled once, callable many times (sliders animate) */
  P.makeTupleConstFn = function (node, env) {
    if (node.t === 'var' && Array.isArray(env.constVals[node.name])) {
      var nm = node.name;
      return function () { return env.constVals[nm].slice(); };
    }
    return P.makeTupleFn(node, [], env);
  };

  P.prettyName = function (name) {
    var g = { theta: 'θ', rho: 'ρ', phi: 'φ', tau: 'τ', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', lambda: 'λ', mu: 'μ', sigma: 'σ', omega: 'ω', epsilon: 'ε', psi: 'ψ', nu: 'ν', pi: 'π' };
    var parts = name.split('_');
    var base = g[parts[0]] || parts[0];
    return parts.length > 1 ? base + '_' + parts.slice(1).join('_') : base;
  };
})();
