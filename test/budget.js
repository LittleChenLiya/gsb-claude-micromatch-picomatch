'use strict';

const assert = require('assert');
const picomatch = require('..');

// Allow running both under mocha (npm run mocha) and directly with
// plain node (npm run test:budget -> node test/budget.js).
const hasMocha = typeof describe === 'function' && typeof it === 'function';
const _describe = hasMocha ? describe : (name, fn) => fn();
const _it = hasMocha ? it : (name, fn) => fn();

const BS = String.fromCharCode(92); // backslash, kept literal-safe

_describe('picomatch.budget', () => {
  _describe('maxExtglobDepth', () => {
    _it('rejects nested @(a|@(b|c)) at depth limit 1 and locates the inner extglob', () => {
      assert.throws(() => picomatch.budget('@(a|@(b|c))', {}, { maxExtglobDepth: 1 }), err => {
        assert.equal(err.name, 'BudgetError');
        assert.equal(err.code, 'PICOMATCH_BUDGET_EXCEEDED');
        assert.equal(err.dimension, 'maxExtglobDepth');
        assert.equal(err.limit, 1);
        assert.equal(err.actual, 2);
        assert.deepEqual(err.range, { start: 4, end: 10 });
        assert.equal(err.source, '@(b|c)');
        return true;
      });
    });

    _it('accepts the same pattern when the depth budget allows it', () => {
      const isMatch = picomatch.budget('@(a|@(b|c))', {}, { maxExtglobDepth: 2 });
      assert.equal(isMatch('a'), true);
      assert.equal(isMatch('b'), true);
      assert.equal(isMatch('c'), true);
      assert.equal(isMatch('d'), false);
    });

    _it('does not count escaped parentheses towards extglob depth', () => {
      const escaped = BS + '(a|b' + BS + ')'; // \(a|b\)
      const report = picomatch.budget.analyze(escaped);
      assert.equal(report.extglobDepth, 0);
      assert.equal(report.branches, 0);
      assert.doesNotThrow(() => picomatch.budget(escaped, {}, { maxExtglobDepth: 0, maxBranches: 0 }));
      assert.doesNotThrow(() => picomatch.budget('@' + BS + '(a|b)', {}, { maxExtglobDepth: 0 }));
      assert.doesNotThrow(() => picomatch.budget(BS + '@(a)', {}, { maxExtglobDepth: 0 }));
    });

    _it('still counts real extglobs when others are escaped', () => {
      const pattern = BS + '(x' + BS + ')@(a|b)';
      const report = picomatch.budget.analyze(pattern);
      assert.equal(report.extglobDepth, 1);
      assert.throws(() => picomatch.budget(pattern, {}, { maxExtglobDepth: 0 }), /maxExtglobDepth/);
    });

    _it('does not count parens or braces inside bracket classes', () => {
      for (const pattern of ['[(){}]', '[!(]x', '[@(]x', '[a{]b', '[' + BS + ']]@(a)']) {
        const report = picomatch.budget.analyze(pattern);
        assert.equal(report.extglobDepth, pattern.endsWith('@(a)') ? 1 : 0, pattern);
        assert.equal(report.branches, 0, pattern);
        assert.doesNotThrow(() => picomatch.budget(pattern, {}, { maxExtglobDepth: 1, maxBranches: 0 }));
      }
      const posix = picomatch.budget.analyze('[[:alpha:]]@(a|b)');
      assert.equal(posix.extglobDepth, 1);
      assert.equal(posix.branches, 2);
    });
  });

  _describe('maxBranches', () => {
    _it('counts extglob and paren alternation branches', () => {
      assert.equal(picomatch.budget.analyze('@(a|@(b|c))').branches, 4);
      assert.equal(picomatch.budget.analyze('!(a|b)').branches, 2);
      assert.equal(picomatch.budget.analyze('a(b|c)d').branches, 2);
    });

    _it('estimates brace ranges by real expansion rules, not raw characters', () => {
      assert.equal(picomatch.budget.analyze('{1..10}').branches, 10);
      assert.equal(picomatch.budget.analyze('{a..z}').branches, 26);
      assert.equal(picomatch.budget.analyze('{1..10..2}').branches, 5);
      assert.equal(picomatch.budget.analyze('{z..a..3}').branches, 9);
      assert.equal(picomatch.budget.analyze('{a,b,c}').branches, 3);
      assert.equal(picomatch.budget.analyze('{a,{b,c}}').branches, 5);
      assert.equal(picomatch.budget.analyze('{a,b}{c,d}').branches, 4);
    });

    _it('treats literal and invalid braces as zero branches', () => {
      assert.equal(picomatch.budget.analyze('{abc}').branches, 0);
      assert.equal(picomatch.budget.analyze('{1..x}').branches, 0);
      assert.equal(picomatch.budget.analyze(BS + '{a,b' + BS + '}').branches, 0);
    });

    _it('rejects over-budget brace ranges and locates the range', () => {
      assert.throws(() => picomatch.budget('x{1..100}', {}, { maxBranches: 50 }), err => {
        assert.equal(err.code, 'PICOMATCH_BUDGET_EXCEEDED');
        assert.equal(err.dimension, 'maxBranches');
        assert.equal(err.limit, 50);
        assert.equal(err.actual, 100);
        assert.deepEqual(err.range, { start: 1, end: 9 });
        assert.equal(err.source, '{1..100}');
        return true;
      });
    });

    _it('accepts small brace rules and matches exactly like the plain interface', () => {
      const patterns = [
        'src/{a,b}/file.{js,ts}',
        'file{1..3}.txt',
        '{a,b}{c,d}',
        '@(a|b).{js,ts}'
      ];
      const candidates = [
        'src/a/file.js', 'src/b/file.ts', 'src/c/file.js', 'src/a/file.md',
        'file1.txt', 'file2.txt', 'file3.txt', 'file4.txt', 'file.txt',
        'ac', 'ad', 'bc', 'bd', 'ae', 'a.js', 'b.ts', 'c.js', 'a.ts'
      ];
      for (const pattern of patterns) {
        const isMatch = picomatch.budget(pattern, {}, { maxBranches: 10, maxExtglobDepth: 2, maxRegexLength: 1000 });
        const expected = picomatch(pattern);
        for (const candidate of candidates) {
          assert.equal(isMatch(candidate), expected(candidate), `${pattern} vs ${candidate}`);
        }
      }
    });
  });

  _describe('maxRegexLength', () => {
    _it('reports the exact length of the generated regex source', () => {
      for (const pattern of ['*.js', '.js', '!(*.js)', '@(a|@(b|c))', 'src/{a,b}/file.{js,ts}', 'foo/**/bar', 'x{1..100}']) {
        const report = picomatch.budget.analyze(pattern);
        assert.equal(report.regexSource, picomatch.makeRe(pattern).source, pattern);
        assert.equal(report.regexLength, picomatch.makeRe(pattern).source.length, pattern);
      }
    });

    _it('rejects when the generated regex exceeds the length budget', () => {
      const pattern = 'src/{a,b}/file.{js,ts}';
      const report = picomatch.budget.analyze(pattern);
      assert.throws(() => picomatch.budget(pattern, {}, { maxRegexLength: report.regexLength - 1 }), err => {
        assert.equal(err.code, 'PICOMATCH_BUDGET_EXCEEDED');
        assert.equal(err.dimension, 'maxRegexLength');
        assert.equal(err.limit, report.regexLength - 1);
        assert.equal(err.actual, report.regexLength);
        assert.deepEqual(err.range, { start: 0, end: pattern.length });
        return true;
      });
      assert.doesNotThrow(() => picomatch.budget(pattern, {}, { maxRegexLength: report.regexLength }));
    });
  });

  _describe('compile entry', () => {
    _it('supports the (pattern, budget) shorthand', () => {
      assert.throws(() => picomatch.budget('@(a|@(b|c))', { maxExtglobDepth: 1 }), /PICOMATCH_BUDGET_EXCEEDED|maxExtglobDepth/);
      assert.doesNotThrow(() => picomatch.budget('@(a|@(b|c))', { maxExtglobDepth: 2 }));
    });

    _it('validates budget values', () => {
      assert.throws(() => picomatch.budget('a', {}, { maxBranches: -1 }), TypeError);
      assert.throws(() => picomatch.budget('a', {}, { maxRegexLength: Infinity }), TypeError);
      assert.throws(() => picomatch.budget('a', {}, { maxExtglobDepth: '1' }), TypeError);
    });

    _it('rejects before creating a matcher and exposes the report on success', () => {
      const isMatch = picomatch.budget('src/{a,b}/*.js', {}, { maxBranches: 4 });
      assert.equal(typeof isMatch, 'function');
      assert.equal(isMatch.budgetReport.branches, 2);
      assert.equal(isMatch.budgetReport.extglobDepth, 0);
      assert.equal(isMatch('src/a/x.js'), true);
      assert.equal(isMatch('src/c/x.js'), false);
    });

    _it('returns results identical to the plain interface, including match objects', () => {
      const pattern = '!(x).{js,ts}';
      const budgeted = picomatch.budget(pattern, {}, { maxBranches: 10, maxExtglobDepth: 3, maxRegexLength: 500 });
      const plain = picomatch(pattern);
      for (const candidate of ['x.js', 'y.js', 'y.ts', 'x.ts', 'y.md']) {
        assert.equal(budgeted(candidate), plain(candidate), candidate);
        const a = budgeted(candidate, true);
        const b = plain(candidate, true);
        assert.equal(a.isMatch, b.isMatch, candidate);
        assert.equal(a.output, b.output, candidate);
      }
    });
  });
});

if (!hasMocha) {
  console.log('test/budget.js: all budget tests passed');
}
