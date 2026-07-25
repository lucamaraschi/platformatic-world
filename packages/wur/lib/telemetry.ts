/**
 * Reconstruct path prefixes and invocation-time stores from event logs
 * (Def 3.3, Rem 3.5, §5.1).
 */
import { hydrateEventData, asRecord } from './hydrate.ts'
import { topologicalOrder } from './sp.ts'
import type { PathPrefix, ProtocolEvent, ProtocolRun, Site, StepGraph } from './types.ts'

const STEP_START = new Set(['step_started', 'step_created', 'step_retrying'])
const STEP_DONE = new Set(['step_completed', 'step_failed'])
const WAIT_START = new Set(['wait_created', 'sleep_created'])
const WAIT_DONE = new Set(['wait_completed', 'sleep_completed'])
const HOOK_START = new Set(['hook_created'])
const HOOK_DONE = new Set(['hook_received', 'hook_disposed'])

interface SiteOccurrence {
  correlationId: string
  name: string
  kind: 'step' | 'timer' | 'hook'
  completed: boolean
  payload?: unknown
  logIndex: number
  /** True if this was a retry start. */
  isRetry?: boolean
}

/**
 * Extract ordered site occurrences — key on step_started (Rem 3.5).
 */
export function extractOccurrences (events: ProtocolEvent[]): SiteOccurrence[] {
  const byCorr = new Map<string, SiteOccurrence>()
  let logIndex = 0

  for (const ev of events) {
    const corr = ev.correlationId ?? null
    const data = (ev.eventData ?? {}) as Record<string, unknown>
    const name = String(
      data.stepName ?? data.name ?? data.hookName ?? data.waitId ?? corr ?? `anon_${logIndex}`
    )
    const hydrated = hydrateEventData(
      data.result ?? data.output ?? data.payload ?? data.error ?? data,
      ev.specVersion
    )

    if (STEP_START.has(ev.eventType) && corr) {
      const existing = byCorr.get(corr)
      if (!existing) {
        byCorr.set(corr, {
          correlationId: corr,
          name: String(data.stepName ?? data.name ?? name),
          kind: 'step',
          completed: false,
          logIndex,
          isRetry: ev.eventType === 'step_retrying',
        })
      } else {
        if (data.stepName) existing.name = String(data.stepName)
        if (ev.eventType === 'step_retrying') existing.isRetry = true
      }
    } else if (STEP_DONE.has(ev.eventType) && corr) {
      const o = byCorr.get(corr) ?? {
        correlationId: corr,
        name: String(data.stepName ?? data.name ?? name),
        kind: 'step' as const,
        completed: false,
        logIndex,
      }
      o.completed = true
      o.payload = hydrated.value
      if (data.stepName) o.name = String(data.stepName)
      byCorr.set(corr, o)
    } else if (WAIT_START.has(ev.eventType) && corr) {
      if (!byCorr.has(corr)) {
        byCorr.set(corr, {
          correlationId: corr,
          name: String(data.name ?? 'sleep'),
          kind: 'timer',
          completed: false,
          logIndex,
        })
      }
    } else if (WAIT_DONE.has(ev.eventType) && corr) {
      const o = byCorr.get(corr) ?? {
        correlationId: corr,
        name: 'sleep',
        kind: 'timer' as const,
        completed: false,
        logIndex,
      }
      o.completed = true
      byCorr.set(corr, o)
    } else if (HOOK_START.has(ev.eventType) && corr) {
      if (!byCorr.has(corr)) {
        byCorr.set(corr, {
          correlationId: corr,
          name: String(data.token ?? data.name ?? 'hook'),
          kind: 'hook',
          completed: false,
          logIndex,
        })
      }
    } else if (HOOK_DONE.has(ev.eventType) && corr) {
      const o = byCorr.get(corr) ?? {
        correlationId: corr,
        name: String(data.token ?? 'hook'),
        kind: 'hook' as const,
        completed: false,
        logIndex,
      }
      o.completed = true
      o.payload = hydrateEventData(data.payload ?? data, ev.specVersion).value
      byCorr.set(corr, o)
    }
    logIndex++
  }

  // Global invocation order: lexicographic ULID (Rem 3.5)
  const occs = [...byCorr.values()]
  occs.sort((a, b) => {
    if (a.correlationId < b.correlationId) return -1
    if (a.correlationId > b.correlationId) return 1
    return a.logIndex - b.logIndex
  })
  return occs
}

