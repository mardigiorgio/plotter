/* parser.js — LaTeX subset → AST
 *
 * AST nodes:
 *   {t:'num', v}                     number literal (also pi / e resolved here as {t:'const'})
 *   {t:'const', name}                'pi' | 'e'
 *   {t:'var', name}                  variable, possibly subscripted: 'x', 'theta', 'a_1'
 *   {t:'bin', op, a, b}              op in + - * / ^
 *   {t:'neg', a}
 *   {t:'call', name, args:[..]}      builtin function call (sin, sqrt, nthroot, log(+base), vector…)
 *   {t:'apply', head, args:[..]}     var-name applied to parenthesized args — user fn OR implicit mult
 *   {t:'tuple', items:[..]}
 *   {t:'abs', a}
 *
 * Statements:
 *   {kind:'empty'}
 *   {kind:'expr', expr}
 *   {kind:'rel', op:'='|'<'|'>'|'<='|'>=', lhs, rhs}
 */
(function () {
  'use strict';
  var P = window.P = window.P || {};

  var GREEK = {
    pi: 'pi', theta: 'theta', rho: 'rho', phi: 'phi', varphi: 'phi', tau: 'tau',
    alpha: 'alpha', beta: 'beta', gamma: 'gamma', delta: 'delta', lambda: 'lambda',
    mu: 'mu', sigma: 'sigma', omega: 'omega', epsilon: 'epsilon', psi: 'psi', nu: 'nu'
  };

  var FUNCS = {
    sin: 1, cos: 1, tan: 1, sec: 1, csc: 1, cot: 1,
    arcsin: 1, arccos: 1, arctan: 1, asin: 1, acos: 1, atan: 1,
    sinh: 1, cosh: 1, tanh: 1,
    asinh: 1, acosh: 1, atanh: 1,
    ln: 1, log: 1, exp: 1, abs: 1, sqrt: 1, cbrt: 1, nthroot: 1,
    min: 1, max: 1, floor: 1, ceil: 1, round: 1, sign: 1, mod: 1, atan2: 1,
    vector: 1
  };
  // inverse names for f^{-1}
  var INverse = { sin: 'asin', cos: 'acos', tan: 'atan', sinh: 'asinh', cosh: 'acosh', tanh: 'atanh' };

  function err(msg) { var e = new Error(msg); e.isParse = true; throw e; }

  /* ---------------- tokenizer ---------------- */
  function tokenize(s) {
    var toks = [], i = 0, n = s.length;
    function push(t, v) { toks.push({ t: t, v: v }); }
    while (i < n) {
      var c = s[i];
      if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
      if (c === '\\') {
        i++;
        if (i < n && !/[a-zA-Z]/.test(s[i])) {
          // \{ \} "\ " \, etc.
          var sym = s[i]; i++;
          if (sym === '{' ) push('{');
          else if (sym === '}') push('}');
          /* "\ " "\," "\:" → whitespace, skip */
          continue;
        }
        var j = i;
        while (j < n && /[a-zA-Z]/.test(s[j])) j++;
        var cmd = s.slice(i, j); i = j;
        switch (cmd) {
          case 'left': case 'right': {
            // consume the delimiter
            var d = s[i];
            if (d === '\\') {
              var k = i + 1;
              if (/[a-zA-Z]/.test(s[k])) { // \left\lVert etc — take command
                var k2 = k; while (k2 < n && /[a-zA-Z]/.test(s[k2])) k2++;
                var dc = s.slice(k, k2); i = k2;
                if (dc === 'langle') push(cmd === 'left' ? '(' : ')');
                else if (dc === 'rangle') push(cmd === 'left' ? '(' : ')');
                else if (dc === 'lbrace' || dc === 'rbrace') push(cmd === 'left' ? '(' : ')');
                else if (dc === 'vert' || dc === 'lVert' || dc === 'rVert') push(cmd === 'left' ? 'absL' : 'absR');
                else err('unsupported bracket \\' + dc);
              } else { i = k + 1; var dd = s[k]; push(dd === '{' ? '(' : dd === '}' ? ')' : dd); }
            } else {
              i++;
              if (d === '(') push('(');
              else if (d === ')') push(')');
              else if (d === '[') push('(');
              else if (d === ']') push(')');
              else if (d === '|') push(cmd === 'left' ? 'absL' : 'absR');
              else if (d === '.') push(cmd === 'left' ? '(' : ')'); // \right. — treat as close
              else err('unsupported bracket ' + d);
            }
            continue;
          }
          case 'cdot': case 'times': case 'ast': push('*'); continue;
          case 'div': push('/'); continue;
          case 'le': case 'leq': push('<='); continue;
          case 'ge': case 'geq': push('>='); continue;
          case 'lt': push('<'); continue;
          case 'gt': push('>'); continue;
          case 'ne': case 'neq': err('≠ is not supported');
          case 'frac': push('frac'); continue;
          case 'sqrt': push('sqrt'); continue;
          case 'operatorname': {
            // \operatorname{name}
            if (s[i] !== '{') err('bad operatorname');
            var k3 = s.indexOf('}', i);
            var name = s.slice(i + 1, k3).replace(/\\ /g, '').trim();
            i = k3 + 1;
            push('func', name);
            continue;
          }
          case 'pi': push('const', 'pi'); continue;
          case 'infty': push('num', Infinity); continue;
          case 'text': { // \text{...} — skip content? treat as error
            err('text is not supported here');
          }
          default:
            if (GREEK[cmd]) { push('letter', GREEK[cmd]); continue; }
            if (FUNCS[cmd]) { push('func', cmd); continue; }
            err('unknown symbol \\' + cmd);
        }
      }
      if (/[0-9.]/.test(c)) {
        var j2 = i;
        while (j2 < n && /[0-9.]/.test(s[j2])) j2++;
        var txt = s.slice(i, j2);
        if ((txt.match(/\./g) || []).length > 1) err('bad number ' + txt);
        toks.push({ t: 'num', v: parseFloat(txt), raw: txt }); i = j2; continue;
      }
      if (/[a-zA-Z]/.test(c)) { push('letter', c); i++; continue; }
      switch (c) {
        case '+': case '-': case '*': case '/': case '^': case '_':
        case '(': case ')': case ',': case '{': case '}':
          push(c); i++; continue;
        case '|':
          err('for absolute value, type abs(…) or use the |x| bracket keys');
        case '=': push('='); i++; continue;
        case '<':
          if (s[i + 1] === '=') { push('<='); i += 2; } else { push('<'); i++; } continue;
        case '>':
          if (s[i + 1] === '=') { push('>='); i += 2; } else { push('>'); i++; } continue;
        case '·': push('*'); i++; continue;
        default:
          err('unexpected character "' + c + '"');
      }
    }
    return toks;
  }

  /* ---------------- parser ---------------- */
  function Parser(toks) { this.toks = toks; this.i = 0; }
  Parser.prototype = {
    peek: function (k) { return this.toks[this.i + (k || 0)] || { t: 'eof' }; },
    next: function () { return this.toks[this.i++] || { t: 'eof' }; },
    expect: function (t) {
      var tok = this.next();
      if (tok.t !== t) err('expected "' + t + '"' + (tok.t === 'eof' ? ' (the expression is incomplete)' : ''));
      return tok;
    },
    at: function (t) { return this.peek().t === t; },

    parseStatement: function () {
      if (this.at('eof')) return { kind: 'empty' };
      var lhs = this.parseExpr();
      var t = this.peek().t;
      if (t === '=' || t === '<' || t === '>' || t === '<=' || t === '>=') {
        this.next();
        var rhs = this.parseExpr();
        // chained inequality: a < b < c …  (not for '='). Yields a 'chain' node.
        var t2 = this.peek().t;
        if (t !== '=' && (t2 === '<' || t2 === '>' || t2 === '<=' || t2 === '>=')) {
          var terms = [lhs, rhs], ops = [t];
          while (t2 === '<' || t2 === '>' || t2 === '<=' || t2 === '>=') {
            this.next();
            terms.push(this.parseExpr());
            ops.push(t2);
            t2 = this.peek().t;
          }
          if (!this.at('eof')) err('unexpected input after inequality');
          return { kind: 'chain', terms: terms, ops: ops };
        }
        if (!this.at('eof')) err('unexpected input after expression');
        return { kind: 'rel', op: t, lhs: lhs, rhs: rhs };
      }
      if (!this.at('eof')) err('unexpected input after expression');
      return { kind: 'expr', expr: lhs };
    },

    parseExpr: function () {
      var a = this.parseTerm();
      for (;;) {
        var t = this.peek().t;
        if (t === '+' || t === '-') {
          this.next();
          var b = this.parseTerm();
          a = { t: 'bin', op: t, a: a, b: b };
        } else break;
      }
      return a;
    },

    startsPrimary: function () {
      var t = this.peek().t;
      return t === 'num' || t === 'letter' || t === 'const' || t === 'frac' ||
             t === 'sqrt' || t === 'func' || t === '(' || t === 'absL' || t === '{';
    },

    parseTerm: function () {
      var a = this.parseUnary();
      for (;;) {
        var t = this.peek().t;
        if (t === '*' || t === '/') {
          this.next();
          var b = this.parseUnary();
          a = { t: 'bin', op: t, a: a, b: b };
        } else if (this.startsPrimary()) {
          var b2 = this.parsePostfix();
          a = { t: 'bin', op: '*', a: a, b: b2 };
        } else break;
      }
      return a;
    },

    parseUnary: function () {
      var t = this.peek().t;
      if (t === '-') { this.next(); return { t: 'neg', a: this.parseUnary() }; }
      if (t === '+') { this.next(); return this.parseUnary(); }
      return this.parsePostfix();
    },

    parsePostfix: function () {
      var a = this.parsePrimary();
      while (this.at('^')) {
        this.next();
        var e = this.parseGroupOrToken();
        a = { t: 'bin', op: '^', a: a, b: e };
      }
      return a;
    },

    // after ^ or _ : either {expr} or a single token
    parseGroupOrToken: function () {
      if (this.at('{')) {
        this.next();
        var e = this.parseExpr();
        this.expect('}');
        return e;
      }
      var tok = this.peek();
      if (tok.t === '-') { this.next(); return { t: 'neg', a: this.parseGroupOrToken() }; }
      if (tok.t === 'num') { this.next(); return { t: 'num', v: tok.v }; }
      if (tok.t === 'letter') { this.next(); return { t: 'var', name: tok.v }; }
      if (tok.t === 'const') { this.next(); return { t: 'const', name: tok.v }; }
      err('expected exponent');
    },

    // raw text for subscripts: a_{12}, a_{bc}
    parseSubscriptText: function () {
      var parts = [];
      function digits(tok) { // keep leading zeros: a_{01} must stay distinct from a_1
        var raw = tok.raw !== undefined ? tok.raw : String(tok.v);
        if (raw.indexOf('.') !== -1) err('bad subscript');
        return raw;
      }
      if (this.at('{')) {
        this.next();
        while (!this.at('}')) {
          var tok = this.next();
          if (tok.t === 'num') parts.push(digits(tok));
          else if (tok.t === 'letter') parts.push(tok.v);
          else err('bad subscript');
        }
        this.next();
      } else {
        var tok2 = this.next();
        if (tok2.t === 'num') parts.push(digits(tok2));
        else if (tok2.t === 'letter') parts.push(tok2.v);
        else err('bad subscript');
      }
      return parts.join('');
    },

    parseArgsParen: function () {
      // caller consumed '('
      var args = [this.parseExpr()];
      while (this.at(',')) { this.next(); args.push(this.parseExpr()); }
      this.expect(')');
      return args;
    },

    parsePrimary: function () {
      var tok = this.peek();
      switch (tok.t) {
        case 'num': this.next(); return { t: 'num', v: tok.v };
        case 'const': this.next(); return { t: 'const', name: tok.v };
        case 'letter': {
          this.next();
          var name = tok.v;
          if (this.at('_')) { this.next(); name = name + '_' + this.parseSubscriptText(); }
          if (this.at('(')) {
            this.next();
            var args = this.parseArgsParen();
            return { t: 'apply', head: name, args: args };
          }
          return { t: 'var', name: name };
        }
        case 'frac': {
          this.next();
          this.expect('{'); var a = this.at('}') ? err('empty numerator') : this.parseExpr(); this.expect('}');
          this.expect('{'); var b = this.at('}') ? err('empty denominator') : this.parseExpr(); this.expect('}');
          return { t: 'bin', op: '/', a: a, b: b };
        }
        case 'sqrt': {
          this.next();
          if (this.at('{')) {
            this.next(); var e = this.parseExpr(); this.expect('}');
            return { t: 'call', name: 'sqrt', args: [e] };
          }
          err('malformed sqrt'); // \sqrt[n]{x} was rewritten to nthroot in preprocess()
        }
        case 'func': {
          this.next();
          var fname = tok.v;
          var powNode = null, inverse = false, logBase = null;
          if (this.at('_')) {
            if (fname !== 'log') err(fname + ' cannot take a subscript');
            this.next();
            logBase = this.at('{') ? (this.next(), (function (self) { var e = self.parseExpr(); self.expect('}'); return e; })(this)) : this.parseGroupOrToken();
          }
          if (this.at('^')) {
            this.next();
            powNode = this.parseGroupOrToken();
            if (powNode.t === 'neg' && powNode.a.t === 'num' && powNode.a.v === 1) {
              inverse = true; powNode = null;
            }
          }
          if (inverse) {
            if (INverse[fname]) fname = INverse[fname];
            else err(fname + '^{-1} is not supported');
          }
          var argsF = null;
          if (this.at('(')) { this.next(); argsF = this.parseArgsParen(); }
          else {
            // paren-less: consume a tight product, stopping before another function
            if (!this.startsPrimary()) err(fname + ' needs an argument');
            var argA = this.parseFnBare();
            argsF = [argA];
          }
          var node;
          if (logBase) node = { t: 'call', name: 'logb', args: [argsF[0], logBase] };
          else if (FUNCS[fname]) node = { t: 'call', name: fname, args: argsF };
          else node = { t: 'apply', head: fname, args: argsF }; // operatorname of unknown → user fn
          if (powNode) node = { t: 'bin', op: '^', a: node, b: powNode };
          return node;
        }
        case '(': {
          this.next();
          var e1 = this.parseExpr();
          if (this.at(',')) {
            var items = [e1];
            while (this.at(',')) { this.next(); items.push(this.parseExpr()); }
            this.expect(')');
            return { t: 'tuple', items: items };
          }
          this.expect(')');
          return e1;
        }
        case 'absL': {
          this.next();
          var e2 = this.parseExpr();
          this.expect('absR');
          return { t: 'abs', a: e2 };
        }
        case '{': { // stray latex group
          this.next();
          var e3 = this.parseExpr();
          this.expect('}');
          return e3;
        }
        case 'eof': err('expression is incomplete');
        default: err('unexpected "' + (tok.v || tok.t) + '"');
      }
    },

    // argument of a paren-less function: product of primaries, stops before another function
    parseFnBare: function () {
      var a = this.parsePostfixNoFunc();
      for (;;) {
        var t = this.peek().t;
        if (t === 'num' || t === 'letter' || t === 'const' || t === 'frac' || t === 'sqrt' || t === '(' || t === 'absL') {
          var b = this.parsePostfixNoFunc();
          a = { t: 'bin', op: '*', a: a, b: b };
        } else break;
      }
      return a;
    },
    parsePostfixNoFunc: function () {
      if (this.at('func')) err('write parentheses around nested function arguments');
      return this.parsePostfix();
    }
  };

  /* handle \sqrt[n]{x}: MathQuill emits "\sqrt[n]{x}" — preprocess into nthroot */
  function preprocess(latex) {
    // MathQuill emits single-character super/subscripts UNBRACED ("x^23" means x²·3);
    // brace that one character so the tokenizer can't swallow following digits.
    var out = latex.replace(/([_^])([0-9a-zA-Z])/g, '$1{$2}');
    for (;;) {
      var idx = out.indexOf('\\sqrt[');
      if (idx === -1) break;
      // find matching ] then matching {}
      var i = idx + 6, depth = 0;
      while (i < out.length && (out[i] !== ']' || depth > 0)) {
        if (out[i] === '[') depth++;
        if (out[i] === ']') depth--;
        i++;
      }
      var idxN = out.slice(idx + 6, i);
      var j = i + 1;
      if (out[j] !== '{') return out; // malformed; let parser error
      var d2 = 1, k = j + 1;
      while (k < out.length && d2 > 0) {
        if (out[k] === '{') d2++;
        else if (out[k] === '}') d2--;
        k++;
      }
      var body = out.slice(j + 1, k - 1);
      out = out.slice(0, idx) + '\\operatorname{nthroot}\\left(' + body + ',' + idxN + '\\right)' + out.slice(k);
    }
    return out;
  }

  P.parse = function (latex) {
    // bare "intersection" (optionally with empty parens) is its own statement kind
    if (/^\s*\\operatorname\{intersection\}\s*(\\left\(\s*\\right\)|\(\s*\))?\s*$/.test(latex)) {
      return { kind: 'intersection' };
    }
    // bare "region" likewise: its inequality bounds live in the row's substrip
    if (/^\s*\\operatorname\{region\}\s*(\\left\(\s*\\right\)|\(\s*\))?\s*$/.test(latex)) {
      return { kind: 'region' };
    }
    var toks = tokenize(preprocess(latex));
    var p = new Parser(toks);
    return p.parseStatement();
  };
  P.parseFuncs = FUNCS;
})();
