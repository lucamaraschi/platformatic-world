# Session learnings

## 2026-07-23 — WUR (arXiv:2607.13617)

### Decisions
- Implemented the paper as a **world-agnostic pure library** under `packages/workflow/lib/wur/`, plus Fastify endpoints. Static step graphs are caller-supplied (no JS source analyzer yet); telemetry comes from event logs.
- Exact regime for interface risk: recorded producer payloads are validated against new consumer demands; distributional regime uses field-presence frequencies with Beta posteriors.
- Coupling layer: contagion least-fixpoint + s–t min-cut for migrate/pin; hard pin when `R_b > 0`.

### Problems & fixes
- `primaryAxis` in `siteIncompatibilities` defaulted to `'protocol'`, so interface changes were labeled protocol and skipped exact payload checks → all forward risk collapsed to 1. Fixed by initializing from the first change axis.
- Postgres 18 rejects volume mount at `/var/lib/postgresql/data`; compose volume updated to `/var/lib/postgresql`.

### Useful commands
```bash
pnpm -C packages/workflow exec node --test --test-concurrency=1 test/wur.test.ts
docker compose up -d   # after volume path fix
```

### Paper mapping
| Paper | Code |
|---|---|
| Algorithm 1 | `lib/wur/analyze.ts` |
| Matching μ, Δ | `lib/wur/graph.ts` |
| ρ, lattice | `lib/wur/contracts.ts` |
| Markov / hitting | `lib/wur/markov.ts` |
| R_b, R_f, WUR | `lib/wur/risk.ts` |
| migrate/review/pin | `lib/wur/policy.ts` |
| Contagion + min-cut | `lib/wur/coupling.ts` |
| Event → prefix | `lib/wur/telemetry.ts` |
