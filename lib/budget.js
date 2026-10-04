'use strict';

const parse = require('./parse');
const utils = require('./utils');

const DEFAULT_MAX_BRANCHES = 25;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_REGEX_LENGTH = 2000;

class BudgetError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'BudgetError';
    this.details = details;
  }
}

const estimateRangeCost = (brace, input, options) => {
  const content = input.slice(brace.start + 1, brace.end);
  const dot = content.indexOf('..');
  if (dot === -1) return 0;
  const left = content.slice(0, dot);
  const right = content.slice(dot + 2);
  const args = [left, right];
  if (typeof options.expandRange === 'function') {
    try {
      const expanded = options.expandRange(...args, options);
      if (typeof expanded === 'string') return expanded.length;
    } catch (err) { /* fall through */ }
  }
  args.sort();
  const value = '[' + args.join('-') + ']';
  try {
    // Mirror picomatch's own validation: if the class is invalid it falls
    // back to escaped literals joined by `..`.
    const re = new RegExp(value);
    void re;
    return value.length;
  } catch (ex) {
    return args.map(v => utils.escapeRegex(v)).join('..').length;
  }
};

const walkInput = (input, options) => {
  const extglobs = [];
  const braces = [];
  let totalBranches = 0;
  let maxDepth = 0;
  const stack = [];
  let escaped = false;
  let bracket = 0;
  let quote = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped === true) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { quote = quote === 1 ? 0 : 1; continue; }
    if (quote === 1) continue;
    if (ch === '[') { bracket++; continue; }
    if (ch === ']' && bracket > 0) { bracket--; continue; }
    if (bracket > 0) continue;
    if ((ch === '@' || ch === '+' || ch === '*' || ch === '?' || ch === '!') && input[i + 1] === '(') {
      const depth = stack.filter(f => f.type === 'extglob').length + 1;
      const frame = { type: 'extglob', extglobType: ch, start: i, depth, branches: 0 };
      stack.push(frame);
      if (depth > maxDepth) maxDepth = depth;
      i++;
      continue;
    }
    if (ch === '(') { stack.push({ type: 'paren', start: i }); continue; }
    if (ch === ')') {
      const frame = stack.pop();
      if (frame && frame.type === 'extglob') {
        frame.end = i;
        frame.branchCount = frame.branches + 1;
        extglobs.push(frame);
        totalBranches += frame.branchCount;
      }
      continue;
    }
    if (ch === '{') { stack.push({ type: 'brace', start: i, commas: 0, isRange: false }); continue; }
    if (ch === '}') {
      let braceIdx = -1;
      for (let j = stack.length - 1; j >= 0; j--) {
        if (stack[j].type === 'brace') { braceIdx = j; break; }
      }
      if (braceIdx >= 0) {
        const brace = stack.splice(braceIdx, 1)[0];
        brace.end = i;
        if (brace.isRange === true) {
          brace.cost = estimateRangeCost(brace, input, options);
        } else {
          brace.branches = brace.commas + 1;
          brace.cost = brace.branches;
          totalBranches += brace.branches;
        }
        braces.push(brace);
      }
      continue;
    }
    if (ch === ',' && stack.length > 0 && stack[stack.length - 1].type === 'brace') {
      stack[stack.length - 1].commas++;
      continue;
    }
    if (ch === '.' && input[i + 1] === '.' && stack.length > 0 && stack[stack.length - 1].type === 'brace') {
      stack[stack.length - 1].isRange = true;
      i++;
      continue;
    }
    if (ch === '|' && stack.length > 0 && stack[stack.length - 1].type === 'extglob') {
      stack[stack.length - 1].branches++;
      continue;
    }
  }
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame.type === 'extglob') {
      frame.end = input.length - 1;
      frame.branchCount = frame.branches + 1;
      extglobs.push(frame);
      totalBranches += frame.branchCount;
    } else if (frame.type === 'brace') {
      frame.end = input.length - 1;
      braces.push(frame);
    }
  }
  // Sort extglobs by start index so the running total follows opening order.
  extglobs.sort((a, b) => a.start - b.start);
  return { extglobs, braces, totalBranches, maxDepth };
};

const analyze = (input, options = {}) => {
  if (typeof input !== 'string') throw new TypeError('Expected a string');
  const state = parse(input, { ...options, fastpaths: false });
  const walk = walkInput(input, options);
  return { input, regexLength: state.output.length, output: state.output, ...walk };
};

const budget = (pattern, options = {}) => {
  if (Array.isArray(pattern)) {
    const fns = pattern.map(p => budget(p, options));
    const arrayMatcher = str => {
      for (const isMatch of fns) {
        const state = isMatch(str);
        if (state) return state;
      }
      return false;
    };
    return arrayMatcher;
  }
  const opts = options || {};
  const maxBranches = typeof opts.maxBranches === 'number' ? opts.maxBranches : DEFAULT_MAX_BRANCHES;
  const maxDepth = typeof opts.maxDepth === 'number' ? opts.maxDepth : DEFAULT_MAX_DEPTH;
  const maxRegexLength = typeof opts.maxRegexLength === 'number' ? opts.maxRegexLength : DEFAULT_MAX_REGEX_LENGTH;
  const info = analyze(pattern, opts);
  if (info.maxDepth > maxDepth) {
    const deepest = info.extglobs.reduce((a, b) => (a.depth > b.depth ? a : b));
    throw new BudgetError(
      'Extglob nesting depth ' + info.maxDepth + ' exceeds maximum allowed depth ' + maxDepth,
      { budget: 'depth', actual: info.maxDepth, limit: maxDepth, range: [deepest.start, deepest.end], source: pattern }
    );
  }
  if (info.totalBranches > maxBranches) {
    let running = 0;
    let cause = null;
    for (const ext of info.extglobs) {
      running += ext.branchCount;
      if (running > maxBranches) { cause = { type: 'extglob', range: [ext.start, ext.end], branches: ext.branchCount }; break; }
    }
    if (!cause) {
      for (const brace of info.braces) {
        if (brace.isRange) continue;
        running += brace.branches;
        if (running > maxBranches) { cause = { type: 'brace', range: [brace.start, brace.end], branches: brace.branches }; break; }
      }
    }
    throw new BudgetError(
      'Total branch count ' + info.totalBranches + ' exceeds maximum allowed branches ' + maxBranches,
      { budget: 'branches', actual: info.totalBranches, limit: maxBranches, range: cause ? cause.range : [0, pattern.length], source: pattern }
    );
  }
  if (info.regexLength > maxRegexLength) {
    throw new BudgetError(
      'Generated regex length ' + info.regexLength + ' exceeds maximum allowed length ' + maxRegexLength,
      { budget: 'regexLength', actual: info.regexLength, limit: maxRegexLength, range: [0, pattern.length], source: pattern }
    );
  }
  const picomatch = require('./picomatch');
  return picomatch(pattern, opts);
};

module.exports = budget;
module.exports.analyze = analyze;
module.exports.BudgetError = BudgetError;
module.exports.DEFAULT_MAX_BRANCHES = DEFAULT_MAX_BRANCHES;
module.exports.DEFAULT_MAX_DEPTH = DEFAULT_MAX_DEPTH;
module.exports.DEFAULT_MAX_REGEX_LENGTH = DEFAULT_MAX_REGEX_LENGTH;
