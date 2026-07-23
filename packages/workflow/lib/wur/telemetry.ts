/**
 * Reconstruct path prefixes and frontiers from protocol event logs (Def 3.3).
 *
 * Per Remark 3.5: key site discovery on step_started (not step_created);
 * recover global invocation order by lexicographic sort of correlation ULIDs.
 */
import type { PathPrefix, ProtocolEvent, ProtocolRun, Site, StepGraph } from './types.ts'
import { topologicalOrder } from './graph.ts'

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
  /** Log order for stable secondary sort. */
  logIndex: number
}

/**
 * Extract ordered site occurrences from an event log.
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

    if (STEP_START.has(ev.eventType) && corr) {
      if (!byCorr.has(corr)) {
        byCorr.set(corr, {
          correlationId: corr,
          name: String(data.stepName ?? data.name ?? name),
          kind: 'step',
          completed: false,
          logIndex,
        })
      } else {
        // retry — keep first
        const o = byCorr.get(corr)!
        if (data.stepName) o.name = String(data.stepName)
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
      // Prefer result payload
      const result = data.result ?? data.output ?? data.error ?? data
      o.payload = result
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
      o.payload = data.payload ?? data
      byCorr.set(corr, o)
    }
    logIndex++
  }

  // Global invocation order: lexicographic ULID order (Remark 3.5)
  const occs = [...byCorr.values()]
  occs.sort((a, b) => {
    if (a.correlationId < b.correlationId) return -1
    if (a.correlationId > b.correlationId) return 1
    return a.logIndex - b.logIndex
  })
  return occs
}

/**
 * Map occurrence names onto G1 site ids by sequential label matching.
 * Repeated same-name sites consume successive graph sites with that label.
 */
export function mapOccurrencesToSites (
  occs: SiteOccurrence[],
  graph: StepGraph
): { siteIds: string[], frontier: string | null, payloads: Map<string, unknown>, correlationIds: string[] } {
  const order = topologicalOrder(graph)
  const siteById = new Map(graph.sites.map(s => [s.id, s]))
  const remaining = new Map<string, string[]>() // labelKey → site ids in order
  for (const id of order) {
    const s = siteById.get(id)!
    const key = `${s.label.kind}:${s.label.name}`
    if (!remaining.has(key)) remaining.set(key, [])
    remaining.get(key)!.push(id)
  }

  // Also allow matching by name only (kind may be inferred as step)
  const takeSite = (kind: string, name: string): string | null => {
    const key = `${kind}:${name}`
    const list = remaining.get(key)
    if (list && list.length) return list.shift()!
    // fallback: any kind with same name
    for (const [k, lst] of remaining) {
      if (k.endsWith(`:${name}`) && lst.length) return lst.shift()!
    }
    return null
  }

  const siteIds: string[] = []
  const payloads = new Map<string, unknown>()
  const correlationIds: string[] = []
  let frontier: string | null = null

  for (const o of occs) {
    const sid = takeSite(o.kind, o.name)
    if (!sid) {
      // Unknown site — still record for diagnostics via synthetic id
      continue
    }
    correlationIds.push(o.correlationId)
    if (o.completed) {
      siteIds.push(sid)
      if (o.payload !== undefined) payloads.set(sid, hydratePayload(o.payload))
    } else {
      // Pending — frontier is the first incomplete in invocation order
      if (frontier === null) frontier = sid
      // Incomplete sites after frontier stay pending (race losers)
    }
  }

  return { siteIds, frontier, payloads, correlationIds }
}

/**
 * Best-effort hydrate of devalue/JSON-ish payloads to plain objects for field checks.
 */
export function hydratePayload (raw: unknown): unknown {
  if (raw === null || raw === undefined) return raw
  if (typeof raw !== 'object') return raw
  // Already plain
  if (!Array.isArray(raw)) return raw
  // devalue-like flattened array is opaque — return as-is (unk for field checks)
  return raw
}

/**
 * Build PathPrefix for a run against G1.
 */
export function buildPrefix (run: ProtocolRun, graph: StepGraph): PathPrefix {
  const occs = extractOccurrences(run.events)
  const mapped = mapOccurrencesToSites(occs, graph)
  return {
    siteIds: mapped.siteIds,
    frontier: mapped.frontier,
    payloads: mapped.payloads,
    correlationIds: mapped.correlationIds,
  }
}

/**
 * Collect historical paths and payload stats from completed (+ optional in-flight) runs.
 */
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
    // Full path includes frontier if present for transition structure
    const path = prefix.frontier
      ? [...prefix.siteIds, prefix.frontier]
      : [...prefix.siteIds]
    historyPaths.push(prefix.siteIds.length ? prefix.siteIds : path)
    historyCompleted.push(run.status === 'completed' || prefix.frontier === null)
    for (const [sid, p] of prefix.payloads) addPayload(sid, p)
  }

  // Also fold in-flight payloads into Φ_v
  const inFlightPrefixes: Array<{ run: ProtocolRun, prefix: PathPrefix }> = []
  for (const run of inFlight) {
    const prefix = buildPrefix(run, graph)
    inFlightPrefixes.push({ run, prefix })
    for (const [sid, p] of prefix.payloads) addPayload(sid, p)
  }

  return { historyPaths, historyCompleted, historyPayloads, inFlightPrefixes }
}

/** Resolve a site by id. */
export function getSite (graph: StepGraph, id: string): Site | undefined {
  return graph.sites.find(s => s.id === id)
}
