/**
 * magnitude tool — an **asymptotic magnitude algebra** for deep_explore's quantitative/analytic
 * reasoning (the third "verification tooth", next to z3Verify and pariGp).
 *
 * WHY: the dominant failure of an LLM doing analytic number theory / hard analysis is *epsilon
 * management* — choosing parameters (the major/minor-arc cutoff Q, exponent pairs, Hölder exponents)
 * so that a pile of bounds composes to beat a target, while tracking magnitudes like N^{3/2}(log N)^{-A}
 * across dozens of steps. LLMs slip on exactly this arithmetic (observed: labelling N^2/N a "minor arc
 * measure", confusing N·log N with N/log N). This tool moves that bookkeeping OUT of the model's head
 * and into exact code: the model proposes the *shape* of each bound; the tool does the arithmetic.
 *
 * WHAT it decides:
 *   - **simplify**: normalise a product/quotient of powers into an exponent vector (sanity-check a magnitude).
 *   - **compare**: is X = o(Y) / O(Y) / Θ(Y), asymptotically? (lexicographic on the declared growth scale).
 *   - **closes**: given a *sum* of contributing bounds and a target, does the sum beat the target — and
 *     with FREE parameters (A, B, κ, …), does there EXIST a choice in their domain that closes it?
 *     This is the "global parameter coordination" the decompose-verify tree cannot represent on its own.
 *       · ternary Goldbach: target N^2(log N)^{-3}, minor bound N^2(log N)^{-A} → **closes at A>3** (witness).
 *       · binary  Goldbach: target N,           minor bound N^{3/2}(log N)^{-A} → **does NOT close** —
 *         the minor term exceeds the target at the dominant scale N (3/2 > 1) for ANY A. The tool returns
 *         that honest verdict + the binding obstruction, instead of the model hand-waving past it.
 *
 * It is a *magnitude* calculator, not a prover: it reasons about orders of growth (the exponent lattice),
 * never about hidden constants. A "closes" verdict means the orders compose; the actual analytic lemmas
 * that justify each bound's shape still need real reasoning (z3/pariGp/human). Pure, deterministic, no I/O.
 */

import type { Tool } from '@agent/policy';

// ── Exact rationals (exponents are small: 3/2, 1/6, -A·1 …) ──────────────────────────────────────
export interface Frac {
  n: number; // numerator (carries the sign)
  d: number; // denominator > 0
}
function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}
export function fr(n: number, d = 1): Frac {
  if (d === 0) throw new Error('zero denominator');
  if (!Number.isInteger(n) || !Number.isInteger(d)) {
    // accept decimals like 1.5 by scaling to a fraction
    const scale = 1e9;
    const N = Math.round(n * scale);
    const D = Math.round(d * scale);
    return fr(N, D);
  }
  if (d < 0) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
const F0 = fr(0);
function fAdd(a: Frac, b: Frac): Frac {
  return fr(a.n * b.d + b.n * a.d, a.d * b.d);
}
function fSub(a: Frac, b: Frac): Frac {
  return fr(a.n * b.d - b.n * a.d, a.d * b.d);
}
function fMul(a: Frac, b: Frac): Frac {
  return fr(a.n * b.n, a.d * b.d);
}
function fNeg(a: Frac): Frac {
  return { n: -a.n, d: a.d };
}
function fIsZero(a: Frac): boolean {
  return a.n === 0;
}
function fSign(a: Frac): number {
  return Math.sign(a.n);
}
function fCmp(a: Frac, b: Frac): number {
  return fSign(fSub(a, b));
}
export function fStr(a: Frac): string {
  return a.d === 1 ? String(a.n) : `${a.n}/${a.d}`;
}

// ── Affine forms over free parameters: c + Σ coeff_i · param_i (an exponent may depend on A,B,κ…) ──
export interface Aff {
  c: Frac;
  t: Record<string, Frac>; // param -> coefficient
}
function aConst(c: Frac): Aff {
  return { c, t: {} };
}
function aParam(name: string): Aff {
  return { c: F0, t: { [name]: fr(1) } };
}
function aAdd(a: Aff, b: Aff): Aff {
  const t: Record<string, Frac> = { ...a.t };
  for (const [k, v] of Object.entries(b.t)) t[k] = t[k] ? fAdd(t[k], v) : v;
  for (const k of Object.keys(t)) if (fIsZero(t[k])) delete t[k];
  return { c: fAdd(a.c, b.c), t };
}
function aScale(a: Aff, s: Frac): Aff {
  const t: Record<string, Frac> = {};
  for (const [k, v] of Object.entries(a.t)) {
    const nv = fMul(v, s);
    if (!fIsZero(nv)) t[k] = nv;
  }
  return { c: fMul(a.c, s), t };
}
function aSub(a: Aff, b: Aff): Aff {
  return aAdd(a, aScale(b, fr(-1)));
}
function aIsZero(a: Aff): boolean {
  return fIsZero(a.c) && Object.keys(a.t).length === 0;
}
function aConstVal(a: Aff): Frac | null {
  return Object.keys(a.t).length === 0 ? a.c : null;
}
function aStr(a: Aff): string {
  const parts: string[] = [];
  if (!fIsZero(a.c)) parts.push(fStr(a.c));
  for (const [k, v] of Object.entries(a.t)) {
    if (fIsZero(v)) continue;
    const c = fStr(v);
    parts.push(c === '1' ? k : c === '-1' ? `-${k}` : `${c}·${k}`);
  }
  if (parts.length === 0) return '0';
  let s = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    s += p.startsWith('-') ? ` - ${p.slice(1)}` : ` + ${p}`;
  }
  return s;
}

