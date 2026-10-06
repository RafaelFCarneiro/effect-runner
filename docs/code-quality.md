# Code quality principles

These apply to every line of code in this repo. They are non-negotiable. [code-style.md](code-style.md) covers
implementation patterns; this document covers the underlying rules behind them.

## Constants over literals

Never pass a magic string or number where a named constant exists.

```ts
// ✅ DO
op: PersistOp.enum.insert
if (attemptsLeft <= 1) …           // attempts come from MAX_RUN_EFFECTS_ATTEMPTS

// ❌ DON'T
op: 'insert'
```

- Zod enums expose `.enum` — always use it at call sites.
- A value used in more than one place gets a constant. That includes error and log message strings, not just
  domain values. Grep your diff for repeated substrings before pushing.
- Every non-obvious literal needs a name or a comment saying *why that value*.

## Naming clarity

No abbreviations or acronyms unless universally known (`id`, `url`).

- Functions: verb + noun describing what they do (`applyBatch`, `resolveApplier`), not `getX`/`checkY`.
- Booleans: `is*`, `has*`, `can*`, `needs*`.
- Variables name the concept, not the type (`outcome`, not `outcomeResult`).

### Names carry the context of their module — don't repeat it

The file or import namespace already provides context; a name must not restate it.

```ts
// ✅ DO — file is adapters/orders.ts, imported as orderAdapters.*
export const modelToRow = …        // orderAdapters.modelToRow(entity)

// ❌ DON'T
export const orderModelToRow = …
```

When two exports from different modules collide, rely on namespacing rather than lengthening the name.

## Single responsibility

One function, one job. If the description needs "and", split it. Extract when a block could be named and tested
on its own.

## Declarative over imperative

Describe *what* the result is, not *how* to build it. Reach for [remeda](https://remedajs.com/docs/) before
writing a loop.

| Instead of… | Use… |
|---|---|
| `let count = 0; for…` | `R.countBy` |
| `arr.reduce((acc, x) => …, {})` | `R.groupBy`, `R.mapValues`, `R.sumBy` |
| `if (a \|\| b \|\| c)` on predicates | `R.anyPass([…])` |
| `if (a && b && c)` on predicates | `R.allPass([…])` |
| chained `.filter().map().sort()` | `R.pipe(…)` |
| `arr.filter(fn)[0]` / `find(fn) ?? fallback` | `R.firstBy` / `R.find` |
| `switch` that transforms a value | `R.conditional` |
| `() => fixedValue` | `R.constant(fixedValue)` |

Native `map`/`filter` is fine for a single-stage transform; use remeda for ≥2 stages, grouping, counting, or
predicate composition. A loop is acceptable where **ordered awaiting** is the point (applying a batch in sequence).

### Named functions over inline lambdas in pipes

A pipe should read as a sequence of *what* happens. Extract non-trivial predicates and mappers into named
functions; inline lambdas bury intent.

```ts
// ✅ DO
R.pipe(outcomes, R.filter(isApplied), R.map(toEntityTag), R.unique())

// ❌ DON'T
R.pipe(outcomes, R.filter((o) => o.applied && o.entity !== ''), R.map((o) => o.entity.trim()), R.unique())
```

### Dual-signature helpers with `purry`

When a helper is used both directly and inside pipes, wrap it with remeda's `purry` so one function supports
data-first and data-last calls, rather than a manual curry that forces `f(a)(b)` at direct call sites.

## Avoid unnecessary complexity

Write the simplest code that correctly solves the problem. Do not add an abstraction before there are three
concrete cases, use generics where a concrete type works, add options for behaviour that has never varied, or
pull in a library for three lines of TypeScript. The test: if you inlined the abstraction, would the code be
harder to understand? If not, keep it simple.

## Comments

Comments carry what the code cannot: **why**, never **what**.

- Write a comment only for an invariant, a trade-off, a non-obvious constraint, or a deliberate deviation.
- Be terse. One or two lines is the norm; a paragraph needs a reason. If a comment grows past a short block,
  the design usually belongs in `docs/architecture.md` or an ADR — link it instead.
- Never restate the signature, the types, or the next line. Never narrate history ("previously…", "now we…")
  or cite where it's used from; that rots.
- No ticket, phase, or decision-number references in source comments; the ADR or git history holds those.
- Doc comments on exported API state the contract (what it guarantees, what the caller supplies) in a sentence
  or two, not the implementation.

```ts
// ✅ DO — one line, states the why
// Exported so tests assert the real policy instead of duplicating the literal.
export const MAX_RUN_EFFECTS_ATTEMPTS = 3;

// ❌ DON'T — five lines re-explaining what the name and type already say
```

## Static imports over inline dynamic `import()`

Keep imports at the top of the file. The one exception is a genuine lazy-load gate for a module that is
expensive or has load-time side effects and is needed only on a runtime-conditional path. Isolate it in one small
named module-scope function, document why it's lazy, and share that function if several call sites need it.

## Fail loudly at boundaries, trust internally

- Validate with zod at every external boundary; inside the domain, trust your own types and don't re-validate.
- Don't add defensive `== null` checks on values the type system guarantees.

## Consistency over cleverness

Follow an existing pattern when one exists; introduce a new one only when the old genuinely doesn't fit, and
document the reason.
