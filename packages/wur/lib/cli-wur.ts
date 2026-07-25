/**
 * WUR CLI — score upgrade risk + record calibration from CI.
 *
 * Slim package: `npx @platformatic/wur` / `wur` (no Fastify service).
 *
 * Analyze (typical CI):
 *   npx @platformatic/wur --source-v1 old.ts --source-v2 new.ts \
 *     --app-id my-app --record-exposure --service-url http://workflow:3042
 *
 * Persistence:
 *   --service-url …     HTTP to workflow service (preferred for product CI)
 *   DATABASE_URL=…      direct Postgres (optional peer dep `pg`)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { analyzeUpgradeRisk } from './analyze.ts'
import {
  classesFromAnnotations,
  defaultCalibrationStore,
  type ChangeClass,
} from './calibration.ts'
import {
  loadCalibrationFromDb,
  recordReleaseOutcomePersistent,
} from './calibration-db.ts'
import { extractGraphsFromSource, extractWorkflowGraph } from './static/ast-extract.ts'
import { graphToManifest, manifestToGraph, type GraphManifest } from './static/extract.ts'
import type { FleetRiskResult, ProtocolRun, StepGraph } from './types.ts'

export interface WurCliArgs {
  g1?: string
  g2?: string
  history?: string
  inflight?: string
  extract?: string
  workflow?: string
  out?: string
  sourceV1?: string
  sourceV2?: string
  tauLo?: number
  tauHi?: number
  draws?: number
  alpha?: number
  json?: boolean
  /** After analyze, record exposure for inferred change classes (CI). */
  recordExposure?: boolean
  /** Mark recorded outcome as incident (default false = benign exposure). */
  incident?: boolean
  appId?: string
  serviceUrl?: string
  databaseUrl?: string
  /** Explicit classes for `calibration record` (comma-separated or repeated). */
  classes?: string[]
  /** Subcommand path: [] | ['calibration','record'] | ['calibration','show'] */
  subcommand?: string[]
}

export function parseWurArgs (argv: string[]): WurCliArgs {
  const args: WurCliArgs = { subcommand: [], classes: [] }
  let i = 0

  // Optional subcommands: calibration record|show
  if (argv[0] === 'calibration') {
    args.subcommand = ['calibration']
    i = 1
    if (argv[1] === 'record' || argv[1] === 'show') {
      args.subcommand.push(argv[1])
      i = 2
    }
  }

  for (; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--g1': args.g1 = next(); break
      case '--g2': args.g2 = next(); break
      case '--history': args.history = next(); break
      case '--inflight': case '--in-flight': args.inflight = next(); break
      case '--extract': args.extract = next(); break
      case '--workflow': args.workflow = next(); break
      case '--out': args.out = next(); break
      case '--source-v1': args.sourceV1 = next(); break
      case '--source-v2': args.sourceV2 = next(); break
      case '--tau-lo': args.tauLo = Number(next()); break
      case '--tau-hi': args.tauHi = Number(next()); break
      case '--draws': args.draws = Number(next()); break
      case '--alpha': args.alpha = Number(next()); break
      case '--json': args.json = true; break
      case '--record-exposure': args.recordExposure = true; break
      case '--incident': args.incident = true; break
      case '--app-id': args.appId = next(); break
      case '--service-url': args.serviceUrl = next(); break
      case '--database-url': args.databaseUrl = next(); break
      case '--class': case '--classes': {
        const v = next()
        if (v) args.classes!.push(...v.split(',').map(s => s.trim()).filter(Boolean))
        break
      }
      case '--help': case '-h':
        args.subcommand = ['help']
        break
      default: break
    }
  }

  // Env fallbacks
  if (!args.databaseUrl && process.env.DATABASE_URL) {
    args.databaseUrl = process.env.DATABASE_URL
  }
  if (!args.serviceUrl && process.env.PLT_WORLD_SERVICE_URL) {
    args.serviceUrl = process.env.PLT_WORLD_SERVICE_URL
  }
  if (!args.appId && process.env.PLT_WORLD_APP_ID) {
    args.appId = process.env.PLT_WORLD_APP_ID
  }

  return args
}