export function mapOccurrencesToSites (
  occs: SiteOccurrence[],
  graph: StepGraph
): {
    siteIds: string[]
    frontier: string | null
    payloads: Map<string, unknown>
    correlationIds: string[]
    invocationStore: Map<string, Map<string, unknown>>
  } {
  const order = topologicalOrder(graph)
  const siteById = new Map(graph.sites.map(s => [s.id, s]))
  const remaining = new Map<string, string[]>()
  for (const id of order) {
    const s = siteById.get(id)!
    const key = `${s.label.kind}:${s.label.name}`
    if (!remaining.has(key)) remaining.set(key, [])
    remaining.get(key)!.push(id)
  }

  const takeSite = (kind: string, name: string): string | null => {
    const key = `${kind}:${name}`
    const list = remaining.get(key)
    if (list && list.length) return list.shift()!
    for (const [k, lst] of remaining) {
      if (k.endsWith(`:${name}`) && lst.length) return lst.shift()!
    }
    return null
  }

  const siteIds: string[] = []
  const payloads = new Map<string, unknown>()
  const correlationIds: string[] = []
  const invocationStore = new Map<string, Map<string, unknown>>()
  let frontier: string | null = null
  // Running store of completed producer payloads in invocation order
  const liveStore = new Map<string, unknown>()

  for (const o of occs) {
    const sid = takeSite(o.kind, o.name)
    if (!sid) continue
    correlationIds.push(o.correlationId)

    // Snapshot store at this site's invocation
    const snap = new Map(liveStore)
    invocationStore.set(sid, snap)

    if (o.completed) {
      siteIds.push(sid)
      if (o.payload !== undefined) {
        payloads.set(sid, o.payload)
        liveStore.set(sid, o.payload)
      }
    } else if (frontier === null) {
      frontier = sid
    }
  }

  return { siteIds, frontier, payloads, correlationIds, invocationStore }
}

/** @deprecated use hydrateEventData */
export function hydratePayload (raw: unknown): unknown {
  return hydrateEventData(raw).value
}

export function buildPrefix (run: ProtocolRun, graph: StepGraph): PathPrefix {
  const occs = extractOccurrences(run.events)
  const mapped = mapOccurrencesToSites(occs, graph)
  return {
    siteIds: mapped.siteIds,
    frontier: mapped.frontier,
    payloads: mapped.payloads,
    correlationIds: mapped.correlationIds,
    invocationStore: mapped.invocationStore,
  }
}

export function collectTelemetry (
  history: ProtocolRun[],
  inFlight: ProtocolRun[],
  graph: StepGraph
): {
    historyPaths: string[][]
    historyCompleted: boolean[]
    historyPayloads: Map<string, unknown[]>
    inFlightPrefixes: Array<{ run: ProtocolRun, prefix: PathPrefix }>
  } {
  const historyPaths: string[][] = []
  const historyCompleted: boolean[] = []
  const historyPayloads = new Map<string, unknown[]>()

  const addPayload = (siteId: string, payload: unknown) => {
    if (!historyPayloads.has(siteId)) historyPayloads.set(siteId, [])
    historyPayloads.get(siteId)!.push(payload)
  }

  for (const run of history) {
    const prefix = buildPrefix(run, graph)
    historyPaths.push([...prefix.siteIds])
    historyCompleted.push(run.status === 'completed' || prefix.frontier === null)
    for (const [sid, p] of prefix.payloads) addPayload(sid, p)
  }

  const inFlightPrefixes: Array<{ run: ProtocolRun, prefix: PathPrefix }> = []
  for (const run of inFlight) {
    const prefix = buildPrefix(run, graph)
    inFlightPrefixes.push({ run, prefix })
    for (const [sid, p] of prefix.payloads) addPayload(sid, p)
  }

  return { historyPaths, historyCompleted, historyPayloads, inFlightPrefixes }
}

export function getSite (graph: StepGraph, id: string): Site | undefined {
  return graph.sites.find(s => s.id === id)
}

/** Field presence on hydrated record. */
export function recordHasFields (payload: unknown, fields: string[]): {
  ok: boolean
  missing: string[]
  unk: boolean
} {
  const h = hydrateEventData(payload)
  const rec = asRecord(h)
  if (!rec) {
    if (h.kind === 'opaque' || h.kind === 'map' || h.kind === 'date' || h.kind === 'set' || h.kind === 'array') {
      return { ok: false, missing: [], unk: true }
    }
    return { ok: false, missing: [...fields], unk: false }
  }
  const missing = fields.filter(f => !(f in rec) || rec[f] === undefined)
  return { ok: missing.length === 0, missing, unk: false }
}
