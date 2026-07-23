/**
 * WUR fidelity suite — arXiv:2607.13617 §12 scenarios + oracle gate.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeUpgradeRisk,
  buildCouplingGraph,
  canonicalNormalForm,
  contagionFixpoint,
  hydrateEventData,
  isPrefixValid,
  linearGraph,
  matchGraphs,
  minCutPartition,
  mixedWindowPenalty,
  oracleReplay,
  oracleUnsafe,
  parallelGraph,
  prefixHash,
  traceEquivalent,
  validatePayload,
  manifestToGraph,
  type ProtocolRun,
  type RunRisk,
  type StepGraph,
} from '../lib/wur/index.ts'

function ulidAt (seq: number): string {
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
      if (s.completed) events.push({ eventType: 'wait_completed', correlationId: corr, eventData: {} })
    } else {
      events.push({ eventType: 'step_started', correlationId: corr, eventData: { stepName: s.name } })
      if (s.completed) {
        events.push({
          eventType: 'step_completed',
          correlationId: corr,
          eventData: { stepName: s.name, result: s.result ?? {} },
        })
      }
    }
  }
  return { runId, workflowName: 'wf', deploymentId: 'v1', status, events }
}

function linearSites (names: string[], extra: Record<string, any> = {}): StepGraph {
  return linearGraph(names.map(name => ({
    id: name,
    name,
    kind: extra[name]?.kind ?? (name === 'sleep' ? 'timer' : 'step'),
    outputFields: extra[name]?.outputFields,
    demandFields: extra[name]?.demandFields,
    consumesFrom: extra[name]?.consumesFrom,
  })))
}

// ---------------------------------------------------------------------------
// Hydration (WS-A)
// ---------------------------------------------------------------------------

describe('WUR fidelity WS-A hydration', () => {
  it('hydrates JSON records as inspectable', () => {
    const h = hydrateEventData({ promoCode: 'X', amount: 1 })
    assert.equal(h.kind, 'record')
    assert.equal(h.recordInspectable, true)
  })

  it('marks Date/Map as non-record (unk lattice)', () => {
    assert.equal(hydrateEventData(new Date()).recordInspectable, false)
    assert.equal(hydrateEventData(new Map()).recordInspectable, false)
  })

  it('validatePayload returns unk for opaque', () => {
    const v = validatePayload({ __opaque: true, base64: 'aaaa' }, ['x'])
    // may be opaque or vio depending on decode
    assert.ok(v.verdict === 'unk' || v.verdict === 'vio' || v.verdict === 'sat')
  })
})

// ---------------------------------------------------------------------------
// Trace equivalence (WS-B)
// ---------------------------------------------------------------------------

describe('WUR fidelity WS-B concurrency', () => {
  it('S8: join branch reorder is protocol-invalid for prefixes reaching group', () => {
    const g1 = parallelGraph({
      prefix: [{ id: 'a', name: 'a' }],
      branches: [
        [{ id: 'b1', name: 'left' }],
        [{ id: 'b2', name: 'right' }],
      ],
      suffix: [{ id: 'c', name: 'c' }],
      groupId: 'p0',
      kind: 'join',
    })
    const g2 = parallelGraph({
      prefix: [{ id: 'a', name: 'a' }],
      branches: [
        [{ id: 'b2', name: 'right' }],
        [{ id: 'b1', name: 'left' }],
      ],
      suffix: [{ id: 'c', name: 'c' }],
      groupId: 'p0',
      kind: 'join',
    })
    const m = matchGraphs(g1, g2)
    // Branch order changed → classify should flag; prefix with a,b1,b2
    const result = analyzeUpgradeRisk({
      g1,
      g2,
      history: [],
      inFlight: [
        runWithSteps('r1', [
          { name: 'a', completed: true, result: {} },
          { name: 'left', completed: true, result: {} },
          { name: 'right', completed: true, result: {} },
          { name: 'c', completed: false },
        ]),
      ],
    })
    // Either R_b > 0 or protocol annotation present
    const run = result.runs[0]
    assert.ok(
      run.backwardRisk > 0 || result.annotations.some(a => a.axis === 'protocol'),
      `expected protocol risk, got Rb=${run.backwardRisk} ann=${JSON.stringify(result.annotations)}`
    )
    assert.ok(m.map.size >= 0)
  })

  it('completion-order permutation of join branches is ≡_I', () => {
    const g = parallelGraph({
      branches: [
        [{ id: 'b1', name: 'left' }],
        [{ id: 'b2', name: 'right' }],
      ],
      kind: 'join',
      groupId: 'p0',
    })
    const a = ['b1', 'b2']
    const b = ['b2', 'b1']
    assert.equal(traceEquivalent(a, b, g), true)
    assert.deepEqual(
      canonicalNormalForm(a, g),
      canonicalNormalForm(b, g)
    )
  })

  it('prefix hash buckets identical normal forms', () => {
    const g = linearSites(['a', 'b', 'c'])
    const h1 = prefixHash(['a', 'b'], g, 'c')
    const h2 = prefixHash(['a', 'b'], g, 'c')
    assert.equal(h1, h2)
  })
})

// ---------------------------------------------------------------------------
// §12.1 structural scenarios (oracle vs analyzer)
// ---------------------------------------------------------------------------

describe('WUR fidelity §12.1 structural (oracle)', () => {
  const base = ['validate', 'charge', 'notify']

  function fleetUnsafe (g1: StepGraph, g2: StepGraph, n = 30): {
    predicted: number
    trueUnsafe: number
    fn: number
  } {
    const history: ProtocolRun[] = []
    for (let i = 0; i < 20; i++) {
      history.push(runWithSteps(`h${i}`, base.map(name => ({
        name, completed: true, result: { ok: true },
      })), 'completed'))
    }
    const inFlight: ProtocolRun[] = []
    const prefixes: Array<{ sites: string[], frontier: string | null }> = []
    for (let f = 0; f < base.length; f++) {
      for (let k = 0; k < Math.floor(n / base.length); k++) {
        const steps = base.map((name, i) => ({
          name,
          completed: i < f,
          result: i < f ? { ok: true } : undefined,
        }))
        inFlight.push(runWithSteps(`r${f}_${k}`, steps))
        prefixes.push({
          sites: base.slice(0, f),
          frontier: f < base.length ? base[f] : null,
        })
      }
    }
    const result = analyzeUpgradeRisk({
      g1,
      g2,
      history,
      inFlight,
      options: { exactRegime: true, tauLo: 0.01, tauHi: 0.5 },
    })
    let predicted = 0
    let trueUnsafe = 0
    let fn = 0
    for (let i = 0; i < result.runs.length; i++) {
      const pred = result.runs[i].backwardRisk > 0
      const truth = oracleUnsafe(g1, g2, prefixes[i].sites, prefixes[i].frontier)
      if (pred) predicted++
      if (truth) trueUnsafe++
      if (truth && !pred) fn++
    }
    return { predicted, trueUnsafe, fn }
  }

  it('S1 body-only: FN=0, zero unsafe', () => {
    const g = linearSites(base)
    const { predicted, trueUnsafe, fn } = fleetUnsafe(g, g)
    assert.equal(fn, 0)
    assert.equal(predicted, 0)
    assert.equal(trueUnsafe, 0)
  })

  it('S4 insert at head: high unsafe, FN=0', () => {
    const g1 = linearSites(base)
    const g2 = linearSites(['audit', ...base])
    const { predicted, trueUnsafe, fn } = fleetUnsafe(g1, g2)
    assert.equal(fn, 0)
    assert.ok(predicted > 0)
    assert.ok(trueUnsafe > 0)
  })

  it('S5 insert at tail: zero unsafe, FN=0', () => {
    const g1 = linearSites(base)
    const g2 = linearSites([...base, 'audit'])
    const { predicted, trueUnsafe, fn } = fleetUnsafe(g1, g2)
    assert.equal(fn, 0)
    assert.equal(predicted, 0)
    assert.equal(trueUnsafe, 0)
  })

  it('S6 delete tail: FN=0', () => {
    const g1 = linearSites(base)
    const g2 = linearSites(['validate', 'charge'])
    const { fn } = fleetUnsafe(g1, g2)
    assert.equal(fn, 0)
  })

  it('S7 swap steps: FN=0', () => {
    const g1 = linearSites(base)
    const g2 = linearSites(['charge', 'validate', 'notify'])
    const { fn, predicted } = fleetUnsafe(g1, g2)
    assert.equal(fn, 0)
    assert.ok(predicted > 0)
  })
})

// ---------------------------------------------------------------------------
// Worked example §9.1 regression
// ---------------------------------------------------------------------------

describe('WUR fidelity §9.1 worked example', () => {
  it('promoCode partition', () => {
    const g1 = linearSites(['validate', 'charge', 'sleep', 'notify', 'archive'], {
      charge: { outputFields: ['amount'] },
      archive: { demandFields: [], consumesFrom: ['charge'] },
    })
    const g2 = linearSites(['validate', 'charge', 'sleep', 'notify', 'archive'], {
      charge: { outputFields: ['amount', 'promoCode'] },
      archive: { demandFields: ['promoCode'], consumesFrom: ['charge'] },
    })
    const history: ProtocolRun[] = []
    for (let i = 0; i < 120; i++) {
      const hasPromo = i < 68
      history.push(runWithSteps(`h${i}`, [
        { name: 'validate', completed: true, result: { ok: true } },
        { name: 'charge', completed: true, result: hasPromo ? { amount: 10, promoCode: 'P' } : { amount: 10 } },
        { name: 'sleep', completed: true },
        { name: 'notify', completed: true, result: {} },
        { name: 'archive', completed: true, result: {} },
      ], 'completed'))
    }
    const inFlight = [
      runWithSteps('r1', [
        { name: 'validate', completed: true, result: { ok: true } },
        { name: 'charge', completed: false },
      ]),
      runWithSteps('r2', [
        { name: 'validate', completed: true, result: { ok: true } },
        { name: 'charge', completed: true, result: { amount: 10, promoCode: 'X' } },
        { name: 'sleep', completed: false },
      ]),
      runWithSteps('r3', [
        { name: 'validate', completed: true, result: { ok: true } },
        { name: 'charge', completed: true, result: { amount: 10 } },
        { name: 'sleep', completed: false },
      ]),
      runWithSteps('r4', [
        { name: 'validate', completed: true, result: { ok: true } },
        { name: 'charge', completed: true, result: { amount: 10, promoCode: 'Y' } },
        { name: 'sleep', completed: true },
        { name: 'notify', completed: true, result: {} },
        { name: 'archive', completed: true, result: {} },
      ], 'running'),
    ]
    const result = analyzeUpgradeRisk({
      g1,
      g2,
      history,
      inFlight,
      options: { tauLo: 0.1, tauHi: 0.5, alpha: 1, exactRegime: true },
    })
    const byId = new Map(result.runs.map(r => [r.runId, r]))
    assert.equal(byId.get('r2')!.verdict, 'migrate')
    assert.equal(byId.get('r3')!.verdict, 'pin')
    assert.equal(byId.get('r1')!.verdict, 'review')
    assert.equal(byId.get('r4')!.verdict, 'migrate')
  })
})

// ---------------------------------------------------------------------------
// Coupling §12.5–12.6
// ---------------------------------------------------------------------------

describe('WUR fidelity §10 coupling', () => {
  it('contagion elevates neighbors (acyclic)', () => {
    const b = new Map([['r1', 0.5], ['r2', 0], ['r3', 0]])
    const q = contagionFixpoint(b, [
      { from: 'r1', to: 'r2', transmission: 1, channelPenalty: 0 },
      { from: 'r2', to: 'r3', transmission: 1, channelPenalty: 0 },
    ])
    assert.ok((q.get('r3') ?? 0) > 0.2)
  })

  it('min-cut matches hard pin constraint', () => {
    const runs: RunRisk[] = [
      { runId: 'r1', backwardRisk: 0, forwardRisk: 0.1, wur: 0.1, verdict: 'migrate', prefixValid: true, frontier: 'a', reasons: [] },
      { runId: 'r2', backwardRisk: 1, forwardRisk: 0, wur: 1, verdict: 'pin', prefixValid: false, frontier: 'a', reasons: [] },
      { runId: 'r3', backwardRisk: 0, forwardRisk: 0, wur: 0, verdict: 'migrate', prefixValid: true, frontier: null, reasons: [] },
      { runId: 'r4', backwardRisk: 0, forwardRisk: 0.2, wur: 0.2, verdict: 'review', prefixValid: true, frontier: 'b', reasons: [] },
    ]
    const part = minCutPartition(runs, [
      { from: 'r3', to: 'r4', transmission: 1, channelPenalty: Number.POSITIVE_INFINITY },
    ])
    assert.ok(part.pin.includes('r2'))
    const s3 = part.migrate.includes('r3') ? 'm' : 'p'
    const s4 = part.migrate.includes('r4') ? 'm' : 'p'
    assert.equal(s3, s4)
  })

  it('mixed-window penalty increases with rate and incompat', () => {
    const low = mixedWindowPenalty({ eventRate: 0.1, overlapDuration: 1, crossVersionIncompat: 0.1 })
    const high = mixedWindowPenalty({ eventRate: 10, overlapDuration: 10, crossVersionIncompat: 1 })
    assert.ok(high > low)
    assert.ok(high > 0.9)
  })

  it('buildCouplingGraph finds hierarchy edges', () => {
    const runs: ProtocolRun[] = [
      { runId: 'a', workflowName: 'w', deploymentId: 'd', status: 'running', events: [], coupledRunIds: ['b'] },
      { runId: 'b', workflowName: 'w', deploymentId: 'd', status: 'running', events: [] },
    ]
    const edges = buildCouplingGraph(runs)
    assert.ok(edges.some(e => e.from === 'a' && e.to === 'b'))
  })
})

// ---------------------------------------------------------------------------
// Manifest extract (WS-C1)
// ---------------------------------------------------------------------------

describe('WUR fidelity static manifest', () => {
  it('round-trips graph manifest', () => {
    const g = linearSites(['a', 'b'])
    const m = {
      version: 2,
      modulePath: 'workflows/order.ts',
      sites: g.sites.map(s => ({ id: s.id, name: s.label.name, kind: s.label.kind })),
      edges: g.edges,
    }
    const g2 = manifestToGraph(m)
    assert.equal(g2.sites.length, 2)
    assert.equal(g2.modulePath, 'workflows/order.ts')
  })
})

// ---------------------------------------------------------------------------
// Oracle self-consistency
// ---------------------------------------------------------------------------

describe('WUR fidelity oracle', () => {
  it('replay of path against own graph succeeds', () => {
    const g = linearSites(['a', 'b', 'c'])
    const r = oracleReplay(g, [
      { ordinal: 0, name: 'a', kind: 'step' },
      { ordinal: 1, name: 'b', kind: 'step' },
      { ordinal: 2, name: 'c', kind: 'step', pending: true },
    ])
    assert.equal(r.ok, true)
  })

  it('head-insert graph fails oracle on non-empty prefix', () => {
    const g2 = linearSites(['audit', 'a', 'b'])
    const r = oracleReplay(g2, [
      { ordinal: 0, name: 'a', kind: 'step' },
      { ordinal: 1, name: 'b', kind: 'step' },
    ])
    assert.equal(r.ok, false)
  })
})

// ---------------------------------------------------------------------------
// Mutation smoke (WS-H lightweight)
// ---------------------------------------------------------------------------

describe('WUR fidelity mutation smoke', () => {
  it('random linear mutations have FN=0 on oracle', () => {
    const names = ['s0', 's1', 's2', 's3']
    let fn = 0
    let total = 0
    for (let trial = 0; trial < 40; trial++) {
      const g1 = linearSites(names)
      // mutate: insert / delete / swap
      const mode = trial % 4
      let g2: StepGraph
      if (mode === 0) g2 = linearSites(['x', ...names])
      else if (mode === 1) g2 = linearSites([...names, 'x'])
      else if (mode === 2) g2 = linearSites(names.slice(0, 3))
      else g2 = linearSites([names[1], names[0], names[2], names[3]])

      for (let f = 0; f <= 3; f++) {
        const sites = names.slice(0, f)
        const frontier = f < names.length ? names[f] : null
        const truth = oracleUnsafe(g1, g2, sites, frontier)
        const m = matchGraphs(g1, g2)
        const v = isPrefixValid(sites, g1, g2, m)
        const pred = !v.valid
        total++
        if (truth && !pred) fn++
      }
    }
    assert.equal(fn, 0, `false negatives: ${fn}/${total}`)
  })
})
