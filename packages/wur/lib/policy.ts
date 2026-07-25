/**
 * Migration policy: migrate / review / pin (Section 9).
 */
import type { RunRisk, VerdictClass } from './types.ts'

/**
 * Threshold policy:
 *   R_b = 0 ∧ α R_f < τ_lo           → migrate
 *   R_b = 0 ∧ α R_f ∈ [τ_lo, τ_hi]   → review
 *   R_b > 0 ∨ α R_f > τ_hi           → pin
 *
 * When wurUpper is set (CI upper bound), classify pessimistically.
 */
export function classifyVerdict (
  rb: number,
  rf: number,
  alpha = 1,
  tauLo = 0.1,
  tauHi = 0.5,
  wurUpper?: number
): VerdictClass {
  if (rb > 0) return 'pin'
  if (wurUpper !== undefined) {
    if (wurUpper < tauLo) return 'migrate'
    if (wurUpper <= tauHi) return 'review'
    return 'pin'
  }
  const arb = alpha * rf
  if (arb < tauLo) return 'migrate'
  if (arb <= tauHi) return 'review'
  return 'pin'
}

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

/**
 * Label-instability review (Remark 10.6): runs whose optimal label flips
 * across posterior partition draws.
 */
export function labelInstabilityReview (
  drawPartitions: Array<{ migrate: string[], pin: string[] }>,
  runIds: string[]
): string[] {
  if (drawPartitions.length === 0) return []
  const review: string[] = []
  for (const id of runIds) {
    let mig = 0
    let pin = 0
    for (const p of drawPartitions) {
      if (p.migrate.includes(id)) mig++
      else if (p.pin.includes(id)) pin++
    }
    if (mig > 0 && pin > 0) review.push(id)
  }
  return review
}