// ── Monomial: a product ∏ scaleVar^(Aff exponent). Sums of monomials are handled at the bound level. ──
export type Mono = Record<string, Aff>; // scaleVar -> exponent
function mMul(a: Mono, b: Mono): Mono {
  const r: Mono = {};
  for (const [k, v] of Object.entries(a)) r[k] = v;
  for (const [k, v] of Object.entries(b)) r[k] = r[k] ? aAdd(r[k], v) : v;
  for (const k of Object.keys(r)) if (aIsZero(r[k])) delete r[k];
  return r;
}
function mPow(a: Mono, e: Frac): Mono {
  const r: Mono = {};
  for (const [k, v] of Object.entries(a)) {
    const nv = aScale(v, e);
    if (!aIsZero(nv)) r[k] = nv;
  }
  return r;
}
function mDiv(a: Mono, b: Mono): Mono {
  return mMul(a, mPow(b, fr(-1)));
}
export function mStr(m: Mono, scale: string[]): string {
  const ks = Object.keys(m).sort((x, y) => scale.indexOf(x) - scale.indexOf(y));
  if (ks.length === 0) return '1';
  return ks
    .map((k) => {
      const e = m[k];
      const cv = aConstVal(e);
      if (cv && cv.n === 1 && cv.d === 1) return k;
      return `${k}^(${aStr(e)})`;
    })
    .join('·');
}

