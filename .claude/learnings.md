# Session learnings

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
