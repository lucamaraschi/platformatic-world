# Session learnings

## Deferred / do not forget

- **[calib-persist] DONE** — migration `008`, `calibration-db.ts`, load onReady, write-through on POST. Keys: `fleet` + external app_id string.
- **Gaps fill DONE** — demand-infer, resource fingerprints, large mutation study, CI `test:wur` step.
- **Paper-perfect push DONE** — vendored vercel workbench corpus (`test/fixtures/vercel-corpus`), `paper-eval.ts` S1–S11 + corpus mutations, deeper demand (Promise.all, alias, if-predicates).
- **Last 3 chased DONE**:
  1. Corpus pinned to paper commit `39673b7a381b029032525485e566f1663f549fa3`
  2. TS compiler AST demand (`ts-demand.ts`) preferred over scanner
  3. `realcorpus/` JSON artifacts (paper hand-translation constructors); regenerate via `pnpm -C packages/workflow run generate:realcorpus`

## 2026-07-23 — Corpus harness

- `lib/wur/corpus.ts` + `test/wur-corpus.test.ts`: e2e-v4/v5 extract, self-diff, mutators, FN=0
- Not a byte-for-byte port of the paper's Vercel commit corpus; same *methodology* on in-repo sources

## 2026-07-23 — WUR residuals (CLI, AST, calibration, mutations)

### Added
- **CLI** `platformatic-workflow wur` — extract graphs, offline analyze, source-v1/v2 diff
- **AST extract** (`static/ast-extract.ts`) — scanner for `use workflow`/`use step`/sleep/hooks/`Promise.all|race` without tsc dependency; nested param types need `findMatchingParen`
- **CalibrationStore** — change-class empirical-Bayes severity; wired into `scoreRuns`
- **Devalue flat expand** — table `[ptr, {field: idx}, ...]` → inspectable record
- **Mutation scale** — 400+ pairs FN=0 gate in `wur-extract-cli.test.ts`

### Commands
```bash
pnpm -C packages/workflow exec node --test --test-concurrency=1 \
  test/wur*.test.ts
# 50 tests

node packages/workflow/cli.js wur --extract e2e-v5/workflows/greet.ts --workflow greet
```

### Pitfalls
- Function param regex `[^)]*` fails on `(order: { id: string })` — use balanced paren scan
- Empty prefix R_b is always 0 (oracle must match Def 5.1 for FN gate)

## 2026-07-23 — WUR full fidelity A–H

See prior commit `143a66d`. Core pipeline: hydrate, SP/trace, match/demand, risk, estimate, coupling, oracle.