// ── Parser: a product/quotient of powers. Exponents may be affine in params (e.g. N^(1-B), L^-A). ──
// Grammar (one MONOMIAL, no '+' at the top level — sums live in the `terms` array):
//   mono   := factor ( ('*' | '/') factor )*
//   factor := atom ( '^' power )?
//   atom   := IDENT | NUMBER | '(' mono ')'
//   power  := affine expression in numbers and params: NUMBER | IDENT | '(' affine ')' | -power | n*IDENT
// log N is written `L` (alias: logN, log(N), lnN).
class Parser {
  private s: string;
  private i = 0;
  constructor(
    src: string,
    private scale: Set<string>,
    private params: Set<string>,
  ) {
    // normalise the common ways to write log N → L, and strip spaces.
    this.s = src
      .replace(/\blog\s*\(\s*N\s*\)/gi, 'L')
      .replace(/\bln\s*\(\s*N\s*\)/gi, 'L')
      .replace(/\blog\s*N\b/gi, 'L')
      .replace(/\blogN\b/gi, 'L')
      .replace(/\s+/g, '');
  }
  private peek(): string {
    return this.s[this.i] ?? '';
  }
  private eof(): boolean {
    return this.i >= this.s.length;
  }
  private ident(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i));
    if (!m) throw new Error(`expected an identifier at "${this.s.slice(this.i, this.i + 8)}"`);
    this.i += m[0].length;
    return m[0];
  }
  private number(): Frac {
    const m = /^[0-9]+(\.[0-9]+)?/.exec(this.s.slice(this.i));
    if (!m) throw new Error(`expected a number at "${this.s.slice(this.i, this.i + 8)}"`);
    this.i += m[0].length;
    return fr(parseFloat(m[0]));
  }

  parseMono(): Mono {
    let m = this.parseFactor();
    while (!this.eof()) {
      const op = this.peek();
      if (op === '*') {
        this.i++;
        m = mMul(m, this.parseFactor());
      } else if (op === '/') {
        this.i++;
        m = mDiv(m, this.parseFactor());
      } else break;
    }
    return m;
  }
  private parseFactor(): Mono {
    const base = this.parseAtom();
    if (this.peek() === '^') {
      this.i++;
      const e = this.parsePowerAffine();
      return mPowAff(base, e);
    }
    return base;
  }
  private parseAtom(): Mono {
    const c = this.peek();
    if (c === '(') {
      this.i++;
      const m = this.parseMono();
      if (this.peek() !== ')') throw new Error('missing ")"');
      this.i++;
      return m;
    }
    if (/[0-9.]/.test(c)) {
      const n = this.number();
      // a bare number is dimensionless (magnitude 1) UNLESS it carries an exponent handled by caller;
      // we treat numeric literals as O(1) — they do not affect the order of growth.
      if (n.n !== 0) return {}; // O(1)
      return {};
    }
    // identifier → a scale variable (exponent 1) we will raise via '^' in parseFactor.
    const id = this.ident();
    if (this.params.has(id)) {
      throw new Error(`"${id}" is a parameter, not a magnitude — parameters may only appear in exponents (e.g. L^-${id})`);
    }
    if (!this.scale.has(id)) {
      throw new Error(`unknown symbol "${id}" — add it to "scale" (a growth variable) or "params" (a real knob used in exponents)`);
    }
    return { [id]: aConst(fr(1)) };
  }
  // exponent after '^'. '^' binds tighter than '*'/'+', so a BARE power is a single signed atom
  // (N^2, L^-A, N^-1); multi-term exponents must be parenthesised (N^(1-B), N^(2*t), N^(3/2)).
  private parsePowerAffine(): Aff {
    if (this.peek() === '(') {
      this.i++;
      const a = this.parseAffineExpr();
      if (this.peek() !== ')') throw new Error('missing ")" in exponent');
      this.i++;
      return a;
    }
    return this.parseAffineAtom();
  }
  // a single signed atom: -A | +2 | A | 3 (NO '*' '/' '+' '-' chaining — those require parentheses).
  private parseAffineAtom(): Aff {
    let sign = fr(1);
    while (this.peek() === '-' || this.peek() === '+') {
      if (this.peek() === '-') sign = fMul(sign, fr(-1));
      this.i++;
    }
    const c = this.peek();
    if (/[0-9.]/.test(c)) return aConst(fMul(this.number(), sign));
    const id = this.ident();
    if (!this.params.has(id)) throw new Error(`"${id}" in an exponent must be a declared param`);
    return { c: F0, t: { [id]: sign } };
  }
  // full affine expression (only inside parentheses): terms with +/-, each a */÷ chain.
  private parseAffineExpr(): Aff {
    let a = this.parseAffineMul();
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.peek();
      this.i++;
      const t = this.parseAffineMul();
      a = op === '+' ? aAdd(a, t) : aSub(a, t);
    }
    return a;
  }
  private parseAffineMul(): Aff {
    let sign = fr(1);
    while (this.peek() === '-' || this.peek() === '+') {
      if (this.peek() === '-') sign = fMul(sign, fr(-1));
      this.i++;
    }
    let coeff = fr(1);
    let param: string | null = null;
    const grab = () => {
      const c = this.peek();
      if (c === '(') {
        this.i++;
        const inner = this.parseAffineExpr();
        if (this.peek() !== ')') throw new Error('missing ")" in exponent');
        this.i++;
        const cv = aConstVal(inner);
        if (cv) coeff = fMul(coeff, cv);
        else if (!param && Object.keys(inner.t).length === 1 && fIsZero(inner.c)) {
          const [p, k] = Object.entries(inner.t)[0];
          param = p;
          coeff = fMul(coeff, k);
        } else throw new Error('exponent must be affine (no param·param)');
      } else if (/[0-9.]/.test(c)) {
        coeff = fMul(coeff, this.number());
      } else {
        const id = this.ident();
        if (!this.params.has(id)) throw new Error(`"${id}" in an exponent must be a declared param`);
        if (param) throw new Error('exponent must be affine (no param·param)');
        param = id;
      }
    };
    grab();
    while (this.peek() === '*' || this.peek() === '/') {
      const op = this.peek();
      this.i++;
      if (op === '/') {
        if (!/[0-9.]/.test(this.peek())) throw new Error('exponent division must be by a number (e.g. A/2, 3/2)');
        const num = this.number();
        coeff = fMul(coeff, fr(num.d, num.n)); // × 1/num
      } else grab();
    }
    coeff = fMul(coeff, sign);
    return param ? { c: F0, t: { [param]: coeff } } : aConst(coeff);
  }
}
// raise a monomial base to an affine power; only legal when the base is a single scale var.
function mPowAff(base: Mono, e: Aff): Mono {
  const ks = Object.keys(base);
  if (ks.length === 1 && aConstVal(base[ks[0]])?.n === 1 && aConstVal(base[ks[0]])?.d === 1) {
    return { [ks[0]]: e };
  }
  if (ks.length === 0) return {}; // O(1)^anything = O(1)
  const cv = eAsFrac(e, 'exponent on a composite base must be constant');
  if (cv) return mPow(base, cv);
  throw new Error('an affine (parameter) exponent is only allowed directly on a single scale variable, e.g. N^(1-B) or L^-A');
}
function eAsFrac(e: Aff, _msg: string): Frac | null {
  return aConstVal(e);
}
export function parseMagnitude(src: string, scale: string[], params: string[]): Mono {
  const p = new Parser(src, new Set(scale), new Set(params));
  const m = (p as unknown as { parseMono(): Mono }).parseMono();
  if (!(p as unknown as { eof(): boolean }).eof())
    throw new Error(`unexpected trailing input in "${src}" (a magnitude is a single product/quotient of powers; put summands in "terms")`);
  return m;
}

