/**
 * Prefix validity θ ⊑_μ G₂ modulo trace equivalence (Def 5.1, Thm 7.3).
 */
import { matchGraphs } from './match.ts'
import { topologicalOrder } from './sp.ts'
import { canonicalNormalForm } from './trace.ts'
import type { Matching, StepGraph } from './types.ts'

/**
 * Prefix validity under μ, modulo ≡_I.
 *
 * Head/mid insertions or deletions that shift ordinals before recorded events
 * invalidate the prefix. Tail insertions after the prefix region are valid.
 * Join-observed completion permutations are quotiented via normal form.
 */
export function isPrefixValid (
  prefixSiteIds: string[],
  g1: StepGraph,
  g2: StepGraph,
  matching: Matching,
  correlationIds?: string[]
): { valid: boolean, reason?: string } {
  if (prefixSiteIds.length === 0) return { valid: true }

  const norm1 = canonicalNormalForm(prefixSiteIds, g1, correlationIds)

  // Every normalized prefix site must be matched
  const mapped: string[] = []
  for (const id of norm1) {
    const m = matching.map.get(id)
    if (!m) {
      return {
        valid: false,
        reason: `prefix site ${id} has no match in G2 (protocol change on recorded history)`,
      }
    }
    mapped.push(m)
  }

  const order1 = topologicalOrder(g1)
  const order2 = topologicalOrder(g2)
  const pos1 = new Map(order1.map((id, i) => [id, i]))
  const pos2 = new Map(order2.map((id, i) => [id, i]))
  const inv = new Map([...matching.map].map(([a, b]) => [b, a]))

  // Mapped sequence must respect G2 order
  for (let i = 1; i < mapped.length; i++) {
    if ((pos2.get(mapped[i - 1]) ?? 0) > (pos2.get(mapped[i]) ?? 0)) {
      return { valid: false, reason: `prefix order violation in G2 at ${mapped[i]}` }
    }
  }

  // Head insertion/deletion before first prefix site
  const firstV1 = norm1[0]
  const firstMapped = mapped[0]
  const firstPos1 = pos1.get(firstV1) ?? 0
  const firstPos2 = pos2.get(firstMapped) ?? 0
  const before1 = order1.slice(0, firstPos1)
  const before2 = order2.slice(0, firstPos2)
  const unmatchedBefore2 = before2.filter(id => !inv.has(id))
  const removedBefore = before1.filter(id => !matching.map.has(id))
  if (unmatchedBefore2.length > 0 || removedBefore.length > 0) {
    return {
      valid: false,
      reason: 'sites inserted or removed before recorded prefix (ordinal shift)',
    }
  }

  // Mid insertion between consecutive prefix sites
  for (let i = 1; i < mapped.length; i++) {
    const a2 = pos2.get(mapped[i - 1])!
    const b2 = pos2.get(mapped[i])!
    const a1 = pos1.get(norm1[i - 1])!
    const b1 = pos1.get(norm1[i])!
    const between2 = order2.slice(a2 + 1, b2).filter(id => !inv.has(id))
    const between1 = order1.slice(a1 + 1, b1).filter(id => !matching.map.has(id))
    if (between2.length > 0 || between1.length > 0) {
      // Allow if only independent reordering — already normalized; residual = protocol
      return {
        valid: false,
        reason: `sites inserted/removed between prefix sites ${norm1[i - 1]} and ${norm1[i]}`,
      }
    }
  }

  // Ensure mapped normal form embeds as a valid G2 path region
  const norm2 = canonicalNormalForm(mapped, g2)
  if (norm2.length !== mapped.length) {
    return { valid: false, reason: 'mapped prefix failed G2 normal form' }
  }

  return { valid: true }
}

export { matchGraphs }
