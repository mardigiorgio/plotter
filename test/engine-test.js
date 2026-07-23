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

  /* ---------- planarSample: asymptote tails reach the edge, poles split ---------- */
  try {
    var G3 = P.geom;
    var flat = function (polys) { return polys.reduce(function (s, p) { return s.concat(p); }, []); };
    var W3 = { xmin: -8, xmax: 8, ymin: -6, ymax: 6 };

    // ln(x): defined only for x>0; the vertical tail must dive to the bottom edge
    var lnP = G3.planarSample(function (t) { return [t, Math.log(t), 0]; }, W3.xmin, W3.xmax, W3, { N: 400 });
    var lnPts = flat(lnP);
    ok(lnP.length >= 1, 'ln: produces a curve');
    ok(lnPts.every(function (q) { return q[0] > -1e-6; }), 'ln: no points at x<=0');
    var lnMinY = Math.min.apply(null, lnPts.map(function (q) { return q[1]; }));
    ok(lnMinY <= W3.ymin, 'ln: asymptote tail reaches the bottom edge (minY=' + lnMinY.toFixed(2) + ')');

    // ln(x) zoomed way out: the tail must STILL reach the bottom edge (the old
    // absolute snapEdge threshold made this fail once the window grew large)
    [ {ymin:-60,ymax:60}, {ymin:-600,ymax:600}, {ymin:-60000,ymax:60000} ].forEach(function (yw) {
      var WZ = { xmin: -yw.ymax * 1.6, xmax: yw.ymax * 1.6, ymin: yw.ymin, ymax: yw.ymax };
      var p = G3.planarSample(function (t) { return [t, Math.log(t), 0]; }, WZ.xmin, WZ.xmax, WZ, { N: 3000 });
      var mn = Math.min.apply(null, flat(p).map(function (q) { return q[1]; }));
      ok(mn <= WZ.ymin, 'ln zoomed to y=' + yw.ymax + ': tail reaches bottom (minY=' + mn.toFixed(1) + ')');
    });

    // sqrt(x): finite at its domain edge → must NOT sprout a fake vertical tail
    var sqP = G3.planarSample(function (t) { return [t, Math.sqrt(t), 0]; }, W3.xmin, W3.xmax, W3, { N: 400 });
    var sqPts = flat(sqP);
    ok(sqPts.every(function (q) { return q[0] > -1e-6; }), 'sqrt: no points at x<0');
    var sqMinY = Math.min.apply(null, sqPts.map(function (q) { return q[1]; }));
    ok(sqMinY > -0.5, 'sqrt: no fake asymptote tail (minY=' + sqMinY.toFixed(3) + ')');

    // 1/x with samples that exceed the box near the pole (box-exit path)
    var invP = G3.planarSample(function (t) { return [t, 1 / t, 0]; }, W3.xmin, W3.xmax, W3, { N: 400 });
    ok(invP.length === 2, '1/x: split into two branches (got ' + invP.length + ')');
    var noBridge = function (polys, win) {
      var yr = win.ymax - win.ymin;
      return polys.every(function (p) {
        for (var i = 1; i < p.length; i++) {
          if ((p[i - 1][0] < 0) !== (p[i][0] < 0) && Math.abs(p[i][1] - p[i - 1][1]) > yr) return false;
        }
        return true;
      });
    };
    ok(noBridge(invP, W3), '1/x: no spurious vertical bridge across x=0');
    var invPts = flat(invP);
    ok(Math.max.apply(null, invPts.map(function (q) { return q[1]; })) >= W3.ymax &&
       Math.min.apply(null, invPts.map(function (q) { return q[1]; })) <= W3.ymin,
      '1/x: both tails reach the top and bottom edges');

    // 1/(x-0.3), wide y-window: neighbours straddle the pole while staying
    // in-box, so only pole detection (not box-exit) can split it
    var WY = { xmin: -8, xmax: 8, ymin: -100, ymax: 100 };
    var invW = G3.planarSample(function (t) { return [t, 1 / (t - 0.3), 0]; }, WY.xmin, WY.xmax, WY, { N: 400 });
    ok(invW.length === 2, '1/(x-0.3) wide-y: pole split when neighbours stay in-box (got ' + invW.length + ')');
    ok(invW.every(function (p) {
      for (var i = 1; i < p.length; i++) {
        if ((p[i - 1][0] < 0.3) !== (p[i][0] < 0.3) && Math.abs(p[i][1] - p[i - 1][1]) > 200) return false;
      }
      return true;
    }), '1/(x-0.3) wide-y: no bridge through the pole');

    // tan(x): several poles → several branches, none bridged
    var tanP = G3.planarSample(function (t) { return [t, Math.tan(t), 0]; }, -4, 4, W3, { N: 600 });
    ok(tanP.length >= 3, 'tan: multiple branches across poles (got ' + tanP.length + ')');
    ok(tanP.every(function (p) {
      for (var i = 1; i < p.length; i++) {
        if (Math.abs(p[i][0] - p[i - 1][0]) < 0.2 && Math.abs(p[i][1] - p[i - 1][1]) > (W3.ymax - W3.ymin)) return false;
      }
      return true;
    }), 'tan: no spurious vertical bridge through a pole');

    // plain line y=x fully inside the box: one clean run, no artifacts
    ok(G3.planarSample(function (t) { return [t, t, 0]; }, W3.xmin, W3.xmax, W3, { N: 200 }).length === 1,
      'line y=x: single run');

    // bounded oscillation must not explode the sampler nor split spuriously
    var oscP = G3.planarSample(function (t) { return [t, Math.sin(t * 20), 0]; }, W3.xmin, W3.xmax, W3, { N: 300 });
    var oscPts = flat(oscP);
    ok(oscPts.length < 20000, 'oscillation: sampler stays bounded (' + oscPts.length + ' pts)');
    ok(oscPts.every(function (q) { return Math.abs(q[1]) <= 1.0001; }), 'oscillation: values stay on the curve');
  } catch (e) { ok(false, 'planarSample suite threw', e.message + ' | ' + (e.stack || '')); }

  /* ---------- 3D box clipping: clean asymptote edges, no pole bridging ---------- */
  try {
    var G4 = P.geom;
    var box = { xmin: -4, xmax: 4, ymin: -4, ymax: 4, zmin: -4, zmax: 4 };
    ok(G4.clampState([0, 0, 0], box) === 0, 'clampState: origin is strictly inside');
    ok(G4.clampState([0, 0, 5], box) === 1, 'clampState: just past a wall is clamped');
    ok(G4.clampState([0, 0, 20], box) === 2, 'clampState: far beyond is outside');

    var tri = function (a, b, c) {
      return [a, b, c].map(function (p) { return { p: p, n: [0, 0, 1] }; });
    };
    // fully inside → unchanged 3-gon
    var inRing = G4.clipToBox(tri([0, 0, 0], [1, 0, 0], [0, 1, 0]), box);
    ok(inRing.length === 3, 'clipToBox: interior triangle passes through');
    // fully outside → empty
    ok(G4.clipToBox(tri([10, 10, 10], [11, 10, 10], [10, 11, 10]), box).length === 0,
      'clipToBox: fully-outside triangle is removed');
    // one vertex above z=4 (a 1/x-style wall reaching the top): clipped ON z=4
    var cut = G4.clipToBox(tri([0, 0, 0], [1, 0, 8], [0, 1, 0]), box);
    ok(cut.length >= 3, 'clipToBox: partly-above triangle keeps a face');
    ok(cut.every(function (v) { return v.p[2] <= box.zmax + 1e-9; }), 'clipToBox: nothing survives above z=zmax');
    ok(cut.some(function (v) { return Math.abs(v.p[2] - box.zmax) < 1e-9; }), 'clipToBox: a crisp edge lands exactly on z=zmax');
  } catch (e) { ok(false, 'clip suite threw', e.message + ' | ' + (e.stack || '')); }

  /* ---------- chained inequalities & the region object ---------- */
  try {
    var rsubst = { subst: P.CART_SUBST };
    // chained inequality → a solid region, F ≤ 0 exactly where all parts hold
    var chSpec = classifyLatex('3<x<5');
    ok(chSpec.type === 'region', 'chain 3<x<5 → region');
    var chF = P.makeFn(chSpec.F, ['x', 'y', 'z'], emptyEnv(), rsubst);
    ok(chF(4, 0, 0) <= 0, 'chain: x=4 inside 3<x<5');
    ok(chF(2, 0, 0) > 0 && chF(6, 0, 0) > 0, 'chain: x=2 and x=6 outside 3<x<5');

    // curved bounds: x² + y² < z < 4
    var cvSpec = classifyLatex('x^{2}+y^{2}<z<4');
    ok(cvSpec.type === 'region', 'curved bound → region');
    var cvF = P.makeFn(cvSpec.F, ['x', 'y', 'z'], emptyEnv(), rsubst);
    ok(cvF(0, 0, 2) <= 0, 'curved: (0,0,2) inside (x²+y² < z < 4)');
    ok(cvF(0, 0, 5) > 0, 'curved: (0,0,5) outside (z > 4)');
    ok(cvF(1.9, 0, 1) > 0, 'curved: (1.9,0,1) outside (z < x²+y²)');

    // bare "region" keyword → region3 object
    ok(P.parse('\\operatorname{region}').kind === 'region', 'region keyword parses');
    ok(P.classify(P.parse('\\operatorname{region}'), emptyEnv()).type === 'region3', 'region → region3 spec');

    // three bound fields intersect into one solid
    var parts = P.regionConstraints(P.parse('-2<x<2'))
      .concat(P.regionConstraints(P.parse('y<1')))
      .concat(P.regionConstraints(P.parse('z>0')));
    var rF = P.makeFn(P.regionF(parts), ['x', 'y', 'z'], emptyEnv(), rsubst);
    ok(rF(0, 0, 1) <= 0, 'region: (0,0,1) satisfies all three bounds');
    ok(rF(0, 3, 1) > 0, 'region: y=3 violates y<1');
    ok(rF(5, 0, 1) > 0, 'region: x=5 violates -2<x<2');
    ok(rF(0, 0, -1) > 0, 'region: z=-1 violates z>0');

    // equality is not a valid bound
    var threwEq = false;
    try { P.regionConstraints(P.parse('x=2')); } catch (e2) { threwEq = true; }
    ok(threwEq, 'region: equality bound rejected');
  } catch (e) { ok(false, 'region suite threw', e.message + ' | ' + (e.stack || '')); }

  /* ---------- mesher: polygonizer, caps, 2D fill ---------- */
  try {
    var MM = P.mesher;
    var win8 = { xmin: -4, xmax: 4, ymin: -4, ymax: 4, zmin: -4, zmax: 4 };
    var vkey = function (pos, vi) {
      return pos[vi * 3].toFixed(7) + ',' + pos[vi * 3 + 1].toFixed(7) + ',' + pos[vi * 3 + 2].toFixed(7);
    };
    // undirected edge → triangle count over one or more meshes
    var edgeCounts = function (meshes) {
      var counts = new Map();
      meshes.forEach(function (m) {
        for (var t = 0; t < m.idx.length; t += 3) {
          for (var e = 0; e < 3; e++) {
            var a = vkey(m.pos, m.idx[t + e]), b = vkey(m.pos, m.idx[t + (e + 1) % 3]);
            if (a === b) continue; // degenerate (coincident refined crossings)
            var kk = a < b ? a + '|' + b : b + '|' + a;
            counts.set(kk, (counts.get(kk) || 0) + 1);
          }
        }
      });
      return counts;
    };

    // 1. sphere: closed manifold, refined vertices on the surface, sane normals
    var sphF = function (x, y, z) { return x * x + y * y + z * z - 9; };
    var sph = MM.polygonize(sphF, win8, 20, { refine: true, gradF: true });
    ok(sph.idx.length / 3 > 300, 'mesher: sphere has a real triangle count', String(sph.idx.length / 3));
    var badEdge = 0;
    edgeCounts([sph]).forEach(function (nTri) { if (nTri !== 2) badEdge++; });
    ok(badEdge === 0, 'mesher: sphere mesh is a closed manifold', badEdge + ' bad edges');
    var worstF = 0, worstN = 1, badWind = 0;
    for (var sv = 0; sv < sph.pos.length; sv += 3) {
      worstF = Math.max(worstF, Math.abs(sphF(sph.pos[sv], sph.pos[sv + 1], sph.pos[sv + 2])));
      var rl = Math.hypot(sph.pos[sv], sph.pos[sv + 1], sph.pos[sv + 2]);
      worstN = Math.min(worstN,
        (sph.nrm[sv] * sph.pos[sv] + sph.nrm[sv + 1] * sph.pos[sv + 1] + sph.nrm[sv + 2] * sph.pos[sv + 2]) / rl);
    }
    ok(worstF < 1e-4, 'mesher: refined vertices sit on the sphere', 'max |F| = ' + worstF);
    ok(worstN > 0.99, 'mesher: sphere normals are radial', 'min dot = ' + worstN);
    for (var st = 0; st < sph.idx.length; st += 3) {
      var A3 = sph.idx[st] * 3, B3 = sph.idx[st + 1] * 3, C3 = sph.idx[st + 2] * 3;
      var ux = sph.pos[B3] - sph.pos[A3], uy = sph.pos[B3 + 1] - sph.pos[A3 + 1], uz = sph.pos[B3 + 2] - sph.pos[A3 + 2];
      var wx = sph.pos[C3] - sph.pos[A3], wy = sph.pos[C3 + 1] - sph.pos[A3 + 1], wz = sph.pos[C3 + 2] - sph.pos[A3 + 2];
      var cxv = uy * wz - uz * wy, cyv = uz * wx - ux * wz, czv = ux * wy - uy * wx;
      if (cxv * sph.pos[A3] + cyv * sph.pos[A3 + 1] + czv * sph.pos[A3 + 2] < 0) badWind++;
    }
    ok(badWind === 0, 'mesher: sphere winding is outward', badWind + ' flipped');

    // 2. region paraboloid + caps: the union is a closed solid, caps are planar
    var parF = function (x, y, z) { return z - 3.7 + x * x + y * y; };
    var par = MM.polygonize(parF, win8, 16, { refine: true, gradF: true });
    var caps = MM.buildCaps(win8, 16, par.cache);
    ok(caps.idx.length > 0, 'mesher: paraboloid region grows caps');
    var openEdges = 0;
    edgeCounts([par, caps]).forEach(function (nTri) { if (nTri !== 2) openEdges++; });
    ok(openEdges === 0, 'mesher: surface+caps form a closed solid (seam is exact)', openEdges + ' open/bad edges');
    var capPlanar = true;
    for (var cv = 0; cv < caps.pos.length; cv += 3) {
      var onFace = Math.abs(caps.pos[cv]) === 4 || Math.abs(caps.pos[cv + 1]) === 4 || Math.abs(caps.pos[cv + 2]) === 4;
      if (!onFace) capPlanar = false;
    }
    ok(capPlanar, 'mesher: every cap vertex lies exactly on a box face');

    // 3. region3 crease: max(x-1, z) with parts → normals are pure ±ex / ±ez
    var g1 = function (x, y, z) { return x - 1; };
    var g2 = function (x, y, z) { return z; };
    var mxF = function (x, y, z) { return Math.max(g1(x, y, z), g2(x, y, z)); };
    var mx = MM.polygonize(mxF, win8, 16, { refine: true, gradF: true, parts: [g1, g2] });
    var blended = 0;
    for (var mv = 0; mv < mx.nrm.length; mv += 3) {
      var dx2 = Math.abs(mx.nrm[mv]), dz2 = Math.abs(mx.nrm[mv + 2]);
      if (!(dx2 > 0.999 || dz2 > 0.999)) blended++;
    }
    ok(blended === 0, 'mesher: crease normals come from one constraint each', blended + ' blended');
    // split vertices: some position occurs twice, once with each constraint's
    // normal (shared loop vertices of triangles on either side of the crease)
    var creasePos = {};
    for (var mv2 = 0; mv2 < mx.pos.length; mv2 += 3) {
      var pk = mx.pos[mv2].toFixed(7) + ',' + mx.pos[mv2 + 1].toFixed(7) + ',' + mx.pos[mv2 + 2].toFixed(7);
      creasePos[pk] = (creasePos[pk] || 0) | (Math.abs(mx.nrm[mv2]) > 0.999 ? 1 : 2);
    }
    var split = Object.keys(creasePos).some(function (kk) { return creasePos[kk] === 3; });
    ok(split, 'mesher: crease vertices split into per-constraint copies');

    // 4. 2D fill: disc area, saddle-consistent fill, contours returned
    var triArea = function (fill) {
      var area = 0;
      for (var t2 = 0; t2 < fill.idx.length; t2 += 3) {
        var a2 = fill.idx[t2] * 3, b2 = fill.idx[t2 + 1] * 3, c2 = fill.idx[t2 + 2] * 3;
        area += Math.abs((fill.pos[b2] - fill.pos[a2]) * (fill.pos[c2 + 1] - fill.pos[a2 + 1]) -
                         (fill.pos[c2] - fill.pos[a2]) * (fill.pos[b2 + 1] - fill.pos[a2 + 1])) / 2;
      }
      return area;
    };
    var disc = MM.fillRegion2D(function (x, y) { return x * x + y * y - 4; }, win8, 64, 3);
    ok(Math.abs(triArea(disc) - Math.PI * 4) < Math.PI * 4 * 0.01,
      'mesher: disc fill area ≈ 4π', 'got ' + triArea(disc));
    ok(disc.contours.length >= 1, 'mesher: disc fill returns stroke contours');
    var quads = MM.fillRegion2D(function (x, y) { return x * y; }, win8, 64, 3);
    ok(Math.abs(triArea(quads) - 32) < 32 * 0.02,
      'mesher: xy<0 fill (saddle checkerboard) ≈ half the window', 'got ' + triArea(quads));

    // 2b. cap winding: face-winding normal must agree with the stored outward
    // normal on EVERY face — the y-faces used a left-handed axis pair once
    var capWind = function (caps, label) {
      var badW = 0;
      for (var ct = 0; ct < caps.idx.length; ct += 3) {
        var a4 = caps.idx[ct] * 3, b4 = caps.idx[ct + 1] * 3, c4 = caps.idx[ct + 2] * 3;
        var ux2 = caps.pos[b4] - caps.pos[a4], uy2 = caps.pos[b4 + 1] - caps.pos[a4 + 1], uz2 = caps.pos[b4 + 2] - caps.pos[a4 + 2];
        var wx2 = caps.pos[c4] - caps.pos[a4], wy2 = caps.pos[c4 + 1] - caps.pos[a4 + 1], wz2 = caps.pos[c4 + 2] - caps.pos[a4 + 2];
        var fx2 = uy2 * wz2 - uz2 * wy2, fy2 = uz2 * wx2 - ux2 * wz2, fz2 = ux2 * wy2 - uy2 * wx2;
        if (fx2 * caps.nrm[a4] + fy2 * caps.nrm[a4 + 1] + fz2 * caps.nrm[a4 + 2] <= 0) badW++;
      }
      ok(badW === 0, 'mesher: cap winding matches outward normals (' + label + ')', badW + ' flipped');
    };
    capWind(caps, 'paraboloid z-caps');
    var cylY = MM.polygonize(function (x, y, z) { return x * x + z * z - 9; }, win8, 16, { refine: true, gradF: true });
    capWind(MM.buildCaps(win8, 16, cylY.cache), 'y-axis cylinder y-caps');

    // 2c. full-window region: six merged face quads, closed box, wound outward
    var boxAll = MM.polygonize(function (x, y, z) { return z - 100; }, win8, 16, { refine: true, gradF: true });
    var boxCaps = MM.buildCaps(win8, 16, boxAll.cache);
    ok(boxAll.idx.length === 0, 'mesher: full-window region has no interior surface');
    ok(boxCaps.idx.length === 36, 'mesher: full-window region caps merge to 6 quads', boxCaps.idx.length + ' indices');
    var boxOpen = 0;
    edgeCounts([boxCaps]).forEach(function (nTri) { if (nTri !== 2) boxOpen++; });
    ok(boxOpen === 0, 'mesher: merged box caps close up', boxOpen + ' bad edges');
    capWind(boxCaps, 'full box');

    // 4b. domain-edge fill: y < sqrt(x) with x=0 off-lattice must fill to
    // within a sub-cell of the domain edge (it used to skip whole base cells)
    var winOff = { xmin: -4.03, xmax: 4.05, ymin: -4.03, ymax: 4.05, zmin: -4, zmax: 4 };
    var sqf = MM.fillRegion2D(function (x, y) { return y - Math.sqrt(x); }, winOff, 64, 3);
    var covered = false;
    var px2 = 0.02, py2 = -2.5; // inside the region, just right of the domain edge
    for (var ft = 0; ft < sqf.idx.length && !covered; ft += 3) {
      var ax3 = sqf.pos[sqf.idx[ft] * 3], ay3 = sqf.pos[sqf.idx[ft] * 3 + 1];
      var bx4 = sqf.pos[sqf.idx[ft + 1] * 3], by4 = sqf.pos[sqf.idx[ft + 1] * 3 + 1];
      var cx4 = sqf.pos[sqf.idx[ft + 2] * 3], cy4 = sqf.pos[sqf.idx[ft + 2] * 3 + 1];
      var d1 = (bx4 - ax3) * (py2 - ay3) - (by4 - ay3) * (px2 - ax3);
      var d2 = (cx4 - bx4) * (py2 - by4) - (cy4 - by4) * (px2 - bx4);
      var d3 = (ax3 - cx4) * (py2 - cy4) - (ay3 - cy4) * (px2 - cx4);
      if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) covered = true;
    }
    ok(covered, 'mesher: sqrt-domain fill reaches the domain edge');

    // 6b. dashes are flagged open so flatRibbon never wraps them into loops
    var dashes2 = MM.dashPolylines([[[0, 0, 0], [10, 0, 0]]], 1, 1);
    ok(dashes2.every(function (dp) { return dp.open === true; }), 'mesher: dashes are marked open');

    // pole guard end-to-end: 1/x - y must not mesh a wall across x = 0
    var pole3 = MM.polygonize(function (x, y, z) { return 1 / x - y; }, win8, 16, { refine: true, gradF: true });
    var longEdge = 0;
    for (var pt2 = 0; pt2 < pole3.idx.length; pt2 += 3) {
      for (var pe = 0; pe < 3; pe++) {
        var va3 = pole3.idx[pt2 + pe] * 3, vb3 = pole3.idx[pt2 + (pe + 1) % 3] * 3;
        var el2 = Math.hypot(pole3.pos[va3] - pole3.pos[vb3], pole3.pos[va3 + 1] - pole3.pos[vb3 + 1], pole3.pos[va3 + 2] - pole3.pos[vb3 + 2]);
        if (el2 > 1.5) longEdge++;
      }
    }
    ok(longEdge === 0, 'mesher: pole field grows no asymptote wall', longEdge + ' long edges');

    // 5. NaN robustness: sqrt half-space; no NaN output, still meshes
    var nanF = function (x, y, z) { return Math.sqrt(x) - 1; };
    var nan3 = MM.polygonize(nanF, win8, 12, { refine: true, gradF: true });
    var nanBad = false;
    for (var nv = 0; nv < nan3.pos.length; nv++) if (!isFinite(nan3.pos[nv])) nanBad = true;
    for (var nv2 = 0; nv2 < nan3.nrm.length; nv2++) if (!isFinite(nan3.nrm[nv2])) nanBad = true;
    ok(!nanBad, 'mesher: NaN domains produce finite geometry only');

    // 6. dashes: 10-long line, dash 1 / gap 1 → 5 dashes
    var dashes = MM.dashPolylines([[[0, 0, 0], [10, 0, 0]]], 1, 1);
    ok(dashes.length === 5, 'mesher: dash splitting', 'got ' + dashes.length);

    // 7. perf smoke: settle-grade sphere well under interactive budgets
    var t0p = Date.now();
    MM.polygonize(sphF, win8, 48, { refine: true, gradF: true });
    var dtp = Date.now() - t0p;
    ok(dtp < 1500, 'mesher: N=48 refined sphere under 1.5s in gjs', dtp + 'ms');
  } catch (e) { ok(false, 'mesher suite threw', e.message + ' | ' + (e.stack || '')); }

  print('PASS ' + passed + '  FAIL ' + failed);
  failures.forEach(function (f2) { print('  FAILED: ' + f2); });
  if (failed > 0) imports.system.exit(1);
})();