// ── Lexicographic comparison on the growth scale (scale[0] grows fastest) ─────────────────────────
// diff(target, term)[i] = exp_target(scale_i) − exp_term(scale_i). term = o(target) ⟺ diff >_lex 0.
function diffVec(target: Mono, term: Mono, scale: string[]): Aff[] {
  return scale.map((s) => aSub(target[s] ?? aConst(F0), term[s] ?? aConst(F0)));
}

// ── Linear feasibility (Fourier–Motzkin with witness) over the params ────────────────────────────
// Constraint: Σ coeff_v · v + c  OP  0, OP ∈ {'>','>=','='}.
interface Lin {
  coeff: Record<string, Frac>;
  c: Frac;
  op: '>' | '>=' | '=';
}
function linEval(l: Lin, point: Record<string, Frac>): Frac {
  let s = l.c;
  for (const [v, k] of Object.entries(l.coeff)) s = fAdd(s, fMul(k, point[v] ?? F0));
  return s;
}
// Returns a satisfying assignment or null. Exact; intended for a handful of params/constraints.
function solveLinear(consIn: Lin[], varsIn: string[]): Record<string, Frac> | null {
  // 1. use equalities to eliminate variables by substitution.
  const subst: Record<string, Lin> = {}; // var -> expression (as a Lin with op '=', that var removed)
  let cons = consIn.map((l) => ({ coeff: { ...l.coeff }, c: l.c, op: l.op }) as Lin);
  let vars = [...varsIn];
  let changed = true;
  while (changed) {
    changed = false;
    const eqIdx = cons.findIndex((l) => l.op === '=' && Object.values(l.coeff).some((k) => !fIsZero(k)));
    if (eqIdx < 0) break;
    const eq = cons[eqIdx];
    const v = Object.keys(eq.coeff).find((k) => !fIsZero(eq.coeff[k]))!;
    const kv = eq.coeff[v];
    // v = -(Σ_{u≠v} coeff_u u + c) / kv
    const expr: Lin = { coeff: {}, c: fNeg(fMul(eq.c, fr(1, 1))), op: '=' };
    expr.c = fMul(eq.c, fr(-1));
    for (const [u, k] of Object.entries(eq.coeff)) if (u !== v) expr.coeff[u] = fMul(k, fr(-1));
    const inv = fr(kv.d, kv.n); // 1/kv
    expr.c = fMul(expr.c, inv);
    for (const u of Object.keys(expr.coeff)) expr.coeff[u] = fMul(expr.coeff[u], inv);
    subst[v] = expr;
    // substitute v out of all constraints
    cons = cons
      .filter((_, idx) => idx !== eqIdx)
      .map((l) => {
        if (!l.coeff[v] || fIsZero(l.coeff[v])) return l;
        const k = l.coeff[v];
        const nc: Record<string, Frac> = { ...l.coeff };
        delete nc[v];
        for (const [u, ku] of Object.entries(expr.coeff)) nc[u] = fAdd(nc[u] ?? F0, fMul(k, ku));
        for (const u of Object.keys(nc)) if (fIsZero(nc[u])) delete nc[u];
        return { coeff: nc, c: fAdd(l.c, fMul(k, expr.c)), op: l.op };
      });
    vars = vars.filter((x) => x !== v);
    changed = true;
  }
  // any remaining pure-equality with nonzero const and no vars → contradiction
  for (const l of cons) {
    if (Object.values(l.coeff).every((k) => fIsZero(k))) {
      const s = fSign(l.c);
      if (l.op === '=' && s !== 0) return null;
      if (l.op === '>' && s <= 0) return null;
      if (l.op === '>=' && s < 0) return null;
    }
  }
  let ineqs = cons.filter((l) => Object.values(l.coeff).some((k) => !fIsZero(k)));
  // 2. Fourier–Motzkin: eliminate vars one by one, recording bounds for back-substitution.
  const order = [...vars];
  const elimSteps: Array<{ v: string; lowers: Lin[]; uppers: Lin[] }> = [];
  for (const v of order) {
    const lowers: Lin[] = []; // v >= expr  (coeff_v > 0 after normalising to v on the left)
    const uppers: Lin[] = []; // v <= expr  (coeff_v < 0)
    const rest: Lin[] = [];
    for (const l of ineqs) {
      const kv = l.coeff[v];
      if (!kv || fIsZero(kv)) {
        rest.push(l);
        continue;
      }
      if (fSign(kv) > 0) lowers.push(l);
      else uppers.push(l);
    }
    // combine every lower with every upper into a v-free constraint
    const combined: Lin[] = [...rest];
    for (const lo of lowers) {
      for (const up of uppers) {
        // lo: a·v + R1 (op1) 0 with a>0  → v (op1) -R1/a
        // up: b·v + R2 (op2) 0 with b<0  → v (op2flip) -R2/b
        // eliminate: a·up - ... ; do (−b)·lo + a·up? Standard: scale to clear v.
        const a = lo.coeff[v];
        const b = up.coeff[v]; // negative
        // (-b)*lo + a*up  removes v (since (-b)*a + a*b = 0)
        const s1 = fNeg(b);
        const s2 = a;
        const nc: Record<string, Frac> = {};
        for (const [u, k] of Object.entries(lo.coeff)) if (u !== v) nc[u] = fAdd(nc[u] ?? F0, fMul(k, s1));
        for (const [u, k] of Object.entries(up.coeff)) if (u !== v) nc[u] = fAdd(nc[u] ?? F0, fMul(k, s2));
        for (const u of Object.keys(nc)) if (fIsZero(nc[u])) delete nc[u];
        const c = fAdd(fMul(lo.c, s1), fMul(up.c, s2));
        const op: Lin['op'] = lo.op === '>' || up.op === '>' ? '>' : '>=';
        const comb: Lin = { coeff: nc, c, op };
        if (Object.values(nc).every((k) => fIsZero(k))) {
          const sgn = fSign(c);
          if (op === '>' && sgn <= 0) return null;
          if (op === '>=' && sgn < 0) return null;
        } else combined.push(comb);
      }
    }
    elimSteps.push({ v, lowers, uppers });
    ineqs = combined;
  }
  // final residual constraints (no vars) already checked during elimination; assign back.
  const point: Record<string, Frac> = {};
  for (let s = elimSteps.length - 1; s >= 0; s--) {
    const { v, lowers, uppers } = elimSteps[s];
    let lo: { val: Frac; strict: boolean } | null = null;
    let up: { val: Frac; strict: boolean } | null = null;
    for (const l of lowers) {
      // a·v + R (op) 0, a>0 → v (op) -R/a ; here it's a LOWER bound v >= -R/a
      const a = l.coeff[v];
      let R = l.c;
      for (const [u, k] of Object.entries(l.coeff)) if (u !== v) R = fAdd(R, fMul(k, point[u] ?? F0));
      const val = fMul(R, fr(-a.d, a.n)); // -R/a
      const strict = l.op === '>';
      if (!lo || fCmp(val, lo.val) > 0 || (fCmp(val, lo.val) === 0 && strict)) lo = { val, strict };
    }
    for (const l of uppers) {
      const a = l.coeff[v]; // negative
      let R = l.c;
      for (const [u, k] of Object.entries(l.coeff)) if (u !== v) R = fAdd(R, fMul(k, point[u] ?? F0));
      const val = fMul(R, fr(-a.d, a.n)); // -R/a (a<0 → flips to upper bound)
      const strict = l.op === '>';
      if (!up || fCmp(val, up.val) < 0 || (fCmp(val, up.val) === 0 && strict)) up = { val, strict };
    }
    let pick: Frac;
    if (lo && up) {
      const c = fCmp(lo.val, up.val);
      if (c > 0) return null;
      if (c === 0) {
        if (lo.strict || up.strict) return null;
        pick = lo.val;
      } else pick = fMul(fAdd(lo.val, up.val), fr(1, 2)); // midpoint
    } else if (lo) pick = lo.strict ? fAdd(lo.val, fr(1)) : lo.val;
    else if (up) pick = up.strict ? fSub(up.val, fr(1)) : up.val;
    else pick = F0;
    point[v] = pick;
  }
  for (const [v, expr] of Object.entries(subst)) point[v] = linEval({ ...expr, op: '=' }, point);
  return point;
}

