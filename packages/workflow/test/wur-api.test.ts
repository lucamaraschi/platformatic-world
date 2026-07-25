/**
 * WUR HTTP plugin integration (service loads @platformatic/wur).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { linearGraph } from '@platformatic/wur'
import { setupTest, teardownTest, type TestContext } from './helper.ts'

function linearSites (names: string[]) {
  return linearGraph(names.map(name => ({ id: name, name })))
}

function ulidAt (seq: number): string {
  return `01ARZ3NDEKTSV4RRFFQ69G${String(seq).padStart(5, '0')}`
}

describe('WUR API', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('POST /api/v1/upgrade-risk/analyze returns partition', async () => {
    const g1 = linearSites(['validate', 'charge'])
    const g2 = linearSites(['validate', 'charge', 'audit'])
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/upgrade-risk/analyze',
      payload: {
        g1,
        g2,
        history: [
          {
            runId: 'h1',
            workflowName: 'orderFlow',
            deploymentId: 'v1',
            status: 'completed',
            events: [
              { eventType: 'step_started', correlationId: ulidAt(1), eventData: { stepName: 'validate' } },
              { eventType: 'step_completed', correlationId: ulidAt(1), eventData: { stepName: 'validate', result: {} } },
              { eventType: 'step_started', correlationId: ulidAt(2), eventData: { stepName: 'charge' } },
              { eventType: 'step_completed', correlationId: ulidAt(2), eventData: { stepName: 'charge', result: {} } },
            ],
          },
        ],
        inFlight: [
          {
            runId: 'r1',
            workflowName: 'orderFlow',
            deploymentId: 'v1',
            status: 'running',
            events: [
              { eventType: 'step_started', correlationId: ulidAt(1), eventData: { stepName: 'validate' } },
              { eventType: 'step_completed', correlationId: ulidAt(1), eventData: { stepName: 'validate', result: {} } },
              { eventType: 'step_started', correlationId: ulidAt(2), eventData: { stepName: 'charge' } },
            ],
          },
        ],
        options: { tauLo: 0.1, tauHi: 0.5 },
      },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.ok(Array.isArray(body.runs))
    assert.equal(body.runs.length, 1)
    assert.equal(body.runs[0].backwardRisk, 0)
    assert.ok(body.partition)
  })

  it('POST /api/v1/apps/:appId/upgrade-risk loads telemetry from DB', async () => {
    const appId = ctx.appId
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/runs/seed-run/events`,
      payload: {
        eventType: 'run_created',
        eventData: {
          workflowName: 'orderFlow',
          deploymentId: 'dep-v1',
          input: Buffer.from('{}').toString('base64'),
        },
      },
    })
    await ctx.app.pg.query(
      `UPDATE workflow_runs SET status = 'completed', completed_at = NOW()
       WHERE id = 'seed-run'`
    )

    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/runs/live-run/events`,
      payload: {
        eventType: 'run_created',
        eventData: {
          workflowName: 'orderFlow',
          deploymentId: 'dep-v1',
          input: Buffer.from('{}').toString('base64'),
        },
      },
    })
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/runs/live-run/events`,
      payload: {
        eventType: 'step_started',
        correlationId: ulidAt(1),
        eventData: { stepName: 'validate' },
      },
    })
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/runs/live-run/events`,
      payload: {
        eventType: 'step_completed',
        correlationId: ulidAt(1),
        eventData: { stepName: 'validate', result: { ok: true } },
      },
    })
    await ctx.app.pg.query(
      'UPDATE workflow_runs SET status = \'running\' WHERE id = \'live-run\''
    )

    const g1 = linearSites(['validate', 'charge'])
    const g2 = linearSites(['validate', 'charge'])
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/upgrade-risk`,
      payload: {
        g1,
        g2,
        deploymentId: 'dep-v1',
        workflowName: 'orderFlow',
        options: { tauLo: 0.1, tauHi: 0.5 },
      },
    })
    assert.equal(res.statusCode, 200, String(res.body))
    const body = res.json()
    assert.equal(body.meta.paper, 'arXiv:2607.13617')
    assert.ok(body.meta.inFlightCount >= 1)
    assert.ok(Array.isArray(body.runs))
  })
})
