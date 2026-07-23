/**
 * Algorithm 1 — WUR: telemetry-driven upgrade risk (arXiv:2607.13617 §8).
 *
 * Consumes only the protocol surface (graphs + run/event listings).
 * Executes no workflow code and requires no sandbox.
 */
import { applyCoupling, type CouplingEdge } from './coupling.ts'
import { classifyChanges, matchGraphs } from './graph.ts'
import { partitionByVerdict } from './policy.ts'
import { fleetWur, scoreRuns } from './risk.ts'
import { collectTelemetry } from './telemetry.ts'
import type {
  AnalyzeOptions,
  ChangedSite,
  FleetRiskResult,
  ProtocolRun,
  StepGraph,
} from './types.ts'

export interface AnalyzeInput {
  /** Deployed version step graph G1. */
  g1: StepGraph
  /** Candidate version step graph G2. */
  g2: StepGraph
  /** Completed historical runs ℋ. */
  history: ProtocolRun[]
  /** In-flight runs ℛ. */
  inFlight: ProtocolRun[]
  /** Optional precomputed change set (else derived from graphs). */
  changes?: ChangedSite[]
  options?: AnalyzeOptions
}

/**
 * Run the full WUR pipeline (Algorithm 1).
 */
export function analyzeUpgradeRisk (input: AnalyzeInput): FleetRiskResult {
  const { g1, g2, history, inFlight, options = {} } = input
  const warnings: string[] = []

  // 1–2. Match and classify Δ
  const matching = matchGraphs(g1, g2)
  const changes = input.changes ?? classifyChanges(g1, g2, matching)

  if (matching.unmatchedG1.length || matching.unmatchedG2.length) {
    warnings.push(
      `protocol delta: ${matching.unmatchedG1.length} removed, ${matching.unmatchedG2.length} inserted sites`
    )
  }

  // 3–4. Telemetry from protocol surface
  const {
    historyPaths,
    historyCompleted,
    historyPayloads,
    inFlightPrefixes,
  } = collectTelemetry(history, inFlight, g1)

  if (historyPaths.length === 0 && changes.some(c => c.axis === 'interface')) {
    warnings.push('thin telemetry: no historical paths for interface estimation')
  }

  // 5–15. Per-run R_b, R_f, WUR
  const scored = scoreRuns(
    g1,
    g2,
    matching,
    changes,
    historyPaths,
    historyCompleted,
    historyPayloads,
    inFlightPrefixes,
    options
  )

  const runs = scored.map(s => s.risk)
  let wur = fleetWur(scored)
  let partition = partitionByVerdict(runs)

  // 16–17. Coupling extension when edges provided
  const rawEdges = options.couplingEdges ?? []
  if (rawEdges.length > 0) {
    const edges: CouplingEdge[] = rawEdges.map(e => ({
      from: e.from,
      to: e.to,
      transmission: e.transmission ?? 1,
      channelPenalty: e.channelPenalty ?? 0,
    }))
    // Also derive hierarchy edges from run metadata
    for (const r of inFlight) {
      for (const other of r.coupledRunIds ?? []) {
        edges.push({
          from: r.runId,
          to: other,
          transmission: 1,
          channelPenalty: Number.POSITIVE_INFINITY,
        })
      }
    }
    const coupled = applyCoupling(runs, edges, {
      pinCost: options.pinCost,
      forgoneFix: options.forgoneFix,
      useMinCut: true,
    })
    wur = coupled.fleetWur
    if (coupled.partition) {
      // Overlay min-cut: migrate/pin stable core; keep independent review
      const reviewSet = new Set(partition.review)
      const migrateSet = new Set(coupled.partition.migrate)
      const pinSet = new Set(coupled.partition.pin)
      // Hard pins from R_b stay pin
      for (const r of runs) {
        if (r.backwardRisk > 0) {
          pinSet.add(r.runId)
          migrateSet.delete(r.runId)
        }
      }
      // Review only if not forced by cut and originally review
      const finalReview: string[] = []
      for (const id of reviewSet) {
        if (!migrateSet.has(id) && !pinSet.has(id)) finalReview.push(id)
      }
      // Assign review runs that min-cut put on migrate with moderate WUR stay review
      for (const r of runs) {
        if (reviewSet.has(r.runId) && migrateSet.has(r.runId) && r.wur >= (options.tauLo ?? 0.1)) {
          migrateSet.delete(r.runId)
          finalReview.push(r.runId)
        }
        // Update verdict labels
        if (pinSet.has(r.runId)) r.verdict = 'pin'
        else if (finalReview.includes(r.runId)) r.verdict = 'review'
        else if (migrateSet.has(r.runId)) r.verdict = 'migrate'
      }
      partition = {
        migrate: [...migrateSet],
        pin: [...pinSet],
        review: finalReview,
      }
    }
  }

  // Annotations: which change affects how many runs
  const annotations = changes.map(c => {
    let affected = 0
    for (const s of scored) {
      if (s.risk.reasons.some(r => r.includes(c.siteId) || r.includes(c.reason.slice(0, 20)))) {
        affected++
      } else if (s.risk.backwardRisk > 0 && c.axis === 'protocol') {
        affected++
      } else if (s.risk.forwardRisk > 0 && c.axis === 'interface') {
        // approximate: all non-zero forward may relate
        if (s.prefix.frontier) affected++
      }
    }
    // Better count: runs whose prefix/frontier can hit this site
    if (c.axis === 'interface') {
      affected = scored.filter(s => {
        if (s.risk.verdict === 'migrate' && s.risk.wur === 0) return false
        return s.risk.forwardRisk > 0 || s.risk.backwardRisk > 0
      }).length
    }
    return {
      siteId: c.siteId,
      axis: c.axis,
      reason: c.reason,
      affectedRuns: affected,
    }
  })

  return {
    wur,
    runs,
    annotations,
    partition,
    warnings,
  }
}

/**
 * Convenience: analyze with explicit change list (skips graph diff).
 * Useful when static analysis is performed out-of-process.
 */
export function analyzeWithChanges (
  g1: StepGraph,
  g2: StepGraph,
  changes: ChangedSite[],
  history: ProtocolRun[],
  inFlight: ProtocolRun[],
  options?: AnalyzeOptions
): FleetRiskResult {
  return analyzeUpgradeRisk({ g1, g2, history, inFlight, changes, options })
}