// ── Domain parsing for free params: { A: {gt: 0}, kappa: {ge: 0, le: 1} } or concrete { A: 4 } ────
export interface ParamDomain {
  gt?: number;
  ge?: number;
  lt?: number;
  le?: number;
  eq?: number;
}
function domainCons(name: string, d: ParamDomain): Lin[] {
  const out: Lin[] = [];
  if (d.eq !== undefined) out.push({ coeff: { [name]: fr(1) }, c: fr(-d.eq), op: '=' });
  if (d.gt !== undefined) out.push({ coeff: { [name]: fr(1) }, c: fr(-d.gt), op: '>' });
  if (d.ge !== undefined) out.push({ coeff: { [name]: fr(1) }, c: fr(-d.ge), op: '>=' });
  if (d.lt !== undefined) out.push({ coeff: { [name]: fr(-1) }, c: fr(d.lt), op: '>' });
  if (d.le !== undefined) out.push({ coeff: { [name]: fr(-1) }, c: fr(d.le), op: '>=' });
  return out;
}

// ── closes(): does Σ terms beat target? Free params → ∃-feasibility (the parameter-coordination check) ──
export type Relation = 'o' | 'O' | 'Theta';
export interface TermVerdict {
  term: string;
  mono: string;
  // the lexicographically-leading nonzero exponent difference (target − term)
  leading: { scale: string; diff: string } | null;
  // for a fully-numeric (no free param) comparison: a definite per-term relation
  numeric: 'smaller' | 'equal' | 'larger' | null;
}
export interface ClosesResult {
  ok: boolean; // parse/logic ok
  relation: Relation;
  target: string;
  closes: boolean | 'depends';
  witness: Record<string, string> | null; // example parameter assignment that closes it (∃ mode)
  obstruction: string | null; // when it cannot close: the binding reason
  terms: TermVerdict[];
  note: string;
}

