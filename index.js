'use strict';

const pico = require('./lib/picomatch');
const utils = require('./lib/utils');
const budget = require('./lib/budget');

function picomatch(glob, options, returnState = false) {
  // default to os.platform()
  if (options && (options.windows === null || options.windows === undefined)) {
    // don't mutate the original options object
    options = { ...options, windows: utils.isWindows() };
  }

  return pico(glob, options, returnState);
}

Object.assign(picomatch, pico);

/**
 * Explicit budget compile entry. Analyzes the pattern (actual branches,
 * nested extglob depth and generated regex length), rejects patterns
 * that exceed the given budget before any executable matcher is
 * created, and otherwise returns a matcher that behaves exactly like
 * `picomatch(pattern, options)`. See docs/budgets.md.
 *
 * ```js
 * const isMatch = picomatch.budget('src/{a,b}/*.js', {}, { maxBranches: 8 });
 * ```
 */
picomatch.budget = (pattern, options, budgetOptions) => {
  return budget.compile(pattern, options, budgetOptions, picomatch);
};
picomatch.budget.analyze = budget.analyze;
picomatch.budget.check = budget.check;
picomatch.budget.BudgetError = budget.BudgetError;

module.exports = picomatch;
