#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create } from '@platformatic/runtime'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Subcommand: wur (upgrade-risk analyzer + CI calibration feed)
if (process.argv[2] === 'wur') {
  const { runWurCli } = await import('./lib/wur/cli-wur.ts')
  const code = await runWurCli(process.argv.slice(3))
  process.exit(code)
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: 'string', default: '0.0.0.0' },
    port: { type: 'string', short: 'p', default: '3042' },
    help: { type: 'boolean', short: 'h', default: false }
  }
})

if (values.help) {
  console.log(`@platformatic/workflow - Workflow orchestration service for Vercel Workflow DevKit

Usage:
  npx @platformatic/workflow <database-url>
  npx @platformatic/workflow wur --g1 g1.json --g2 g2.json [options]
  npx @platformatic/workflow wur --extract workflow.ts [--workflow name]
  npx @platformatic/workflow --help

Examples:
  npx @platformatic/workflow postgresql://user:pass@localhost:5432/workflow
  npx @platformatic/workflow postgresql://user:pass@localhost:5432/workflow --port 4000
  npx @platformatic/workflow wur --source-v1 old.ts --source-v2 new.ts --workflow orderFlow

Options (server):
  --host <host>      Bind address (default: 0.0.0.0)
  --port, -p <port>  Listen port (default: 3042)
  --help, -h         Show this help message

Subcommand wur (WUR analyzer + CI calibration, arXiv:2607.13617):
  --g1 / --g2        Step graph JSON manifests
  --source-v1/v2     Extract graphs from workflow source
  --extract <file>   Emit graph manifest(s) from source
  --history / --inflight  Protocol run telemetry JSON
  --record-exposure  After analyze, record change-class exposure (for CI)
  --incident         Mark that exposure as an incident (bad release)
  --app-id <id>      Application id (or PLT_WORLD_APP_ID)
  --service-url <u>  Workflow service for HTTP calibration (or PLT_WORLD_SERVICE_URL)
  --database-url <u> Postgres write-through (or DATABASE_URL)
  wur calibration record --app-id X --class insert-step [--incident]
  wur calibration show --app-id X

The service runs in single-tenant mode (no auth) by default.
For multi-tenant mode with K8s authentication, deploy via the Platformatic Helm chart.

Documentation: https://github.com/platformatic/platformatic-world`)
  process.exit(0)
}

const databaseUrl = positionals[0] || process.env.DATABASE_URL

if (!databaseUrl) {
  console.error('Error: Database URL is required (or use: platformatic-workflow wur ...).')
  console.error('')
  console.error('Usage:')
  console.error('  npx @platformatic/workflow postgresql://user:pass@localhost:5432/workflow')
  console.error('  npx @platformatic/workflow wur --help')
  console.error('')
  process.exit(1)
}

process.env.DATABASE_URL = databaseUrl
process.env.HOST = values.host
process.env.PORT = values.port

const runtime = await create(__dirname, null, { isProduction: true })
await runtime.init()
await runtime.start()

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await runtime.close()
    process.exit(0)
  })
}
