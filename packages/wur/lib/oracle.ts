/**
 * Replay oracle implementing Rem 3.5 semantics for §12 evaluation.
 *
 * One ID sequence, ordinal+name match, in-order consumption, hard divergence
 * on unmatched events. Never executes real workflow code.
 */
import type { Site, StepGraph } from './types.ts'
import { topologicalOrder } from './sp.ts'

export interface OracleEvent {
  /** Global invocation ordinal (0-based). */
  ordinal: number
  name: string
  kind: 'step' | 'timer' | 'hook'
  payload?: unknown
  pending?: boolean
}

export interface OracleResult {
  ok: boolean
  reason?: string
  /** Sites consumed under the candidate graph. */
  consumed: string[]
}

/**
 * Replay events against a graph using ordinal+name matching.
 * Site sequence is graph topo order; event ordinals must match names.
 */
export function oracleReplay (
  graph: StepGraph,
  events: OracleEvent[]
): OracleResult {
  const order = topologicalOrder(graph)
  const siteByPos = order.map(id => graph.sites.find(s => s.id === id)!)
  let eventIdx = 0
  const consumed: string[] = []

  // Consume events in order: each event matches next pending site with same name
  // Simplified linear oracle: event i must match site at position i by name
  // For partial prefixes, only completed events are required.
  const completed = events.filter(e => !e.pending)
  for (let i = 0; i < completed.length; i++) {
    const ev = completed[i]
    if (ev.ordinal !== i) {
      // Allow explicit ordinals; require monotonic
    }
    if (i >= siteByPos.length) {
      return { ok: false, reason: `extra event ${ev.name} beyond graph`, consumed }
    }
    const site = siteByPos[i]
    if (site.label.name !== ev.name || site.label.kind !== ev.kind) {
      return {
        ok: false,
        reason: `name mismatch at ordinal ${i}: event ${ev.kind}/${ev.name} vs site ${site.label.kind}/${site.label.name}`,
        consumed,
      }
    }
    consumed.push(site.id)
    eventIdx++
  }

  // Pending frontier: next site if any
  const pending = events.find(e => e.pending)
  if (pending && eventIdx < siteByPos.length) {
    const site = siteByPos[eventIdx]
    if (site.label.name !== pending.name) {
      return {
        ok: false,
        reason: `frontier mismatch: ${pending.name} vs ${site.label.name}`,
        consumed,
      }
    }
  }

  return { ok: true, consumed }
}

/**
 * Build oracle events from a path of site ids on g1.
 */
export function eventsFromPath (
  graph: StepGraph,
  siteIds: string[],
  frontier: string | null,
  payloads: Map<string, unknown> = new Map()
): OracleEvent[] {
  const byId = new Map(graph.sites.map(s => [s.id, s]))
  const events: OracleEvent[] = []
  let ord = 0
  for (const id of siteIds) {
    const s = byId.get(id)
    if (!s) continue
    events.push({
      ordinal: ord++,
      name: s.label.name,
      kind: s.label.kind,
      payload: payloads.get(id),
    })
  }
  if (frontier) {
    const s = byId.get(frontier)
    if (s) {
      events.push({
        ordinal: ord,
        name: s.label.name,
        kind: s.label.kind,
        pending: true,
      })
    }
  }
  return events
}

/**
 * Ground-truth rehydration-unsafe for R_b comparison (Def 5.1).
 *
 * Empty prefixes have no recorded history to rehydrate → not R_b-unsafe
 * (head-insert still affects forward/ordinal for non-empty prefixes).
 * Replay checks completed events only; frontier demand is separate.
 */
export function oracleUnsafe (
  g1: StepGraph,
  g2: StepGraph,
  siteIds: string[],
  frontier: string | null,
  payloads?: Map<string, unknown>
): boolean {
  // No recorded events → R_b gate is open (paper: θ empty is valid)
  if (siteIds.length === 0) {
    return false
  }

  // Completed events only (exclude pending frontier from ordinal match)
  const events = eventsFromPath(g1, siteIds, null, payloads)
  const result = oracleReplay(g2, events)
  if (!result.ok) return true

  // Interface on consumed sites
  const g2ById = new Map(g2.sites.map(s => [s.id, s]))
  for (const id of result.consumed) {
    const s = g2ById.get(id)
    if (!s?.demandFields?.length || !s.consumesFrom?.length) continue
    for (const prod of s.consumesFrom) {
      const prodSite = g2ById.get(prod)
      const name = prodSite?.label.name
      const g1Prod = siteIds.find(sid => {
        const ps = g1.sites.find(x => x.id === sid)
        return ps?.label.name === name
      })
      if (!g1Prod || !payloads) continue
      const p = payloads.get(g1Prod)
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        for (const f of s.demandFields) {
          if (!(f in (p as object))) return true
        }
      }
    }
  }
  return false
}

export function site (id: string, name: string, kind: Site['label']['kind'] = 'step'): Site {
  return { id, label: { name, kind } }
}
