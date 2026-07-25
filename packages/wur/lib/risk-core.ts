/**
 * Core risk composition without circular imports.
 */
import { clamp01 } from './contracts.ts'

export function combineWur (rb: number, rf: number, alpha = 1): number {
  return clamp01(1 - (1 - rb) * (1 - alpha * rf))
}