function printHelp (): void {
  console.error(`@platformatic/wur (arXiv:2607.13617) — upgrade risk + calibration for CI

Analyze workflows (typical CI step):
  npx @platformatic/wur --source-v1 old.ts --source-v2 new.ts \\
    --app-id my-app --record-exposure --service-url http://workflow:3042
  npx @platformatic/wur --g1 g1.json --g2 g2.json \\
    --history h.json --inflight i.json --record-exposure --json

  # After a bad deploy / failed canary, re-run with:
  npx @platformatic/wur ... --record-exposure --incident

Extract graphs:
  npx @platformatic/wur --extract workflow.ts [--workflow name] [--out g.json]

Calibration (explicit):
  npx @platformatic/wur calibration record --app-id my-app \\
    --class insert-step,demand-growth [--incident]
  npx @platformatic/wur calibration show --app-id my-app

Persistence (pick one):
  --service-url http://host:3042         POST to workflow service (product CI)
  DATABASE_URL=postgresql://...          write-through to Postgres (optional peer: pg)
  (in-memory only if neither is set — prints a warning)

Env aliases: PLT_WORLD_SERVICE_URL, PLT_WORLD_APP_ID, DATABASE_URL
`)
}

/** Optional peer `pg` — only required for DATABASE_URL write-through. */
async function createPgPool (connectionString: string) {
  let mod: typeof import('pg')
  try {
    mod = await import('pg')
  } catch {
    throw new Error(
      'DATABASE_URL persistence requires the optional peer dependency `pg`. ' +
      'Install it (`npm i pg`) or use --service-url instead.'
    )
  }
  const Pool = mod.default?.Pool ?? mod.Pool
  return new Pool({ connectionString })
}

function loadGraph (path: string): StepGraph {
  const raw = JSON.parse(readFileSync(resolve(path), 'utf8')) as GraphManifest | StepGraph
  if ('sites' in raw && Array.isArray(raw.sites)) {
    if (raw.sites[0] && 'name' in (raw.sites[0] as object) && !('label' in (raw.sites[0] as object))) {
      return manifestToGraph(raw as GraphManifest)
    }
    return raw as StepGraph
  }
  throw new Error(`invalid graph file: ${path}`)
}

function loadRuns (path: string | undefined): ProtocolRun[] {
  if (!path) return []
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as ProtocolRun[]
}

type PersistMode = 'db' | 'http' | 'memory'

function resolvePersistMode (args: WurCliArgs): PersistMode {
  if (args.databaseUrl) return 'db'
  if (args.serviceUrl) return 'http'
  return 'memory'
}

async function recordCalibration (opts: {
  args: WurCliArgs
  changeClasses: ChangeClass[]
  incident: boolean
  exposures?: number
}): Promise<{ mode: PersistMode, changeClasses: ChangeClass[] }> {
  const { args, changeClasses, incident } = opts
  const exposures = opts.exposures ?? 1
  const mode = resolvePersistMode(args)
  const appId = args.appId ?? 'default'

  if (changeClasses.length === 0) {
    return { mode, changeClasses: [] }
  }

  if (mode === 'db') {
    const pool = await createPgPool(args.databaseUrl!)
    try {
      await recordReleaseOutcomePersistent({
        pg: pool,
        appIdStr: appId,
        changeClasses,
        incident,
        exposures,
        store: defaultCalibrationStore,
      })
    } finally {
      await pool.end()
    }
  } else if (mode === 'http') {
    const base = args.serviceUrl!.replace(/\/$/, '')
    const url = `${base}/api/v1/apps/${encodeURIComponent(appId)}/upgrade-risk/calibration`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        changeClasses,
        incident,
        exposures,
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`calibration HTTP ${res.status}: ${text}`)
    }
  } else {
    // memory only — still update process store for this CLI invocation
    const { recordReleaseOutcome } = await import('./calibration.ts')
    for (let i = 0; i < exposures; i++) {
      recordReleaseOutcome({
        appId,
        changeClasses,
        incident,
        store: defaultCalibrationStore,
      })
    }
  }

  return { mode, changeClasses }
}

