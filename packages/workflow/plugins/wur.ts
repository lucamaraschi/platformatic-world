/**
 * WUR API — score upgrade risk + calibration incident feed.
 *
 * POST /api/v1/apps/:appId/upgrade-risk
 * POST /api/v1/upgrade-risk/analyze
 * POST /api/v1/apps/:appId/upgrade-risk/calibration  — record release outcomes
 * GET  /api/v1/apps/:appId/upgrade-risk/calibration  — inspect posteriors
 */
import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { BadRequest } from '../lib/errors.ts'
import {
  analyzeUpgradeRisk,
  classesFromAnnotations,
  defaultCalibrationStore,
  hydrateEventData,
  recordReleaseOutcome,
  type AnalyzeOptions,
  type ChangeClass,
  type ChangedSite,
  type ProtocolEvent,
  type ProtocolRun,
  type StepGraph,
} from '../lib/wur/index.ts'

/**
 * Decode event_data BYTEA for WUR: keep Buffer so hydrate/devalue can run.
 * Also attach a pre-hydrated view on result when nested in event envelopes.
 */
function decodeEventData (buf: Buffer | null): unknown {
  if (buf === null) return undefined
  // JSON envelopes (step_completed with JSON eventData wrapper)
  if (buf[0] === 0x7b || buf[0] === 0x5b || buf[0] === 0x22) {
    try {
      const obj = JSON.parse(buf.toString('utf-8')) as Record<string, unknown>
      // Hydrate nested result/output if base64 or still binary-looking
      if (obj && typeof obj === 'object') {
        for (const key of ['result', 'output', 'payload', 'input']) {
          if (typeof obj[key] === 'string') {
            const h = hydrateEventData(obj[key])
            if (h.recordInspectable || h.kind === 'primitive' || h.kind === 'array') {
              obj[key] = h.value
            }
          }
        }
      }
      return obj
    } catch {
      // fall through to binary hydrate
    }
  }
  // Binary: pass Buffer; telemetry.hydrateEventData uses devalue on devl prefix
  const h = hydrateEventData(buf)
  if (h.kind === 'encrypted') {
    return { __opaque: true, encrypted: true }
  }
  if (h.kind !== 'opaque') {
    // For step events that are pure payload blobs, wrap as result
    return h.value
  }
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
      `SELECT event_type, correlation_id, event_data, created_at, spec_version
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
      spec_version: number | null
    }) => {
      const eventData = decodeEventData(e.event_data)
      // If pure payload (not an envelope), wrap for step_completed shape
      let data = eventData
      if (
        eventData !== undefined &&
        (e.event_type === 'step_completed' || e.event_type === 'step_failed') &&
        (typeof eventData !== 'object' || eventData === null ||
          (!('result' in (eventData as object)) && !('stepName' in (eventData as object))))
      ) {
        data = { result: eventData }
      }
      return {
        eventType: e.event_type,
        correlationId: e.correlation_id,
        eventData: data,
        createdAt: e.created_at,
        specVersion: e.spec_version,
      }
    })
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
      targetDeploymentId?: string
      workflowName?: string
      changes?: ChangedSite[]
      options?: AnalyzeOptions
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

  /**
   * Record a release outcome for severity calibration (§6.4).
   * Body: {
   *   changeClasses?: ChangeClass[],  // explicit
   *   annotations?: { axis, reason }[], // or infer from last WUR annotations
   *   incident?: boolean,
   *   exposures?: number  // default 1
   * }
   */
  app.post('/api/v1/apps/:appId/upgrade-risk/calibration', async (request) => {
    const body = request.body as {
      changeClasses?: ChangeClass[]
      annotations?: Array<{ axis: string, reason: string }>
      incident?: boolean
      exposures?: number
    }
    const appIdStr = String((request.params as { appId: string }).appId ?? request.appId ?? '')

    let classes = body.changeClasses
    if ((!classes || classes.length === 0) && body.annotations?.length) {
      classes = classesFromAnnotations(body.annotations)
    }
    if (!classes || classes.length === 0) {
      throw new BadRequest('changeClasses or annotations required')
    }

    const n = Math.max(1, body.exposures ?? 1)
    for (let i = 0; i < n; i++) {
      recordReleaseOutcome({
        appId: appIdStr,
        changeClasses: classes,
        incident: body.incident === true,
        store: defaultCalibrationStore,
      })
    }

    const posteriors = Object.fromEntries(
      classes.map(c => [c, defaultCalibrationStore.calibrate(c, appIdStr)])
    )
    return { recorded: true, changeClasses: classes, posteriors }
  })

  app.get('/api/v1/apps/:appId/upgrade-risk/calibration', async (request) => {
    const appIdStr = String((request.params as { appId: string }).appId ?? request.appId ?? '')
    const classes: ChangeClass[] = [
      'body-only', 'demand-growth', 'insert-step', 'insert-timer', 'delete-site',
      'swap-sites', 'parallel-reorder', 'predicate-change', 'predicate-refactor',
      'migration', 'unknown',
    ]
    const fleet = Object.fromEntries(classes.map(c => [c, defaultCalibrationStore.calibrate(c)]))
    const app = Object.fromEntries(classes.map(c => [c, defaultCalibrationStore.calibrate(c, appIdStr)]))
    return {
      fleet,
      app,
      store: defaultCalibrationStore.toJSON(),
      paper: 'arXiv:2607.13617 §6.4',
    }
  })
}

export default fp(wurPlugin, { name: 'wur', dependencies: ['auth', 'db'] })
