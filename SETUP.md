# Seeding the effect-runner repo (one-time)

This folder is a ready-to-init scaffold for **`@rafaelfcarneiro/effect-runner`** (ADR-031). `src/engine.ts`
and `src/persistable.ts` are copied verbatim from FinTrack's `src/effects/`; everything else is package
scaffolding. Remaining manual steps:

1. **Create the repo and drop these files in.**
   ```bash
   # new empty GitHub repo: rafaelfcarneiro/effect-runner
   git init && git add -A && git commit -m "chore: initial effect-runner package (extracted from fintrack, ADR-031)"
   ```

2. **Bring over the engine's unit tests.** Copy FinTrack's `test/unit/effects/*` into this repo's `test/`, and
   fix their relative imports: `../../../src/effects/engine` → `../src/engine.js` (and `…/persistable` likewise).
   These are the *pure* engine tests (fake runner + fake appliers, no DB). Do **not** bring
   `test/integration/db/effects.test.ts` — that exercises FinTrack's libSQL adapter and stays in FinTrack.

3. **Install + gate.**
   ```bash
   npm install
   npm run lint && npm run typecheck && npm run test && npm run build
   ```
   `build` emits `dist/` (ESM + `.d.ts`). Confirm `dist/index.js` + `dist/index.d.ts` exist.

4. **Publish public** (requires an npmjs.com account with the `@rafaelfcarneiro` scope):
   ```bash
   npm publish --access public   # prepublishOnly re-runs the gate
   git tag v0.1.0 && git push --tags
   ```

Notes:
- `zod` is a **peerDependency** — the consumer (FinTrack) supplies the single shared instance.
- `engines.node` is set to `>=20` (permissive for a library), not FinTrack's `>=25`. Widen/narrow if you prefer.
- License is **MIT** (deliberately permissive; FinTrack itself stays Apache-2.0).
- Once published, FinTrack consumes it on branch `refactor/consume-effects-package` (ADR-031 step 2).
