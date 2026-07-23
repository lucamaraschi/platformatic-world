/**
 * Backward risk R_b, forward risk R_f, and WUR (Defs 5.1–5.5).
 */
import {
  betaMean,
  clamp01,
  distributionalInterfaceRisk,
  poolLogOdds,
  validatePayload,
} from './contracts.ts'
import { isPrefixValid, topologicalOrder } from './graph.ts'
import {
  allHittingProbabilities,
  countTransitions,
  transitionMatrix,
  type TransitionCounts,
} from './markov.ts'
import type {
  AnalyzeOptions,
  ChangedSite,
  Matching,
  PathPrefix,
  ProtocolRun,
  RunRisk,
  StepGraph,
  VerdictClass,
} from './types.ts'
import { classifyVerdict } from './policy.ts'

export interface SiteIncompatibility {
  siteId: string
  rhoP: number
  rhoI: number
  rhoM: number
  rho: number
  weightP: number
  weightI: number
  weightM: number
  severity: number
  demandFields?: string[]
  producerSiteId?: string
  axis: ChangedSite['axis']
  reason: string
}

/**
 * Compute per-site incompatibility ρ from change set + telemetry (Eqs 1–3, 8).
 */
export function siteIncompatibilities (
  changes: ChangedSite[],
  historyPayloads: Map<string, unknown[]>,
  betaPrior: [number, number] = [1, 1]
): SiteIncompatibility[] {
  // Group by siteId
  const bySite = new Map<string, ChangedSite[]>()
  for (const c of changes) {
    if (!bySite.has(c.siteId)) bySite.set(c.siteId, [])
    bySite.get(c.siteId)!.push(c)
  }

  const out: SiteIncompatibility[] = []
  for (const [siteId, list] of bySite) {
    let rhoP = 0
    let rhoI = 0
    let rhoM = 0
    let weightP = 0
    let weightI = 1
    let weightM = 0
    let severity = 0
    let demandFields: string[] | undefined
    let producerSiteId: string | undefined
    // Protocol dominates; otherwise prefer interface over migration for labeling
    let primaryAxis: ChangedSite['axis'] = list[0]?.axis ?? 'protocol'
    const reason = list.map(c => c.reason).join('; ')

    for (const c of list) {
      severity = Math.max(severity, c.severity ?? 1)
      if (c.axis === 'protocol') {
        rhoP = 1
        weightP = Infinity
        primaryAxis = 'protocol'
      } else if (c.axis === 'migration') {
        rhoM = 1
        weightM = Infinity
        if (primaryAxis !== 'protocol') primaryAxis = 'migration'
      } else if (c.axis === 'interface') {
        demandFields = c.demandFields
        producerSiteId = c.producerSiteId ?? siteId
        const payloads = historyPayloads.get(producerSiteId) ?? []
        if (demandFields?.length) {
          // Distributional estimate; exact regime overrides per-run later
          const [a, b] = betaPrior
          if (payloads.length === 0) {
            rhoI = betaMean(0, 0, a, b) // prior mean 0.5 with weak weight
            weightI = a + b
          } else {
            const dist = distributionalInterfaceRisk(payloads, demandFields)
            // interpret as m = dist * n violations
            const n = payloads.length
            const m = dist * n
            rhoI = Math.max(rhoI, betaMean(m, n, a, b))
            weightI = n + a + b
          }
        }
        if (primaryAxis !== 'protocol') primaryAxis = 'interface'
      }
    }

    const rho = poolLogOdds([
      { rho: rhoP, weight: weightP },
      { rho: rhoI, weight: weightI },
      { rho: rhoM, weight: weightM || (rhoM > 0 ? Infinity : 0) },
    ])

    out.push({
      siteId,
      rhoP,
      rhoI,
      rhoM,
      rho,
      weightP,
      weightI,
      weightM,
      severity: severity || 1,
      demandFields,
      producerSiteId,
      axis: primaryAxis,
      reason,
    })
  }
  return out
}

/**
 * Backward risk R_b(r) (Definition 5.1 / Eq 4).
 *
 * In exact regime, ρ_I collapses to indicators over the run's recorded payloads.
 * Protocol membership (prefix validity) is a hard gate.
 */
