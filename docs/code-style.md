# Code style & generation guidelines

Rules with examples — follow these when writing any code here. [code-quality.md](code-quality.md) holds the
principles behind them.

## General

- TypeScript strict, ESM with NodeNext: **relative imports end in `.js`** (`from './engine.js'`).
- `const` + expressions over `let` + mutation. Arrow functions. No classes (the one exception is the exported
  `VersionConflict` sentinel, an `Error` subclass the engine needs for `instanceof`).
- Small named functions over inline complexity; extract when a function does two things.
- Comments explain *why*, tersely — see [Comments](code-quality.md#comments).

## One concern per library

| Library | Owns | Don't use it for |
|---|---|---|
| **zod** | schemas, enums (`.enum.*`), decoding at boundaries; types are `z.infer`, not hand-written twins | control flow |
| **neverthrow** | the success/error track (`Result`, `ResultAsync`, `safeTry`); expected failures are values | data reshaping |
| **remeda** | reshaping data: pipes, grouping, uniqueness, predicate composition | error handling |

### neverthrow

- Expected failures are values on the error track; unexpected ones throw. Never `try/catch` an expected outcome.
- Compose with `safeTry` + `yield*` so each step short-circuits on error. Avoid resolve-then-early-return chains.
- The engine owns no error type: it is generic in the consumer's `E` and builds one only via the injected
  `conflictError` factory.

### zod

- Enums are zod enums; reference members via `.enum.*`.
- Validate at external boundaries (`safeParse` when the failure is an expected value, `parse` when throwing is
  intended and handled at the edge). Don't re-validate inside the engine.
- Derive types from schemas (`z.infer`); never declare a parallel hand-written type.

### remeda

See the table in [code-quality.md](code-quality.md#declarative-over-imperative).

## Purity and the shell boundary

- Contract code (`persistable.ts`) is pure data and schemas: no I/O, no clock, no imports from the engine.
- The engine performs no database work itself; everything driver-shaped goes through the adapter port. It must
  stay generic in the transaction handle `TTx` and error `E`.
- A flow returns its writes as data (see [architecture.md](architecture.md)); it never calls a write method.

## Testing

- Behaviour changes ship with tests in the same change, covering success and expected-failure paths.
- Test the engine generically with in-memory fake adapters; no real database, network, or clock dependence.
- Keep tests small and deterministic. Assert on policy constants (`MAX_RUN_EFFECTS_ATTEMPTS`), never their literals.
- Pure helpers get their own focused tests.

## Naming & misc

- Identifiers and comments in English.
- Exports are the public API: anything exported from `src/index.ts` is semver-governed (see ADR 0001).
