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
