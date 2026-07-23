/**
 * Step-graph operations: matching μ, change classification Δ (Defs 4.1–4.2).
 */
import type {
  ChangedSite,
  Matching,
  ParallelGroup,
  Site,
  SiteLabel,
  StepGraph,
} from './types.ts'

function labelKey (label: SiteLabel): string {
  return `${label.kind}:${label.name}`
}

function siteKey (site: Site): string {
  return site.fingerprint
    ? `${labelKey(site.label)}#${site.fingerprint}`
    : labelKey(site.label)
}

/** Topological order of site ids (entry-first). */
export function topologicalOrder (graph: StepGraph): string[] {
  const ids = new Set(graph.sites.map(s => s.id))
  const indeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const id of ids) {
    indeg.set(id, 0)
    adj.set(id, [])
  }
  for (const e of graph.edges) {
    if (e.from === null) continue
    if (!ids.has(e.from) || !ids.has(e.to)) continue
    adj.get(e.from)!.push(e.to)
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  }
  const queue: string[] = []
  for (const [id, d] of indeg) {
    if (d === 0) queue.push(id)
  }
  // Prefer sites with only null-from edges as starts
  const starts = new Set(
    graph.edges.filter(e => e.from === null).map(e => e.to)
  )
  queue.sort((a, b) => {
    const sa = starts.has(a) ? 0 : 1
    const sb = starts.has(b) ? 0 : 1
    return sa - sb || a.localeCompare(b)
  })
  const order: string[] = []
  const seen = new Set<string>()
  while (queue.length) {
    const u = queue.shift()!
    if (seen.has(u)) continue
    seen.add(u)
    order.push(u)
    for (const v of adj.get(u) ?? []) {
      const d = (indeg.get(v) ?? 1) - 1
      indeg.set(v, d)
      if (d === 0) queue.push(v)
    }
  }
  for (const id of ids) {
    if (!seen.has(id)) order.push(id)
  }
  return order
}

/** Linear site sequence for simple (non-branching) graphs. */
export function linearSequence (graph: StepGraph): string[] {
  return topologicalOrder(graph)
}

/**
 * Matching μ: pair sites by label+fingerprint preserving path order (Def 4.1).
 * Uses greedy longest common subsequence over linearizations for ordinal family.
 */