export function backwardRisk (
  prefix: PathPrefix,
  g1: StepGraph,
  g2: StepGraph,
  matching: Matching,
  siteRho: SiteIncompatibility[],
  options: { exactRegime?: boolean } = {}
): { rb: number, prefixValid: boolean, reasons: string[] } {
  const exact = options.exactRegime !== false
  const reasons: string[] = []
  const validity = isPrefixValid(prefix.siteIds, g1, g2, matching)
  if (!validity.valid) {
    reasons.push(validity.reason ?? 'prefix invalid under μ')
    return { rb: 1, prefixValid: false, reasons }
  }

  // Sites in product: prefix sites + frontier (k+1 for interface)
  const sitesForI = [...prefix.siteIds]
  if (prefix.frontier) sitesForI.push(prefix.frontier)
  const sitesForM = [...prefix.siteIds]

  const rhoBySite = new Map(siteRho.map(s => [s.siteId, s]))

  let survI = 1
  let survM = 1

  // Interface product over prefix sites + frontier consumer (Eq 4: i=1..k+1).
  // A demand on consumer c is a backward fault only when c is already in the
  // prefix or is the frontier *and* the producer payload is recorded and bad.
  const ifaceChanges = siteRho.filter(s => s.axis === 'interface' && s.demandFields?.length)
  for (const s of ifaceChanges) {
    const consumer = s.siteId
    const inPrefix = prefix.siteIds.includes(consumer)
    const isFrontier = prefix.frontier === consumer
    if (!inPrefix && !isFrontier) continue // purely forward

    let rhoI = s.rhoI
    if (exact) {
      const prodId = s.producerSiteId ?? consumer
      const payload = prefix.payloads.get(prodId)
      if (payload === undefined) {
        // Producer not in prefix — not a rehydration fault yet
        rhoI = 0
      } else {
        const v = validatePayload(payload, s.demandFields!)
        if (v.verdict === 'vio') {
          rhoI = 1
          reasons.push(`payload at ${prodId} missing: ${v.missing.join(', ')}`)
        } else if (v.verdict === 'unk') {
          rhoI = Math.max(rhoI, 0.5)
          reasons.push(`uninspectable payload at ${prodId}`)
        } else {
          rhoI = 0
        }
      }
    }
    survI *= (1 - clamp01(rhoI))
  }

  // Residual non-interface site rho for sites in prefix (migration-dominated path)
  for (const sid of sitesForI) {
    const info = rhoBySite.get(sid)
    if (!info || info.axis === 'interface') continue
    if (info.rhoI > 0) survI *= (1 - clamp01(info.rhoI))
  }

  for (const sid of sitesForM) {
    const s = rhoBySite.get(sid)
    if (!s) continue
    survM *= (1 - clamp01(s.rhoM))
    if (s.rhoM > 0) reasons.push(`migration risk at ${sid}`)
  }

  // Protocol axis already gated by prefix validity; ρ_P on matched prefix sites
  // that are themselves in Δ_P would have failed validity. Residual ρ_P = 0 here.

  const rb = clamp01(1 - survI * survM)
  return { rb, prefixValid: true, reasons }
}

/**
 * Forward risk R_f(r) (Definition 5.4 / Eq 6).
 * R_f = 1 − ∏_{v ∈ Δ} (1 − sev(v) · h_v(φ_r))
 *
 * Exact interface regime: when the producer payload is already recorded, the
 * incompatibility factor collapses to an indicator and multiplies the hitting
 * probability of the *consumer* (worked example §9.1: r2 vs r3).
 */
export function forwardRisk (
  frontier: string | null,
  siteRho: SiteIncompatibility[],
  hitting: Map<string, Map<string, number>>,
  prefix: PathPrefix,
  options: { exactRegime?: boolean } = {}
): { rf: number, reasons: string[] } {
  const exact = options.exactRegime !== false
  const reasons: string[] = []
  if (!frontier) {
    // Completed / no pending work: no remaining path under V2 for forward exposure
    // (backward product already covered full prefix including final consumer).
    return { rf: 0, reasons }
  }

  let survival = 1
  for (const s of siteRho) {
    let sev = s.severity
    let h = hitting.get(s.siteId)?.get(frontier) ?? 0

    if (s.axis === 'interface' && s.demandFields?.length) {
      const prodId = s.producerSiteId ?? s.siteId
      const payload = prefix.payloads.get(prodId)

      if (exact && payload !== undefined) {
        const v = validatePayload(payload, s.demandFields)
        if (v.verdict === 'vio') {
          // Exact future fault if consumer is reachable from frontier
          sev = 1
          h = hitting.get(s.siteId)?.get(frontier) ?? 0
          // If consumer is the frontier itself, hit probability is 1
          if (s.siteId === frontier) h = 1
          if (h > 0) {
            reasons.push(
              `exact interface violation on recorded ${prodId}: missing ${v.missing.join(', ')}`
            )
          }
        } else if (v.verdict === 'sat') {
          // This run's recorded producer satisfies the new demand
          sev = 0
          h = 0
        } else {
          // unk — keep distributional sev/h
          reasons.push(`uninspectable payload at ${prodId}`)
        }
      } else if (exact && payload === undefined) {
        // Producer not yet executed: use distributional ρ as severity factor
        sev = s.rhoI > 0 ? s.rhoI : s.severity
        h = hitting.get(s.siteId)?.get(frontier) ?? 0
      }
    }

    if (s.axis === 'protocol') {
      h = hitting.get(s.siteId)?.get(frontier) ?? 0
      // Deleted sites: h from frontier if still on remaining path.
      // Inserted sites live only in G2 — not in G1 hitting map (h=0 here);
      // prefix validity already gates ordinal shifts.
    }

    const hazard = clamp01(sev * h)
    if (hazard > 0) {
      survival *= (1 - hazard)
      if (hazard > 0.01) {
        reasons.push(`forward hazard ${hazard.toFixed(3)} at ${s.siteId} (${s.axis})`)
      }
    }
  }

  return { rf: clamp01(1 - survival), reasons }
}