export function closes(
  targetSrc: string,
  termSrcs: string[],
  scale: string[],
  params: Record<string, ParamDomain | number>,
  relation: Relation,
): ClosesResult {
  const paramNames = Object.keys(params);
  const target = parseMagnitude(targetSrc, scale, paramNames);
  const domains: Record<string, ParamDomain> = {};
  for (const [k, v] of Object.entries(params)) domains[k] = typeof v === 'number' ? { eq: v } : v;
  const domConstraints = paramNames.flatMap((p) => domainCons(p, domains[p]));
  const hasFreeParams = paramNames.some((p) => domains[p].eq === undefined);

  const termVerdicts: TermVerdict[] = [];
  // We need EVERY term to beat the target (for o/O); Theta additionally needs at least one to match order.
  // For ∃-feasibility we OR over which scale position each term wins at; intersect across terms.
  // Build, per term, the list of alternative constraint-sets (one per leading position) and combine.
  const perTermAlternatives: Lin[][][] = [];

  for (const src of termSrcs) {
    const term = parseMagnitude(src, scale, paramNames);
    const dv = diffVec(target, term, scale); // target − term, per scale position
    // record the leading nonzero difference for reporting (constant-resolved where possible)
    let leading: TermVerdict['leading'] = null;
    let numeric: TermVerdict['numeric'] = null;
    for (let i = 0; i < dv.length; i++) {
      if (!aIsZero(dv[i])) {
        leading = { scale: scale[i], diff: aStr(dv[i]) };
        const cv = aConstVal(dv[i]);
        if (cv) numeric = fSign(cv) > 0 ? 'smaller' : 'larger'; // diff>0 → term smaller than target
        break;
      }
    }
    if (leading === null) numeric = 'equal';
    termVerdicts.push({ term: src, mono: mStr(term, scale), leading, numeric });

    // alternatives: term `relation` target.
    //  - 'o': diff >_lex 0  →  OR_k [ d_0=…=d_{k-1}=0  ∧  d_k > 0 ]
    //  - 'O': diff >=_lex 0 →  the above, plus the all-zero (equal) case as a non-strict alternative
    const alts: Lin[][] = [];
    for (let k = 0; k < dv.length; k++) {
      const conj: Lin[] = [];
      for (let j = 0; j < k; j++) conj.push(affToLin(dv[j], '='));
      conj.push(affToLin(dv[k], '>'));
      alts.push(conj);
    }
    if (relation === 'O' || relation === 'Theta') {
      // equal-order alternative: all differences zero
      const conj: Lin[] = dv.map((d) => affToLin(d, '='));
      alts.push(conj);
    }
    perTermAlternatives.push(alts);
  }

  // Fully numeric (no free params): decide directly from the per-term numeric verdicts.
  if (!hasFreeParams) {
    const bad = termVerdicts.find((t) => (relation === 'o' ? t.numeric !== 'smaller' : t.numeric === 'larger'));
    const closesNum = !bad;
    return {
      ok: true,
      relation,
      target: mStr(target, scale),
      closes: closesNum,
      witness: closesNum && paramNames.length ? numericWitness(domains) : null,
      obstruction: bad
        ? `term ${bad.term} (=${bad.mono}) is ${bad.numeric} than the target at scale ${bad.leading?.scale ?? '—'} — it does not beat ${mStr(target, scale)}`
        : null,
      terms: termVerdicts,
      note: 'All parameters are fixed to concrete values; verdict is exact.',
    };
  }

  // Free params: search the cross product of per-term alternatives for ONE jointly-feasible combination.
  const witness = searchFeasible(perTermAlternatives, domConstraints, paramNames);
  if (witness) {
    return {
      ok: true,
      relation,
      target: mStr(target, scale),
      closes: true,
      witness: Object.fromEntries(Object.entries(witness).map(([k, v]) => [k, fStr(v)])),
      obstruction: null,
      terms: termVerdicts,
      note: 'A parameter choice exists that makes every term beat the target (witness shown). The bound SHAPES still need analytic justification.',
    };
  }
  // Infeasible → find the binding obstruction: a term whose dominant-scale exponent cannot be brought
  // below the target for any params in domain (the honest "this gap cannot be closed by tuning" verdict).
  const obstr = findObstruction(target, termSrcs, scale, paramNames, domConstraints);
  return {
    ok: true,
    relation,
    target: mStr(target, scale),
    closes: false,
    witness: null,
    obstruction: obstr,
    terms: termVerdicts,
    note: 'No choice of the free parameters (within their domains) makes the bounds compose to beat the target. This is a structural gap, not a tuning issue — a genuinely sharper bound (new idea) is required.',
  };
}

