/**
 * Backward risk R_b, forward risk R_f, and WUR (Defs 5.1–5.5).
 */
import {
  betaMean,
  clamp01,
  distributionalInterfaceRisk,
  poolLogOdds,
} from './contracts.ts'
import {
  estimateSeverity,
  collectRetryStats,
  monteCarloWur,
  pointTransitionMatrix,
  hittingFromP,
} from './estimate.ts'
import { isPrefixValid } from './prefix.ts'
import { combineWur } from './risk-core.ts'
import { topologicalOrder } from './sp.ts'
import { prefixHash } from './trace.ts'
import { recordHasFields } from './telemetry.ts'
import { classifyVerdict } from './policy.ts'
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

export { combineWur } from './risk-core.ts'

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
  insertAfter?: string | null
  unsatisfiable?: boolean
}

export function siteIncompatibilities (
  changes: ChangedSite[],
  historyPayloads: Map<string, unknown[]>,
  betaPrior: [number, number] = [1, 1],
  severityBySite: Map<string, number> = new Map()
): SiteIncompatibility[] {
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
    let severity = severityBySite.get(siteId) ?? 0
    let demandFields: string[] | undefined
    let producerSiteId: string | undefined
    let insertAfter: string | null | undefined
    let unsatisfiable = false
    let primaryAxis: ChangedSite['axis'] = list[0]?.axis ?? 'protocol'
    const reason = list.map(c => c.reason).join('; ')

    for (const c of list) {
      severity = Math.max(severity, c.severity ?? 1)
      if (c.insertAfter !== undefined) insertAfter = c.insertAfter
      if (c.unsatisfiable) unsatisfiable = true
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
          const [a, b] = betaPrior
          if (payloads.length === 0) {
            rhoI = betaMean(0, 0, a, b)
            weightI = a + b
          } else {
            const dist = distributionalInterfaceRisk(payloads, demandFields)
            const n = payloads.length
            rhoI = Math.max(rhoI, betaMean(dist * n, n, a, b))
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
      insertAfter,
      unsatisfiable,
    })
  }
  return out
}

/**
 * Backward risk R_b (Eq 4) with invocation-time store and k+1 interface product.
 */
export function backwardRisk (
  prefix: PathPrefix,
  g1: StepGraph,
  g2: StepGraph,
  matching: Matching,
  siteRho: SiteIncompatibility[],
  options: { exactRegime?: boolean, unkMode?: 'uninformative' | 'pessimistic' } = {}
): { rb: number, prefixValid: boolean, reasons: string[] } {
  const exact = options.exactRegime !== false
  const unkMode = options.unkMode ?? 'uninformative'
  const reasons: string[] = []
  const validity = isPrefixValid(
    prefix.siteIds,
    g1,
    g2,
    matching,
    prefix.correlationIds
  )
  if (!validity.valid) {
    reasons.push(validity.reason ?? 'prefix invalid under μ')
    return { rb: 1, prefixValid: false, reasons }
  }

  let survI = 1
  let survM = 1

  const ifaceChanges = siteRho.filter(s => s.axis === 'interface' && s.demandFields?.length)
  for (const s of ifaceChanges) {
    if (s.unsatisfiable) {
      // Gate: only if consumer is invoked during rehydration
      const consumer = s.siteId
      const inPrefix = prefix.siteIds.includes(consumer)
      const isFrontier = prefix.frontier === consumer
      if (inPrefix || isFrontier) {
        survI = 0
        reasons.push(`unsatisfiable demand at ${consumer}`)
      }
      continue
    }

    const consumer = s.siteId
    const inPrefix = prefix.siteIds.includes(consumer)
    const isFrontier = prefix.frontier === consumer
    if (!inPrefix && !isFrontier) continue

    let rhoI = s.rhoI
    if (exact) {
      const prodId = s.producerSiteId ?? consumer
      // Invocation-time store for this consumer
      const store = prefix.invocationStore.get(consumer) ?? prefix.payloads
      const payload = store.get(prodId) ?? prefix.payloads.get(prodId)
      if (payload === undefined) {
        rhoI = 0
      } else {
        const check = recordHasFields(payload, s.demandFields!)
        if (check.unk) {
          rhoI = unkMode === 'pessimistic' ? 1 : 0.5
          reasons.push(`uninspectable payload at ${prodId}`)
        } else if (!check.ok) {
          rhoI = 1
          reasons.push(`payload at ${prodId} missing: ${check.missing.join(', ')}`)
        } else {
          rhoI = 0
        }
      }
    }
    survI *= (1 - clamp01(rhoI))
  }

  for (const s of siteRho) {
    if (s.axis !== 'migration') continue
    if (prefix.siteIds.includes(s.siteId)) {
      survM *= (1 - clamp01(s.rhoM))
      if (s.rhoM > 0) reasons.push(`migration risk at ${s.siteId}`)
    }
  }

  const rb = clamp01(1 - survI * survM)
  return { rb, prefixValid: true, reasons }
}

