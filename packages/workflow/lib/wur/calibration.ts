/**
 * Change-class severity calibration from deployment history (§6.4).
 *
 * Past releases are natural experiments: per-class (incident | exposure)
 * records yield empirical-Bayes Beta posteriors with shrinkage toward a
 * cross-fleet prior. Cold start → wide intervals (honest uncertainty).
 */

export type ChangeClass =
  | 'body-only'
  | 'demand-growth'
  | 'insert-step'
  | 'insert-timer'
  | 'delete-site'
  | 'swap-sites'
  | 'parallel-reorder'
  | 'predicate-change'
  | 'predicate-refactor'
  | 'migration'
  | 'unknown'

export interface ClassRecord {
  changeClass: ChangeClass
  /** Number of releases/exposures of this class. */
  exposures: number
  /** Number that caused operator-visible incidents. */
  incidents: number
}

export interface ClassCalibration {
  /** Posterior mean P(incident | class). */
  mean: number
  /** Effective sample size. */
  n: number
  /** 90% central interval (approx via Beta quantiles). */
  interval: [number, number]
  /** True when prior-dominated (cold start). */
  coldStart: boolean
}

const DEFAULT_PRIOR = { a: 1, b: 1 } // uniform

/**
 * In-memory fleet prior + per-app history.
 */
export class CalibrationStore {
  private fleet: Map<ChangeClass, ClassRecord> = new Map()
  private apps: Map<string, Map<ChangeClass, ClassRecord>> = new Map()

  record (appId: string | null, rec: ClassRecord): void {
    this.bump(this.fleet, rec)
    if (appId) {
      if (!this.apps.has(appId)) this.apps.set(appId, new Map())
      this.bump(this.apps.get(appId)!, rec)
    }
  }

  private bump (m: Map<ChangeClass, ClassRecord>, rec: ClassRecord): void {
    const prev = m.get(rec.changeClass) ?? {
      changeClass: rec.changeClass,
      exposures: 0,
      incidents: 0,
    }
    m.set(rec.changeClass, {
      changeClass: rec.changeClass,
      exposures: prev.exposures + rec.exposures,
      incidents: prev.incidents + rec.incidents,
    })
  }

  /**
   * Empirical-Bayes: app posterior shrunk toward fleet prior.
   */
  calibrate (changeClass: ChangeClass, appId?: string | null): ClassCalibration {
    const fleet = this.fleet.get(changeClass)
    const app = appId ? this.apps.get(appId)?.get(changeClass) : undefined

    // Fleet pseudo-counts as prior
    const priorA = DEFAULT_PRIOR.a + (fleet?.incidents ?? 0) * 0.1
    const priorB = DEFAULT_PRIOR.b + ((fleet?.exposures ?? 0) - (fleet?.incidents ?? 0)) * 0.1

    const n = app?.exposures ?? 0
    const inc = app?.incidents ?? 0
    const a = priorA + inc
    const b = priorB + (n - inc)
    const mean = a / (a + b)
    const coldStart = n < 5 && (fleet?.exposures ?? 0) < 10

    // Approximate Beta quantiles via normal on logit scale
    const variance = (a * b) / ((a + b) ** 2 * (a + b + 1))
    const sd = Math.sqrt(Math.max(variance, 1e-9))
    const lo = clamp(mean - 1.645 * sd, 0, 1)
    const hi = clamp(mean + 1.645 * sd, 0, 1)

    return { mean, n: n + (fleet?.exposures ?? 0) * 0.1, interval: [lo, hi], coldStart }
  }

  /** Map annotation reason → change class. */
  static classifyReason (reason: string): ChangeClass {
    const r = reason.toLowerCase()
    if (r.includes('demand') || r.includes('fields:')) return 'demand-growth'
    if (r.includes('inserted') && r.includes('timer')) return 'insert-timer'
    if (r.includes('inserted') || r.includes('insert')) return 'insert-step'
    if (r.includes('removed') || r.includes('delete')) return 'delete-site'
    if (r.includes('reorder') || r.includes('parallel') || r.includes('race')) return 'parallel-reorder'
    if (r.includes('swap') || r.includes('order violation')) return 'swap-sites'
    if (r.includes('predicate') && r.includes('refactor')) return 'predicate-refactor'
    if (r.includes('predicate')) return 'predicate-change'
    if (r.includes('migration')) return 'migration'
    if (r.includes('body') || r.includes('fingerprint')) return 'body-only'
    return 'unknown'
  }

  toJSON (): { fleet: ClassRecord[], apps: Record<string, ClassRecord[]> } {
    return {
      fleet: [...this.fleet.values()],
      apps: Object.fromEntries(
        [...this.apps.entries()].map(([k, v]) => [k, [...v.values()]])
      ),
    }
  }

  static fromJSON (data: { fleet?: ClassRecord[], apps?: Record<string, ClassRecord[]> }): CalibrationStore {
    const s = new CalibrationStore()
    for (const r of data.fleet ?? []) s.bump(s.fleet, r)
    for (const [appId, recs] of Object.entries(data.apps ?? {})) {
      s.apps.set(appId, new Map())
      for (const r of recs) s.bump(s.apps.get(appId)!, r)
    }
    return s
  }
}

function clamp (x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

/** Shared process-local store (tests can replace). */
export const defaultCalibrationStore = new CalibrationStore()

/**
 * Record a release exposure (and optional incident) for severity learning.
 * Call after deploy / after ops marks a bad release.
 */
export function recordReleaseOutcome (opts: {
  appId?: string | null
  changeClasses: ChangeClass[]
  incident?: boolean
  store?: CalibrationStore
}): void {
  const store = opts.store ?? defaultCalibrationStore
  const incident = opts.incident === true ? 1 : 0
  for (const changeClass of opts.changeClasses) {
    store.record(opts.appId ?? null, {
      changeClass,
      exposures: 1,
      incidents: incident,
    })
  }
}

/**
 * Infer change classes from WUR annotations (deploy-time feedback loop).
 */
export function classesFromAnnotations (
  annotations: Array<{ axis: string, reason: string }>
): ChangeClass[] {
  const set = new Set<ChangeClass>()
  for (const a of annotations) {
    set.add(CalibrationStore.classifyReason(a.reason))
  }
  if (set.size === 0) set.add('unknown')
  return [...set]
}