export function matchGraphs (g1: StepGraph, g2: StepGraph): Matching {
  const seq1 = topologicalOrder(g1)
  const seq2 = topologicalOrder(g2)
  const site1 = new Map(g1.sites.map(s => [s.id, s]))
  const site2 = new Map(g2.sites.map(s => [s.id, s]))

  // LCS on site keys
  const keys1 = seq1.map(id => siteKey(site1.get(id)!))
  const keys2 = seq2.map(id => siteKey(site2.get(id)!))
  const n = keys1.length
  const m = keys2.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = keys1[i - 1] === keys2[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const map = new Map<string, string>()
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (keys1[i - 1] === keys2[j - 1]) {
      map.set(seq1[i - 1], seq2[j - 1])
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }

  // Also check predicate equivalence on matched edges
  const unmatchedG1 = seq1.filter(id => !map.has(id))
  const matchedG2 = new Set(map.values())
  const unmatchedG2 = seq2.filter(id => !matchedG2.has(id))

  return { map, unmatchedG1, unmatchedG2 }
}

/**
 * Classify change set Δ = Δ_P ∪ Δ_I ∪ Δ_M (Definition 4.2).
 *
 * Interface demands may also be supplied on G2 sites (demandFields /
 * consumesFrom) so callers need not pre-build ChangedSite lists.
 */
export function classifyChanges (
  g1: StepGraph,
  g2: StepGraph,
  matching: Matching
): ChangedSite[] {
  const changes: ChangedSite[] = []
  const site1 = new Map(g1.sites.map(s => [s.id, s]))
  const site2 = new Map(g2.sites.map(s => [s.id, s]))

  // Protocol: unmatched sites in either graph
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
    // Insertions are protocol changes; position matters for prefix validity
    changes.push({
      siteId: id,
      axis: 'protocol',
      reason: `site inserted: ${s.label.kind}/${s.label.name}`,
      severity: 1,
    })
  }

  // Protocol: changed predicates on matched edges
  for (const [v1, v2] of matching.map) {
    const preds1 = g1.edges.filter(e => e.to === v1).map(e => e.predicate ?? '')
    const preds2 = g2.edges.filter(e => e.to === v2).map(e => e.predicate ?? '')
    // If any incoming predicate text differs, mark protocol change
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

  // Parallel group branch reorder → protocol (Def 3.6 / 4.1)
  const groups1 = indexParallel(g1.parallelGroups)
  const groups2 = indexParallel(g2.parallelGroups)
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
    // Map branch first sites through μ and compare order
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

  // Interface: demand growth on G2 consumers (keyed by G1 consumer for hitting probs)
  const inv = new Map([...matching.map].map(([a, b]) => [b, a]))
  for (const s2 of g2.sites) {
    if (!s2.demandFields?.length) continue
    const producers = s2.consumesFrom?.length
      ? s2.consumesFrom
      : findPrecedingProducers(g2, s2.id)
    const cons1 = inv.get(s2.id)
    // Prefer matched consumer id in G1 for forward hitting; fall back to G2 id
    const consumerKey = cons1 ?? s2.id
    const oldDemand = cons1
      ? new Set(site1.get(cons1)?.demandFields ?? [])
      : new Set<string>()
    const grown = s2.demandFields.filter(f => !oldDemand.has(f))
    if (grown.length === 0 && cons1) continue

    const demandFields = grown.length > 0 ? grown : s2.demandFields
    for (const prod2 of producers) {
      const prod1 = inv.get(prod2)
      if (!prod1) {
        changes.push({
          siteId: consumerKey,
          axis: 'interface',
          reason: `demand at ${s2.label.name} has no matched producer`,
          severity: 1,
          demandFields,
          producerSiteId: prod2,
        })
        continue
      }
      changes.push({
        siteId: consumerKey,
        axis: 'interface',
        reason: `consumer ${s2.label.name} demands fields: ${demandFields.join(', ')}`,
        severity: 1,
        demandFields,
        producerSiteId: prod1,
      })
    }
  }

  // Fingerprint-crossing swaps: same label matched but different fingerprint means
  // LCS may have paired wrong call sites — already handled by siteKey including fingerprint.

  // Deduplicate by siteId+axis+reason
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

function indexParallel (groups?: ParallelGroup[]): Map<string, ParallelGroup> {
  const m = new Map<string, ParallelGroup>()
  for (const g of groups ?? []) m.set(g.id, g)
  return m
}

/** Heuristic: preceding step sites on a linear path. */
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

/**
 * Prefix validity θ ⊑_μ G2 (Definition 5.1).
 *
 * For the ordinal-identity family: each recorded site must map under μ, and
 * the mapped sequence must be a path from entry in G2 with no unmatched
 * insertions *ahead of* the prefix (i.e. ordinals preserved).
 *
 * Tail insertions (after the prefix region) leave the prefix valid.
 * Head/mid insertions that shift ordinals before recorded events invalidate.
 */
export function isPrefixValid (
  prefixSiteIds: string[],
  g1: StepGraph,
  g2: StepGraph,
  matching: Matching
): { valid: boolean, reason?: string } {
  if (prefixSiteIds.length === 0) return { valid: true }

  // Every prefix site must be matched
  const mapped: string[] = []
  for (const id of prefixSiteIds) {
    const m = matching.map.get(id)
    if (!m) {
      return {
        valid: false,
        reason: `prefix site ${id} has no match in G2 (protocol change ahead of or on recorded history)`,
      }
    }
    mapped.push(m)
  }

  // Ordinal preservation: among the topological order of G1 and G2, the matched
  // sites that appear in the prefix region must keep relative positions such that
  // no unmatched G2 site is inserted *before* the last prefix site in G2 order
  // relative to the first prefix site's mapped position in a way that shifts ordinals.
  //
  // Concrete rule (paper Figure 1): count sites before each recorded event in G1
  // and G2 under μ. Insertion at head shifts all ordinals → invalid.
  // Insertion only after the longest common matched prefix region → valid.
  const order1 = topologicalOrder(g1)
  const order2 = topologicalOrder(g2)
  const inv = new Map([...matching.map].map(([a, b]) => [b, a]))

  // Positions of matched sites in both orders
  const pos1 = new Map(order1.map((id, i) => [id, i]))
  const pos2 = new Map(order2.map((id, i) => [id, i]))

  // For each consecutive pair in the prefix, verify order preserved in G2
  for (let i = 0; i < mapped.length; i++) {
    const v2 = mapped[i]
    if (!pos2.has(v2)) {
      return { valid: false, reason: `mapped site ${v2} missing from G2` }
    }
    if (i > 0) {
      if (pos2.get(mapped[i - 1])! > pos2.get(v2)!) {
        return { valid: false, reason: `prefix order violation in G2 at ${v2}` }
      }
    }
  }

  // Head-insertion check: any unmatched G2 site that appears before the first
  // mapped prefix site in G2 order, while corresponding unmatched G1 is empty
  // or later, shifts ordinals.
  const firstMapped = mapped[0]
  const firstPos2 = pos2.get(firstMapped)!
  const firstV1 = prefixSiteIds[0]
  const firstPos1 = pos1.get(firstV1) ?? 0

  // Sites in G1 before first prefix site
  const before1 = order1.slice(0, firstPos1)
  // Sites in G2 before first mapped site
  const before2 = order2.slice(0, firstPos2)

  // Count unmatched insertions before the prefix in G2
  const unmatchedBefore2 = before2.filter(id => !inv.has(id))
  // Sites that existed in G1 before prefix but were removed
  const removedBefore = before1.filter(id => !matching.map.has(id))

  if (unmatchedBefore2.length > 0 || removedBefore.length > 0) {
    // Any insertion/deletion before the first recorded site invalidates ordinals.
    // Equal counts without label-preserving renames are still treated conservatively.
    return {
      valid: false,
      reason: 'sites inserted or removed before recorded prefix (ordinal shift)',
    }
  }

  // Mid-insertion: between consecutive prefix sites, G2 must not introduce
  // unmatched sites that weren't between them in G1 (ordinal shift for later events).
  for (let i = 1; i < mapped.length; i++) {
    const a2 = pos2.get(mapped[i - 1])!
    const b2 = pos2.get(mapped[i])!
    const a1 = pos1.get(prefixSiteIds[i - 1])!
    const b1 = pos1.get(prefixSiteIds[i])!
    const between2 = order2.slice(a2 + 1, b2).filter(id => !inv.has(id))
    const between1 = order1.slice(a1 + 1, b1).filter(id => !matching.map.has(id))
    if (between2.length > 0 || between1.length > 0) {
      return {
        valid: false,
        reason: `sites inserted/removed between prefix sites ${prefixSiteIds[i - 1]} and ${prefixSiteIds[i]}`,
      }
    }
  }

  return { valid: true }
}

/** Build a simple linear step graph from ordered site descriptors. */
export function linearGraph (
  sites: Array<{
    id: string
    name: string
    kind?: SiteKindLike
    fingerprint?: string
    outputFields?: string[]
    demandFields?: string[]
    consumesFrom?: string[]
  }>
): StepGraph {
  const nodes: Site[] = sites.map(s => ({
    id: s.id,
    label: { name: s.name, kind: (s.kind ?? 'step') as Site['label']['kind'] },
    fingerprint: s.fingerprint,
    outputFields: s.outputFields,
    demandFields: s.demandFields,
    consumesFrom: s.consumesFrom,
  }))
  const edges: StepGraph['edges'] = []
  for (let i = 0; i < nodes.length; i++) {
    edges.push({
      from: i === 0 ? null : nodes[i - 1].id,
      to: nodes[i].id,
    })
  }
  return { sites: nodes, edges }
}

type SiteKindLike = 'step' | 'timer' | 'hook'
