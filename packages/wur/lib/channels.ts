/**
 * Mixed-version channel risk and coupling graph construction (§10.1–10.3).
 */
import { clamp01, distributionalInterfaceRisk } from './contracts.ts'
import type { ProtocolRun } from './types.ts'
import type { CouplingEdge } from './coupling.ts'

export type ChannelKind = 'signal' | 'hierarchy' | 'resource'

export interface Channel {
  id: string
  kind: ChannelKind
  from: string
  to: string
  /** Interface demand fields on reader side. */
  demandFields?: string[]
  payloads?: unknown[]
}

/**
 * Build coupling edges from protocol telemetry (tier 1) + optional co-occurrence.
 */
export function buildCouplingGraph (
  runs: ProtocolRun[],
  options: {
    /** Infinite penalty for hierarchy/saga (must-move-together). */
    hardHierarchy?: boolean
    coOccurrenceMin?: number
    resourceTransmission?: number
    resourcePenalty?: number
  } = {}
): CouplingEdge[] {
  const hard = options.hardHierarchy !== false
  const edges: CouplingEdge[] = []
  const byId = new Map(runs.map(r => [r.runId, r]))

  // Hierarchy / explicit coupling
  for (const r of runs) {
    for (const other of r.coupledRunIds ?? []) {
      if (!byId.has(other)) continue
      edges.push({
        from: r.runId,
        to: other,
        transmission: 1,
        channelPenalty: hard ? Number.POSITIVE_INFINITY : 1,
      })
      edges.push({
        from: other,
        to: r.runId,
        transmission: 1,
        channelPenalty: hard ? Number.POSITIVE_INFINITY : 1,
      })
    }
  }

  // Protocol signal edges: shared hook tokens across runs
  const tokenOwners = new Map<string, string[]>()
  for (const r of runs) {
    for (const ev of r.events) {
      if (ev.eventType === 'hook_created' || ev.eventType === 'hook_received') {
        const data = (ev.eventData ?? {}) as Record<string, unknown>
        const token = String(data.token ?? ev.correlationId ?? '')
        if (!token) continue
        if (!tokenOwners.has(token)) tokenOwners.set(token, [])
        tokenOwners.get(token)!.push(r.runId)
      }
    }
  }
  for (const [, owners] of tokenOwners) {
    const uniq = [...new Set(owners)]
    if (uniq.length < 2) continue
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        edges.push({
          from: uniq[i],
          to: uniq[j],
          transmission: 1,
          channelPenalty: 1,
        })
        edges.push({
          from: uniq[j],
          to: uniq[i],
          transmission: 1,
          channelPenalty: 1,
        })
      }
    }
  }

  // Tier 2: resource fingerprints (tables, queues, endpoints) with write mode
  const resourceEdges = buildResourceFingerprintEdges(runs, {
    transmission: options.resourceTransmission ?? 0.7,
    channelPenalty: options.resourcePenalty ?? 0.5,
  })
  edges.push(...resourceEdges)

  // Key co-occurrence (tier 3): shared primitive id-like fields
  const minCo = options.coOccurrenceMin ?? 2
  const keyRuns = new Map<string, Set<string>>()
  for (const r of runs) {
    for (const ev of r.events) {
      const keys = extractEntityKeys(ev.eventData)
      for (const k of keys) {
        if (!keyRuns.has(k)) keyRuns.set(k, new Set())
        keyRuns.get(k)!.add(r.runId)
      }
    }
  }
  for (const [, rs] of keyRuns) {
    if (rs.size < minCo) continue
    const ids = [...rs]
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        edges.push({
          from: ids[i],
          to: ids[j],
          transmission: 0.3,
          channelPenalty: 0.2,
        })
      }
    }
  }

  return dedupeEdges(edges)
}

export interface ResourceTouch {
  resource: string
  mode: 'read' | 'write' | 'unknown'
}

/**
 * Extract resource fingerprints from event/step payloads and attributes.
 * Looks for:
 *   - explicit resourceFingerprint / resources arrays
 *   - span-like attributes: db.table, messaging.destination, http.url, queue
 *   - common keys: table, queue, topic, endpoint, bucket
 */
export function extractResourceTouches (eventData: unknown): ResourceTouch[] {
  const out: ResourceTouch[] = []
  if (eventData == null || typeof eventData !== 'object') return out
  const obj = eventData as Record<string, unknown>

  // Explicit SDK-style annotations
  if (Array.isArray(obj.resourceFingerprint)) {
    for (const r of obj.resourceFingerprint) {
      if (typeof r === 'string') out.push({ resource: r, mode: 'unknown' })
      else if (r && typeof r === 'object') {
        const rr = r as Record<string, unknown>
        out.push({
          resource: String(rr.name ?? rr.id ?? rr.resource ?? ''),
          mode: rr.mode === 'write' || rr.mode === 'read' ? rr.mode : 'unknown',
        })
      }
    }
  }
  if (Array.isArray(obj.resources)) {
    for (const r of obj.resources) {
      if (typeof r === 'string') out.push({ resource: `res:${r}`, mode: 'unknown' })
    }
  }

  // Nested attributes (OTEL-style)
  const attrs = (obj.attributes ?? obj.attrs ?? obj.spanAttributes ?? obj) as Record<string, unknown>
  const pairs: Array<[string, string, ResourceTouch['mode']]> = [
    ['db.table', 'table', 'write'],
    ['db.sql.table', 'table', 'write'],
    ['messaging.destination', 'queue', 'write'],
    ['messaging.kafka.topic', 'topic', 'write'],
    ['http.url', 'http', 'read'],
    ['http.target', 'http', 'read'],
    ['table', 'table', guessMode(obj)],
    ['queue', 'queue', guessMode(obj)],
    ['topic', 'topic', guessMode(obj)],
    ['endpoint', 'http', 'read'],
    ['bucket', 'bucket', guessMode(obj)],
  ]
  for (const [key, kind, mode] of pairs) {
    const v = attrs[key]
    if (typeof v === 'string' && v.length > 0) {
      out.push({ resource: `${kind}:${v}`, mode })
    }
  }

  // Walk result payload for nested resource hints
  const result = obj.result
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    out.push(...extractResourceTouches(result))
  }

  return out.filter(t => t.resource.length > 0)
}

