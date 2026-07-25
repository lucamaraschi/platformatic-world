/**
 * Mazurkiewicz trace equivalence and canonical normal forms (Def 3.7, Thm 7.3).
 */
import { areIndependent, independencePairs, topologicalOrder } from './sp.ts'
import type { StepGraph } from './types.ts'

/**
 * Canonical normal form of a prefix under ≡_I (Thm 7.3).
 *
 * Sequential regions preserve order; within join-observed parallel groups,
 * branch subsequences are ordered by fork invocation ordinal (protocol identity),
 * not completion order. Race groups have no independent pairs — order preserved.
 */
export function canonicalNormalForm (
  siteIds: string[],
  graph: StepGraph,
  /** Optional: correlation ids parallel to siteIds for invocation order within groups. */
  correlationIds?: string[]
): string[] {
  if (siteIds.length <= 1) return [...siteIds]
  const I = independencePairs(graph)
  if (I.size === 0) return [...siteIds]

  // Bubble-sort style: sort by repeatedly swapping adjacent independent pairs
  // into a unique normal order keyed by site id within independent sets,
  // but for join groups use branch invocation order from graph, not alpha id.
  const branchOrder = buildBranchInvocationOrder(graph)
  const invCorr = new Map<string, string>()
  if (correlationIds) {
    for (let i = 0; i < siteIds.length; i++) {
      if (correlationIds[i]) invCorr.set(siteIds[i], correlationIds[i])
    }
  }

  const arr = [...siteIds]
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < arr.length - 1; i++) {
      const a = arr[i]
      const b = arr[i + 1]
      if (!areIndependent(a, b, I)) continue
      // Normal order: lower branch invocation ordinal first; tie-break ULID/corr; then id
      if (shouldSwap(a, b, branchOrder, invCorr)) {
        arr[i] = b
        arr[i + 1] = a
        changed = true
      }
    }
  }
  return arr
}

function buildBranchInvocationOrder (graph: StepGraph): Map<string, number> {
  const order = new Map<string, number>()
  let n = 0
  // Global topo as baseline
  for (const id of topologicalOrder(graph)) {
    if (!order.has(id)) order.set(id, n++)
  }
  // Within each join group, assign branch order by source array order (fork order)
  for (const g of graph.parallelGroups ?? []) {
    if (g.kind !== 'join') continue
    let bo = 0
    for (const branch of g.branches) {
      for (const id of branch) {
        order.set(id, bo)
      }
      bo++
    }
  }
  return order
}

function shouldSwap (
  a: string,
  b: string,
  branchOrder: Map<string, number>,
  corr: Map<string, string>
): boolean {
  const ba = branchOrder.get(a) ?? 0
  const bb = branchOrder.get(b) ?? 0
  if (ba !== bb) return ba > bb
  const ca = corr.get(a)
  const cb = corr.get(b)
  if (ca !== undefined && cb !== undefined && ca !== cb) return ca > cb
  return a > b
}

/** Two prefixes are ≡_I-equivalent iff normal forms are equal. */
export function traceEquivalent (
  a: string[],
  b: string[],
  graph: StepGraph
): boolean {
  const na = canonicalNormalForm(a, graph)
  const nb = canonicalNormalForm(b, graph)
  if (na.length !== nb.length) return false
  return na.every((id, i) => id === nb[i])
}

/**
 * Hash for prefix bucketing (Prop 7.5): canonical form joined.
 */
export function prefixHash (
  siteIds: string[],
  graph: StepGraph,
  frontier: string | null,
  correlationIds?: string[]
): string {
  const norm = canonicalNormalForm(siteIds, graph, correlationIds)
  return `${norm.join(',')}|${frontier ?? ''}`
}
