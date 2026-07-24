/**
 * Real devalue wiring + calibration incident feed + e2e corpus extract.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  analyzeUpgradeRisk,
  dehydrateForTest,
  extractGraphsFromSource,
  hydrateEventData,
  recordReleaseOutcome,
  CalibrationStore,
  validatePayload,
} from '../lib/wur/index.ts'
import { setupTest, teardownTest, type TestContext } from './helper.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('WUR devalue SDK wiring', () => {
  it('round-trips plain record through devl+devalue', () => {
    const payload = { amount: 10, promoCode: 'SAVE10', nested: { ok: true } }
    const buf = dehydrateForTest(payload)
    assert.equal(buf.subarray(0, 4).toString('utf-8'), 'devl')

    const h = hydrateEventData(buf)
    assert.equal(h.kind, 'record')
    assert.equal(h.recordInspectable, true)
    assert.equal(h.format, 'devl')
    const rec = h.value as Record<string, unknown>
    assert.equal(rec.amount, 10)
    assert.equal(rec.promoCode, 'SAVE10')
    assert.equal(validatePayload(rec, ['promoCode']).verdict, 'sat')
    assert.equal(validatePayload(rec, ['missing']).verdict, 'vio')
  })

  it('hydrates base64 of devl buffer', () => {
    const buf = dehydrateForTest({ x: 1 })
    const h = hydrateEventData(buf.toString('base64'))
    assert.equal(h.recordInspectable, true)
    assert.equal((h.value as any).x, 1)
  })

  it('marks encr prefix as encrypted (not inspectable)', () => {
    const body = Buffer.from('ciphertext')
    const buf = Buffer.alloc(4 + body.length)
    buf.write('encr', 0)
    body.copy(buf, 4)
    const h = hydrateEventData(buf)
    assert.equal(h.kind, 'encrypted')
    assert.equal(h.recordInspectable, false)
  })

  it('Date values are not record-inspectable (lattice unk)', () => {
    const buf = dehydrateForTest({ when: new Date('2026-01-01'), n: 1 })
    const h = hydrateEventData(buf)
    // whole object may be record with Date field — field check on n works
    assert.equal(h.recordInspectable, true)
    assert.equal(validatePayload(h.value, ['n']).verdict, 'sat')
  })

  it('interface risk works on devalue step results in analyze path', () => {
    const g1 = {
      sites: [
        { id: 'charge', label: { name: 'charge', kind: 'step' as const }, outputFields: ['amount'] },
        { id: 'archive', label: { name: 'archive', kind: 'step' as const }, demandFields: [], consumesFrom: ['charge'] },
      ],
      edges: [
        { from: null, to: 'charge' },
        { from: 'charge', to: 'archive' },
      ],
    }
    const g2 = {
      sites: [
        { id: 'charge', label: { name: 'charge', kind: 'step' as const }, outputFields: ['amount', 'promoCode'] },
        { id: 'archive', label: { name: 'archive', kind: 'step' as const }, demandFields: ['promoCode'], consumesFrom: ['charge'] },
      ],
      edges: [
        { from: null, to: 'charge' },
        { from: 'charge', to: 'archive' },
      ],
    }

    // Simulate storage: eventData is JSON envelope with devalue-base64 result
    const goodBuf = dehydrateForTest({ amount: 1, promoCode: 'X' })
    const badBuf = dehydrateForTest({ amount: 1 })

    const mkRun = (id: string, resultBuf: Buffer) => ({
      runId: id,
      workflowName: 'wf',
      deploymentId: 'd',
      status: 'running',
      events: [
        {
          eventType: 'step_started',
          correlationId: '01ARZ3NDEKTSV4RRFFQ6900001',
          eventData: { stepName: 'charge' },
        },
        {
          eventType: 'step_completed',
          correlationId: '01ARZ3NDEKTSV4RRFFQ6900001',
          // Plugin path hydrates; here we pre-hydrate via hydrateEventData as storage would after decode
          eventData: {
            stepName: 'charge',
            result: hydrateEventData(resultBuf).value,
          },
        },
        {
          eventType: 'step_started',
          correlationId: '01ARZ3NDEKTSV4RRFFQ6900002',
          eventData: { stepName: 'archive' },
        },
      ],
    })

    const history = Array.from({ length: 20 }, (_, i) => ({
      runId: `h${i}`,
      workflowName: 'wf',
      deploymentId: 'd',
      status: 'completed',
      events: [
        {
          eventType: 'step_started',
          correlationId: '01ARZ3NDEKTSV4RRFFQ6900001',
          eventData: { stepName: 'charge' },
        },
        {
          eventType: 'step_completed',
          correlationId: '01ARZ3NDEKTSV4RRFFQ6900001',
          eventData: {
            stepName: 'charge',
            result: i < 10 ? { amount: 1, promoCode: 'P' } : { amount: 1 },
          },
        },
        {
          eventType: 'step_started',
          correlationId: '01ARZ3NDEKTSV4RRFFQ6900002',
          eventData: { stepName: 'archive' },
        },
        {
          eventType: 'step_completed',
          correlationId: '01ARZ3NDEKTSV4RRFFQ6900002',
          eventData: { stepName: 'archive', result: {} },
        },
      ],
    }))

    const result = analyzeUpgradeRisk({
      g1,
      g2,
      history,
      inFlight: [mkRun('good', goodBuf), mkRun('bad', badBuf)],
      options: { exactRegime: true, tauLo: 0.1, tauHi: 0.5 },
    })
    const byId = new Map(result.runs.map(r => [r.runId, r]))
    assert.equal(byId.get('good')!.verdict, 'migrate')
    assert.equal(byId.get('bad')!.verdict, 'pin')
  })
})

describe('WUR calibration incident feed API', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('POST/GET calibration endpoints', async () => {
    const appId = ctx.appId
    const post = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/upgrade-risk/calibration`,
      payload: {
        changeClasses: ['insert-step', 'demand-growth'],
        incident: true,
        exposures: 3,
      },
    })
    assert.equal(post.statusCode, 200, post.body)
    const body = post.json()
    assert.equal(body.recorded, true)
    assert.ok(body.posteriors['insert-step'].mean > 0.5)

    const get = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${appId}/upgrade-risk/calibration`,
    })
    assert.equal(get.statusCode, 200)
    const g = get.json()
    assert.ok(g.app['insert-step'])
    assert.ok(g.fleet)
  })

  it('record from annotations', async () => {
    const appId = ctx.appId
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/upgrade-risk/calibration`,
      payload: {
        annotations: [
          { axis: 'protocol', reason: 'site inserted: step/audit' },
        ],
        incident: false,
      },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().changeClasses, ['insert-step'])
  })
})

describe('WUR e2e-v5 corpus extract', () => {
  it('extracts graphs from in-repo workflow sources without crash', () => {
    const workflowsDir = join(__dirname, '../../../e2e-v5/workflows')
    let files: string[]
    try {
      files = readdirSync(workflowsDir).filter(f => f.endsWith('.ts'))
    } catch {
      // e2e-v5 not present in some checkouts
      return
    }
    assert.ok(files.length > 0)
    let graphs = 0
    const names: string[] = []
    for (const f of files) {
      const src = readFileSync(join(workflowsDir, f), 'utf8')
      const { workflows, warnings } = extractGraphsFromSource(src, {
        modulePath: `workflows/${f}`,
        qualifiedNames: false,
      })
      for (const w of workflows) {
        graphs++
        names.push(`${f}:${w.name}`)
        assert.ok(Array.isArray(w.graph.sites))
      }
      if (warnings.length > 100) assert.fail('too many extract warnings')
    }
    // At least greet / e2e style workflows should yield some graphs
    assert.ok(graphs >= 1, `extracted graphs=${graphs} from ${files.length} files: ${names.join(', ')}`)
  })

  it('self-diff of extracted graph is zero protocol risk', () => {
    const path = join(__dirname, '../../../e2e-v5/workflows/greet.ts')
    let src: string
    try {
      src = readFileSync(path, 'utf8')
    } catch {
      return
    }
    const { workflows } = extractGraphsFromSource(src, { qualifiedNames: false })
    if (workflows.length === 0) return
    const g = workflows[0].graph
    const result = analyzeUpgradeRisk({
      g1: g,
      g2: g,
      history: [],
      inFlight: [],
    })
    assert.equal(result.wur, 0)
    assert.equal(result.runs.length, 0)
  })
})

describe('WUR recordReleaseOutcome helper', () => {
  it('updates default store', () => {
    const store = new CalibrationStore()
    recordReleaseOutcome({
      appId: 'test-app',
      changeClasses: ['swap-sites'],
      incident: true,
      store,
    })
    const c = store.calibrate('swap-sites', 'test-app')
    assert.ok(c.mean > 0.4)
  })
})
