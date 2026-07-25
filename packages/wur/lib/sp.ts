/**
 * Series–parallel step graphs and concurrency structure (Defs 3.2, 3.6).
 */
import type { ParallelGroup, ParallelGroupKind, Site, SiteKind, StepGraph } from './types.ts'

export type SPNode =
  | { type: 'site', siteId: string }
  | { type: 'seq', children: SPNode[] }
  | { type: 'par', kind: ParallelGroupKind, id: string, branches: SPNode[] }

/** Build adjacency and entry list from a StepGraph. */
export function graphAdjacency (graph: StepGraph): {
  sites: Map<string, Site>
  succ: Map<string, string[]>
  pred: Map<string, string[]>
  entries: string[]
} {
  const sites = new Map(graph.sites.map(s => [s.id, s]))
  const succ = new Map<string, string[]>()
  const pred = new Map<string, string[]>()
  for (const s of graph.sites) {
    succ.set(s.id, [])
    pred.set(s.id, [])
  }
  const entries: string[] = []
  for (const e of graph.edges) {
    if (e.from === null) {
      entries.push(e.to)
      continue
    }
    if (!succ.has(e.from)) succ.set(e.from, [])
    if (!pred.has(e.to)) pred.set(e.to, [])
    succ.get(e.from)!.push(e.to)
    pred.get(e.to)!.push(e.from)
  }
  return { sites, succ, pred, entries: [...new Set(entries)] }
}

/** Topological order (stable). */
export function topologicalOrder (graph: StepGraph): string[] {
  const { succ, pred, entries, sites } = graphAdjacency(graph)
  const indeg = new Map<string, number>()
  for (const id of sites.keys()) indeg.set(id, pred.get(id)?.length ?? 0)
  const queue = [...entries].sort()
  for (const id of sites.keys()) {
    if ((indeg.get(id) ?? 0) === 0 && !queue.includes(id)) queue.push(id)
  }
  queue.sort()
  const order: string[] = []
  const seen = new Set<string>()
  while (queue.length) {
    const u = queue.shift()!
    if (seen.has(u)) continue
    seen.add(u)
    order.push(u)
    for (const v of succ.get(u) ?? []) {
      const d = (indeg.get(v) ?? 1) - 1
      indeg.set(v, d)
      if (d === 0) queue.push(v)
    }
  }
  for (const id of sites.keys()) {
    if (!seen.has(id)) order.push(id)
  }
  return order
}

/**
 * Independence relation I: pairs on distinct branches of the same join-observed
 * parallel group (Def 3.6). Race groups contribute no independent pairs.
 */
export function independencePairs (graph: StepGraph): Set<string> {
  const pairs = new Set<string>()
  for (const g of graph.parallelGroups ?? []) {
    if (g.kind !== 'join') continue
    const branchSets = g.branches.map(b => new Set(flattenBranchIds(b, graph)))
    for (let i = 0; i < branchSets.length; i++) {
      for (let j = i + 1; j < branchSets.length; j++) {
        for (const a of branchSets[i]) {
          for (const b of branchSets[j]) {
            pairs.add(canonPair(a, b))
          }
        }
      }
    }
  }
  return pairs
}

function flattenBranchIds (branch: string[], graph: StepGraph): string[] {
  // Branch is list of site ids in that branch
  return branch
}

function canonPair (a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

export function areIndependent (a: string, b: string, I: Set<string>): boolean {
  return I.has(canonPair(a, b))
}

/**
 * Build a simple linear step graph (sequential SP form).
 */
export function linearGraph (
  sites: Array<{
    id: string
    name: string
    kind?: SiteKind
    fingerprint?: string
    outputFields?: string[]
    demandFields?: string[]
    consumesFrom?: string[]
    outputContract?: Record<string, string>
    demandContract?: Record<string, string>
  }>
): StepGraph {
  const nodes: Site[] = sites.map(s => ({
    id: s.id,
    label: { name: s.name, kind: s.kind ?? (s.name === 'sleep' ? 'timer' : 'step') },
    fingerprint: s.fingerprint,
    outputFields: s.outputFields,
    demandFields: s.demandFields,
    consumesFrom: s.consumesFrom,
    outputContract: s.outputContract,
    demandContract: s.demandContract,
  }))
  const edges: StepGraph['edges'] = []
  for (let i = 0; i < nodes.length; i++) {
    edges.push({ from: i === 0 ? null : nodes[i - 1].id, to: nodes[i].id })
  }
  return { sites: nodes, edges }
}

/**
 * Build a graph with a join-observed parallel section.
 * prefix → parallel(branches) → suffix
 */
export function parallelGraph (opts: {
  prefix?: Array<{ id: string, name: string, kind?: SiteKind }>
  branches: Array<Array<{ id: string, name: string, kind?: SiteKind }>>
  suffix?: Array<{ id: string, name: string, kind?: SiteKind }>
  groupId?: string
  kind?: ParallelGroupKind
}): StepGraph {
  const kind = opts.kind ?? 'join'
  const groupId = opts.groupId ?? 'par0'
  const sites: Site[] = []
  const edges: StepGraph['edges'] = []
  const add = (list: Array<{ id: string, name: string, kind?: SiteKind }>) => {
    for (const s of list) {
      sites.push({
        id: s.id,
        label: { name: s.name, kind: s.kind ?? 'step' },
      })
    }
  }
  const prefix = opts.prefix ?? []
  const suffix = opts.suffix ?? []
  add(prefix)
  for (const b of opts.branches) add(b)
  add(suffix)

  // Chain prefix
  for (let i = 0; i < prefix.length; i++) {
    edges.push({ from: i === 0 ? null : prefix[i - 1].id, to: prefix[i].id })
  }
  const forkFrom = prefix.length ? prefix[prefix.length - 1].id : null
  // Each branch starts after fork
  for (const b of opts.branches) {
    for (let i = 0; i < b.length; i++) {
      edges.push({
        from: i === 0 ? forkFrom : b[i - 1].id,
        to: b[i].id,
      })
    }
  }
  // Join into suffix
  if (suffix.length) {
    for (const b of opts.branches) {
      const last = b[b.length - 1]
      if (last) edges.push({ from: last.id, to: suffix[0].id })
    }
    if (opts.branches.length === 0) {
      edges.push({ from: forkFrom, to: suffix[0].id })
    }
    for (let i = 1; i < suffix.length; i++) {
      edges.push({ from: suffix[i - 1].id, to: suffix[i].id })
    }
  } else if (prefix.length === 0) {
    for (const b of opts.branches) {
      if (b[0]) edges.push({ from: null, to: b[0].id })
    }
  }

  const parallelGroups: ParallelGroup[] = [{
    id: groupId,
    kind,
    branches: opts.branches.map(b => b.map(s => s.id)),
  }]

  return { sites, edges, parallelGroups }
}

/** Position map for path-order checks. */
export function sitePositions (graph: StepGraph): Map<string, number> {
  return new Map(topologicalOrder(graph).map((id, i) => [id, i]))
}
