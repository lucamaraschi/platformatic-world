/**
 * Demand inference, differential-demand lemma, satisfiability gate (§4.1).
 */
import { coversDemand, fieldsToSchema, latticeCompare } from './lattice.ts'
import { normalizePredicate } from './match.ts'
import { topologicalOrder } from './sp.ts'
import type { ChangedSite, Matching, Site, StepGraph } from './types.ts'

export type UnkPriorMode = 'uninformative' | 'pessimistic'

/**
 * Classify change set Δ = Δ_P ∪ Δ_I ∪ Δ_M (Definition 4.2).
 */
export function classifyChanges (
  g1: StepGraph,
  g2: StepGraph,
  matching: Matching
): ChangedSite[] {
  const changes: ChangedSite[] = []
  const site1 = new Map(g1.sites.map(s => [s.id, s]))
  const site2 = new Map(g2.sites.map(s => [s.id, s]))

  for (const id of matching.unmatchedG1) {
    const s = site1.get(id)!
    changes.push({
      siteId: id,
      axis: 'protocol',
      reason: `site removed or reordered: ${s.label.kind}/${s.label.name}`,
      severity: 1,
    })
  }
  for (const id of matching.unmatchedG2) {
    const s = site2.get(id)!
    changes.push({
      siteId: id,
      axis: 'protocol',
      reason: `site inserted: ${s.label.kind}/${s.label.name}`,
      severity: 1,
      /** G2-only insert: forward hazard attaches at insertion ordinal in G1 */
      insertAfter: findInsertAnchor(g1, g2, matching, id),
    })
  }

  // Changed predicates on matched edges
  for (const [v1, v2] of matching.map) {
    const preds1 = g1.edges.filter(e => e.to === v1).map(e => normalizePredicate(e.predicate))
    const preds2 = g2.edges.filter(e => e.to === v2).map(e => normalizePredicate(e.predicate))
    if (preds1.length && preds2.length) {
      const p1 = [...preds1].sort().join('|')
      const p2 = [...preds2].sort().join('|')
      if (p1 !== p2) {
        changes.push({
          siteId: v1,
          axis: 'protocol',
          reason: `branch predicate changed at ${site1.get(v1)!.label.name}`,
          severity: 1,
        })
      }
    }
  }

  // Parallel group branch reorder → protocol
  const groups1 = new Map((g1.parallelGroups ?? []).map(g => [g.id, g]))
  const groups2 = new Map((g2.parallelGroups ?? []).map(g => [g.id, g]))
  for (const [gid, g] of groups1) {
    const g2g = groups2.get(gid)
    if (!g2g) continue
    if (g.kind !== g2g.kind) {
      changes.push({
        siteId: g.branches[0]?.[0] ?? gid,
        axis: 'protocol',
        reason: `parallel group ${gid} kind changed`,
        severity: 1,
      })
      continue
    }
    const orderA = g.branches.map(b => b.map(id => matching.map.get(id) ?? id).join(','))
    const orderB = g2g.branches.map(b => b.join(','))
    if (orderA.join(';') !== orderB.join(';')) {
      changes.push({
        siteId: g.branches[0]?.[0] ?? gid,
        axis: 'protocol',
        reason: `parallel/race branch reorder in group ${gid}`,
        severity: 1,
      })
    }
  }

  // Interface demand growth on G2 consumers
  const inv = new Map([...matching.map].map(([a, b]) => [b, a]))
  for (const s2 of g2.sites) {
    const demandFields = s2.demandFields ?? Object.keys(s2.demandContract ?? {})
    if (!demandFields.length) continue

    const producers = s2.consumesFrom?.length
      ? s2.consumesFrom
      : findPrecedingProducers(g2, s2.id)
    const cons1 = inv.get(s2.id)
    const consumerKey = cons1 ?? s2.id
    const oldDemand = new Set(
      cons1
        ? (site1.get(cons1)?.demandFields ?? Object.keys(site1.get(cons1)?.demandContract ?? {}))
        : []
    )
    const grown = demandFields.filter(f => !oldDemand.has(f))
    // Differential demand (Lem 4.5): if consumer slice unchanged, skip
    if (grown.length === 0 && cons1) continue
    if (cons1 && consumerSliceUnchanged(site1.get(cons1), s2) && grown.length === 0) continue

    const fields = grown.length > 0 ? grown : demandFields
    for (const prod2 of producers) {
      const prod1 = inv.get(prod2)
      if (!prod1) {
        changes.push({
          siteId: consumerKey,
          axis: 'interface',
          reason: `demand at ${s2.label.name} has no matched producer (unsatisfiable)`,
          severity: 1,
          demandFields: fields,
          producerSiteId: prod2,
          unsatisfiable: true,
        })
        continue
      }
      // Lattice check when contracts present
      const p1 = site1.get(prod1)
      const cSchema = s2.demandContract
        ? s2.demandContract
        : fieldsToSchema(fields)
      const pSchema = p1?.outputContract
        ? p1.outputContract
        : fieldsToSchema(p1?.outputFields ?? [])
      const rel = latticeCompare(pSchema, cSchema)
      if (rel === 'compatible' && coversDemand(p1?.outputFields, fields) && grown.length === 0) {
        continue
      }
      changes.push({
        siteId: consumerKey,
        axis: 'interface',
        reason: `consumer ${s2.label.name} demands fields: ${fields.join(', ')}`,
        severity: 1,
        demandFields: fields,
        producerSiteId: prod1,
      })
    }

    // Satisfiability: producer must certainly precede consumer in G2
    for (const prod2 of producers) {
      if (!certainlyPrecedes(g2, prod2, s2.id)) {
        changes.push({
          siteId: consumerKey,
          axis: 'interface',
          reason: `demand satisfiability: ${prod2} does not certainly precede ${s2.id} in G2`,
          severity: 1,
          demandFields: fields,
          producerSiteId: inv.get(prod2) ?? prod2,
          unsatisfiable: true,
        })
      }
    }
  }

  // Fingerprint-crossing: same label different fingerprint already affects LCS;
  // explicit check for matched same-label with fingerprint swap left as Δ_I
  for (const [v1, v2] of matching.map) {
    const s1 = site1.get(v1)!
    const s2 = site2.get(v2)!
    if (s1.fingerprint && s2.fingerprint && s1.fingerprint !== s2.fingerprint) {
      changes.push({
        siteId: v1,
        axis: 'interface',
        reason: `fingerprint-crossing match at ${s1.label.name}`,
        severity: 1,
      })
    }
  }

  // Dedup
  const seen = new Set<string>()
  const out: ChangedSite[] = []
  for (const c of changes) {
    const k = `${c.siteId}|${c.axis}|${c.reason}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(c)
  }
  return out
}

function consumerSliceUnchanged (s1: Site | undefined, s2: Site): boolean {
  if (!s1) return false
  const d1 = [...(s1.demandFields ?? [])].sort().join(',')
  const d2 = [...(s2.demandFields ?? [])].sort().join(',')
  return d1 === d2 && s1.label.name === s2.label.name
}

function findPrecedingProducers (graph: StepGraph, siteId: string): string[] {
  const order = topologicalOrder(graph)
  const idx = order.indexOf(siteId)
  if (idx <= 0) return []
  const siteMap = new Map(graph.sites.map(s => [s.id, s]))
  for (let i = idx - 1; i >= 0; i--) {
    const s = siteMap.get(order[i])
    if (s?.label.kind === 'step') return [order[i]]
  }
  return []
}

/** Producer certainly precedes consumer in graph topo order (same linear scope). */
export function certainlyPrecedes (graph: StepGraph, producer: string, consumer: string): boolean {
  const order = topologicalOrder(graph)
  const ip = order.indexOf(producer)
  const ic = order.indexOf(consumer)
  if (ip < 0 || ic < 0) return false
  return ip < ic
}

/**
 * Invocation gate: replay invokes consumer once all sites certainly preceding
 * it in G2 that V1 can produce have completed in the prefix.
 */
export function invocationGateOpen (
  g2: StepGraph,
  matching: Matching,
  consumerG2Id: string,
  completedG1Ids: string[]
): boolean {
  const order = topologicalOrder(g2)
  const ci = order.indexOf(consumerG2Id)
  if (ci < 0) return false
  const inv = new Map([...matching.map].map(([a, b]) => [b, a]))
  const completed = new Set(completedG1Ids)
  for (let i = 0; i < ci; i++) {
    const s2 = order[i]
    const s1 = inv.get(s2)
    if (s1 && !completed.has(s1)) return false
  }
  return true
}

function findInsertAnchor (
  g1: StepGraph,
  g2: StepGraph,
  matching: Matching,
  g2SiteId: string
): string | null {
  const order2 = topologicalOrder(g2)
  const idx = order2.indexOf(g2SiteId)
  if (idx <= 0) return null
  // nearest preceding matched site
  for (let i = idx - 1; i >= 0; i--) {
    for (const [v1, v2] of matching.map) {
      if (v2 === order2[i]) return v1
    }
  }
  return null
}
