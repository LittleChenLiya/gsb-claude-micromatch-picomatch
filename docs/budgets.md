# Budget compilation

`picomatch.budget(pattern, options, budget)` is an explicit compile entry
point for untrusted patterns. Before any executable matcher is created,
the pattern is analyzed and three budgets are enforced. When a budget is
exceeded a `BudgetError` (`code: "PICOMATCH_BUDGET_EXCEEDED"`) is thrown
and **no matcher is compiled**. When the pattern is within budget, the
returned matcher is created through the regular `picomatch()` interface,
so match results are identical to the plain API.

```js
const picomatch = require('picomatch');

// throws BudgetError before a matcher is created:
picomatch.budget('@(a|@(b|c))', {}, { maxExtglobDepth: 1 });
// BudgetError: picomatch budget exceeded: maxExtglobDepth allows at most 1,
// but the pattern requires 2 (source "@(b|c)" at 4..10)

// within budget: behaves exactly like picomatch(pattern, options)
const isMatch = picomatch.budget('src/{a,b}/*.js', {}, { maxBranches: 8 });
isMatch('src/a/x.js'); //=> true
```

The budget object may also be passed as the second argument
(`picomatch.budget(pattern, budget)`).

## The three budgets

### `maxBranches` — alternation branches

Upper bound on the total number of alternation branches in the pattern:

* every paren or extglob group that contains top-level `|` separators
  contributes `separators + 1` branches (`@(a|b)` → 2);
* every brace expansion contributes its estimated expansion count
  (`{a,b,c}` → 3).

Nested constructs each contribute their own alternatives, so nesting is
additive (`@(a|@(b|c))` → 2 + 2 = 4). Brace **ranges** are estimated with
the real expansion rules (fill-range semantics), never by counting raw
characters: `{1..10}` → 10, `{a..z}` → 26, `{1..10..2}` → 5,
`{z..a..3}` → 9. Braces without a comma or a valid range (`{abc}`,
`{1..x}`) are literals and contribute 0.

### `maxExtglobDepth` — nested extglob depth

Upper bound on the nesting depth of extglob groups (`@(...)`, `*(...)`,
`+(...)`, `?(...)`, `!(...)`). `@(a|@(b|c))` has depth 2. Escaped
parentheses (`\(`, `\@(`) and parentheses inside bracket classes
(`[(]`, `[!(]`) are literals and never increase the depth.

### `maxRegexLength` — generated regex length

Upper bound on the length of the regular expression source picomatch
generates for the pattern (the exact `source` of the RegExp that
`picomatch.makeRe(pattern, options)` would return, measured without
constructing the RegExp).

## Error reporting

`BudgetError` exposes:

| field | description |
| ----- | ----------- |
| `code` | always `"PICOMATCH_BUDGET_EXCEEDED"` |
| `dimension` | the exceeded budget: `maxBranches`, `maxExtglobDepth` or `maxRegexLength` |
| `limit` / `actual` | the configured limit and the measured value |
| `range` | `{ start, end }` offsets into the pattern that caused the violation (the innermost offending extglob group for depth violations, the construct that pushed the total over the limit for branch violations, the whole pattern for regex-length violations) |
| `source` | the offending pattern slice |
| `pattern` | the full pattern |

## Analysis without compiling

```js
const report = picomatch.budget.analyze('@(a|@(b|c))');
// { pattern, branches: 4, extglobDepth: 2, regexLength: 15,
//   regexSource, deepestExtglob: { start: 4, end: 10 }, extglobs, constructs }

picomatch.budget.check(report, { maxExtglobDepth: 1 }); // throws BudgetError
```

## Local verification

```sh
npm run test:budget   # runs test/budget.js with plain node (no dependencies)
```
