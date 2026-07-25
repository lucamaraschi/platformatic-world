# `@platformatic/wur`

**Workflow Upgrade Risk** (arXiv:2607.13617) — slim **CLI + library for CI/ops**.

This package does **not** include the workflow orchestration service. Install it in product CI without pulling Fastify, watt, or `@platformatic/workflow`.

| Package | Role |
|---------|------|
| **`@platformatic/wur`** (this) | Score V₁→V₂ upgrade risk; optional calibration feed |
| `@platformatic/world` | App-side World client (runtime) |
| `@platformatic/workflow` | Deployable service (runtime + HTTP upgrade-risk APIs) |

## Install (product CI)

```bash
# DevDependency or npx — no service deps
npm i -D @platformatic/wur
# optional peers:
#   typescript  — better demand AST
#   pg          — only if you pass DATABASE_URL (prefer --service-url)
```

## CLI

```bash
# Score two workflow sources
npx @platformatic/wur --source-v1 old.ts --source-v2 new.ts --workflow orderFlow --json

# CI: compare + record exposure via HTTP to a running service (recommended)
npx @platformatic/wur --source-v1 old.ts --source-v2 new.ts \
  --app-id my-app --record-exposure \
  --service-url "$PLT_WORLD_SERVICE_URL"

# After a bad release
npx @platformatic/wur ... --record-exposure --incident --service-url ...

# Explicit calibration helpers
npx @platformatic/wur calibration record --app-id my-app --class insert-step --incident \
  --service-url http://workflow:3042
npx @platformatic/wur calibration show --app-id my-app --service-url http://workflow:3042
```

Bins: `wur`, `platformatic-wur` (same entry).

## Library

```ts
import { analyzeUpgradeRisk, extractGraphsFromSource } from '@platformatic/wur'
```

Full model docs: [`lib/README.md`](./lib/README.md).

## Monorepo

```bash
pnpm --filter @platformatic/wur test
pnpm --filter @platformatic/wur run ci:compare
```

Service integration tests (HTTP plugin + Postgres) stay under `@platformatic/workflow`.
