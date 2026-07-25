/**
 * Algorithm 1 — WUR: telemetry-driven upgrade risk (arXiv:2607.13617 §8).
 */
import { buildCouplingGraph } from './channels.ts'
import { applyCoupling, type CouplingEdge, minCutPartition } from './coupling.ts'
import { classifyChanges } from './demand.ts'
import { matchGraphs } from './match.ts'
import { labelInstabilityReview, partitionByVerdict } from './policy.ts'
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
  g1: StepGraph
  g2: StepGraph
  history: ProtocolRun[]
  inFlight: ProtocolRun[]
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
  if (g1.modulePath && g2.modulePath && g1.modulePath !== g2.modulePath) {
    warnings.push(`module path changed: ${g1.modulePath} → ${g2.modulePath}`)
  }

  // 3–4. Telemetry
  const {
    historyPaths,
    historyCompleted,
    historyPayloads,
    inFlightPrefixes,
  } = collectTelemetry(history, inFlight, g1)

  if (historyPaths.length === 0 && changes.some(c => c.axis === 'interface')) {
    warnings.push('thin telemetry: no historical paths for interface estimation')
  }

  // 5–15. Per-run R_b, R_f, WUR (+ optional MC)
  const scored = scoreRuns(
    g1,
    g2,
    matching,
    changes,
    historyPaths,
    historyCompleted,
    historyPayloads,
    inFlightPrefixes,
    options,
    [...history, ...inFlight]
  )

  const runs = scored.map(s => s.risk)
  let wur = fleetWur(scored)
  let partition = partitionByVerdict(runs)

  // Fleet CI from first run if present
  const wurInterval = runs[0]?.wurInterval

  // 16–17. Coupling
  let edges: CouplingEdge[] = (options.couplingEdges ?? []).map(e => ({
    from: e.from,
    to: e.to,
    transmission: e.transmission ?? 1,
    channelPenalty: e.channelPenalty ?? 0,
  }))

  if (options.autoCouple || options.buildCouplingFromTelemetry) {
    edges = [...edges, ...buildCouplingGraph(inFlight)]
  }

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

  if (edges.length > 0) {
    const coupled = applyCoupling(runs, edges, {
      pinCost: options.pinCost,
      forgoneFix: options.forgoneFix,
      useMinCut: true,
    })
    wur = coupled.fleetWur

    // Label-instability review under multiple min-cut draws with noise
    const drawParts: Array<{ migrate: string[], pin: string[] }> = []
    for (let d = 0; d < Math.min(options.draws ?? 0, 20); d++) {
      const noisy = runs.map(r => ({
        ...r,
        wur: clampNoise(r.wur, 0.05),
      }))
      const p = minCutPartition(noisy, edges, {
        pinCost: options.pinCost,
        forgoneFix: options.forgoneFix,
      })
      drawParts.push({ migrate: p.migrate, pin: p.pin })
    }
    const unstable = labelInstabilityReview(drawParts, runs.map(r => r.runId))

    if (coupled.partition) {
      const reviewSet = new Set([...partition.review, ...unstable])
      const migrateSet = new Set(coupled.partition.migrate)
      const pinSet = new Set(coupled.partition.pin)
      for (const r of runs) {
        if (r.backwardRisk > 0) {
          pinSet.add(r.runId)
          migrateSet.delete(r.runId)
        }
        if (unstable.includes(r.runId)) {
          migrateSet.delete(r.runId)
          pinSet.delete(r.runId)
          reviewSet.add(r.runId)
          r.verdict = 'review'
          r.diagnosis = r.diagnosis ?? 'label-instability'
        }
      }
      for (const r of runs) {
        if (pinSet.has(r.runId)) r.verdict = 'pin'
        else if (reviewSet.has(r.runId)) r.verdict = 'review'
        else if (migrateSet.has(r.runId)) r.verdict = 'migrate'
      }
      partition = {
        migrate: [...migrateSet],
        pin: [...pinSet],
        review: [...reviewSet],
      }
    }
  }

  // Annotations
  const annotations = changes.map(c => {
    let affected = 0
    for (const s of scored) {
      if (s.risk.backwardRisk > 0 && c.axis === 'protocol') affected++
      else if (s.risk.forwardRisk > 0 && (c.axis === 'interface' || c.axis === 'protocol')) {
        if (s.prefix.frontier) affected++
      } else if (s.risk.reasons.some(r => r.includes(c.siteId))) {
        affected++
      }
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
    wurInterval,
    runs,
    annotations,
    partition,
    warnings,
  }
}

function clampNoise (x: number, eps: number): number {
  const n = x + (Math.random() * 2 - 1) * eps
  return Math.max(0, Math.min(1, n))
}

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