function affToLin(a: Aff, op: Lin['op']): Lin {
  return { coeff: { ...a.t }, c: a.c, op };
}
function numericWitness(domains: Record<string, ParamDomain>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, d] of Object.entries(domains)) if (d.eq !== undefined) out[k] = String(d.eq);
  return out;
}
function searchFeasible(perTerm: Lin[][][], dom: Lin[], vars: string[]): Record<string, Frac> | null {
  // cross product of one alternative per term
  function rec(i: number, acc: Lin[]): Record<string, Frac> | null {
    if (i === perTerm.length) return solveLinear([...acc, ...dom], vars);
    for (const alt of perTerm[i]) {
      const r = rec(i + 1, [...acc, ...alt]);
      if (r) return r;
    }
    return null;
  }
  return rec(0, []);
}
function findObstruction(
  target: Mono,
  termSrcs: string[],
  scale: string[],
  paramNames: string[],
  dom: Lin[],
): string {
  // A term is an unfixable obstruction if it cannot even be made o(target) at the DOMINANT scale:
  // i.e. there is no param choice with target_exp(scale0) − term_exp(scale0) > 0.
  for (const src of termSrcs) {
    const term = parseMagnitude(src, scale, paramNames);
    const dv = diffVec(target, term, scale);
    // can we make the leading position strictly positive at all? try each position as the decider.
    const alts: Lin[][] = [];
    for (let k = 0; k < dv.length; k++) {
      const conj: Lin[] = [];
      for (let j = 0; j < k; j++) conj.push(affToLin(dv[j], '='));
      conj.push(affToLin(dv[k], '>'));
      alts.push(conj);
    }
    const feasibleAlone = alts.some((a) => solveLinear([...a, ...dom], paramNames));
    if (!feasibleAlone) {
      const d0 = dv[0];
      const cv = aConstVal(d0);
      const at =
        cv && fSign(cv) <= 0
          ? `at the dominant scale ${scale[0]} the exponent gap is ${aStr(d0)} (≤ 0): the term is at least the order of the target there, for ANY parameter value`
          : `no parameter choice in the given domains brings it below the target`;
      return `term ${src} cannot be made o(${mStr(target, scale)}) — ${at}.`;
    }
  }
  return 'the terms cannot be made jointly smaller than the target (coupled parameter constraints conflict).';
}

// ── The tool ──────────────────────────────────────────────────────────────────────────────────────
function fmtTerms(r: ClosesResult): string {
  return r.terms
    .map((t) => {
      const lead = t.leading ? ` [leading ${t.leading.scale}-gap: ${t.leading.diff}]` : ' [equal order]';
      const num = t.numeric ? ` (${t.numeric} than target)` : '';
      return `  • ${t.term}  ⇒  ${t.mono}${lead}${num}`;
    })
    .join('\n');
}

