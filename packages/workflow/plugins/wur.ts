/**
 * WUR API — score upgrade risk for in-flight runs when moving V1 → V2.
 *
 * POST /api/v1/apps/:appId/upgrade-risk
 *   Body: { g1, g2, deploymentId, workflowName?, changes?, options? }
 *   Loads history + in-flight telemetry from Postgres and runs Algorithm 1.
 */
import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { BadRequest } from '../lib/errors.ts'
import {
  analyzeUpgradeRisk,
  type AnalyzeOptions,
  type ChangedSite,
  type ProtocolEvent,
  type ProtocolRun,
  type StepGraph,
} from '../lib/wur/index.ts'

function decodeEventData (buf: Buffer | null): unknown {
  if (buf === null) return undefined
  if (buf[0] === 0x7b || buf[0] === 0x5b || buf[0] === 0x22) {
    try {
      return JSON.parse(buf.toString('utf-8'))
    } catch {
      // fall through
    }
  }
  // Opaque binary (devalue/cbor) — return base64 placeholder; field checks → unk
  return { __opaque: true, base64: buf.toString('base64') }
}

async function loadRuns (
  app: FastifyInstance,
  appId: number,
  workflowName: string | undefined,
  deploymentId: string,
  statuses: string[]
): Promise<ProtocolRun[]> {
  const conditions = ['r.application_id = $1', 'r.deployment_id = $2']
  const params: unknown[] = [appId, deploymentId]
  let idx = 3
  if (workflowName) {
    conditions.push(`r.workflow_name = $${idx++}`)
    params.push(workflowName)
  }
  conditions.push(`r.status = ANY($${idx++}::text[])`)
  params.push(statuses)

  const runResult = await app.pg.query(
    `SELECT r.id, r.workflow_name, r.deployment_id, r.status
     FROM workflow_runs r
     WHERE ${conditions.join(' AND ')}
     ORDER BY r.created_at DESC
     LIMIT 5000`,
    params
  )

  const runs: ProtocolRun[] = []
  for (const row of runResult.rows) {
    const evResult = await app.pg.query(
      `SELECT event_type, correlation_id, event_data, created_at
       FROM workflow_events
       WHERE run_id = $1 AND application_id = $2
       ORDER BY id ASC`,
      [row.id, appId]
    )
    const events: ProtocolEvent[] = evResult.rows.map((e: {
      event_type: string
      correlation_id: string | null
      event_data: Buffer | null
      created_at: Date
    }) => ({
      eventType: e.event_type,
      correlationId: e.correlation_id,
      eventData: decodeEventData(e.event_data),
      createdAt: e.created_at,
    }))
    runs.push({
      runId: row.id,
      workflowName: row.workflow_name,
      deploymentId: row.deployment_id,
      status: row.status,
      events,
    })
  }
  return runs
}

async function wurPlugin (app: FastifyInstance): Promise<void> {
  app.post('/api/v1/apps/:appId/upgrade-risk', async (request) => {
    const body = request.body as {
      g1?: StepGraph
      g2?: StepGraph
      deploymentId?: string
      /** Candidate deployment (metadata only; graphs carry structure). */
      targetDeploymentId?: string
      workflowName?: string
      changes?: ChangedSite[]
      options?: AnalyzeOptions
      /** Optional inline runs (bypass DB) for offline analysis. */
      history?: ProtocolRun[]
      inFlight?: ProtocolRun[]
    }

    if (!body.g1 || !body.g2) {
      throw new BadRequest('g1 and g2 step graphs are required')
    }
    if (!Array.isArray(body.g1.sites) || !Array.isArray(body.g2.sites)) {
      throw new BadRequest('g1.sites and g2.sites must be arrays')
    }

    let history: ProtocolRun[]
    let inFlight: ProtocolRun[]

    if (body.history && body.inFlight) {
      history = body.history
      inFlight = body.inFlight
    } else {
      if (!body.deploymentId) {
        throw new BadRequest('deploymentId is required when history/inFlight are not provided')
      }
      const appId = request.appId
      history = await loadRuns(app, appId, body.workflowName, body.deploymentId, ['completed', 'failed'])
      inFlight = await loadRuns(app, appId, body.workflowName, body.deploymentId, ['pending', 'running'])
    }

    const result = analyzeUpgradeRisk({
      g1: body.g1,
      g2: body.g2,
      history,
      inFlight,
      changes: body.changes,
      options: body.options,
    })

    return {
      ...result,
      meta: {
        historyCount: history.length,
        inFlightCount: inFlight.length,
        deploymentId: body.deploymentId,
        targetDeploymentId: body.targetDeploymentId,
        workflowName: body.workflowName,
        paper: 'arXiv:2607.13617',
      },
    }
  })

  /** Pure scoring endpoint — no DB; caller supplies all telemetry. */
  app.post('/api/v1/upgrade-risk/analyze', async (request) => {
    const body = request.body as {
      g1?: StepGraph
      g2?: StepGraph
      history?: ProtocolRun[]
      inFlight?: ProtocolRun[]
      changes?: ChangedSite[]
      options?: AnalyzeOptions
    }
    if (!body.g1 || !body.g2) {
      throw new BadRequest('g1 and g2 step graphs are required')
    }
    if (!body.history || !body.inFlight) {
      throw new BadRequest('history and inFlight arrays are required')
    }
    return analyzeUpgradeRisk({
      g1: body.g1,
      g2: body.g2,
      history: body.history,
      inFlight: body.inFlight,
      changes: body.changes,
      options: body.options,
    })
  })
}

export default fp(wurPlugin, { name: 'wur', dependencies: ['auth', 'db'] })
