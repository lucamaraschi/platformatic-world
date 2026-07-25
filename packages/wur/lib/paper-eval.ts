/**
 * Paper-faithful evaluation harness (arXiv:2607.13617 §12.1–12.3).
 *
 * - Controlled scenarios S1–S11 on a fixed reference workflow
 * - Mutation study over corpus graphs
 * - Vercel workbench corpus loader
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  evaluateMutation,
  defaultMutators,
  loadCorpus,
  discoverWorkflowFiles,
  type CorpusEntry,
  type Confusion,
  type MutationResult,
} from './corpus.ts'
import { isPrefixValid } from './prefix.ts'
import { matchGraphs } from './match.ts'
import { oracleUnsafe } from './oracle.ts'
import { analyzeUpgradeRisk } from './analyze.ts'
import { linearGraph, parallelGraph, topologicalOrder } from './sp.ts'
import { loadRealCorpusArtifacts } from './static/realcorpus.ts'
import type { ProtocolRun, StepGraph } from './types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Default path to vendored Vercel workbench corpus (§12.3). */
export function vercelCorpusDirs (repoRoot?: string): string[] {
  // Prefer package-relative fixtures (works from monorepo root or package cwd)
  const local = join(__dirname, '../../test/fixtures/vercel-corpus')
  if (repoRoot) {
    const base = join(repoRoot, 'packages/wur/test/fixtures/vercel-corpus')
    return [join(base, 'vitest'), join(base, 'cookbook'), join(base, 'example')]
  }
  return [join(local, 'vitest'), join(local, 'cookbook'), join(local, 'example')]
}

export function loadVercelCorpus (repoRoot?: string): CorpusEntry[] {
  // Prefer hand-translation artifacts (paper realcorpus) when present
  const corpusRoot = repoRoot
    ? join(repoRoot, 'packages/wur/test/fixtures/vercel-corpus')
    : join(__dirname, '../../test/fixtures/vercel-corpus')
  const arts = loadRealCorpusArtifacts(corpusRoot)
  if (arts.length > 0) {
    return arts
      .filter(e => e.graph.sites.length > 0)
      .map(e => ({
        sourcePath: e.sourcePath,
        workflowName: e.workflowName,
        graph: e.graph,
        warnings: e.translationNotes.filter(n => n.startsWith('warn:')),
      }))
  }
  const files = discoverWorkflowFiles(vercelCorpusDirs(repoRoot))
  return loadCorpus(files).filter(e => e.graph.sites.length > 0)
}

// ---------------------------------------------------------------------------
// §12.1 reference workflow + scenarios
// ---------------------------------------------------------------------------

/** Fixed workflow with parallel group, branch, timers, partial fields (paper §12.1). */
export function paperReferenceGraph (): StepGraph {
  return parallelGraph({
    prefix: [
      { id: 'validate', name: 'validate' },
      { id: 'charge', name: 'charge' },
    ],
    branches: [
      [{ id: 'shipA', name: 'shipA' }],
      [{ id: 'shipB', name: 'shipB' }],
    ],
    suffix: [
      { id: 'sleep', name: 'sleep', kind: 'timer' },
      { id: 'notify', name: 'notify' },
      { id: 'archive', name: 'archive' },
    ],
    groupId: 'ship',
    kind: 'join',
  })
}

export type ScenarioId =
  | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S9' | 'S10' | 'S11'

export interface ScenarioSpec {
  id: ScenarioId
  description: string
  /** Build g2 from g1. */
  mutate: (g1: StepGraph) => StepGraph
  /** Expected: structural R_b unsafe only when non-empty prefix conflicts. */
  expectStructuralRisk: boolean
}

/**
 * Paper §12.1 scenario definitions (structural layer).
 * S9/S10 are conservative predicate FP cases (paper reports FP, FN=0).
 */
