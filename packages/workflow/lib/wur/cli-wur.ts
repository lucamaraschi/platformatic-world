/**
 * Offline WUR CLI — score upgrade risk from graphs + optional telemetry JSON.
 *
 * Usage:
 *   platformatic-workflow wur --g1 g1.json --g2 g2.json [--history h.json] [--inflight i.json]
 *   platformatic-workflow wur --extract workflow.ts [--workflow name] [--out graph.json]
 *   platformatic-workflow wur --g1 g1.json --g2 g2.json --source-v1 a.ts --source-v2 b.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { analyzeUpgradeRisk } from './analyze.ts'
import { extractGraphsFromSource, extractWorkflowGraph } from './static/ast-extract.ts'
import { graphToManifest, manifestToGraph, type GraphManifest } from './static/extract.ts'
import type { ProtocolRun, StepGraph } from './types.ts'

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
}

export function parseWurArgs (argv: string[]): WurCliArgs {
  const args: WurCliArgs = {}
  for (let i = 0; i < argv.length; i++) {
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
      default: break
    }
  }
  return args
}

function loadGraph (path: string): StepGraph {
  const raw = JSON.parse(readFileSync(resolve(path), 'utf8')) as GraphManifest | StepGraph
  if ('sites' in raw && Array.isArray(raw.sites)) {
    // Manifest or graph
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

export function runWurCli (argv: string[]): number {
  const args = parseWurArgs(argv)

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
    console.error(`Usage:
  platformatic-workflow wur --g1 g1.json --g2 g2.json [--history h.json] [--inflight i.json]
  platformatic-workflow wur --extract workflow.ts [--workflow name] [--out graph.json]
  platformatic-workflow wur --source-v1 a.ts --source-v2 b.ts [--workflow name]

Options:
  --tau-lo <n>   migrate threshold (default 0.1)
  --tau-hi <n>   pin threshold (default 0.5)
  --draws <n>    Monte Carlo draws for CI (default 0)
  --alpha <n>    behavioral discount (default 1)
  --json         machine-readable output
`)
    return 1
  }

  const history = loadRuns(args.history)
  const inFlight = loadRuns(args.inflight)

  const result = analyzeUpgradeRisk({
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

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
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
