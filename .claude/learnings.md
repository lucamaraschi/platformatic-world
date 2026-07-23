# Session learnings

## 2026-07-23 — WUR full fidelity (arXiv:2607.13617)

### Decisions
- Implemented all workstreams A–H on `feat/wur-upgrade-risk` in one push after the skeleton.
- **Oracle for R_b FN gate** treats empty prefixes as safe (no recorded history); head-insert only fails non-empty prefixes. Matches Def 5.1.
- Build-manifest extract (`static/extract.ts`) ships first; full TS AST extractor deferred.
- Monte Carlo `draws` optional (0 in tests for speed; 200 for prod CI).
- Integer min-cut capacities retained for Thm 10.5 exactness.

### Module layout
```
lib/wur/
  hydrate.ts, telemetry.ts     # WS-A
  sp.ts, trace.ts, prefix.ts   # WS-B
  match.ts, demand.ts, lattice.ts, static/extract.ts  # WS-C
  risk.ts, risk-core.ts        # WS-D
  estimate.ts                  # WS-E
  channels.ts, coupling.ts     # WS-F
  analyze.ts, policy.ts        # WS-G
  oracle.ts                    # WS-H
```

### Commands
```bash
pnpm -C packages/workflow exec node --test --test-concurrency=1 \
  test/wur.test.ts test/wur-fidelity.test.ts
# 39 tests, FN=0 on structural mutations
```

### Residual (paper §11 model limits, not bugs)
- No full devalue SDK hydration (opaque → unk)
- No production AST step-graph extract
- Semi-Markov / multiway k>2 cuts not implemented
- Class calibration needs real deployment-incident history