export function paperScenarios (): ScenarioSpec[] {
  return [
    {
      id: 'S1',
      description: 'body-only edit',
      mutate: g => ({ ...g, sites: g.sites.map(s => ({ ...s })) }),
      expectStructuralRisk: false,
    },
    {
      id: 'S2',
      description: 'consume always-present field',
      mutate: g => ({
        ...g,
        sites: g.sites.map(s =>
          s.id === 'archive'
            ? { ...s, demandFields: ['amount'], consumesFrom: ['charge'] }
            : s
        ),
      }),
      expectStructuralRisk: false, // interface only; protocol prefix valid
    },
    {
      id: 'S3',
      description: 'consume partial field p=0.7',
      mutate: g => ({
        ...g,
        sites: g.sites.map(s =>
          s.id === 'archive'
            ? { ...s, demandFields: ['promoCode'], consumesFrom: ['charge'] }
            : s
        ),
      }),
      expectStructuralRisk: false,
    },
    {
      id: 'S4',
      description: 'insert step at head',
      mutate: g => {
        const sites = [
          { id: 'audit', label: { name: 'audit', kind: 'step' as const } },
          ...g.sites,
        ]
        const edges = g.edges.map(e =>
          e.from === null ? { ...e, from: 'audit' } : { ...e }
        )
        edges.unshift({ from: null, to: 'audit' })
        return { ...g, sites, edges }
      },
      expectStructuralRisk: true,
    },
    {
      id: 'S5',
      description: 'insert step at tail',
      mutate: g => {
        const order = topologicalOrder(g)
        const last = order[order.length - 1]
        return {
          ...g,
          sites: [...g.sites, { id: 'tail', label: { name: 'tail', kind: 'step' as const } }],
          edges: [...g.edges, { from: last, to: 'tail' }],
        }
      },
      expectStructuralRisk: false,
    },
    {
      id: 'S6',
      description: 'delete tail step',
      mutate: g => {
        const order = topologicalOrder(g)
        const last = order[order.length - 1]
        return {
          ...g,
          sites: g.sites.filter(s => s.id !== last),
          edges: g.edges.filter(e => e.to !== last && e.from !== last),
        }
      },
      expectStructuralRisk: true, // when prefix includes deleted site
    },
    {
      id: 'S7',
      description: 'swap step/timer',
      mutate: g => {
        // swap sleep and notify if both present
        const order = topologicalOrder(g)
        const names = order.map(id => {
          const s = g.sites.find(x => x.id === id)!
          return { id: s.id, name: s.label.name, kind: s.label.kind }
        })
        const i = names.findIndex(n => n.name === 'sleep' || n.kind === 'timer')
        const j = names.findIndex(n => n.name === 'notify')
        if (i >= 0 && j >= 0) {
          ;[names[i], names[j]] = [names[j], names[i]]
        } else if (names.length >= 2) {
          ;[names[0], names[1]] = [names[1], names[0]]
        }
        // rebuild linear from names loses parallel — for S7 use simple linear swap of adjacent after join
        return linearGraph(names.map(n => ({ id: n.id, name: n.name, kind: n.kind })))
      },
      expectStructuralRisk: true,
    },
    {
      id: 'S8',
      description: 'Promise.all branch reorder',
      mutate: g => {
        const groups = g.parallelGroups ?? []
        if (!groups.length) return g
        const g0 = groups[0]
        const reordered = {
          ...g0,
          branches: [...g0.branches].reverse(),
        }
        return {
          ...g,
          parallelGroups: [reordered, ...groups.slice(1)],
        }
      },
      expectStructuralRisk: true,
    },
    {
      id: 'S9',
      description: 'predicate semantic change (conservative FP ok)',
      mutate: g => ({
        ...g,
        edges: g.edges.map((e, i) =>
          i === 0 ? { ...e, predicate: 'x > 0' } : e
        ),
      }),
      expectStructuralRisk: true, // may FP on all prefixes touching edge
    },
    {
      id: 'S10',
      description: 'predicate refactor no-op (conservative FP ok)',
      mutate: g => ({
        ...g,
        edges: g.edges.map((e, i) =>
          i === 0 ? { ...e, predicate: '(x) > (0)' } : e
        ),
      }),
      expectStructuralRisk: true, // syntactic FP
    },
    {
      id: 'S11',
      description: 'insert timer mid-workflow',
      mutate: g => {
        const order = topologicalOrder(g)
        if (order.length < 2) return g
        const names = order.map(id => {
          const s = g.sites.find(x => x.id === id)!
          return { id: s.id, name: s.label.name, kind: s.label.kind }
        })
        names.splice(2, 0, { id: 'midSleep', name: 'midSleep', kind: 'timer' as const })
        return linearGraph(names)
      },
      expectStructuralRisk: true,
    },
  ]
}

export interface ScenarioResult {
  id: ScenarioId
  description: string
  predictedUnsafe: number
  trueUnsafe: number
  fp: number
  fn: number
  total: number
}

/**
 * Evaluate one scenario against N in-flight runs at random frontiers.
 */
export function evalScenario (
  spec: ScenarioSpec,
  nRuns = 400
): ScenarioResult {
  const g1 = paperReferenceGraph()
  const g2 = spec.mutate(g1)
  const order = topologicalOrder(g1)
  const matching = matchGraphs(g1, g2)

  let predictedUnsafe = 0
  let trueUnsafe = 0
  let fp = 0
  let fn = 0

  for (let i = 0; i < nRuns; i++) {
    const f = i % (order.length + 1)
    const sites = order.slice(0, f)
    const frontier = f < order.length ? order[f] : null
    const pred = !isPrefixValid(sites, g1, g2, matching).valid
    const truth = oracleUnsafe(g1, g2, sites, frontier)
    if (pred) predictedUnsafe++
    if (truth) trueUnsafe++
    if (pred && !truth) fp++
    if (!pred && truth) fn++
  }

  return {
    id: spec.id,
    description: spec.description,
    predictedUnsafe,
    trueUnsafe,
    fp,
    fn,
    total: nRuns,
  }
}

