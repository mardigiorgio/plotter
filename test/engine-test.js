/* engine-test.js — headless tests for parser/compile/classify, run with:
 *   ./test/run-tests.sh
 * The harness concatenates: this stub header is included via run-tests.sh.
 */
(function () {
  'use strict';
  var P = window.P;
  var passed = 0, failed = 0, failures = [];

  function ok(cond, name, detail) {
    if (cond) { passed++; }
    else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); }
  }
  function approx(a, b, name) {
    ok(isFinite(a) && Math.abs(a - b) < 1e-9, name, 'got ' + a + ' expected ' + b);
  }
  function emptyEnv() { return { constVals: {}, funcs: {}, funcJS: {} }; }
  function classifyLatex(latex, env) {
    return P.classify(P.parse(latex), env || emptyEnv());
  }
  function evalScalar(latex, params, args, env) {
    env = env || emptyEnv();
    var stmt = P.parse(latex);
    var fn = P.makeFn(stmt.expr, params, env);
    return fn.apply(null, args);
  }

  /* ---------- parser + eval ---------- */
  approx(evalScalar('2+3\\cdot 4', [], []), 14, 'precedence');
  approx(evalScalar('\\frac{1}{2}', [], []), 0.5, 'frac');
  approx(evalScalar('2^{3}', [], []), 8, 'pow');
  approx(evalScalar('-x^{2}', ['x'], [3]), -9, 'unary minus binds under power');
  approx(evalScalar('x^{2}y', ['x', 'y'], [3, 2]), 18, 'implicit mult after power');
  approx(evalScalar('2\\pi ', [], []), 2 * Math.PI, 'pi constant');
  approx(evalScalar('e^{1}', [], []), Math.E, 'e constant');
  approx(evalScalar('\\sin \\left(\\frac{\\pi }{2}\\right)', [], []), 1, 'sin parens');
  approx(evalScalar('\\sin \\frac{\\pi }{2}', [], []), 1, 'sin paren-less');
  approx(evalScalar('\\sin 2x', ['x'], [Math.PI / 4]), 1, 'sin 2x = sin(2x)');
  approx(evalScalar('\\sin x\\cos x', ['x'], [Math.PI / 2]), 0, 'sin x cos x splits');
  approx(evalScalar('\\sin ^{2}\\left(x\\right)+\\cos ^{2}\\left(x\\right)', ['x'], [0.7]), 1, 'sin²+cos²');
  approx(evalScalar('\\sin ^{-1}\\left(1\\right)', [], []), Math.PI / 2, 'sin inverse');
  approx(evalScalar('\\sqrt{9}', [], []), 3, 'sqrt');
  approx(evalScalar('\\sqrt[3]{-8}', [], []), -2, 'nthroot odd negative');
  approx(evalScalar('\\left|3-5\\right|', [], []), 2, 'abs bars');
  approx(evalScalar('\\log \\left(100\\right)', [], []), 2, 'log10');
  approx(evalScalar('\\log _{2}\\left(8\\right)', [], []), 3, 'log base 2');
  approx(evalScalar('\\ln \\left(e\\right)', [], []), 1, 'ln e');
  approx(evalScalar('\\operatorname{mod}\\left(-1,3\\right)', [], []), 2, 'mod positive result');
  approx(evalScalar('\\frac{x+1}{x-1}', ['x'], [3]), 2, 'frac with exprs');
  approx(evalScalar('x_{1}+x_{2}', ['x_1', 'x_2'], [1, 2]), 3, 'subscript vars');
  approx(evalScalar('\\theta +\\rho +\\phi ', ['theta', 'rho', 'phi'], [1, 2, 3]), 6, 'greek vars');
  approx(evalScalar('2\\left(x+1\\right)', ['x'], [2]), 6, 'juxtaposition group');
  approx(evalScalar('x\\left(x+1\\right)', ['x'], [2]), 6, 'var applied to group = mult');

  // parse errors
  var threw = false;
  try { P.parse('x+'); } catch (e) { threw = e.isParse; }
  ok(threw, 'incomplete throws parse error');
  threw = false;
  try { P.parse('\\frac{}{2}'); } catch (e) { threw = true; }
  ok(threw, 'empty numerator throws');

  /* ---------- classification ---------- */
  var env = emptyEnv();
  ok(classifyLatex('r=1').type === 'cyl', 'r=1 → cylinder');
  ok(classifyLatex('\\theta =\\frac{\\pi }{4}').type === 'thetaSurf', 'theta=pi/4 → half-plane');
  ok(classifyLatex('\\theta =\\frac{\\pi }{4}').isConst === true, 'theta const flag');
  ok(classifyLatex('\\rho =2\\cos \\left(\\phi \\right)').type === 'sph', 'rho=2cos(phi) → spherical');
  ok(classifyLatex('\\phi =\\frac{\\pi }{6}').type === 'phiSurf', 'phi=pi/6 → cone');
  ok(classifyLatex('z=\\sin \\left(x\\right)+\\cos \\left(y\\right)').type === 'graph', 'z=f(x,y) → graph');
  ok(classifyLatex('z=r^{2}').mode === 'polar', 'z=r² → polar graph');
  ok(classifyLatex('x=y^{2}+z^{2}').axis === 'x', 'x=f(y,z) → x-graph');
  ok(classifyLatex('y=x+z').axis === 'y', 'y=f(x,z) → y-graph');
  ok(classifyLatex('x^{2}+y^{2}+z^{2}=9').type === 'implicit', 'sphere implicit');
  ok(classifyLatex('r^{2}+z^{2}=1').type === 'implicit', 'cylindrical implicit fallback');
  ok(classifyLatex('z\\le 4-x^{2}-y^{2}').type === 'region', 'inequality → region');
  ok(classifyLatex('x^{2}+y^{2}\\le 1').type === 'region', '2-var inequality → region');
  ok(classifyLatex('\\left(1,2,3\\right)').type === 'point', 'constant tuple → point');
  ok(classifyLatex('\\left(\\cos \\left(t\\right),\\sin \\left(t\\right),t\\right)').type === 'curve', 'tuple in t → curve');
  ok(classifyLatex('\\left(u,v,u\\cdot v\\right)').type === 'psurf', 'tuple in u,v → parametric surface');
  ok(classifyLatex('a=1').type === 'slider', 'a=1 → slider');
  ok(classifyLatex('a=-2.5').type === 'slider', 'a=-2.5 → slider');
  ok(classifyLatex('P=\\left(1,2,3\\right)').type === 'namedPoint', 'named point');
  ok(classifyLatex('\\operatorname{vector}\\left(\\left(0,0,0\\right),\\left(1,2,2\\right)\\right)').type === 'vector', 'vector row');
  ok(classifyLatex('5').type === 'constExpr', 'bare number → value');
  ok(classifyLatex('\\sin \\left(x\\right)+y').type === 'graph', 'bare f(x,y) → graph');
  ok(classifyLatex('z=q+x').type === 'error', 'unknown var errors');
  ok(classifyLatex('z=q+x').addSliders.indexOf('q') !== -1, 'unknown var offers slider');
  ok(classifyLatex('\\left(1,2,3,4\\right)').type === 'error', '4-tuple rejected');

  var defSpec = classifyLatex('f\\left(x,y\\right)=x\\cdot y');
  ok(defSpec.type === 'definition' && defSpec.render && defSpec.render.type === 'graph', 'f(x,y) definition renders surface');
  var vfSpec = classifyLatex('F\\left(x,y,z\\right)=\\left(y,-x,0\\right)');
  ok(vfSpec.type === 'definition' && vfSpec.render && vfSpec.render.type === 'vfield', 'F(x,y,z)=tuple → vector field');
  var curveDef = classifyLatex('c\\left(t\\right)=\\left(t,t,t\\right)');
  ok(curveDef.render && curveDef.render.type === 'curve', 'c(t)=tuple renders curve');

  /* slider value flows through env */
  env = emptyEnv();
  env.constVals.a = 2;
  var spec = classifyLatex('z=a\\cdot x', env);
  ok(spec.type === 'graph', 'slider-dependent surface classifies');
  var f = P.makeFn(spec.expr, ['x', 'y'], env);
  approx(f(3, 0), 6, 'slider value in evaluation');
  env.constVals.a = 5;
  approx(f(3, 0), 15, 'live slider mutation');

  /* r = a with slider */
  env = emptyEnv(); env.constVals.a = 1.5;
  ok(classifyLatex('r=a', env).type === 'cyl', 'r=a with slider → cylinder');

  /* user function in expression */
  env = emptyEnv();
  env.funcs.f = { params: ['x'], body: P.parse('x^{2}').expr, isTuple: false };
  env.funcJS.f = P.makeFn(env.funcs.f.body, ['x'], env);
  approx(evalScalar('f\\left(3\\right)+1', [], [], env), 10, 'user function call');
  ok(classifyLatex('z=f\\left(x\\right)+y', env).type === 'graph', 'graph via user fn');

  /* implicit substitution: r=sqrt(x²+y²) */
  var impl = classifyLatex('r=z^{2}+2');  // solved-form actually → cyl; force implicit:
  ok(impl.type === 'cyl', 'r=z²+2 stays cylindrical');
  var impl2 = classifyLatex('r^{2}=z');
  ok(impl2.type === 'implicit', 'r²=z is implicit');
  var F = P.makeFn(impl2.F, ['x', 'y', 'z'], emptyEnv(), { subst: P.CART_SUBST });
  approx(F(3, 4, 25), 0, 'r² substitutes to x²+y²');

  /* rho substitution */
  var impl3 = classifyLatex('\\rho ^{2}=1');
  ok(impl3.type === 'implicit', 'rho²=1 implicit');
  var F3 = P.makeFn(impl3.F, ['x', 'y', 'z'], emptyEnv(), { subst: P.CART_SUBST });
  approx(F3(1, 0, 0), 0, 'rho substitution on unit sphere');
  approx(F3(0, 0, 2), 3, 'rho substitution off sphere');

  /* tuple const eval incl named point */
  env = emptyEnv();
  env.constVals.Q = [1, 2, 3];
  var vec = classifyLatex('\\operatorname{vector}\\left(Q,\\left(2,2,2\\right)\\right)', env);
  ok(vec.type === 'vector', 'vector with named point');
  var tip = P.evalTupleConst(vec.args[0], env);
  ok(tip[0] === 1 && tip[2] === 3, 'named point resolves in vector');

  /* nested definition arithmetic */
  approx(evalScalar('\\frac{\\sqrt{x^{2}+y^{2}}}{2}', ['x', 'y'], [3, 4]), 2.5, 'nested sqrt frac');

  /* ---------- review-workflow regression fixes ---------- */
  // MathQuill emits unbraced single-char scripts: x^23 means x²·3
  approx(evalScalar('x^23', ['x'], [2]), 12, 'unbraced exponent takes one digit');
  approx(evalScalar('\\log _25x', ['x'], [2]), Math.log2(10), 'unbraced log base takes one digit');
  approx(evalScalar('x_12', ['x_1'], [5]), 10, 'unbraced subscript takes one digit');
  // leading zeros in subscripts stay distinct
  ok(P.parse('a_{01}').expr.name === 'a_01', 'a_{01} keeps leading zero');
  ok(P.parse('a_{01}').expr.name !== P.parse('a_{1}').expr.name, 'a_01 distinct from a_1');
  // real odd roots via ^ match nthroot
  approx(evalScalar('x^{\\frac{1}{3}}', ['x'], [-8]), -2, 'x^(1/3) real for negative x');
  approx(evalScalar('x^{\\frac{2}{3}}', ['x'], [-8]), 4, 'x^(2/3) real for negative x');
  approx(evalScalar('x^{0.5}', ['x'], [4]), 2, 'plain sqrt exponent unaffected');
  ok(isNaN(P.RT.pow(-4, 0.5)), 'even root of negative still NaN');
  // tuple constants rejected in scalar context with a clear error
  env = emptyEnv();
  env.constVals.A = [1, 2, 3];
  var tupleErr = '';
  try { P.makeFn(P.parse('A+x').expr, ['x'], env); } catch (e) { tupleErr = e.message; }
  ok(/point/.test(tupleErr), 'tuple const in scalar expression errors');
  // point alias Q = P classifies as a named point
  env.constVals.P = [4, 5, 6];
  ok(classifyLatex('Q=P', env).type === 'namedPoint', 'Q=P is a named point');
  // miniEval accepts digit-adjacent pi
  approx(P.miniEval('2pi', emptyEnv()), 2 * Math.PI, 'miniEval 2pi');
  approx(P.miniEval('pi/2', emptyEnv()), Math.PI / 2, 'miniEval pi/2');
  approx(P.miniEval('-pi', emptyEnv()), -Math.PI, 'miniEval -pi');
  approx(P.miniEval('tau', emptyEnv()), 2 * Math.PI, 'miniEval tau');
  env = emptyEnv(); env.constVals.a = 3;
  approx(P.miniEval('2a', env), 6, 'miniEval slider ref');
  // 2-component tuples live in the xy-plane
  ok(classifyLatex('\\left(1,2\\right)').type === 'point', '2-tuple is a planar point');
  var p2 = P.evalTupleConst(P.parse('\\left(1,2\\right)').expr, emptyEnv());
  ok(p2.length === 3 && p2[2] === 0, '2-tuple pads z = 0');
  ok(classifyLatex('\\left(\\cos\\left(t\\right),\\sin\\left(t\\right)\\right)').type === 'curve', '2-tuple in t is a flat curve');
  ok(classifyLatex('\\left(-y,x\\right)').type === 'vfield', 'bare 2-tuple in x,y is a 2D field');
  ok(classifyLatex('\\left(-y,x\\right)').params.length === 2, '2D field has 2 params');
  ok(classifyLatex('\\left(y,-x,0\\right)').type === 'vfield', 'bare 3-tuple in x,y,z is a field');
  var d2 = classifyLatex('G\\left(x,y\\right)=\\left(-y,x\\right)');
  ok(d2.type === 'definition' && d2.render && d2.render.type === 'vfield', 'G(x,y)=(P,Q) renders 2D field');
  var tf2 = P.makeTupleFn(P.parse('\\left(-y,x\\right)').expr, ['x', 'y'], emptyEnv());
  var v2 = tf2(3, 4);
  ok(v2[0] === -4 && v2[1] === 3 && v2[2] === 0, '2D field evaluates padded');

  // intersection rows
  ok(P.parse('\\operatorname{intersection}').kind === 'intersection', 'intersection statement parses');
  ok(P.parse('\\operatorname{intersection}\\left(\\right)').kind === 'intersection', 'intersection() parses');
  ok(classifyLatex('\\operatorname{intersection}').type === 'intersect', 'intersection classifies');

  /* ---------- 2D plotting helpers: marching squares + overscan ---------- */
  var G2 = P.geom;
  ok(G2 && typeof G2.marchingSquares === 'function', 'marchingSquares exists');
  ok(G2 && typeof G2.overscanNeed === 'function', 'overscanNeed exists');
  ok(G2 && typeof G2.overscanMake === 'function', 'overscanMake exists');
  try {
    var msWin = { xmin: -5, xmax: 5, ymin: -5, ymax: 5, zmin: -5, zmax: 5 };
    var circ = G2.marchingSquares(function (x, y) { return x * x + y * y - 9; }, msWin, 64);
    ok(circ.length >= 1, 'circle contour found');
    var rOK = true, zOK = true, ptCount = 0;
    circ.forEach(function (poly) {
      poly.forEach(function (p) {
        ptCount++;
        if (Math.abs(Math.hypot(p[0], p[1]) - 3) > 0.05) rOK = false;
        if (p[2] !== 0) zOK = false;
      });
    });
    ok(rOK, 'circle contour points sit on radius 3');
    ok(zOK, 'circle contour lives in z=0');
    ok(ptCount > 40, 'circle contour densely sampled');
    var main = circ.reduce(function (a2, b2) { return b2.length > a2.length ? b2 : a2; }, circ[0]);
    var ms0 = main[0], ms1 = main[main.length - 1];
    ok(Math.hypot(ms0[0] - ms1[0], ms0[1] - ms1[1]) < 0.5, 'circle contour chains closed');

    var hyp = G2.marchingSquares(function (x, y) { return x * y - 1; },
      { xmin: -3, xmax: 3, ymin: -3, ymax: 3 }, 96);
    ok(hyp.length >= 2, 'hyperbola chains into separate branches');

    var none = G2.marchingSquares(function (x, y) { return x * x + y * y + 1; }, msWin, 32);
    ok(none.length === 0, 'positive-definite F has empty contour');

    var nanC = G2.marchingSquares(function (x, y) { return Math.sqrt(x) - 1; }, msWin, 64);
    var xOK = nanC.length > 0;
    nanC.forEach(function (poly) {
      poly.forEach(function (p) { if (Math.abs(p[0] - 1) > 0.05) xOK = false; });
    });
    ok(xOK, 'NaN cells skipped, sqrt(x)=1 contour at x=1');
  } catch (e) { ok(false, 'marchingSquares suite threw', e.message); }
  try {
    ok(typeof G2.smoothContours === 'function', 'smoothContours exists');
    // open polyline keeps its two endpoints exactly, and gains points
    var openC = G2.smoothContours([[[0, 0, 0], [1, 0, 0], [1, 1, 0], [2, 1, 0]]], 2)[0];
    ok(openC[0][0] === 0 && openC[0][1] === 0, 'smoothContours keeps the first endpoint');
    ok(openC[openC.length - 1][0] === 2 && openC[openC.length - 1][1] === 1, 'smoothContours keeps the last endpoint');
    ok(openC.length > 4, 'smoothContours subdivides');
    // a closed loop stays closed
    var sq = [[1, 1, 0], [-1, 1, 0], [-1, -1, 0], [1, -1, 0], [1, 1, 0]];
    var cl = G2.smoothContours([sq], 2)[0];
    ok(Math.abs(cl[0][0] - cl[cl.length - 1][0]) < 1e-9 && Math.abs(cl[0][1] - cl[cl.length - 1][1]) < 1e-9, 'smoothContours keeps a loop closed');
    var within = true;
    cl.forEach(function (p) { if (Math.abs(p[0]) > 1.0001 || Math.abs(p[1]) > 1.0001) within = false; });
    ok(within, 'chaikin points stay inside the control polygon');
    // 2-point lines are left untouched
    ok(G2.smoothContours([[[0, 0, 0], [1, 1, 0]]], 2)[0].length === 2, 'smoothContours leaves 2-point lines');
    // a coarse 12-gon on radius 3 smooths to points that hug the circle
    var circ = [];
    for (var ci = 0; ci <= 12; ci++) { var th = ci / 12 * 2 * Math.PI; circ.push([3 * Math.cos(th), 3 * Math.sin(th), 0]); }
    var sc = G2.smoothContours([circ], 2)[0];
    var rok = true;
    sc.forEach(function (p) { var r = Math.hypot(p[0], p[1]); if (r > 3.001 || r < 2.85) rok = false; });
    ok(rok, 'chaikin-smoothed 12-gon stays near radius 3');
    ok(sc.length > circ.length, 'smoothed loop is denser than the 12-gon');
  } catch (e) { ok(false, 'smoothContours suite threw', e.message); }
  try {
    ok(typeof G2.marchingSquaresAdaptive === 'function', 'marchingSquaresAdaptive exists');
    // a small circle in a large window: uniform grid gives a coarse polygon,
    // adaptive refines along the curve and stays smooth
    var bigWin = { xmin: -150, xmax: 150, ymin: -150, ymax: 150, zmin: -1, zmax: 1 };
    var Fc = function (x, y) { return x * x + y * y - 9; };
    var uni = G2.marchingSquares(Fc, bigWin, 128);
    var adp = G2.marchingSquaresAdaptive(Fc, bigWin, 128, 3);
    var uniPts = uni.reduce(function (s, p) { return s + p.length; }, 0);
    var adpPts = adp.reduce(function (s, p) { return s + p.length; }, 0);
    ok(adp.length >= 1, 'adaptive finds the small circle');
    ok(adpPts > uniPts * 3, 'adaptive samples the tiny circle far denser than uniform');
    ok(adpPts > 30, 'adaptive circle is finely sampled even when tiny in the window');
    var adpROK = true, adpZOK = true;
    adp.forEach(function (poly) {
      poly.forEach(function (p) {
        if (Math.abs(Math.hypot(p[0], p[1]) - 3) > 0.1) adpROK = false;
        if (p[2] !== 0) adpZOK = false;
      });
    });
    ok(adpROK, 'adaptive circle points sit on radius 3');
    ok(adpZOK, 'adaptive contour stays in z=0');
    var amain = adp.reduce(function (a2, b2) { return b2.length > a2.length ? b2 : a2; }, adp[0]);
    ok(Math.hypot(amain[0][0] - amain[amain.length - 1][0], amain[0][1] - amain[amain.length - 1][1]) < 1,
      'adaptive circle chains into a closed loop');
    ok(G2.marchingSquaresAdaptive(function (x, y) { return x * x + y * y + 1; }, bigWin, 64, 2).length === 0,
      'adaptive: positive-definite F has no contour');
  } catch (e) { ok(false, 'marchingSquaresAdaptive suite threw', e.message); }
  try {
    var vw = { xmin: -2, xmax: 2, ymin: -1, ymax: 1, zmin: -1, zmax: 1 };
    var ov = G2.overscanMake(vw, 2.5);
    approx(ov.xmax - ov.xmin, 10, 'overscan spans 2.5x the window');
    approx(ov.visYr, 2, 'overscan records visible y-range');
    ok(G2.overscanNeed(vw, null, false), 'missing overscan always needs a build');
    ok(!G2.overscanNeed(vw, ov, false), 'fresh overscan rides the gesture');
    ok(!G2.overscanNeed(vw, ov, true), 'fresh overscan skips the settle rebuild');
    var panMed = { xmin: 0.4, xmax: 4.4, ymin: -1, ymax: 1, zmin: -1, zmax: 1 };
    ok(!G2.overscanNeed(panMed, ov, false), 'medium pan stays inside gesture margin');
    ok(G2.overscanNeed(panMed, ov, true), 'settle recenters after a medium pan');
    var panDeep = { xmin: 0.8, xmax: 4.8, ymin: -1, ymax: 1, zmin: -1, zmax: 1 };
    ok(G2.overscanNeed(panDeep, ov, false), 'deep pan escapes mid-gesture');
    var zoomOut = { xmin: -3.8, xmax: 3.8, ymin: -1.9, ymax: 1.9, zmin: -1, zmax: 1 };
    ok(G2.overscanNeed(zoomOut, ov, false), 'zoom-out 1.9x escapes the overscan');
    var zin14 = { xmin: -2 / 1.4, xmax: 2 / 1.4, ymin: -1 / 1.4, ymax: 1 / 1.4, zmin: -1, zmax: 1 };
    ok(!G2.overscanNeed(zin14, ov, true), 'settle after 1.4x zoom-in reuses geometry');
    var zin16 = { xmin: -2 / 1.6, xmax: 2 / 1.6, ymin: -1 / 1.6, ymax: 1 / 1.6, zmin: -1, zmax: 1 };
    ok(G2.overscanNeed(zin16, ov, true), 'settle after 1.6x zoom-in resamples');
  } catch (e) { ok(false, 'overscan suite threw', e.message); }

  print('PASS ' + passed + '  FAIL ' + failed);
  failures.forEach(function (f2) { print('  FAILED: ' + f2); });
  if (failed > 0) imports.system.exit(1);
})();
