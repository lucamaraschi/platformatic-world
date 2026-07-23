/**
 * Bayesian estimation, severity, Monte Carlo CI (§6).
 */
import { betaMean, clamp01, sampleBeta } from './contracts.ts'
import {
  allHittingProbabilities,
  countTransitions,
  sampleTransitionMatrix,
  transitionMatrix,
} from './markov.ts'
import { topologicalOrder } from './sp.ts'
import type {
  AnalyzeOptions,
  ChangedSite,
  PathPrefix,
  ProtocolRun,
  StepGraph,
} from './types.ts'
import { combineWur } from './risk-core.ts'

export interface SeverityFactors {
  /** κ: re-execution harm probability. */
  reexec: number
  /** Blast radius ∈ [0,1]. */
  blast: number
  /** Class calibration prior mean. */
  classCal: number
  /** Combined sev ∈ [0,1]. */
  sev: number
}

/**
 * Estimate severity from retry telemetry + blast radius + class prior (§6.4).
 */
export function estimateSeverity (
  siteId: string,
  graph: StepGraph,
  retryStats: Map<string, { benign: number, incident: number }>,
  classPrior = 0.5
): SeverityFactors {
  const stats = retryStats.get(siteId) ?? { benign: 0, incident: 0 }
  const total = stats.benign + stats.incident
  const reexec = total === 0
    ? classPrior
    : betaMean(stats.incident, total, 1, 1)

  const order = topologicalOrder(graph)
  const idx = order.indexOf(siteId)
  const downstream = idx < 0 ? 0 : order.length - idx - 1
  const blast = order.length <= 1 ? 0 : downstream / (order.length - 1)

  // Pool in log-odds-ish average
  const sev = clamp01(0.5 * reexec + 0.3 * blast + 0.2 * classPrior)
  return { reexec, blast, classCal: classPrior, sev }
}

/**
 * Collect retry stats from event logs (step_retrying / repeated step_started).
 */
export function collectRetryStats (
  runs: ProtocolRun[],
  siteNameByCorr?: Map<string, string>
): Map<string, { benign: number, incident: number }> {
  const byName = new Map<string, { starts: number, retries: number, failures: number }>()
  for (const run of runs) {
    const seen = new Map<string, number>()
    for (const ev of run.events) {
      const data = (ev.eventData ?? {}) as Record<string, unknown>
      const name = String(data.stepName ?? data.name ?? siteNameByCorr?.get(ev.correlationId ?? '') ?? '')
      if (!name) continue
      if (!byName.has(name)) byName.set(name, { starts: 0, retries: 0, failures: 0 })
      const row = byName.get(name)!
      if (ev.eventType === 'step_started') {
        const c = ev.correlationId ?? name
        const n = (seen.get(c) ?? 0) + 1
        seen.set(c, n)
        row.starts++
        if (n > 1) row.retries++
      } else if (ev.eventType === 'step_retrying') {
        row.retries++
      } else if (ev.eventType === 'step_failed') {
        row.failures++
      }
    }
  }
  const out = new Map<string, { benign: number, incident: number }>()
  for (const [name, s] of byName) {
    // retries that eventually succeed count as benign re-exec experiments
    const benign = Math.max(0, s.retries - s.failures)
    const incident = s.failures
    out.set(name, { benign, incident })
  }
  return out
}

export interface McSample {
  wur: number
  rb: number
  rf: number
}

/**
 * Monte Carlo propagation of WUR posterior (§6.5).
 * Returns mean and 90% credible interval.
 */
export function monteCarloWur (
  args: {
    g1: StepGraph
    changes: ChangedSite[]
    historyPaths: string[][]
    historyCompleted: boolean[]
    prefixes: PathPrefix[]
    weights: number[]
    computeRbRf: (
      prefix: PathPrefix,
      P: Map<string, Map<string, number>>,
      sev: Map<string, number>
    ) => { rb: number, rf: number }
  },
  options: AnalyzeOptions = {}
): { mean: number, interval: [number, number], samples: number[] } {
  const draws = options.draws ?? 200
  const alpha = options.alpha ?? 1
  const dirichletAlpha = options.dirichletAlpha ?? 1
  const counts = countTransitions(args.historyPaths, args.historyCompleted)
  const samples: number[] = []

  // Point severity defaults
  const baseSev = new Map<string, number>()
  for (const c of args.changes) {
    baseSev.set(c.siteId, c.severity ?? 1)
  }

  for (let s = 0; s < draws; s++) {
    const P = sampleTransitionMatrix(counts, args.g1, dirichletAlpha)
    // Sample severities with Beta noise around base
    const sev = new Map<string, number>()
    for (const [id, v] of baseSev) {
      // weak noise: Beta(v*k, (1-v)*k) with k=8
      const k = 8
      const a = Math.max(0.1, v * k)
      const b = Math.max(0.1, (1 - v) * k)
      sev.set(id, sampleBeta(a, b))
    }
    let num = 0
    let den = 0
    for (let i = 0; i < args.prefixes.length; i++) {
      const { rb, rf } = args.computeRbRf(args.prefixes[i], P, sev)
      const w = args.weights[i] ?? 1
      num += w * combineWur(rb, rf, alpha)
      den += w
    }
    samples.push(den === 0 ? 0 : num / den)
  }

  samples.sort((a, b) => a - b)
  const mean = samples.reduce((a, b) => a + b, 0) / (samples.length || 1)
  const lo = samples[Math.floor(0.05 * (samples.length - 1))] ?? mean
  const hi = samples[Math.ceil(0.95 * (samples.length - 1))] ?? mean
  return { mean, interval: [lo, hi], samples }
}

/**
 * Build hitting map from a transition matrix for all change targets.
 */
export function hittingFromP (
  P: Map<string, Map<string, number>>,
  targets: string[],
  nodes: string[]
): Map<string, Map<string, number>> {
  return allHittingProbabilities(P, targets, nodes)
}

export function pointTransitionMatrix (
  historyPaths: string[][],
  historyCompleted: boolean[],
  g1: StepGraph,
  dirichletAlpha = 1
): Map<string, Map<string, number>> {
  const counts = countTransitions(historyPaths, historyCompleted)
  return transitionMatrix(counts, g1, dirichletAlpha)
}
