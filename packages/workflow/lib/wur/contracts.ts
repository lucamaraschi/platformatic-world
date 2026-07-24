/**
 * Compatibility lattice helpers and payload validation (Defs 4.3–4.4).
 */
import { asRecord, hydrateEventData } from './hydrate.ts'

export type ContractVerdict = 'sat' | 'vio' | 'unk'

/**
 * Validate a hydrated payload against demanded fields (exact regime).
 */
export function validatePayload (
  payload: unknown,
  demandFields: string[]
): { verdict: ContractVerdict, missing: string[] } {
  if (!demandFields.length) return { verdict: 'sat', missing: [] }
  // Maximal demand from unk inference
  if (demandFields.includes('*')) {
    return { verdict: 'unk', missing: [] }
  }
  const h = hydrateEventData(payload)
  if (h.kind === 'null') {
    return { verdict: 'vio', missing: [...demandFields] }
  }
  if (h.kind === 'opaque' || h.kind === 'map' || h.kind === 'date' ||
      h.kind === 'set' || h.kind === 'array' || h.kind === 'unknown') {
    return { verdict: 'unk', missing: [] }
  }
  const rec = asRecord(h)
  if (!rec) {
    if (payload === null || payload === undefined) {
      return { verdict: 'vio', missing: [...demandFields] }
    }
    if (typeof payload !== 'object' || Array.isArray(payload)) {
      return { verdict: 'unk', missing: [] }
    }
  }
  const obj = rec ?? (payload as Record<string, unknown>)
  const missing = demandFields.filter(f => !(f in obj) || obj[f] === undefined)
  if (missing.length) return { verdict: 'vio', missing }
  return { verdict: 'sat', missing: [] }
}

export function fieldPresenceFrequencies (
  payloads: unknown[],
  fields: string[]
): Map<string, number> {
  const freq = new Map<string, number>()
  if (payloads.length === 0) {
    for (const f of fields) freq.set(f, 0)
    return freq
  }
  for (const f of fields) {
    let present = 0
    let inspectable = 0
    for (const p of payloads) {
      const v = validatePayload(p, [f])
      if (v.verdict === 'unk') continue
      inspectable++
      if (v.verdict === 'sat') present++
    }
    freq.set(f, inspectable === 0 ? 0 : present / inspectable)
  }
  return freq
}

export function distributionalInterfaceRisk (
  payloads: unknown[],
  demandFields: string[]
): number {
  if (!demandFields.length) return 0
  if (!payloads.length) return 1
  const freq = fieldPresenceFrequencies(payloads, demandFields)
  let minFreq = 1
  for (const f of demandFields) {
    minFreq = Math.min(minFreq, freq.get(f) ?? 0)
  }
  return clamp01(1 - minFreq)
}

export function poolLogOdds (
  axes: Array<{ rho: number, weight: number }>
): number {
  for (const a of axes) {
    if (a.rho >= 1 && (!Number.isFinite(a.weight) || a.weight === Infinity)) return 1
  }
  let num = 0
  let den = 0
  for (const a of axes) {
    if (a.weight === 0) continue
    if (!Number.isFinite(a.weight)) {
      if (a.rho >= 1) return 1
      if (a.rho <= 0) continue
      const w = 1e9
      const lo = logit(clamp01(a.rho, 1e-9, 1 - 1e-9))
      num += w * lo
      den += w
      continue
    }
    const r = clamp01(a.rho, 1e-9, 1 - 1e-9)
    num += a.weight * logit(r)
    den += a.weight
  }
  if (den === 0) return 0
  return sigmoid(num / den)
}

function logit (p: number): number {
  return Math.log(p / (1 - p))
}

function sigmoid (x: number): number {
  if (x > 30) return 1
  if (x < -30) return 0
  return 1 / (1 + Math.exp(-x))
}

export function clamp01 (x: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, x))
}

export function betaMean (m: number, n: number, a = 1, b = 1): number {
  return (m + a) / (n + a + b)
}

export function sampleBeta (a: number, b: number, rng: () => number = Math.random): number {
  const x = sampleGamma(a, rng)
  const y = sampleGamma(b, rng)
  const s = x + y
  return s === 0 ? 0.5 : x / s
}

function sampleGamma (shape: number, rng: () => number): number {
  if (shape < 1) {
    const u = rng()
    return sampleGamma(1 + shape, rng) * Math.pow(u, 1 / shape)
  }
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x: number
    let v: number
    do {
      x = gaussian(rng)
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = rng()
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

function gaussian (rng: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
