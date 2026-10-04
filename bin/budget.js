#!/usr/bin/env node
'use strict';

/**
 * Local Node command for checking glob pattern budgets.
 *
 * Usage:
 *   node bin/budget.js <pattern> [options]
 *
 * Examples:
 *   node bin/budget.js '@(a|b)'
 *   node bin/budget.js '@(a|@(b|c))' --max-depth 1
 *   node bin/budget.js '{a,b,c}' --max-branches 2
 *   node bin/budget.js 'a*.js' --max-regex-length 50
 *
 * Options:
 *   --max-branches <n>      Maximum number of branches (default: 25)
 *   --max-depth <n>         Maximum extglob nesting depth (default: 3)
 *   --max-regex-length <n>  Maximum generated regex length (default: 2000)
 *   --analyze               Only analyze, do not compile
 *   --help                  Show this help message
 */

const picomatch = require('..');
const budget = picomatch.budget;

const parseArgs = argv => {
  const args = { pattern: null, options: {}, analyze: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--analyze') {
      args.analyze = true;
    } else if (arg === '--max-branches') {
      args.options.maxBranches = parseInt(argv[++i], 10);
    } else if (arg === '--max-depth') {
      args.options.maxDepth = parseInt(argv[++i], 10);
    } else if (arg === '--max-regex-length') {
      args.options.maxRegexLength = parseInt(argv[++i], 10);
    } else if (arg.startsWith('--')) {
      process.stderr.write('Unknown option: ' + arg + '\n');
      process.exit(1);
    } else if (args.pattern === null) {
      args.pattern = arg;
    }
  }
  return args;
};

const formatRange = (pattern, range) => {
  if (!range) return '';
  const [start, end] = range;
  const snippet = pattern.slice(start, end + 1);
  return '  range: [' + start + ', ' + end + '] -> "' + snippet + '"';
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.pattern === null) {
    process.stdout.write(require('fs').readFileSync(__filename, 'utf8').split('*/')[0] + '*/\n');
    process.exit(args.help ? 0 : 1);
  }

  const pattern = args.pattern;

  if (args.analyze) {
    const info = budget.analyze(pattern, args.options);
    process.stdout.write('Pattern: ' + JSON.stringify(pattern) + '\n');
    process.stdout.write('Regex length: ' + info.regexLength + '\n');
    process.stdout.write('Total branches: ' + info.totalBranches + '\n');
    process.stdout.write('Max depth: ' + info.maxDepth + '\n');
    process.stdout.write('Extglobs: ' + info.extglobs.length + '\n');
    for (const ext of info.extglobs) {
      process.stdout.write('  ' + JSON.stringify(ext) + '\n');
    }
    process.stdout.write('Braces: ' + info.braces.length + '\n');
    for (const brace of info.braces) {
      process.stdout.write('  ' + JSON.stringify(brace) + '\n');
    }
    return;
  }

  try {
    const isMatch = budget(pattern, args.options);
    process.stdout.write('OK: pattern passes budget checks\n');
    process.stdout.write('  matcher: ' + isMatch.toString().slice(0, 80) + '...\n');
  } catch (err) {
    if (err instanceof budget.BudgetError) {
      process.stdout.write('REJECTED: ' + err.message + '\n');
      process.stdout.write('  budget: ' + err.details.budget + '\n');
      process.stdout.write('  actual: ' + err.details.actual + '\n');
      process.stdout.write('  limit: ' + err.details.limit + '\n');
      process.stdout.write(formatRange(pattern, err.details.range) + '\n');
      process.exit(1);
    }
    throw err;
  }
};

main();
