/**
 * WUR model tests — arXiv:2607.13617 scenarios and worked example.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeUpgradeRisk,
  analyzeWithChanges,
  classifyChanges,
  classifyVerdict,
  combineWur,
  contagionFixpoint,
  countTransitions,
  hittingProbabilities,
  isPrefixValid,
  linearGraph,
  matchGraphs,
  minCutPartition,
  transitionMatrix,
  topologicalOrder,
  validatePayload,
  type ChangedSite,
  type ProtocolRun,
  type RunRisk,
  type StepGraph,
} from '../lib/index.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function linearSites (
  names: string[],
  extra: Record<string, Partial<{
    kind: 'step' | 'timer' | 'hook'
    outputFields: string[]
    demandFields: string[]
    consumesFrom: string[]
  }>> = {}
): StepGraph {
  return linearGraph(names.map(name => ({
    id: name,
    name,
    kind: extra[name]?.kind ?? (name === 'sleep' ? 'timer' : 'step'),
    outputFields: extra[name]?.outputFields,
    demandFields: extra[name]?.demandFields,
    consumesFrom: extra[name]?.consumesFrom,
  })))
}

function ulidAt (seq: number): string {
  // Monotonic-ish ULID-shaped ids for correlation ordering
  return `01ARZ3NDEKTSV4RRFFQ69G${String(seq).padStart(5, '0')}`
}

function runWithSteps (
  runId: string,
  steps: Array<{ name: string, completed: boolean, result?: unknown, kind?: string }>,
  status = 'running'
): ProtocolRun {
  const events: ProtocolRun['events'] = []
  let seq = 1
  for (const s of steps) {
    const corr = ulidAt(seq++)
    const kind = s.kind ?? (s.name === 'sleep' ? 'timer' : 'step')
    if (kind === 'timer') {
      events.push({ eventType: 'wait_created', correlationId: corr, eventData: { name: s.name } })
      if (s.completed) {
        events.push({ eventType: 'wait_completed', correlationId: corr, eventData: {} })
      }
    } else {
      events.push({
        eventType: 'step_started',
        correlationId: corr,
        eventData: { stepName: s.name },
      })
      if (s.completed) {
        events.push({
          eventType: 'step_completed',
          correlationId: corr,
          eventData: { stepName: s.name, result: s.result ?? {} },
        })
      }
    }
  }
  return {
    runId,
    workflowName: 'orderFlow',
    deploymentId: 'v1',
    status,
    events,
  }
}

// ---------------------------------------------------------------------------
// Unit: contracts, matching, prefix validity
// ---------------------------------------------------------------------------

describe('WUR contracts', () => {
  it('validates payload field presence', () => {
    assert.equal(validatePayload({ promoCode: 'X' }, ['promoCode']).verdict, 'sat')
    assert.equal(validatePayload({ }, ['promoCode']).verdict, 'vio')
    assert.equal(validatePayload(null, ['promoCode']).verdict, 'vio')
    assert.equal(validatePayload([1, 2, 3], ['promoCode']).verdict, 'unk')
  })

  it('combines WUR with noisy-or', () => {
    assert.equal(combineWur(0, 0), 0)
    assert.equal(combineWur(1, 0), 1)
    assert.equal(combineWur(0, 1), 1)
    assert.ok(Math.abs(combineWur(0, 0.43) - 0.43) < 1e-9)
  })

  it('classifies migrate/review/pin thresholds', () => {
    assert.equal(classifyVerdict(0, 0.05, 1, 0.1, 0.5), 'migrate')
    assert.equal(classifyVerdict(0, 0.43, 1, 0.1, 0.5), 'review')
    assert.equal(classifyVerdict(0, 0.9, 1, 0.1, 0.5), 'pin')
    assert.equal(classifyVerdict(1, 0, 1, 0.1, 0.5), 'pin')
  })
})

describe('WUR matching and prefix validity', () => {
  it('matches identical linear graphs fully', () => {
    const g = linearSites(['validate', 'charge', 'notify'])
    const m = matchGraphs(g, g)
    assert.equal(m.map.size, 3)
    assert.equal(m.unmatchedG1.length, 0)
    assert.equal(m.unmatchedG2.length, 0)
  })

  it('S5: insert step at tail — prefix remains valid', () => {
    const g1 = linearSites(['validate', 'charge', 'notify'])
    const g2 = linearSites(['validate', 'charge', 'notify', 'audit'])
    const m = matchGraphs(g1, g2)
    assert.deepEqual(m.unmatchedG2, ['audit'])
    const v = isPrefixValid(['validate', 'charge'], g1, g2, m)
    assert.equal(v.valid, true)
  })

  it('S4: insert step at head — prefix invalid', () => {
    const g1 = linearSites(['validate', 'charge', 'notify'])
    const g2 = linearSites(['audit', 'validate', 'charge', 'notify'])
    const m = matchGraphs(g1, g2)
    const v = isPrefixValid(['validate', 'charge'], g1, g2, m)
    assert.equal(v.valid, false)
  })

  it('S6: delete tail step — completed tail prefix invalid for deleted site', () => {
    const g1 = linearSites(['validate', 'charge', 'notify'])
    const g2 = linearSites(['validate', 'charge'])
    const m = matchGraphs(g1, g2)
    // Prefix that only has validate+charge still valid
    assert.equal(isPrefixValid(['validate', 'charge'], g1, g2, m).valid, true)
    // Prefix that includes deleted notify is invalid
    assert.equal(isPrefixValid(['validate', 'charge', 'notify'], g1, g2, m).valid, false)
  })

  it('S7: swap adjacent steps — order violation', () => {
    const g1 = linearSites(['validate', 'charge', 'notify'])
    const g2 = linearSites(['charge', 'validate', 'notify'])
    const m = matchGraphs(g1, g2)
    // LCS may match charge+notify or validate+notify; either way full prefix of g1 order fails
    const v = isPrefixValid(['validate', 'charge'], g1, g2, m)
    // If validate unmatched, invalid; if both matched but order wrong in g2, invalid
    assert.equal(v.valid, false)
  })

  it('classifies protocol changes for insert/delete', () => {
    const g1 = linearSites(['a', 'b'])
    const g2 = linearSites(['a', 'b', 'c'])
    const m = matchGraphs(g1, g2)
    const delta = classifyChanges(g1, g2, m)
    assert.ok(delta.some(c => c.axis === 'protocol' && c.siteId === 'c'))
  })
})

describe('WUR Markov hitting probabilities', () => {
  it('linear chain: hitting from head to tail is 1', () => {
    const g = linearSites(['a', 'b', 'c'])
    const paths = [['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'b', 'c']]
    const counts = countTransitions(paths, [true, true, true])
    const P = transitionMatrix(counts, g)
    const h = hittingProbabilities(P, 'c', topologicalOrder(g))
    assert.ok((h.get('a') ?? 0) > 0.9)
    assert.ok((h.get('b') ?? 0) > 0.9)
    assert.equal(h.get('c'), 1)
  })
})

// ---------------------------------------------------------------------------
// Worked example §9.1
// ---------------------------------------------------------------------------

describe('WUR worked example (§9.1)', () => {
  const g1 = linearSites(['validate', 'charge', 'sleep', 'notify', 'archive'], {
    charge: { outputFields: ['amount'] },
    archive: { demandFields: [], consumesFrom: ['charge'] },
  })
  const g2 = linearSites(['validate', 'charge', 'sleep', 'notify', 'archive'], {
    charge: { outputFields: ['amount', 'promoCode'] },
    archive: { demandFields: ['promoCode'], consumesFrom: ['charge'] },
  })

  // 120 historical runs, 56.7% with promoCode
  const history: ProtocolRun[] = []
  for (let i = 0; i < 120; i++) {
    const hasPromo = i < 68 // 68/120 = 0.5667
    history.push(runWithSteps(`h${i}`, [
      { name: 'validate', completed: true, result: { ok: true } },
      { name: 'charge', completed: true, result: hasPromo ? { amount: 10, promoCode: 'P' } : { amount: 10 } },
      { name: 'sleep', completed: true },
      { name: 'notify', completed: true, result: {} },
      { name: 'archive', completed: true, result: {} },
    ], 'completed'))
  }

  it('partitions four in-flight runs into migrate/review/pin', () => {
    const r1 = runWithSteps('r1', [
      { name: 'validate', completed: true, result: { ok: true } },
      { name: 'charge', completed: false },
    ])
    const r2 = runWithSteps('r2', [
      { name: 'validate', completed: true, result: { ok: true } },
      { name: 'charge', completed: true, result: { amount: 10, promoCode: 'X' } },
      { name: 'sleep', completed: false },
    ])
    const r3 = runWithSteps('r3', [
      { name: 'validate', completed: true, result: { ok: true } },
      { name: 'charge', completed: true, result: { amount: 10 } },
      { name: 'sleep', completed: false },
    ])
    const r4 = runWithSteps('r4', [
      { name: 'validate', completed: true, result: { ok: true } },
      { name: 'charge', completed: true, result: { amount: 10, promoCode: 'Y' } },
      { name: 'sleep', completed: true },
      { name: 'notify', completed: true, result: {} },
      { name: 'archive', completed: true, result: {} },
    ], 'completed')
    // r4 is complete — typically not in in-flight, but paper includes it
    // Re-status for scoring as in-flight with complete prefix (frontier null)
    r4.status = 'running'

    const result = analyzeUpgradeRisk({
      g1,
      g2,
      history,
      inFlight: [r1, r2, r3, r4],
      options: { tauLo: 0.1, tauHi: 0.5, alpha: 1, exactRegime: true },
    })

    const byId = new Map(result.runs.map(r => [r.runId, r]))

    // r2: charged with promo → migrate, WUR ≈ 0
    assert.equal(byId.get('r2')!.backwardRisk, 0)
    assert.ok(byId.get('r2')!.forwardRisk < 0.05, `r2 Rf=${byId.get('r2')!.forwardRisk}`)
    assert.equal(byId.get('r2')!.verdict, 'migrate')

    // r3: charged without promo → pin, WUR = 1
    assert.equal(byId.get('r3')!.backwardRisk, 0)
    assert.ok(byId.get('r3')!.forwardRisk > 0.99, `r3 Rf=${byId.get('r3')!.forwardRisk}`)
    assert.equal(byId.get('r3')!.verdict, 'pin')

    // r1: before charge → review with ~0.43 distributional
    assert.equal(byId.get('r1')!.backwardRisk, 0)
    assert.ok(
      byId.get('r1')!.forwardRisk > 0.3 && byId.get('r1')!.forwardRisk < 0.55,
      `r1 Rf=${byId.get('r1')!.forwardRisk}`
    )
    assert.equal(byId.get('r1')!.verdict, 'review')

    // r4: complete with promo — Rb=0 (archive already done with valid path), Rf=0
    assert.equal(byId.get('r4')!.backwardRisk, 0)
    assert.equal(byId.get('r4')!.verdict, 'migrate')
  })
})

// ---------------------------------------------------------------------------
// Structural scenarios S1–S5 (exact backward oracle agreement)
// ---------------------------------------------------------------------------

describe('WUR structural scenarios (exact R_b)', () => {
  const base = ['validate', 'charge', 'notify']

  function fleetAtFrontiers (g1: StepGraph, g2: StepGraph, n = 40): {
    result: ReturnType<typeof analyzeUpgradeRisk>
    unsafe: number
  } {
    const history: ProtocolRun[] = []
    for (let i = 0; i < 30; i++) {
      history.push(runWithSteps(`h${i}`, base.map(name => ({
        name, completed: true, result: { ok: true },
      })), 'completed'))
    }
    const inFlight: ProtocolRun[] = []
    // Suspend at each prefix length
    for (let f = 0; f < base.length; f++) {
      for (let k = 0; k < Math.floor(n / base.length); k++) {
        const steps = base.map((name, i) => ({
          name,
          completed: i < f,
          result: i < f ? { ok: true } : undefined,
        }))
        // frontier = first incomplete
        inFlight.push(runWithSteps(`r${f}_${k}`, steps))
      }
    }
    const result = analyzeUpgradeRisk({
      g1,
      g2,
      history,
      inFlight,
      options: { exactRegime: true, tauLo: 0.01, tauHi: 0.5 },
    })
    const unsafe = result.runs.filter(r => r.backwardRisk > 0).length
    return { result, unsafe }
  }

  it('S1 body-only edit: zero backward risk', () => {
    const g1 = linearSites(base)
    const g2 = linearSites(base) // same structure
    const { unsafe } = fleetAtFrontiers(g1, g2)
    assert.equal(unsafe, 0)
  })

  it('S4 insert at head: high backward risk', () => {
    const g1 = linearSites(base)
    const g2 = linearSites(['audit', ...base])
    const { unsafe } = fleetAtFrontiers(g1, g2)
    // All runs with non-empty prefix should be unsafe; empty frontier-only at start
    assert.ok(unsafe > 0)
    // Runs that completed at least one site
    assert.ok(unsafe >= 20, `expected many unsafe, got ${unsafe}`)
  })

  it('S5 insert at tail: zero backward risk', () => {
    const g1 = linearSites(base)
    const g2 = linearSites([...base, 'audit'])
    const { unsafe } = fleetAtFrontiers(g1, g2)
    assert.equal(unsafe, 0)
  })
})

// ---------------------------------------------------------------------------
// Coupling: contagion + min-cut
// ---------------------------------------------------------------------------

describe('WUR coupling', () => {
  it('contagion fixpoint elevates neighbor risk', () => {
    const b = new Map([['r1', 0.5], ['r2', 0], ['r3', 0]])
    const edges = [
      { from: 'r1', to: 'r2', transmission: 1, channelPenalty: 0 },
      { from: 'r2', to: 'r3', transmission: 1, channelPenalty: 0 },
    ]
    const q = contagionFixpoint(b, edges)
    assert.ok((q.get('r1') ?? 0) >= 0.5)
    assert.ok((q.get('r2') ?? 0) > 0.4)
    assert.ok((q.get('r3') ?? 0) > 0.3)
  })

  it('min-cut keeps hard-pin runs on pin side', () => {
    const runs: RunRisk[] = [
      { runId: 'r1', backwardRisk: 0, forwardRisk: 0.1, wur: 0.1, verdict: 'migrate', prefixValid: true, frontier: 'a', reasons: [] },
      { runId: 'r2', backwardRisk: 1, forwardRisk: 0, wur: 1, verdict: 'pin', prefixValid: false, frontier: 'a', reasons: [] },
      { runId: 'r3', backwardRisk: 0, forwardRisk: 0, wur: 0, verdict: 'migrate', prefixValid: true, frontier: null, reasons: [] },
      { runId: 'r4', backwardRisk: 0, forwardRisk: 0.2, wur: 0.2, verdict: 'review', prefixValid: true, frontier: 'b', reasons: [] },
    ]
    const edges = [
      { from: 'r1', to: 'r2', transmission: 1, channelPenalty: 10 },
      { from: 'r3', to: 'r4', transmission: 1, channelPenalty: Number.POSITIVE_INFINITY },
    ]
    const part = minCutPartition(runs, edges, { pinCost: 0.05, forgoneFix: 0.05 })
    assert.ok(part.pin.includes('r2'))
    // r3,r4 contracted — same side
    const r3side = part.migrate.includes('r3') ? 'm' : 'p'
    const r4side = part.migrate.includes('r4') ? 'm' : 'p'
    assert.equal(r3side, r4side)
  })
})

// ---------------------------------------------------------------------------
// Explicit change list path
// ---------------------------------------------------------------------------

describe('WUR analyzeWithChanges', () => {
  it('scores from explicit Δ without graph demand fields', () => {
    const g1 = linearSites(['a', 'b', 'c'])
    const g2 = linearSites(['a', 'b', 'c'])
    const changes: ChangedSite[] = [{
      siteId: 'c',
      axis: 'interface',
      reason: 'c demands x from b',
      severity: 1,
      demandFields: ['x'],
      producerSiteId: 'b',
    }]
    const history = Array.from({ length: 20 }, (_, i) =>
      runWithSteps(`h${i}`, [
        { name: 'a', completed: true, result: {} },
        { name: 'b', completed: true, result: i < 10 ? { x: 1 } : {} },
        { name: 'c', completed: true, result: {} },
      ], 'completed')
    )
    const inFlight = [
      runWithSteps('ok', [
        { name: 'a', completed: true, result: {} },
        { name: 'b', completed: true, result: { x: 1 } },
        { name: 'c', completed: false },
      ]),
      runWithSteps('bad', [
        { name: 'a', completed: true, result: {} },
        { name: 'b', completed: true, result: {} },
        { name: 'c', completed: false },
      ]),
    ]
    const result = analyzeWithChanges(g1, g2, changes, history, inFlight, {
      exactRegime: true,
      tauLo: 0.1,
      tauHi: 0.5,
    })
    const byId = new Map(result.runs.map(r => [r.runId, r]))
    assert.equal(byId.get('ok')!.verdict, 'migrate')
    assert.equal(byId.get('bad')!.verdict, 'pin')
  })
})