async function runCalibrationShow (args: WurCliArgs): Promise<number> {
  const appId = args.appId ?? 'default'
  const mode = resolvePersistMode(args)

  if (mode === 'http') {
    const base = args.serviceUrl!.replace(/\/$/, '')
    const url = `${base}/api/v1/apps/${encodeURIComponent(appId)}/upgrade-risk/calibration`
    const res = await fetch(url)
    if (!res.ok) {
      console.error(`GET calibration failed: ${res.status} ${await res.text()}`)
      return 1
    }
    const body = await res.json()
    console.log(JSON.stringify(body, null, 2))
    return 0
  }

  if (mode === 'db') {
    const pool = await createPgPool(args.databaseUrl!)
    try {
      await loadCalibrationFromDb(pool, defaultCalibrationStore)
    } finally {
      await pool.end()
    }
  }

  const classes: ChangeClass[] = [
    'body-only', 'demand-growth', 'insert-step', 'insert-timer', 'delete-site',
    'swap-sites', 'parallel-reorder', 'predicate-change', 'predicate-refactor',
    'migration', 'unknown',
  ]
  const out = {
    mode,
    appId,
    app: Object.fromEntries(classes.map(c => [c, defaultCalibrationStore.calibrate(c, appId)])),
    fleet: Object.fromEntries(classes.map(c => [c, defaultCalibrationStore.calibrate(c)])),
  }
  console.log(JSON.stringify(out, null, 2))
  if (mode === 'memory') {
    console.error('warning: no DATABASE_URL or --service-url; showing in-process store only')
  }
  return 0
}

async function runCalibrationRecord (args: WurCliArgs): Promise<number> {
  const classes = (args.classes ?? []) as ChangeClass[]
  if (classes.length === 0) {
    console.error('calibration record requires --class <name>[,name...]')
    return 1
  }
  if (!args.appId) {
    console.error('calibration record requires --app-id (or PLT_WORLD_APP_ID)')
    return 1
  }
  try {
    const { mode, changeClasses } = await recordCalibration({
      args,
      changeClasses: classes,
      incident: args.incident === true,
    })
    const payload = {
      recorded: true,
      durable: mode !== 'memory',
      mode,
      appId: args.appId,
      changeClasses,
      incident: args.incident === true,
    }
    console.log(JSON.stringify(payload, null, 2))
    if (mode === 'memory') {
      console.error('warning: no DATABASE_URL or --service-url; calibration is in-memory only')
    }
    return 0
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    return 1
  }
}

