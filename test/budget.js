'use strict';

const assert = require('assert');
const picomatch = require('..');
const { isMatch: origIsMatch } = require('..');
const budget = picomatch.budget;
const { BudgetError } = budget;

describe('picomatch.budget', () => {
  describe('depth budget', () => {
    it('should reject nested extglobs that exceed the depth limit and locate the inner extglob', () => {
      try {
        budget('@(a|@(b|c))', { maxDepth: 1 });
        throw new Error('expected BudgetError');
      } catch (err) {
        assert(err instanceof BudgetError, 'should throw BudgetError');
        assert.strictEqual(err.details.budget, 'depth');
        assert.strictEqual(err.details.actual, 2);
        assert.strictEqual(err.details.limit, 1);
        const range = err.details.range;
        assert.strictEqual(range[0], 4);
        assert.strictEqual(range[1], 9);
        assert.strictEqual('@(a|@(b|c))'.slice(range[0], range[1] + 1), '@(b|c)');
      }
    });

    it('should allow extglobs within the depth limit', () => {
      const isMatch = budget('@(a|b)', { maxDepth: 1 });
      assert(isMatch('a'));
      assert(isMatch('b'));
      assert(!isMatch('c'));
    });

    it('should allow nested extglobs within the depth limit', () => {
      const isMatch = budget('@(a|@(b|c))', { maxDepth: 2 });
      assert(isMatch('a'));
      assert(isMatch('b'));
      assert(isMatch('c'));
      assert(!isMatch('d'));
    });

    it('should not count escaped parentheses as groups', () => {
      // `\(` and `\)` are literal parentheses, not extglob groups.
      const isMatch = budget('\\(a\\)', { maxDepth: 0 });
      assert(isMatch('(a)'));
      assert(!isMatch('a'));
    });

    it('should not count parentheses inside character classes as groups', () => {
      const isMatch = budget('[(]a[)]', { maxDepth: 0 });
      assert(isMatch('(a)'));
      assert(!isMatch('a'));
    });

    it('should track depth for plus, star, qmark, and negate extglobs', () => {
      assert.strictEqual(budget.analyze('+(a|b)').maxDepth, 1);
      assert.strictEqual(budget.analyze('*(a|b)').maxDepth, 1);
      assert.strictEqual(budget.analyze('?(a|b)').maxDepth, 1);
      assert.strictEqual(budget.analyze('!(a|b)').maxDepth, 1);
      assert.strictEqual(budget.analyze('+(a|*(b|c))').maxDepth, 2);
    });
  });

  describe('branch budget', () => {
    it('should count actual extglob branches', () => {
      const info = budget.analyze('@(a|b|c)');
      assert.strictEqual(info.totalBranches, 3);
      assert.strictEqual(info.extglobs[0].branchCount, 3);
    });

    it('should count branches across nested extglobs', () => {
      const info = budget.analyze('@(a|@(b|c))');
      assert.strictEqual(info.totalBranches, 4);
    });

    it('should not count pipes inside character classes as branches', () => {
      const info = budget.analyze('[a|b]');
      assert.strictEqual(info.totalBranches, 0);
      assert.strictEqual(info.maxDepth, 0);
    });

    it('should not count escaped pipes as branches', () => {
      const info = budget.analyze('@(a\\|b)');
      assert.strictEqual(info.totalBranches, 1);
    });

    it('should reject patterns that exceed the branch budget', () => {
      try {
        budget('@(a|b|c|d|e)', { maxBranches: 3 });
        throw new Error('expected BudgetError');
      } catch (err) {
        assert(err instanceof BudgetError);
        assert.strictEqual(err.details.budget, 'branches');
        assert.strictEqual(err.details.actual, 5);
        assert.strictEqual(err.details.limit, 3);
      }
    });

    it('should locate the extglob that causes the branch over-limit', () => {
      try {
        budget('@(a|b|c)', { maxBranches: 2 });
        throw new Error('expected BudgetError');
      } catch (err) {
        assert(err instanceof BudgetError);
        const range = err.details.range;
        assert.strictEqual(range[0], 0);
        assert.strictEqual(range[1], 7);
        assert.strictEqual('@(a|b|c)'.slice(range[0], range[1] + 1), '@(a|b|c)');
      }
    });
  });

  describe('brace expansion', () => {
    it('should count comma-separated brace alternations as branches', () => {
      const info = budget.analyze('{a,b,c}');
      assert.strictEqual(info.totalBranches, 3);
      assert.strictEqual(info.braces[0].branches, 3);
      assert.strictEqual(info.braces[0].isRange, false);
    });

    it('should estimate brace ranges by their actual expansion, not raw length', () => {
      const info = budget.analyze('{a..z}');
      assert.strictEqual(info.totalBranches, 0);
      assert.strictEqual(info.braces[0].isRange, true);
      assert(info.braces[0].cost > 0);
      assert(info.braces[0].cost < 26);
    });

    it('should pass small brace patterns and match the original interface', () => {
      const isMatch = budget('{a,b,c}');
      assert.strictEqual(isMatch('a'), origIsMatch('a', '{a,b,c}'));
      assert.strictEqual(isMatch('b'), origIsMatch('b', '{a,b,c}'));
      assert.strictEqual(isMatch('c'), origIsMatch('c', '{a,b,c}'));
      assert.strictEqual(isMatch('d'), origIsMatch('d', '{a,b,c}'));
    });

    it('should pass brace ranges and match the original interface', () => {
      const isMatch = budget('{a..c}');
      assert.strictEqual(isMatch('a'), origIsMatch('a', '{a..c}'));
      assert.strictEqual(isMatch('b'), origIsMatch('b', '{a..c}'));
      assert.strictEqual(isMatch('c'), origIsMatch('c', '{a..c}'));
      assert.strictEqual(isMatch('d'), origIsMatch('d', '{a..c}'));
    });

    it('should handle nested braces', () => {
      const info = budget.analyze('{a,{b,c}}');
      // Outer brace has 2 branches, inner brace has 2 branches.
      // Total branch points = 4 (conservative; the regex has 3 leaf branches).
      assert.strictEqual(info.totalBranches, 4);
    });

    it('should handle braces inside extglobs', () => {
      const info = budget.analyze('@({a,b}|c)');
      // Extglob has 2 branches, brace has 2 branches.
      assert.strictEqual(info.totalBranches, 4);
    });

    it('should match the original interface for brace patterns', () => {
      const patterns = ['{a,b,c}', '{a..c}', '{a,{b,c}}', '@({a,b}|c)'];
      const candidates = ['a', 'b', 'c', 'd', 'aa', 'ab'];
      for (const pattern of patterns) {
        const isMatch = budget(pattern);
        for (const candidate of candidates) {
          assert.strictEqual(
            isMatch(candidate),
            origIsMatch(candidate, pattern),
            'pattern ' + pattern + ' candidate ' + candidate
          );
        }
      }
    });
  });

  describe('regex length budget', () => {
    it('should reject patterns whose generated regex exceeds the length limit', () => {
      const pattern = 'a'.repeat(100);
      try {
        budget(pattern, { maxRegexLength: 50 });
        throw new Error('expected BudgetError');
      } catch (err) {
        assert(err instanceof BudgetError);
        assert.strictEqual(err.details.budget, 'regexLength');
        assert.strictEqual(err.details.limit, 50);
        assert(err.details.actual > 50);
      }
    });

    it('should allow patterns within the regex length limit', () => {
      const isMatch = budget('abc', { maxRegexLength: 100 });
      assert(isMatch('abc'));
      assert(!isMatch('abd'));
    });

    it('should use the actual parsed regex length, not raw pattern length', () => {
      const info = budget.analyze('{a..z}');
      assert(info.regexLength > 0);
      assert.strictEqual(info.regexLength, info.output.length);
    });
  });

  describe('budget-passed matcher equivalence', () => {
    it('should produce identical results to the ordinary picomatch interface', () => {
      const patterns = [
        'abc', '*.js', '@(a|b)', '*(a|b)', '+(a|b)', '?(a|b)', '!(a|b)',
        '{a,b,c}', '{a..c}', '@(a|@(b|c))', 'foo/bar/*.js', '**/*.js',
        '[abc]', '[a-z]'
      ];
      const candidates = [
        'a', 'b', 'c', 'd', 'aa', 'ab', 'abc', 'abcd',
        'foo.js', 'bar.js', 'foo/bar.js', 'foo/bar/baz.js',
        'a.js', 'b.txt', '(a|b)', '[abc]'
      ];
      for (const pattern of patterns) {
        const isMatch = budget(pattern);
        for (const candidate of candidates) {
          assert.strictEqual(
            isMatch(candidate),
            origIsMatch(candidate, pattern),
            'pattern ' + pattern + ' candidate ' + candidate
          );
        }
      }
    });

    it('should return the same matcher behavior as picomatch for arrays', () => {
      const patterns = ['*.js', '*.ts'];
      const isMatch = budget(patterns);
      assert.strictEqual(isMatch('a.js'), origIsMatch('a.js', patterns));
      assert.strictEqual(isMatch('a.ts'), origIsMatch('a.ts', patterns));
      assert.strictEqual(isMatch('a.txt'), origIsMatch('a.txt', patterns));
    });

    it('should support returnState like the ordinary interface', () => {
      const isMatch = budget('*.js', {}, true);
      assert.strictEqual(isMatch('a.js'), true);
      assert.strictEqual(isMatch('a.txt'), false);
    });
  });

  describe('analyze', () => {
    it('should return the parsed regex output', () => {
      const info = budget.analyze('@(a|b)');
      assert.strictEqual(info.output, '(a|b)');
      assert.strictEqual(info.regexLength, '(a|b)'.length);
    });

    it('should throw for non-string input', () => {
      assert.throws(() => budget.analyze(null), /Expected a string/);
      assert.throws(() => budget.analyze(123), /Expected a string/);
    });
  });

  describe('default budgets', () => {
    it('should expose default budget values', () => {
      assert.strictEqual(typeof budget.DEFAULT_MAX_BRANCHES, 'number');
      assert.strictEqual(typeof budget.DEFAULT_MAX_DEPTH, 'number');
      assert.strictEqual(typeof budget.DEFAULT_MAX_REGEX_LENGTH, 'number');
    });

    it('should use defaults when no limits are specified', () => {
      const isMatch = budget('abc');
      assert(isMatch('abc'));
    });
  });
});
