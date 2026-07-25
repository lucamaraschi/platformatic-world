# Session learnings

## Deferred / do not forget

- **[calib-persist] DONE** — migration `008`, `calibration-db.ts`, load onReady, write-through on POST. Keys: `fleet` + external app_id string.
- **Gaps fill DONE** — demand-infer, resource fingerprints, large mutation study, CI `test:wur` step.
- **Paper-perfect push DONE** — vendored vercel workbench corpus (`test/fixtures/vercel-corpus`), `paper-eval.ts` S1–S11 + corpus mutations, deeper demand (Promise.all, alias, if-predicates).
- **Last 3 chased DONE**:
  1. Corpus pinned to paper commit `39673b7a381b029032525485e566f1663f549fa3`
  2. TS compiler AST demand (`ts-demand.ts`) preferred over scanner
  3. `realcorpus/` JSON artifacts (paper hand-translation constructors); regenerate via `pnpm -C packages/workflow run generate:realcorpus`
- **CLI calibration feed DONE** (`c08d730`) — CI WF compare can call `wur ... --record-exposure [--incident]` with `DATABASE_URL` or `--service-url`; also `wur calibration record|show`

## 2026-07-24 — CLI calibration for CI

- Problem: CalibrationStore only learned when ops POSTed to the API; CI already runs WF compare offline.
- Fix: `runWurCli` is async; `--record-exposure` maps annotations → change classes via `classesFromAnnotations`, then writes via Postgres (`recordReleaseOutcomePersistent`) or HTTP POST.
- Env: `DATABASE_URL`, `PLT_WORLD_SERVICE_URL`, `PLT_WORLD_APP_ID`
- Tests: `test/wur-cli-calibration.test.ts` (parse + DB write-through + incident + show)

## 2026-07-24 — CI compare recipe

- `packages/workflow/scripts/wur-ci-compare.ts` + `pnpm … run ci:wur-compare`
- GHA step in `ci.yml` test job: `fetch-depth: 0`, `WUR_BASE_SHA`/`WUR_HEAD_SHA` from PR base or `github.event.before`, paths `e2e-v5/workflows e2e-v4/workflows`, `WUR_RECORD=1`, soft gate (`WUR_GATE=0`)
- Product apps: set `WUR_PATHS` to their workflow dirs; use prod DB only for `--incident`, not ephemeral CI Postgres
- Smoke always self-diffs `greet.ts` so the job exercises CLI even when no workflow files changed

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