export async function runWurCli (argv: string[]): Promise<number> {
  const args = parseWurArgs(argv)

  if (args.subcommand?.[0] === 'help') {
    printHelp()
    return 0
  }

  if (args.subcommand?.[0] === 'calibration') {
    const action = args.subcommand[1]
    if (action === 'show') return runCalibrationShow(args)
    if (action === 'record') return runCalibrationRecord(args)
    printHelp()
    return 1
  }

  // Extract mode
  if (args.extract) {
    const source = readFileSync(resolve(args.extract), 'utf8')
    const result = extractGraphsFromSource(source, {
      modulePath: args.extract.replace(/\\/g, '/'),
    })
    if (args.workflow) {
      const g = result.workflows.find(w => w.name === args.workflow)
      if (!g) {
        console.error(`workflow ${args.workflow} not found; have: ${result.workflows.map(w => w.name).join(', ')}`)
        return 1
      }
      const out = graphToManifest(g.graph)
      const text = JSON.stringify(out, null, 2)
      if (args.out) writeFileSync(resolve(args.out), text)
      else console.log(text)
    } else {
      const out = result.workflows.map(w => ({
        name: w.name,
        graph: graphToManifest(w.graph),
      }))
      const text = JSON.stringify({ workflows: out, warnings: result.warnings }, null, 2)
      if (args.out) writeFileSync(resolve(args.out), text)
      else console.log(text)
    }
    for (const w of result.warnings) console.error(`warning: ${w}`)
    return 0
  }

  // Analyze mode
  let g1: StepGraph
  let g2: StepGraph

  if (args.sourceV1 && args.sourceV2) {
    const s1 = readFileSync(resolve(args.sourceV1), 'utf8')
    const s2 = readFileSync(resolve(args.sourceV2), 'utf8')
    const eg1 = extractWorkflowGraph(s1, args.workflow, { modulePath: args.sourceV1 })
    const eg2 = extractWorkflowGraph(s2, args.workflow, { modulePath: args.sourceV2 })
    if (!eg1 || !eg2) {
      console.error('failed to extract workflow graphs from sources')
      return 1
    }
    g1 = eg1
    g2 = eg2
  } else if (args.g1 && args.g2) {
    g1 = loadGraph(args.g1)
    g2 = loadGraph(args.g2)
  } else {
    printHelp()
    return 1
  }

  const history = loadRuns(args.history)
  const inFlight = loadRuns(args.inflight)

  const result: FleetRiskResult = analyzeUpgradeRisk({
    g1,
    g2,
    history,
    inFlight,
    options: {
      tauLo: args.tauLo ?? 0.1,
      tauHi: args.tauHi ?? 0.5,
      draws: args.draws ?? 0,
      alpha: args.alpha ?? 1,
      exactRegime: true,
      autoCouple: true,
    },
  })

  // CI calibration: record exposure (and optional incident) from annotations
  let calibrationMeta: Record<string, unknown> | undefined
  if (args.recordExposure) {
    if (!args.appId) {
      console.error('error: --record-exposure requires --app-id (or PLT_WORLD_APP_ID)')
      return 1
    }
    const changeClasses = classesFromAnnotations(result.annotations)
    try {
      const rec = await recordCalibration({
        args,
        changeClasses,
        incident: args.incident === true,
      })
      calibrationMeta = {
        recorded: true,
        durable: rec.mode !== 'memory',
        mode: rec.mode,
        changeClasses: rec.changeClasses,
        incident: args.incident === true,
      }
      if (rec.mode === 'memory') {
        console.error('warning: no DATABASE_URL or --service-url; calibration is in-memory only')
      } else if (!args.json) {
        console.error(
          `calibration: recorded ${rec.changeClasses.join(',') || '(none)'} ` +
          `as ${args.incident ? 'incident' : 'exposure'} via ${rec.mode}`
        )
      }
    } catch (err) {
      console.error('calibration record failed:', err instanceof Error ? err.message : err)
      return 1
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ ...result, calibration: calibrationMeta }, null, 2))
  } else {
    console.log(`WUR fleet score: ${result.wur.toFixed(4)}${result.wurInterval ? ` CI90=[${result.wurInterval[0].toFixed(3)}, ${result.wurInterval[1].toFixed(3)}]` : ''}`)
    console.log(`partition: migrate=${result.partition?.migrate.length ?? 0} review=${result.partition?.review.length ?? 0} pin=${result.partition?.pin.length ?? 0}`)
    for (const r of result.runs) {
      console.log(`  ${r.runId}: ${r.verdict}  Rb=${r.backwardRisk.toFixed(3)} Rf=${r.forwardRisk.toFixed(3)} WUR=${r.wur.toFixed(3)}`)
    }
    for (const a of result.annotations) {
      console.log(`  Δ ${a.axis} @ ${a.siteId}: ${a.reason} (affects ~${a.affectedRuns})`)
    }
    for (const w of result.warnings) console.error(`warning: ${w}`)
  }
  return 0
}
