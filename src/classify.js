/* classify.js — statement AST + env → typed plot spec.
 *
 * Spec types:
 *   empty | slider | constdef | namedPoint | definition (may carry .render)
 *   graph {axis, mode}    z=f(x,y), x=f(y,z), y=f(x,z), z=f(r,θ)
 *   cyl                   r = f(θ, z)
 *   thetaSurf             θ = c (half-plane) or θ = f(r,z)
 *   sph                   ρ = f(φ, θ)
 *   phiSurf               φ = c (cone) or φ = f(ρ,θ)
 *   implicit | region     F(x,y,z) ⋛ 0  (cyl/sph vars substituted)
 *   curve {expr}          (x(t), y(t), z(t))
 *   psurf {expr}          (x(u,v), y(u,v), z(u,v))
 *   point | vector | vfield | constExpr
 *   error {message, addSliders}
 */
(function () {
  'use strict';
  var P = window.P = window.P || {};

  var RESERVED = new Set(['x', 'y', 'z', 'r', 'theta', 'rho', 'phi', 't', 'u', 'v', 'e', 'pi']);
  var COORD_ALL = new Set(['x', 'y', 'z', 'r', 'theta', 'rho', 'phi']);
  P.RESERVED = RESERVED;

  function subset(set, allowed) {
    for (var v of set) if (allowed.indexOf(v) === -1) return false;
    return true;
  }
  function errorSpec(message, free) {
    // offer "add slider" for unknown non-coordinate names
    var sliders = [];
    if (free) for (var v of free) if (!COORD_ALL.has(v) && !RESERVED.has(v)) sliders.push(v);
    return { type: 'error', message: message, addSliders: sliders };
  }
  function unknownVarsSpec(free) {
    var names = [];
    for (var v of free) names.push(P.prettyName(v));
    return errorSpec('unknown variable' + (names.length > 1 ? 's' : '') + ': ' + names.join(', '), free);
  }
  function isNumberLiteral(node) {
    return node.t === 'num' || (node.t === 'neg' && node.a.t === 'num');
  }

  function diff(a, b) { return { t: 'bin', op: '-', a: a, b: b }; }

  // an inequality "a op b" as a constraint that holds where the returned
  // expression is ≤ 0 (regions live in F ≤ 0 form, like classifyInequality)
  function ineqF(a, b, op) {
    if (containsTuple(a) || containsTuple(b)) throw new Error('points cannot appear in a bound');
    return (op === '<' || op === '<=') ? diff(a, b) : diff(b, a);
  }
  // a bound statement (a single inequality, or a chained one like a < x < b)
  // → the list of constraint expressions it imposes. Shared by chained-
  // inequality rows and the region object's bound fields.
  P.regionConstraints = function (stmt) {
    if (stmt.kind === 'chain') {
      var cs = [];
      for (var i = 0; i < stmt.ops.length; i++) {
        if (stmt.ops[i] === '=') throw new Error('use < or > in a bound, not =');
        cs.push(ineqF(stmt.terms[i], stmt.terms[i + 1], stmt.ops[i]));
      }
      return cs;
    }
    if (stmt.kind === 'rel' && stmt.op !== '=') return [ineqF(stmt.lhs, stmt.rhs, stmt.op)];
    throw new Error('each bound must be an inequality, e.g. -2 < x < 2');
  };
  // combine constraints into one field F where F ≤ 0 ⇔ all constraints hold
  P.regionF = function (nodes) {
    return nodes.length === 1 ? nodes[0] : { t: 'call', name: 'max', args: nodes };
  };
  // one region-bound text → its constraint list (or null when empty). Bounds
  // come from MathQuill as LaTeX, but legacy saves and hand-typed text may
  // use plain <= / >= or the unicode signs — normalize before parsing.
  P.parseBound = function (str) {
    str = (str || '').trim();
    if (!str) return null;
    str = str.replace(/<=/g, '\\le ').replace(/>=/g, '\\ge ')
             .replace(/≤/g, '\\le ').replace(/≥/g, '\\ge ');
    return P.regionConstraints(P.parse(str));
  };

  P.classify = function (stmt, env) {
    if (stmt.kind === 'empty') return { type: 'empty' };
    if (stmt.kind === 'intersection') return { type: 'intersect' };
    if (stmt.kind === 'region') return { type: 'region3' };

    if (stmt.kind === 'expr') return classifyExpr(stmt.expr, env);

    // chained inequality (3 < x < 5, or x² < z < 4) → a solid region
    if (stmt.kind === 'chain') {
      var cs;
      try { cs = P.regionConstraints(stmt); } catch (e) { return errorSpec(e.message); }
      var Fchain = P.regionF(cs);
      var chFree = P.freeVars(Fchain, env, new Set());
      if (!subset(chFree, ['x', 'y', 'z', 'r', 'theta', 'rho', 'phi'])) return unknownVarsSpec(chFree);
      // parts drive per-constraint normals (crisp creases); strict controls
      // the dashed boundary in the 2D fill
      return { type: 'region', F: Fchain, parts: cs,
               strict: stmt.ops.every(function (o) { return o === '<' || o === '>'; }) };
    }

    // relations
    var lhs = stmt.lhs, rhs = stmt.rhs, op = stmt.op;

    if (op !== '=') return classifyInequality(lhs, rhs, op, env);

    // f(x,…) = body  → definition
    if (lhs.t === 'apply' && lhs.args.every(function (a) { return a.t === 'var'; })) {
      return classifyDefinition(lhs, rhs, env);
    }

    // v = body → solved forms
    if (lhs.t === 'var') {
      var v = lhs.name;
      var free = P.freeVars(rhs, env, new Set());
      var unknown = new Set([...free].filter(function (n) { return !COORD_ALL.has(n) && !RESERVED.has(n); }));
      if (unknown.size && v !== 'e') {
        // could still be a constant definition chain — but these names are genuinely unknown
        if (!COORD_ALL.has(v) && !RESERVED.has(v)) return unknownVarsSpec(unknown);
        return unknownVarsSpec(unknown);
      }

      switch (v) {
        case 'z':
          if (subset(free, ['x', 'y'])) return { type: 'graph', axis: 'z', mode: 'cart', expr: rhs };
          if (subset(free, ['r', 'theta'])) return { type: 'graph', axis: 'z', mode: 'polar', expr: rhs };
          break;
        case 'x':
          if (subset(free, ['y', 'z'])) return { type: 'graph', axis: 'x', mode: 'cart', expr: rhs };
          break;
        case 'y':
          if (subset(free, ['x', 'z'])) return { type: 'graph', axis: 'y', mode: 'cart', expr: rhs };
          break;
        case 'r':
          if (subset(free, ['theta', 'z'])) return { type: 'cyl', expr: rhs };
          break;
        case 'theta':
          if (subset(free, ['r', 'z'])) return { type: 'thetaSurf', expr: rhs, isConst: free.size === 0 };
          break;
        case 'rho':
          if (subset(free, ['phi', 'theta'])) return { type: 'sph', expr: rhs };
          break;
        case 'phi':
          if (subset(free, ['rho', 'theta'])) return { type: 'phiSurf', expr: rhs, isConst: free.size === 0 };
          break;
        case 't': case 'u': case 'v':
          return errorSpec('"' + v + '" is reserved as a parameter. Pick another letter');
        case 'e':
          return errorSpec('"e" is Euler\u2019s number. Pick another letter');
        default: {
          // plain name = … → point / slider / constant
          if (rhs.t === 'tuple') {
            var tfree = P.freeVars(rhs, env, new Set());
            if (tfree.size === 0) return { type: 'namedPoint', name: v, expr: rhs };
            if (subset(tfree, ['t'])) return { type: 'curve', expr: rhs };
            if (subset(tfree, ['u', 'v'])) return { type: 'psurf', expr: rhs };
            return unknownVarsSpec(tfree);
          }
          // alias of another point (Q = P) or of a point-valued function call
          if (rhs.t === 'var' && env.constVals && Array.isArray(env.constVals[rhs.name]))
            return { type: 'namedPoint', name: v, expr: rhs };
          if (rhs.t === 'apply' && env.funcs[rhs.head] && env.funcs[rhs.head].isTuple && free.size === 0)
            return { type: 'namedPoint', name: v, expr: rhs };
          if (free.size === 0) {
            if (isNumberLiteral(rhs)) {
              return { type: 'slider', name: v, value: rhs.t === 'neg' ? -rhs.a.v : rhs.v };
            }
            return { type: 'constdef', name: v, expr: rhs };
          }
          return errorSpec('the right side uses ' +
            [...free].map(P.prettyName).join(', ') +
            '. For a surface write z = \u2026, for a constant use only numbers and sliders', free);
        }
      }
      // fell through a coordinate case → implicit
      return classifyImplicit(lhs, rhs, env);
    }

    // anything = anything → implicit surface
    return classifyImplicit(lhs, rhs, env);
  };

  function classifyDefinition(lhs, rhs, env) {
    var head = lhs.head;
    if (RESERVED.has(head)) return errorSpec('"' + P.prettyName(head) + '" cannot be used as a function name');
    var params = lhs.args.map(function (a) { return a.name; });
    var uniq = new Set(params);
    if (uniq.size !== params.length) return errorSpec('repeated parameter in ' + P.prettyName(head) + '(…)');
    var free = P.freeVars(rhs, env, uniq);
    if (free.size) return unknownVarsSpec(free);
    var isTuple = rhs.t === 'tuple';
    if (isTuple && rhs.items.length !== 3 && rhs.items.length !== 2)
      return errorSpec('a vector-valued function needs 2 or 3 components');

    var render = null;
    var key = params.join(',');
    if (isTuple) {
      if (key === 't') render = { type: 'curve', expr: rhs };
      else if (key === 'u,v' && rhs.items.length === 3) render = { type: 'psurf', expr: rhs };
      else if (key === 'x,y,z' || key === 'x,y') render = { type: 'vfield', params: params, expr: rhs };
    } else {
      if (key === 'x,y') render = { type: 'graph', axis: 'z', mode: 'cart', expr: rhs };
      else if (key === 'r,theta' || key === 'theta,r') render = { type: 'graph', axis: 'z', mode: 'polar', expr: rhs };
    }
    return { type: 'definition', name: head, params: params, body: rhs, isTuple: isTuple, render: render };
  }

  function classifyImplicit(lhs, rhs, env) {
    var F = diff(lhs, rhs);
    var free = P.freeVars(F, env, new Set());
    if (!subset(free, ['x', 'y', 'z', 'r', 'theta', 'rho', 'phi'])) return unknownVarsSpec(free);
    if (containsTuple(lhs) || containsTuple(rhs))
      return errorSpec('points cannot appear in an equation');
    return { type: 'implicit', F: F };
  }

  function classifyInequality(lhs, rhs, op, env) {
    if (containsTuple(lhs) || containsTuple(rhs))
      return errorSpec('points cannot appear in an inequality');
    var F = (op === '<' || op === '<=') ? diff(lhs, rhs) : diff(rhs, lhs); // region is F ≤ 0
    var free = P.freeVars(F, env, new Set());
    if (!subset(free, ['x', 'y', 'z', 'r', 'theta', 'rho', 'phi'])) return unknownVarsSpec(free);
    return { type: 'region', F: F, strict: op === '<' || op === '>' };
  }

  function classifyExpr(expr, env) {
    // vector(A) / vector(A, B)
    if (expr.t === 'call' && expr.name === 'vector') {
      if (expr.args.length < 1 || expr.args.length > 2)
        return errorSpec('vector takes (tip) or (tail, tip)');
      return { type: 'vector', args: expr.args };
    }
    if (expr.t === 'tuple') {
      var nItems = expr.items.length;
      if (nItems !== 3 && nItems !== 2)
        return errorSpec('points need 2 or 3 coordinates');
      var free = P.freeVars(expr, env, new Set());
      if (free.size === 0) return { type: 'point', expr: expr };
      if (subset(free, ['t'])) return { type: 'curve', expr: expr };
      if (nItems === 2) {
        // 2-component tuples live in the xy-plane
        if (subset(free, ['x', 'y'])) return { type: 'vfield', params: ['x', 'y'], expr: expr };
        return unknownVarsSpec(free);
      }
      if (subset(free, ['u', 'v'])) return { type: 'psurf', expr: expr };
      if (subset(free, ['x', 'y', 'z'])) return { type: 'vfield', params: ['x', 'y', 'z'], expr: expr };
      if (subset(free, ['t', 'u', 'v']))
        return errorSpec('use t for curves, or u and v for surfaces, not both');
      return unknownVarsSpec(free);
    }
    // tuple-valued user function reference, e.g. c(t) where c(t)=(…)
    if (expr.t === 'apply' && env.funcs[expr.head] && env.funcs[expr.head].isTuple) {
      var afree = P.freeVars(expr, env, new Set());
      if (afree.size === 0) return { type: 'point', expr: expr };
      if (subset(afree, ['t'])) return { type: 'curve', expr: expr };
      if (subset(afree, ['u', 'v'])) return { type: 'psurf', expr: expr };
      return unknownVarsSpec(afree);
    }
    // bare scalar
    var sfree = P.freeVars(expr, env, new Set());
    if (sfree.size === 0) return { type: 'constExpr', expr: expr };
    if (subset(sfree, ['x', 'y'])) return { type: 'graph', axis: 'z', mode: 'cart', expr: expr };
    if (subset(sfree, ['r', 'theta'])) return { type: 'graph', axis: 'z', mode: 'polar', expr: expr };
    if (subset(sfree, ['x', 'y', 'z', 'r', 'theta', 'rho', 'phi']))
      return errorSpec('write an equation (e.g. z = …) or inequality to plot this');
    return unknownVarsSpec(sfree);
  }

  function containsTuple(node) {
    if (!node) return false;
    if (node.t === 'tuple') return true;
    if (node.t === 'bin') return containsTuple(node.a) || containsTuple(node.b);
    if (node.t === 'neg' || node.t === 'abs') return containsTuple(node.a);
    if (node.t === 'call' || node.t === 'apply') return node.args.some(containsTuple);
    return false;
  }
})();
