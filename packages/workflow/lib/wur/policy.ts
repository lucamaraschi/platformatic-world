/**
 * Migration policy: migrate / review / pin (Section 9).
 */
import type { RunRisk, VerdictClass } from './types.ts'

/**
 * Threshold policy from the paper:
 *
 *   R_b = 0 ∧ α R_f < τ_lo           → migrate
 *   R_b = 0 ∧ α R_f ∈ [τ_lo, τ_hi]   → review
 *   R_b > 0 ∨ α R_f > τ_hi           → pin
 *
 * Runs whose credible interval straddles a threshold are classified by the
 * interval upper bound (pessimistic) when interval is provided.
 */
export function classifyVerdict (
  rb: number,
  rf: number,
  alpha = 1,
  tauLo = 0.1,
  tauHi = 0.5,
  wurUpper?: number
): VerdictClass {
  const arb = alpha * rf
  // Hard pin on any backward risk
  if (rb > 0) return 'pin'
  if (wurUpper !== undefined) {
    // Interval-based: use upper bound pessimistically
    if (wurUpper < tauLo) return 'migrate'
    if (wurUpper <= tauHi) return 'review'
    return 'pin'
  }
  if (arb < tauLo) return 'migrate'
  if (arb <= tauHi) return 'review'
  return 'pin'
}

/** Rank review-class runs by expected loss (descending). */
export function rankReview (runs: RunRisk[]): RunRisk[] {
  return runs
    .filter(r => r.verdict === 'review')
    .sort((a, b) => (b.expectedLoss ?? b.wur) - (a.expectedLoss ?? a.wur))
}

export function partitionByVerdict (runs: RunRisk[]): {
  migrate: string[]
  review: string[]
  pin: string[]
} {
  const migrate: string[] = []
  const review: string[] = []
  const pin: string[] = []
  for (const r of runs) {
    if (r.verdict === 'migrate') migrate.push(r.runId)
    else if (r.verdict === 'review') review.push(r.runId)
    else pin.push(r.runId)
  }
  return { migrate, review, pin }
}