export const magnitudeTool: Tool = {
  name: 'magnitude',
  description:
    'Asymptotic magnitude algebra — do the epsilon/order-of-growth arithmetic you must NOT keep in your head. ' +
    'Quantities are products of powers of growth variables (default N and L=log N; you may declare more), with rational ' +
    'or parameter-dependent exponents (e.g. N^(3/2)*L^-A). Three actions:\n' +
    "  • simplify: normalise one expression into an exponent vector (sanity-check a magnitude).\n" +
    "  • compare:  is X = o(Y) / O(Y) / Theta(Y)?  (lexicographic on the growth scale, N before log N).\n" +
    "  • closes:   given a target and a SUM of contributing bounds (terms[]), does the sum beat the target — and " +
    'if exponents contain free parameters (A,B,κ…), does a choice in their domain EXIST that closes it? ' +
    'It returns a witness assignment when it closes, or the binding obstruction when it cannot (e.g. a minor-arc ' +
    'term whose N-exponent exceeds the target for any parameter — the honest "this gap needs a new idea" verdict).\n' +
    'It reasons about ORDERS only (never hidden constants): a "closes" verdict means the orders compose; each bound\'s ' +
    'shape still needs analytic justification (z3/pariGp/your reasoning).',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['simplify', 'compare', 'closes'], description: 'simplify | compare | closes' },
      scale: {
        type: 'array',
        items: { type: 'string' },
        description: 'Growth variables, FASTEST-growing first. Default ["N","L"] (L = log N). Add more if needed, e.g. ["N","Q","L"].',
      },
      params: {
        type: 'object',
        description:
          'Free parameters used in exponents, with their domain, e.g. {"A":{"gt":0},"kappa":{"ge":0,"le":1}}. ' +
          'A concrete value pins it: {"A":4}. Supported bounds: gt, ge, lt, le, eq.',
      },
      expr: { type: 'string', description: 'simplify: the single expression to normalise, e.g. "N^2/(log N)^3".' },
      x: { type: 'string', description: 'compare: left magnitude X.' },
      y: { type: 'string', description: 'compare: right magnitude Y.' },
      relation: { type: 'string', enum: ['o', 'O', 'Theta'], description: 'compare/closes target relation. Default "o" (strictly smaller order).' },
      target: { type: 'string', description: 'closes: the magnitude to beat, e.g. "N^2*L^-3".' },
      terms: { type: 'array', items: { type: 'string' }, description: 'closes: the contributing bounds whose sum must beat the target.' },
    },
    required: ['action'],
  },
  capability: 'execute',
  domain: 'local',
  async execute(params) {
    try {
      const action = String(params.action ?? '');
      const scale = Array.isArray(params.scale) && params.scale.length ? (params.scale as string[]).map(String) : ['N', 'L'];
      const pdecl = (params.params && typeof params.params === 'object' ? params.params : {}) as Record<string, ParamDomain | number>;
      const paramNames = Object.keys(pdecl);
      const relation = (['o', 'O', 'Theta'].includes(String(params.relation)) ? params.relation : 'o') as Relation;

      if (action === 'simplify') {
        const src = String(params.expr ?? '');
        if (!src.trim()) return { success: false, output: '', error: 'simplify needs "expr".' };
        const m = parseMagnitude(src, scale, paramNames);
        return { success: true, output: `${src}  ⇒  ${mStr(m, scale)}` };
      }

      if (action === 'compare') {
        const x = String(params.x ?? '');
        const y = String(params.y ?? '');
        if (!x.trim() || !y.trim()) return { success: false, output: '', error: 'compare needs "x" and "y".' };
        // X relation Y  ⟺  closes with target=Y, terms=[X]
        const r = closes(y, [x], scale, pdecl, relation);
        const verdict =
          r.closes === true
            ? `YES: ${x} = ${relation}(${y})`
            : `NO: ${x} is NOT ${relation}(${y})`;
        const wit = r.witness ? `\nwitness: ${JSON.stringify(r.witness)}` : '';
        const obs = r.obstruction ? `\nwhy: ${r.obstruction}` : '';
        return { success: true, output: `${verdict}\n${fmtTerms(r)}${wit}${obs}\n(${r.note})` };
      }

      if (action === 'closes') {
        const target = String(params.target ?? '');
        const terms = Array.isArray(params.terms) ? (params.terms as unknown[]).map(String).filter((s) => s.trim()) : [];
        if (!target.trim()) return { success: false, output: '', error: 'closes needs "target".' };
        if (!terms.length) return { success: false, output: '', error: 'closes needs a non-empty "terms" array.' };
        const r = closes(target, terms, scale, pdecl, relation);
        const head =
          r.closes === true
            ? `✅ CLOSES: Σ terms = ${relation}(${r.target})`
            : `❌ DOES NOT CLOSE: Σ terms is not ${relation}(${r.target})`;
        const wit = r.witness ? `\nwitness (a parameter choice that closes it): ${JSON.stringify(r.witness)}` : '';
        const obs = r.obstruction ? `\nobstruction: ${r.obstruction}` : '';
        return {
          success: true,
          output: `${head}\ntarget: ${r.target}\nterms:\n${fmtTerms(r)}${wit}${obs}\n\n${r.note}`,
        };
      }

      return { success: false, output: '', error: `unknown action "${action}" (simplify | compare | closes)` };
    } catch (e) {
      return { success: false, output: '', error: `magnitude error: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};
