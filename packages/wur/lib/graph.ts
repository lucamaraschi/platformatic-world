/**
 * Step-graph facade — re-exports SP, match, demand, prefix (Defs 3–4).
 */
export { linearGraph, parallelGraph, topologicalOrder, independencePairs } from './sp.ts'
export { matchGraphs, normalizePredicate } from './match.ts'
export { classifyChanges, certainlyPrecedes, invocationGateOpen } from './demand.ts'
export { isPrefixValid } from './prefix.ts'
export { canonicalNormalForm, traceEquivalent, prefixHash } from './trace.ts'

import { topologicalOrder } from './sp.ts'
import type { StepGraph } from './types.ts'

/** Linear site sequence for simple graphs. */
export function linearSequence (graph: StepGraph): string[] {
  return topologicalOrder(graph)
}
