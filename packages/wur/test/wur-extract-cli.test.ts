/**
 * AST extract, calibration, hydration expand, mutation scale, CLI parse.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  analyzeUpgradeRisk,
  CalibrationStore,
  expandDevalueFlat,
  extractGraphsFromSource,
  extractWorkflowGraph,
  hydrateEventData,
  isPrefixValid,
  linearGraph,
  matchGraphs,
  oracleUnsafe,
  parseWurArgs,
  runWurCli,
  type StepGraph,
} from '../lib/index.ts'

const SAMPLE = `
import { sleep, createWebhook } from 'workflow'

export async function add (a: number, b: number) {
  'use step'
  return a + b
}

export async function orderFlow (order: { id: string }) {
  'use workflow'
  const validated = await validate(order)
  const [a, b] = await Promise.all([
    await charge(validated),
    await reserve(validated),
  ])
  await sleep(1000)
  await notify(a)
  return b
}

async function validate (o: any) {
  'use step'
  return o
}
async function charge (o: any) {
  'use step'
  return { amount: 1 }
}
async function reserve (o: any) {
  'use step'
  return { ok: true }
}
async function notify (o: any) {
  'use step'
  return true
}
`

describe('WUR AST extract', () => {
  it('extracts workflow sites including sleep and Promise.all', () => {
    const { workflows, warnings } = extractGraphsFromSource(SAMPLE, {
      modulePath: 'workflows/order.ts',
      qualifiedNames: false,
    })
    assert.ok(workflows.length >= 1, `workflows=${workflows.map(w => w.name)} warn=${warnings}`)
    const order = workflows.find(w => w.name === 'orderFlow')
    assert.ok(order)
    const names = order!.graph.sites.map(s => s.label.name)
    assert.ok(names.includes('validate') || names.some(n => n.includes('validate')))
    assert.ok(names.includes('sleep') || names.some(n => n === 'sleep'))
    assert.ok(names.includes('charge') || names.some(n => n.includes('charge')))
    assert.ok(
      (order!.graph.parallelGroups?.length ?? 0) >= 1,
      'expected Promise.all parallel group'
    )
  })

  it('extractWorkflowGraph by name', () => {
    const g = extractWorkflowGraph(SAMPLE, 'orderFlow', { qualifiedNames: false })
    assert.ok(g)
    assert.ok(g!.sites.length >= 3)
  })

  it('analyzes extracted V1 vs V2 with insert', () => {
    const v1 = `
export async function wf() {
  'use workflow'
  await a()
  await b()
}
async function a() { 'use step'; return 1 }
async function b() { 'use step'; return 2 }
`
    const v2 = `
export async function wf() {
  'use workflow'
  await audit()
  await a()
  await b()
}
async function audit() { 'use step'; return 0 }
async function a() { 'use step'; return 1 }
async function b() { 'use step'; return 2 }
`
    const g1 = extractWorkflowGraph(v1, 'wf', { qualifiedNames: false })!
    const g2 = extractWorkflowGraph(v2, 'wf', { qualifiedNames: false })!
    const result = analyzeUpgradeRisk({
      g1,
      g2,
      history: [],
      inFlight: [{
        runId: 'r1',
        workflowName: 'wf',
        deploymentId: 'd1',
        status: 'running',
        events: [
          { eventType: 'step_started', correlationId: '01ARZ3NDEKTSV4RRFFQ6900001', eventData: { stepName: 'a' } },
          { eventType: 'step_completed', correlationId: '01ARZ3NDEKTSV4RRFFQ6900001', eventData: { stepName: 'a', result: {} } },
          { eventType: 'step_started', correlationId: '01ARZ3NDEKTSV4RRFFQ6900002', eventData: { stepName: 'b' } },
        ],
      }],
    })
    assert.ok(result.runs[0].backwardRisk > 0 || result.annotations.some(a => a.axis === 'protocol'))
  })
})

describe('WUR devalue flat expand', () => {
  it('expands pointer-table array to record', () => {
    // Manual pointer table: slot0 → slot1 object; fields point at string/number slots
    const flat = [1, { promoCode: 2, amount: 3 }, 'SAVE', 10]
    const h = expandDevalueFlat(flat)
    assert.equal(h.recordInspectable, true, JSON.stringify(h))
    const rec = h.value as Record<string, unknown>
    assert.equal(rec.promoCode, 'SAVE')
    assert.equal(rec.amount, 10)
  })

  it('hydrateEventData uses expand on arrays', () => {
    const h = hydrateEventData([1, { x: 2 }, 'hi'])
    assert.ok(h.kind === 'record' || h.kind === 'array')
  })
})

describe('WUR calibration store', () => {
  it('cold start has wide-ish interval; data shrinks mean toward incidents', () => {
    const store = new CalibrationStore()
    const cold = store.calibrate('insert-step', 'app1')
    assert.equal(cold.coldStart, true)

    for (let i = 0; i < 20; i++) {
      store.record('app1', { changeClass: 'insert-step', exposures: 1, incidents: 1 })
    }
    const hot = store.calibrate('insert-step', 'app1')
    assert.ok(hot.mean > 0.7)
    assert.equal(hot.coldStart, false)
  })

  it('classifyReason maps annotation text', () => {
    assert.equal(CalibrationStore.classifyReason('consumer archive demands fields: promo'), 'demand-growth')
    assert.equal(CalibrationStore.classifyReason('site inserted: step/audit'), 'insert-step')
    assert.equal(CalibrationStore.classifyReason('parallel/race branch reorder'), 'parallel-reorder')
  })

  it('round-trips JSON', () => {
    const s = new CalibrationStore()
    s.record(null, { changeClass: 'delete-site', exposures: 5, incidents: 1 })
    const s2 = CalibrationStore.fromJSON(s.toJSON())
    const c = s2.calibrate('delete-site')
    assert.ok(c.mean > 0 && c.mean < 1)
  })
})

describe('WUR CLI parse + extract', () => {
  it('parseWurArgs', () => {
    const a = parseWurArgs(['--g1', 'a.json', '--g2', 'b.json', '--draws', '10', '--json'])
    assert.equal(a.g1, 'a.json')
    assert.equal(a.draws, 10)
    assert.equal(a.json, true)
  })

  it('runWurCli extract writes manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wur-'))
    try {
      const src = join(dir, 'wf.ts')
      const out = join(dir, 'g.json')
      writeFileSync(src, SAMPLE)
      const code = await runWurCli(['--extract', src, '--workflow', 'orderFlow', '--out', out])
      assert.equal(code, 0)
      const g = JSON.parse(readFileSync(out, 'utf8'))
      assert.ok(Array.isArray(g.sites))
      assert.ok(g.sites.length >= 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('WUR mutation scale (§12.2 style)', () => {
  function linear (names: string[]): StepGraph {
    return linearGraph(names.map(n => ({ id: n, name: n })))
  }

  const MUTATORS: Array<(names: string[]) => StepGraph> = [
    (n) => linear(['x', ...n]),
    (n) => linear([...n, 'x']),
    (n) => linear(n.slice(0, Math.max(1, n.length - 1))),
    (n) => {
      const m = [...n]
      if (m.length >= 2) [m[0], m[1]] = [m[1], m[0]]
      return linear(m)
    },
    (n) => linear([n[0], 'mid', ...n.slice(1)]),
    (n) => linear(n), // body-only identity
  ]

  it('FN=0 across 500 mutation×prefix pairs', () => {
    let fn = 0
    let total = 0
    for (let t = 0; t < 100; t++) {
      const n = 3 + (t % 4)
      const names = Array.from({ length: n }, (_, i) => `s${i}`)
      const g1 = linear(names)
      const g2 = MUTATORS[t % MUTATORS.length](names)
      for (let f = 0; f <= names.length; f++) {
        const sites = names.slice(0, f)
        const frontier = f < names.length ? names[f] : null
        const truth = oracleUnsafe(g1, g2, sites, frontier)
        const m = matchGraphs(g1, g2)
        const pred = !isPrefixValid(sites, g1, g2, m).valid
        total++
        if (truth && !pred) fn++
      }
    }
    assert.equal(fn, 0, `false negatives ${fn}/${total}`)
    assert.ok(total >= 400)
  })
})