/**
 * Forward risk R_f (Eq 6) including G2-insert hazards via insertAfter anchors.
 */
export function forwardRisk (
  frontier: string | null,
  siteRho: SiteIncompatibility[],
  hitting: Map<string, Map<string, number>>,
  prefix: PathPrefix,
  options: { exactRegime?: boolean, unkMode?: 'uninformative' | 'pessimistic' } = {}
): { rf: number, reasons: string[] } {
  const exact = options.exactRegime !== false
  const unkMode = options.unkMode ?? 'uninformative'
  const reasons: string[] = []
  if (!frontier) return { rf: 0, reasons }

  let survival = 1
  for (const s of siteRho) {
    let sev = s.severity
    let h = hitting.get(s.siteId)?.get(frontier) ?? 0

    // G2-only inserts: hazard if we pass the insert anchor
    if (s.axis === 'protocol' && s.insertAfter !== undefined) {
      const anchor = s.insertAfter
      if (anchor === null) {
        // insert at head — if we already have any prefix, R_b handled; else h=1
        h = prefix.siteIds.length === 0 ? 1 : 0
      } else if (prefix.siteIds.includes(anchor) || frontier === anchor) {
        // past or at anchor → will hit insertion on remaining path
        h = 1
      } else {
        h = hitting.get(anchor)?.get(frontier) ?? 0
      }
      sev = s.severity
    }

    if (s.axis === 'interface' && s.demandFields?.length) {
      const prodId = s.producerSiteId ?? s.siteId
      const payload = prefix.payloads.get(prodId)
      if (exact && payload !== undefined) {
        const check = recordHasFields(payload, s.demandFields)
        if (!check.ok && !check.unk) {
          sev = 1
          h = hitting.get(s.siteId)?.get(frontier) ?? 0
          if (s.siteId === frontier) h = 1
          if (h > 0) {
            reasons.push(
              `exact interface violation on recorded ${prodId}: missing ${check.missing.join(', ')}`
            )
          }
        } else if (check.ok) {
          sev = 0
          h = 0
        } else if (check.unk) {
          sev = unkMode === 'pessimistic' ? 1 : Math.max(sev * 0.5, s.rhoI)
          reasons.push(`uninspectable payload at ${prodId}`)
        }
      } else if (exact && payload === undefined) {
        sev = s.rhoI > 0 ? s.rhoI : s.severity
        h = hitting.get(s.siteId)?.get(frontier) ?? 0
      }
    }

    if (s.axis === 'protocol' && s.insertAfter === undefined) {
      h = hitting.get(s.siteId)?.get(frontier) ?? 0
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

export interface ScoredRun {
  run: ProtocolRun
  prefix: PathPrefix
  risk: RunRisk
}

export function scoreRuns (
  g1: StepGraph,
  g2: StepGraph,
  matching: Matching,
  changes: ChangedSite[],
  historyPaths: string[][],
  historyCompleted: boolean[],
  historyPayloads: Map<string, unknown[]>,
  inFlight: Array<{ run: ProtocolRun, prefix: PathPrefix }>,
  options: AnalyzeOptions = {},
  allRunsForRetry: ProtocolRun[] = []
): ScoredRun[] {
  const alpha = options.alpha ?? 1
  const tauLo = options.tauLo ?? 0.1
  const tauHi = options.tauHi ?? 0.5
  const betaPrior = options.betaPrior ?? [1, 1]
  const exact = options.exactRegime !== false
  const dirichletAlpha = options.dirichletAlpha ?? 1
  const unkMode = options.unkMode ?? 'uninformative'
  const classPrior = options.classSeverityPrior ?? 0.5

  // Severity from retry telemetry
  const retryStats = collectRetryStats([...allRunsForRetry, ...inFlight.map(x => x.run)])
  const severityBySite = new Map<string, number>()
  for (const c of changes) {
    const site = g1.sites.find(s => s.id === c.siteId)
    const name = site?.label.name ?? c.siteId
    const named = retryStats.get(name) ?? retryStats.get(c.siteId)
    const mapped = new Map<string, { benign: number, incident: number }>()
    if (named) mapped.set(c.siteId, named)
    const factors = estimateSeverity(c.siteId, g1, mapped, classPrior)
    severityBySite.set(c.siteId, Math.max(c.severity ?? 0, factors.sev))
    // Prefer explicit severity 1 for protocol
    if (c.axis === 'protocol') severityBySite.set(c.siteId, c.severity ?? 1)
  }

  const siteRho = siteIncompatibilities(changes, historyPayloads, betaPrior, severityBySite)
  // Apply estimated severity onto siteRho
  for (const s of siteRho) {
    if (severityBySite.has(s.siteId) && s.axis !== 'protocol') {
      s.severity = severityBySite.get(s.siteId)!
    }
  }

  const P = pointTransitionMatrix(historyPaths, historyCompleted, g1, dirichletAlpha)
  const nodes = topologicalOrder(g1)
  const targets = [...new Set([
    ...siteRho.map(s => s.siteId).filter(id => nodes.includes(id)),
    ...siteRho.map(s => s.insertAfter).filter((x): x is string => !!x && nodes.includes(x)),
  ])]
  const hitting = hittingFromP(P, targets, nodes)

  // Prefix bucketing for shared R_b
  const rbCache = new Map<string, { rb: number, prefixValid: boolean, reasons: string[] }>()

  const results: ScoredRun[] = []
  for (const { run, prefix } of inFlight) {
    const ph = prefixHash(prefix.siteIds, g1, prefix.frontier, prefix.correlationIds)
    let bw = rbCache.get(ph)
    if (!bw) {
      bw = backwardRisk(prefix, g1, g2, matching, siteRho, { exactRegime: exact, unkMode })
      rbCache.set(ph, bw)
    }
    // Recompute interface exact per-run even when structure shared
    const bwExact = backwardRisk(prefix, g1, g2, matching, siteRho, { exactRegime: exact, unkMode })
    const fw = forwardRisk(prefix.frontier, siteRho, hitting, prefix, { exactRegime: exact, unkMode })
    const wur = combineWur(bwExact.rb, fw.rf, alpha)
    const verdict: VerdictClass = classifyVerdict(bwExact.rb, fw.rf, alpha, tauLo, tauHi)

    let expectedLoss = 0
    if (prefix.frontier) {
      for (const s of siteRho) {
        const h = hitting.get(s.siteId)?.get(prefix.frontier) ?? 0
        expectedLoss += s.severity * h
      }
    }

    results.push({
      run,
      prefix,
      risk: {
        runId: run.runId,
        backwardRisk: bwExact.rb,
        forwardRisk: fw.rf,
        wur,
        verdict,
        prefixValid: bwExact.prefixValid,
        frontier: prefix.frontier,
        reasons: [...bwExact.reasons, ...fw.reasons],
        expectedLoss,
      },
    })
  }

  // Optional MC intervals on fleet and per-run (using draws)
  if ((options.draws ?? 0) > 0 && results.length > 0) {
    const mc = monteCarloWur({
      g1,
      changes,
      historyPaths,
      historyCompleted,
      prefixes: results.map(r => r.prefix),
      weights: results.map(r => r.run.weight ?? 1),
      computeRbRf: (prefix, Pdraw, sev) => {
        const hmap = hittingFromP(
          Pdraw,
          targets,
          nodes
        )
        // Apply sampled severity
        const rhoAdj = siteRho.map(s => ({
          ...s,
          severity: sev.get(s.siteId) ?? s.severity,
        }))
        const bw = backwardRisk(prefix, g1, g2, matching, rhoAdj, { exactRegime: exact, unkMode })
        const fw = forwardRisk(prefix.frontier, rhoAdj, hmap, prefix, { exactRegime: exact, unkMode })
        return { rb: bw.rb, rf: fw.rf }
      },
    }, options)

    // Attach fleet interval via first run marker — analyze will lift
    for (const r of results) {
      r.risk.wurInterval = mc.interval
      // Reclassify by upper bound when interval straddles
      r.risk.verdict = classifyVerdict(
        r.risk.backwardRisk,
        r.risk.forwardRisk,
        alpha,
        tauLo,
        tauHi,
        mc.interval[1]
      )
      if (mc.interval[1] - mc.interval[0] > 0.4) {
        r.risk.diagnosis = 'low-telemetry'
      }
    }
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