function guessMode (obj: Record<string, unknown>): ResourceTouch['mode'] {
  const m = obj.mode ?? obj.accessMode ?? obj.op
  if (m === 'write' || m === 'read') return m
  if (typeof obj.eventType === 'string' && /write|insert|update|delete|publish/i.test(obj.eventType)) {
    return 'write'
  }
  return 'unknown'
}

/**
 * Tier-2 resource edges: runs that share a resource with at least one write.
 */
export function buildResourceFingerprintEdges (
  runs: ProtocolRun[],
  opts: { transmission?: number, channelPenalty?: number } = {}
): CouplingEdge[] {
  const transmission = opts.transmission ?? 0.7
  const channelPenalty = opts.channelPenalty ?? 0.5
  // resource → { runId, modes }
  const map = new Map<string, Map<string, Set<ResourceTouch['mode']>>>()

  for (const r of runs) {
    for (const ev of r.events) {
      for (const t of extractResourceTouches(ev.eventData)) {
        if (!map.has(t.resource)) map.set(t.resource, new Map())
        const runModes = map.get(t.resource)!
        if (!runModes.has(r.runId)) runModes.set(r.runId, new Set())
        runModes.get(r.runId)!.add(t.mode)
      }
    }
  }

  const edges: CouplingEdge[] = []
  for (const [, runModes] of map) {
    const ids = [...runModes.keys()]
    if (ids.length < 2) continue
    // Require at least one writer among the set
    const hasWrite = [...runModes.values()].some(modes =>
      modes.has('write') || modes.has('unknown')
    )
    if (!hasWrite) continue
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        edges.push({
          from: ids[i],
          to: ids[j],
          transmission,
          channelPenalty,
        })
        edges.push({
          from: ids[j],
          to: ids[i],
          transmission,
          channelPenalty,
        })
      }
    }
  }
  return edges
}

function extractEntityKeys (data: unknown, path = ''): string[] {
  if (data === null || data === undefined) return []
  if (typeof data === 'string' && data.length >= 8 && data.length <= 64) {
    if (/^[a-zA-Z0-9_-]+$/.test(data)) return [`str:${data}`]
  }
  if (typeof data !== 'object') return []
  if (Array.isArray(data)) {
    return data.flatMap((x, i) => extractEntityKeys(x, `${path}[${i}]`))
  }
  const out: string[] = []
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (['id', 'orderId', 'accountId', 'userId', 'runId', 'token'].includes(k) && typeof v === 'string') {
      out.push(`${k}:${v}`)
    }
    out.push(...extractEntityKeys(v, `${path}.${k}`))
  }
  return out
}

function dedupeEdges (edges: CouplingEdge[]): CouplingEdge[] {
  const m = new Map<string, CouplingEdge>()
  for (const e of edges) {
    const k = `${e.from}->${e.to}`
    const prev = m.get(k)
    if (!prev) {
      m.set(k, e)
      continue
    }
    m.set(k, {
      from: e.from,
      to: e.to,
      transmission: Math.max(prev.transmission, e.transmission),
      channelPenalty: Math.max(
        Number.isFinite(prev.channelPenalty) ? prev.channelPenalty : 1e12,
        Number.isFinite(e.channelPenalty) ? e.channelPenalty : 1e12
      ) >= 1e12
        ? Number.POSITIVE_INFINITY
        : Math.max(prev.channelPenalty, e.channelPenalty),
    })
  }
  return [...m.values()]
}

/**
 * Mixed-window channel penalty π_c(a) = 1 − exp(−λ T ρ_×) (Eq 11).
 */
export function mixedWindowPenalty (opts: {
  eventRate: number
  overlapDuration: number
  crossVersionIncompat: number
}): number {
  const { eventRate, overlapDuration, crossVersionIncompat } = opts
  return clamp01(1 - Math.exp(-eventRate * overlapDuration * crossVersionIncompat))
}

/**
 * Estimate event rate λ from inter-event times (mean of exponential / Gamma).
 */
export function estimateEventRate (timestamps: number[]): number {
  if (timestamps.length < 2) return 0
  const sorted = [...timestamps].sort((a, b) => a - b)
  let sum = 0
  for (let i = 1; i < sorted.length; i++) sum += sorted[i] - sorted[i - 1]
  const meanGap = sum / (sorted.length - 1)
  if (meanGap <= 0) return 0
  return 1 / meanGap
}

/**
 * Cross-version interface incompatibility on a channel (Eq 10).
 */
export function channelInterfaceRisk (
  payloads: unknown[],
  demandFields: string[]
): number {
  return distributionalInterfaceRisk(payloads, demandFields)
}