export function evalAllScenarios (nRuns = 400): ScenarioResult[] {
  return paperScenarios().map(s => evalScenario(s, nRuns))
}

// ---------------------------------------------------------------------------
// §12.2 / §12.3 mutation on real corpus
// ---------------------------------------------------------------------------

export interface PaperMutationReport {
  corpusSize: number
  totalSites: number
  byMutation: MutationResult[]
  totals: Confusion
  sound: boolean
  precision: number
  recall: number
}

export function evalCorpusMutations (entries: CorpusEntry[]): PaperMutationReport {
  const totals: Confusion = { tp: 0, fp: 0, fn: 0, tn: 0 }
  const byMutation: MutationResult[] = []
  let totalSites = 0
  for (const e of entries) totalSites += e.graph.sites.length

  for (const mut of defaultMutators()) {
    if (mut.name === 'demand-growth') continue
    const r = evaluateMutation(entries, mut.apply, mut.name)
    byMutation.push(r)
    totals.tp += r.tp
    totals.fp += r.fp
    totals.fn += r.fn
    totals.tn += r.tn
  }

  const precision = totals.tp + totals.fp > 0 ? totals.tp / (totals.tp + totals.fp) : 1
  const recall = totals.tp + totals.fn > 0 ? totals.tp / (totals.tp + totals.fn) : 1

  return {
    corpusSize: entries.length,
    totalSites,
    byMutation,
    totals,
    sound: totals.fn === 0,
    precision,
    recall,
  }
}

/**
 * Worked example §9.1 as a regression check.
 */
export function workedExamplePartitions (): Map<string, string> {
  const g1 = linearGraph([
    { id: 'validate', name: 'validate' },
    { id: 'charge', name: 'charge', outputFields: ['amount'] },
    { id: 'sleep', name: 'sleep', kind: 'timer' },
    { id: 'notify', name: 'notify' },
    { id: 'archive', name: 'archive', demandFields: [], consumesFrom: ['charge'] },
  ])
  const g2 = linearGraph([
    { id: 'validate', name: 'validate' },
    { id: 'charge', name: 'charge', outputFields: ['amount', 'promoCode'] },
    { id: 'sleep', name: 'sleep', kind: 'timer' },
    { id: 'notify', name: 'notify' },
    { id: 'archive', name: 'archive', demandFields: ['promoCode'], consumesFrom: ['charge'] },
  ])

  function run (id: string, steps: Array<{ name: string, done: boolean, result?: unknown }>, status = 'running'): ProtocolRun {
    const events: ProtocolRun['events'] = []
    let seq = 1
    for (const s of steps) {
      const corr = `01ARZ3NDEKTSV4RRFFQ69G${String(seq++).padStart(5, '0')}`
      if (s.name === 'sleep') {
        events.push({ eventType: 'wait_created', correlationId: corr, eventData: { name: 'sleep' } })
        if (s.done) events.push({ eventType: 'wait_completed', correlationId: corr, eventData: {} })
      } else {
        events.push({ eventType: 'step_started', correlationId: corr, eventData: { stepName: s.name } })
        if (s.done) {
          events.push({
            eventType: 'step_completed',
            correlationId: corr,
            eventData: { stepName: s.name, result: s.result ?? {} },
          })
        }
      }
    }
    return { runId: id, workflowName: 'order', deploymentId: 'v1', status, events }
  }

  const history: ProtocolRun[] = []
  for (let i = 0; i < 120; i++) {
    const has = i < 68
    history.push(run(`h${i}`, [
      { name: 'validate', done: true, result: { ok: true } },
      { name: 'charge', done: true, result: has ? { amount: 10, promoCode: 'P' } : { amount: 10 } },
      { name: 'sleep', done: true },
      { name: 'notify', done: true, result: {} },
      { name: 'archive', done: true, result: {} },
    ], 'completed'))
  }

  const inFlight = [
    run('r1', [
      { name: 'validate', done: true, result: { ok: true } },
      { name: 'charge', done: false },
    ]),
    run('r2', [
      { name: 'validate', done: true, result: { ok: true } },
      { name: 'charge', done: true, result: { amount: 10, promoCode: 'X' } },
      { name: 'sleep', done: false },
    ]),
    run('r3', [
      { name: 'validate', done: true, result: { ok: true } },
      { name: 'charge', done: true, result: { amount: 10 } },
      { name: 'sleep', done: false },
    ]),
    run('r4', [
      { name: 'validate', done: true, result: { ok: true } },
      { name: 'charge', done: true, result: { amount: 10, promoCode: 'Y' } },
      { name: 'sleep', done: true },
      { name: 'notify', done: true, result: {} },
      { name: 'archive', done: true, result: {} },
    ]),
  ]

  const result = analyzeUpgradeRisk({
    g1,
    g2,
    history,
    inFlight,
    options: { exactRegime: true, tauLo: 0.1, tauHi: 0.5 },
  })
  return new Map(result.runs.map(r => [r.runId, r.verdict]))
}