/**
 * WUR(r) = 1 − (1 − R_b)(1 − α R_f) (Definition 5.5).
 */
export function combineWur (rb: number, rf: number, alpha = 1): number {
  return clamp01(1 - (1 - rb) * (1 - alpha * rf))
}

export interface ScoredRun {
  run: ProtocolRun
  prefix: PathPrefix
  risk: RunRisk
}

/**
 * Score all in-flight runs given graphs, matching, and history paths.
 */
export function scoreRuns (
  g1: StepGraph,
  g2: StepGraph,
  matching: Matching,
  changes: ChangedSite[],
  historyPaths: string[][],
  historyCompleted: boolean[],
  historyPayloads: Map<string, unknown[]>,
  inFlight: Array<{ run: ProtocolRun, prefix: PathPrefix }>,
  options: AnalyzeOptions = {}
): ScoredRun[] {
  const alpha = options.alpha ?? 1
  const tauLo = options.tauLo ?? 0.1
  const tauHi = options.tauHi ?? 0.5
  const betaPrior = options.betaPrior ?? [1, 1]
  const exact = options.exactRegime !== false
  const dirichletAlpha = options.dirichletAlpha ?? 1

  const siteRho = siteIncompatibilities(changes, historyPayloads, betaPrior)
  const counts = countTransitions(historyPaths, historyCompleted)
  const P = transitionMatrix(counts, g1, dirichletAlpha)
  const nodes = topologicalOrder(g1)
  const targets = [...new Set(siteRho.map(s => s.siteId).filter(id => nodes.includes(id)))]
  // Also include G1 sites that appear in changes even if only as protocol deleted — already in siteRho
  const hitting = allHittingProbabilities(P, targets, nodes)

  const results: ScoredRun[] = []
  for (const { run, prefix } of inFlight) {
    // Per-run exact interface: rebuild siteRho with this run's payloads for exact regime
    const bw = backwardRisk(prefix, g1, g2, matching, siteRho, { exactRegime: exact })
    const fw = forwardRisk(prefix.frontier, siteRho, hitting, prefix, { exactRegime: exact })
    const wur = combineWur(bw.rb, fw.rf, alpha)
    const verdict: VerdictClass = classifyVerdict(bw.rb, fw.rf, alpha, tauLo, tauHi)

    // Expected loss for review ranking: Σ sev(v) h_v(φ)
    let expectedLoss = 0
    if (prefix.frontier) {
      for (const s of siteRho) {
        const h = hitting.get(s.siteId)?.get(prefix.frontier) ?? 0
        expectedLoss += s.severity * h
      }
    }

    const reasons = [...bw.reasons, ...fw.reasons]
    results.push({
      run,
      prefix,
      risk: {
        runId: run.runId,
        backwardRisk: bw.rb,
        forwardRisk: fw.rf,
        wur,
        verdict,
        prefixValid: bw.prefixValid,
        frontier: prefix.frontier,
        reasons,
        expectedLoss,
      },
    })
  }
  return results
}

export function fleetWur (scored: ScoredRun[]): number {
  if (scored.length === 0) return 0
  let num = 0
  let den = 0
  for (const s of scored) {
    const w = s.run.weight ?? 1
    num += w * s.risk.wur
    den += w
  }
  return den === 0 ? 0 : num / den
}

export type { TransitionCounts }
