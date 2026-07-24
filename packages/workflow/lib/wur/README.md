# WUR — Workflow Upgrade Risk (arXiv:2607.13617)

Telemetry-driven model for quantifying the risk of upgrading in-flight durable
workflow runs from version V₁ to V₂. **No dry-run, sandbox, or shadow execution.**

## Paper map

| Paper | Module |
|-------|--------|
| Def 3.1–3.7 system model | `types.ts`, `sp.ts`, `trace.ts` |
| Def 4.1 matching μ | `match.ts` |
| Def 4.2–4.4 change taxonomy + lattice | `demand.ts`, `lattice.ts` |
| §4.1 demand / Lem 4.5 / satisfiability | `demand.ts` |
| Eq 4 R_b | `risk.ts` `backwardRisk` |
| Eq 5–6 hitting + R_f | `markov.ts`, `risk.ts` `forwardRisk` |
| Eq 7 WUR | `risk-core.ts` |
| §6 Bayesian estimation | `estimate.ts`, `contracts.ts` |
| §8 Algorithm 1 | `analyze.ts` |
| §9 migrate/review/pin | `policy.ts` |
| §10 coupling + min-cut | `channels.ts`, `coupling.ts` |
| §12 evaluation oracle | `oracle.ts` |
| Payload hydration Def 4.3 | `hydrate.ts` |
| Event → prefix Rem 3.5 | `telemetry.ts` |
| Build manifests | `static/extract.ts` |

## Usage

```ts
import { analyzeUpgradeRisk, linearGraph } from './index.ts'

const result = analyzeUpgradeRisk({
  g1: linearGraph([...]),
  g2: linearGraph([...]),
  history,   // completed ProtocolRun[]
  inFlight,  // running ProtocolRun[]
  options: {
    tauLo: 0.1,
    tauHi: 0.5,
    exactRegime: true,
    draws: 200,           // 90% CI
    autoCouple: true,     // build coupling graph from hooks/hierarchy
  },
})
// result.partition → { migrate, review, pin }
```

## API

- `POST /api/v1/apps/:appId/upgrade-risk` — DB telemetry + graphs
- `POST /api/v1/upgrade-risk/analyze` — pure (inline history/inFlight)

## CLI

```bash
# Extract step graph from workflow source
npx @platformatic/workflow wur --extract workflows/order.ts --workflow orderFlow --out g1.json

# Score from graphs + optional telemetry
npx @platformatic/workflow wur --g1 g1.json --g2 g2.json --history h.json --inflight i.json --json

# Diff two source versions (extract + analyze)
npx @platformatic/workflow wur --source-v1 old.ts --source-v2 new.ts --workflow orderFlow
```

## Fidelity tests

```bash
pnpm -C packages/workflow exec node --test --test-concurrency=1 test/wur*.test.ts
```

Gate: **FN = 0** vs oracle on structural mutations (§12 soundness).

### Corpus (`lib/wur/corpus.ts`)

Runs extract → self-diff → mutators over `e2e-v4/workflows` + `e2e-v5/workflows`
(paper §12-style stand-in for the Vercel workbench corpus):

```ts
import { runCorpusReport } from './corpus.ts'
const report = runCorpusReport(['e2e-v5/workflows', 'e2e-v4/workflows'])
// report.sound === true  ⇔  FN=0 and self-diff clean
```

## Devalue hydration

Step payloads stored as BYTEA with Workflow SDK framing (`devl` + devalue text)
are decoded with the `devalue` library (same as `@workflow/core`). Encrypted
payloads (`encr` prefix) remain non-inspectable without a key.

```ts
import { dehydrateForTest, hydrateEventData } from './index.ts'
const buf = dehydrateForTest({ promoCode: 'X' })
const h = hydrateEventData(buf) // recordInspectable: true
```

## Calibration feed

```bash
# After a deploy / incident review
POST /api/v1/apps/:appId/upgrade-risk/calibration
{ "changeClasses": ["insert-step"], "incident": true }

# Or pass annotations from a prior WUR response
{ "annotations": [...], "incident": false }

GET /api/v1/apps/:appId/upgrade-risk/calibration
```

Severity in scoring uses `CalibrationStore` posteriors (§6.4).

**Durable:** table `workflow_wur_calibration` (migration `008`). Loaded on
service ready into `defaultCalibrationStore`; `POST .../calibration` write-through
updates both memory and Postgres (`application_key = 'fleet' | <app_id>`).

## Model limitations (§11)

Implemented *as specified* (not fixed):

- R_f measures exposure, not intent
- Unobserved branches → wide CI / review
- First-order Markov control flow
- Cyclic contagion over-estimates (safe direction)
- Binary migrate/pin cut (k=2 versions)
- Encrypted payloads without key → opaque (no field risk)
