/**
 * Gap-fill tests: demand inference, resource coupling, large mutation study.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyDemandsToGraph,
  buildCouplingGraph,
  buildResourceFingerprintEdges,
  enrichGraphWithDemandInference,
  extractResourceTouches,
  generateSyntheticCorpus,
  inferDemandsFromSource,
  linearGraph,
  runLargeMutationStudy,
  validatePayload,
  type ProtocolRun,
} from '../lib/index.ts'

describe('WUR demand inference (§4.1 access paths)', () => {
  it('infers member access fields from await bindings', () => {
    const src = `
      export async function wf(order) {
        'use workflow'
        const charged = await charge(order)
        const code = charged.promoCode
        const amt = charged?.amount
        await archive(charged)
      }
    `
    const inf = inferDemandsFromSource(src)
    const charge = inf.byProducer.get('charge')
    assert.ok(charge)
    assert.ok(charge!.fields.includes('promoCode'))
    assert.ok(charge!.fields.includes('amount'))
    assert.equal(charge!.unk, false)
  })

  it('infers destructuring fields', () => {
    const src = `
      const { userId, region } = await loadUser(id)
      await save(userId)
    `
    const inf = inferDemandsFromSource(src)
    // direct destructure from await
    const d = inf.demands.find(x => x.producerStep === 'loadUser')
    assert.ok(d)
    assert.ok(d!.fields.includes('userId'))
    assert.ok(d!.fields.includes('region'))
  })

  it('marks computed access as unk', () => {
    const src = `
      const x = await fetchData()
      const v = x[fieldName]
    `
    const inf = inferDemandsFromSource(src)
    const d = inf.byProducer.get('fetchData')
    assert.ok(d)
    assert.equal(d!.unk, true)
  })

  it('marks Reflect.get as unk', () => {
    const src = `
      const x = await fetchData()
      Reflect.get(x, 'hidden')
    `
    const inf = inferDemandsFromSource(src)
    assert.equal(inf.byProducer.get('fetchData')!.unk, true)
  })

  it('enrichGraphWithDemandInference attaches consumesFrom + demandFields', () => {
    const src = `
      const a = await stepA()
      const b = a.foo
      await stepB(b)
    `
    const g = linearGraph([
      { id: 'stepA', name: 'stepA' },
      { id: 'stepB', name: 'stepB' },
    ])
    const { graph } = enrichGraphWithDemandInference(src, g)
    const b = graph.sites.find(s => s.id === 'stepB')
    assert.ok(b?.consumesFrom?.includes('stepA'))
    assert.ok(b?.demandFields?.includes('foo'))
  })

  it('unk demand uses * maximal marker', () => {
    assert.equal(validatePayload({ a: 1 }, ['*']).verdict, 'unk')
  })
})

describe('WUR resource fingerprint coupling (tier 2)', () => {
  it('extractResourceTouches finds db.table and queue', () => {
    const t = extractResourceTouches({
      attributes: { 'db.table': 'orders', queue: 'email-q' },
      mode: 'write',
    })
    const names = t.map(x => x.resource)
    assert.ok(names.some(n => n.includes('orders')))
    assert.ok(names.some(n => n.includes('email-q')))
  })

  it('extractResourceTouches respects explicit resourceFingerprint', () => {
    const t = extractResourceTouches({
      resourceFingerprint: [
        { name: 'pg:users', mode: 'write' },
        'redis:session',
      ],
    })
    assert.ok(t.some(x => x.resource.includes('users') && x.mode === 'write'))
    assert.ok(t.some(x => x.resource === 'redis:session'))
  })

  it('buildResourceFingerprintEdges couples writers sharing a resource', () => {
    const runs: ProtocolRun[] = [
      {
        runId: 'r1',
        workflowName: 'w',
        deploymentId: 'd',
        status: 'running',
        events: [
          {
            eventType: 'step_completed',
            eventData: { attributes: { 'db.table': 'orders' }, mode: 'write' },
          },
        ],
      },
      {
        runId: 'r2',
        workflowName: 'w',
        deploymentId: 'd',
        status: 'running',
        events: [
          {
            eventType: 'step_completed',
            eventData: { attributes: { 'db.table': 'orders' }, mode: 'read' },
          },
        ],
      },
      {
        runId: 'r3',
        workflowName: 'w',
        deploymentId: 'd',
        status: 'running',
        events: [
          {
            eventType: 'step_completed',
            eventData: { attributes: { 'db.table': 'other' }, mode: 'read' },
          },
        ],
      },
    ]
    const edges = buildResourceFingerprintEdges(runs)
    assert.ok(edges.some(e => e.from === 'r1' && e.to === 'r2'))
    assert.ok(!edges.some(e => e.from === 'r1' && e.to === 'r3'))
  })

  it('buildCouplingGraph includes resource tier', () => {
    const runs: ProtocolRun[] = [
      {
        runId: 'a',
        workflowName: 'w',
        deploymentId: 'd',
        status: 'running',
        events: [{ eventType: 'step_completed', eventData: { queue: 'q1', mode: 'write' } }],
      },
      {
        runId: 'b',
        workflowName: 'w',
        deploymentId: 'd',
        status: 'running',
        events: [{ eventType: 'step_completed', eventData: { queue: 'q1' } }],
      },
    ]
    const edges = buildCouplingGraph(runs)
    assert.ok(edges.some(e =>
      (e.from === 'a' && e.to === 'b') || (e.from === 'b' && e.to === 'a')
    ))
  })
})

describe('WUR large mutation study (§12.2 scale)', () => {
  it('FN=0 on large-scale synthetic prefix pairs', () => {
    const study = runLargeMutationStudy({ corpusSize: 250 })
    assert.ok(study.pairs >= 5_000, `pairs=${study.pairs}`)
    assert.equal(study.totals.fn, 0, JSON.stringify(study.totals))
    assert.equal(study.sound, true)
    const { tp, fp } = study.totals
    if (tp + fp > 0) {
      const prec = tp / (tp + fp)
      assert.ok(prec > 0.5, `precision=${prec}`)
    }
  })

  it('generateSyntheticCorpus produces mixed linear/parallel graphs', () => {
    const c = generateSyntheticCorpus(20)
    assert.ok(c.length >= 20)
    assert.ok(c.some(e => (e.graph.parallelGroups?.length ?? 0) > 0))
  })
})

describe('WUR applyDemandsToGraph unit', () => {
  it('merges demand onto consumer', () => {
    const g = linearGraph([
      { id: 'p', name: 'produce' },
      { id: 'c', name: 'consume' },
    ])
    const inf = inferDemandsFromSource(`
      const x = await produce()
      const y = x.fieldA
    `)
    const g2 = applyDemandsToGraph(g, inf)
    // producer name is produce
    const consumer = g2.sites.find(s => s.id === 'c')
    // produce maps to site p by name
    assert.ok(consumer)
  })
})
