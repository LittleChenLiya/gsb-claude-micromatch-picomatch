'use strict';

const parse = require('./parse');

/**
 * Budget keys supported by the budget compiler. See docs/budgets.md.
 */

const BUDGET_KEYS = ['maxBranches', 'maxExtglobDepth', 'maxRegexLength'];
const EXTGLOB_OPERATORS = new Set(['@', '*', '+', '?', '!']);
const RANGE_NUMERIC = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/;
const RANGE_ALPHA = /^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/;

/**
 * Error thrown when a pattern exceeds one of the configured budgets,
 * before any executable matcher is created.
 */

class BudgetError extends Error {
  constructor(dimension, limit, actual, range, pattern) {
    const source = pattern.slice(range.start, range.end);
    super(`picomatch budget exceeded: ${dimension} allows at most ${limit}, but the pattern requires ${actual} (source "${source}" at ${range.start}..${range.end})`);
    this.name = 'BudgetError';
    this.code = 'PICOMATCH_BUDGET_EXCEEDED';
    this.dimension = dimension;
    this.limit = limit;
    this.actual = actual;
    this.range = range;
    this.source = source;
    this.pattern = pattern;
  }
}

/**
 * Estimate the number of alternatives a brace range expands to,
 * using the real expansion rules (fill-range semantics) instead of
 * raw character counts. Returns 0 when the text is not a valid range.
 */

const rangeCount = text => {
  let m = RANGE_NUMERIC.exec(text);
  if (m) {
    const span = Math.abs(Number(m[2]) - Number(m[1]));
    const step = Math.abs(Number(m[3])) || 1;
    return Math.floor(span / step) + 1;
  }
  m = RANGE_ALPHA.exec(text);
  if (m) {
    const span = Math.abs(m[2].charCodeAt(0) - m[1].charCodeAt(0));
    const step = Math.abs(Number(m[3])) || 1;
    return Math.floor(span / step) + 1;
  }
  return 0;
};

/**
 * Lexically scan a glob pattern with the same rules the picomatch
 * parser uses for escapes, bracket classes, extglob operators, parens
 * and braces, and measure:
 *
 * - branches: the total number of alternation branches. Every paren or
 *   extglob group contributes (number of top-level `|` separators + 1)
 *   when it contains at least one `|`; every brace expansion contributes
 *   its estimated expansion count (comma parts and `a..b` ranges).
 * - extglobDepth: the maximum nesting depth of extglob groups
 *   (`@(...)`, `*(...)`, `+(...)`, `?(...)`, `!(...)`). Escaped
 *   parentheses and parentheses inside bracket classes never count.
 *
 * Source ranges ({ start, end } offsets into the pattern) are recorded
 * for every extglob group and every branch-contributing construct so
 * that budget violations can be located precisely.
 */

const scanPattern = pattern => {
  const stack = [];
  const extglobs = [];
  const constructs = [];
  const len = pattern.length;

  let branches = 0;
  let maxExtglobDepth = 0;
  let deepest = null;
  let openExtglobs = 0;
  let i = 0;

  const finalizeBracePart = (group, end) => {
    let count;
    if (group.hasNested) {
      count = group.partProduct;
    } else {
      const text = pattern.slice(group.partStart, end);
      const range = rangeCount(text);
      count = range > 0 ? range : 1;
    }
    group.parts.push(count);
  };

  while (i < len) {
    const ch = pattern[i];

    // Escaped characters are literal: \( \) \{ \[ \@ ... never
    // open or close any group.
    if (ch === '\\') {
      i += 2;
      continue;
    }

    // Bracket class contents are literal: parens, braces and pipes
    // inside [...] never count as groups or branches.
    if (ch === '[') {
      let j = i + 1;
      if (pattern[j] === '!' || pattern[j] === '^') j++;
      if (pattern[j] === ']') j++;
      let closed = false;
      while (j < len) {
        if (pattern[j] === '\\') {
          j += 2;
          continue;
        }
        if (pattern[j] === ']') {
          closed = true;
          break;
        }
        j++;
      }
      i = closed ? j + 1 : i + 1;
      continue;
    }

    const top = stack[stack.length - 1];

    // Extglob openers: @( *( +( ?( !(
    if (EXTGLOB_OPERATORS.has(ch) && pattern[i + 1] === '(') {
      const group = { kind: 'extglob', start: i, pipes: 0, depth: ++openExtglobs, end: len };
      stack.push(group);
      if (group.depth > maxExtglobDepth) {
        maxExtglobDepth = group.depth;
        deepest = group;
      }
      i += 2;
      continue;
    }

    if (ch === '(') {
      stack.push({ kind: 'paren', start: i, pipes: 0 });
      i++;
      continue;
    }

    if (ch === ')') {
      if (top && (top.kind === 'paren' || top.kind === 'extglob')) {
        stack.pop();
        top.end = i + 1;
        if (top.kind === 'extglob') {
          openExtglobs--;
          extglobs.push({ start: top.start, end: top.end, depth: top.depth });
        }
        if (top.pipes > 0) {
          const alternatives = top.pipes + 1;
          branches += alternatives;
          constructs.push({ kind: 'alternation', start: top.start, end: top.end, alternatives });
        }
      }
      i++;
      continue;
    }

    if (ch === '|') {
      if (top && (top.kind === 'paren' || top.kind === 'extglob')) {
        top.pipes++;
      }
      i++;
      continue;
    }

    if (ch === '{') {
      stack.push({
        kind: 'brace',
        start: i,
        commas: 0,
        parts: [],
        partStart: i + 1,
        partProduct: 1,
        hasNested: false
      });
      i++;
      continue;
    }

    if (ch === ',') {
      if (top && top.kind === 'brace') {
        finalizeBracePart(top, i);
        top.commas++;
        top.partStart = i + 1;
        top.partProduct = 1;
        top.hasNested = false;
      }
      i++;
      continue;
    }

    if (ch === '}') {
      if (top && top.kind === 'brace') {
        stack.pop();
        finalizeBracePart(top, i);
        const count = top.commas === 0
          ? top.parts[0]
          : top.parts.reduce((sum, n) => sum + n, 0);
        if (count > 1) {
          branches += count;
          constructs.push({ kind: 'brace', start: top.start, end: i + 1, alternatives: count });
        }
        const parent = stack[stack.length - 1];
        if (parent && parent.kind === 'brace') {
          parent.hasNested = true;
          parent.partProduct *= count;
        }
      }
      i++;
      continue;
    }

    i++;
  }

  // Record extglob groups that were never closed (malformed patterns)
  for (const group of stack) {
    if (group.kind === 'extglob') {
      extglobs.push({ start: group.start, end: len, depth: group.depth });
    }
  }

  return {
    branches,
    maxExtglobDepth,
    deepestExtglob: deepest ? { start: deepest.start, end: deepest.end } : null,
    extglobs,
    constructs
  };
};

/**
 * Compute the exact regex source string picomatch would generate for
 * the pattern (mirroring picomatch.makeRe + picomatch.compileRe),
 * without constructing the RegExp object itself.
 */

const regexSource = (pattern, options) => {
  const opts = options || {};
  let parsed = { negated: false, fastpaths: true };

  if (opts.fastpaths !== false && (pattern[0] === '.' || pattern[0] === '*')) {
    parsed.output = parse.fastpaths(pattern, opts);
  }

  if (!parsed.output) {
    parsed = parse(pattern, opts);
  }

  const prepend = opts.contains ? '' : '^';
  const append = opts.contains ? '' : '$';

  let source = `${prepend}(?:${parsed.output})${append}`;
  if (parsed && parsed.negated === true) {
    source = `^(?!${source}).*$`;
  }
  return source;
};

/**
 * Analyze a pattern against the three budget dimensions. Returns a
 * report: { pattern, branches, extglobDepth, regexLength, regexSource,
 * deepestExtglob, extglobs, constructs }.
 */

const analyze = (pattern, options = {}) => {
  if (typeof pattern !== 'string' || pattern === '') {
    throw new TypeError('Expected pattern to be a non-empty string');
  }
  const scan = scanPattern(pattern);
  const source = regexSource(pattern, options);
  return {
    pattern,
    branches: scan.branches,
    extglobDepth: scan.maxExtglobDepth,
    regexLength: source.length,
    regexSource: source,
    deepestExtglob: scan.deepestExtglob,
    extglobs: scan.extglobs,
    constructs: scan.constructs
  };
};

/**
 * Validate a report against a budget. Throws a BudgetError (with the
 * exact source range that caused the violation) when any configured
 * budget is exceeded. Returns the report unchanged otherwise.
 */

const check = (report, budget = {}) => {
  for (const key of BUDGET_KEYS) {
    if (budget[key] !== undefined && (typeof budget[key] !== 'number' || budget[key] < 0 || !Number.isFinite(budget[key]))) {
      throw new TypeError(`Expected budget "${key}" to be a non-negative finite number`);
    }
  }

  if (budget.maxExtglobDepth !== undefined && report.extglobDepth > budget.maxExtglobDepth) {
    const range = report.deepestExtglob || { start: 0, end: report.pattern.length };
    throw new BudgetError('maxExtglobDepth', budget.maxExtglobDepth, report.extglobDepth, range, report.pattern);
  }

  if (budget.maxBranches !== undefined && report.branches > budget.maxBranches) {
    let acc = 0;
    let culprit = null;
    for (const construct of report.constructs) {
      acc += construct.alternatives;
      if (acc > budget.maxBranches) {
        culprit = construct;
        break;
      }
    }
    const range = culprit ? { start: culprit.start, end: culprit.end } : { start: 0, end: report.pattern.length };
    throw new BudgetError('maxBranches', budget.maxBranches, report.branches, range, report.pattern);
  }

  if (budget.maxRegexLength !== undefined && report.regexLength > budget.maxRegexLength) {
    const range = { start: 0, end: report.pattern.length };
    throw new BudgetError('maxRegexLength', budget.maxRegexLength, report.regexLength, range, report.pattern);
  }

  return report;
};

/**
 * Explicit budget compile entry: analyze the pattern, enforce the
 * budget, and only then create the executable matcher through the
 * regular picomatch interface. Match results are therefore identical
 * to `picomatch(pattern, options)`.
 *
 * ```js
 * const isMatch = picomatch.budget('@(a|@(b|c))', {}, { maxExtglobDepth: 1 });
 * //=> throws BudgetError before any matcher is created
 * ```
 */

const compile = (pattern, options, budget, createMatcher) => {
  if (budget === undefined && options && typeof options === 'object'
    && BUDGET_KEYS.some(key => options[key] !== undefined)) {
    budget = options;
    options = {};
  }

  const report = analyze(pattern, options || {});
  check(report, budget || {});

  const fn = createMatcher || require('./picomatch');
  const matcher = fn(pattern, options);
  matcher.budgetReport = report;
  return matcher;
};

module.exports = { analyze, check, compile, scanPattern, regexSource, BudgetError, BUDGET_KEYS };
