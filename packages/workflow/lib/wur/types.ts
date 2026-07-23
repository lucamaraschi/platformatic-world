/**
 * Types for the Workflow Upgrade Risk (WUR) model
 * (arXiv:2607.13617 — Maraschi & Collina, 2026).
 */

/** Site kinds in the durable-workflow protocol. */
export type SiteKind = 'step' | 'timer' | 'hook'

/** Label of a site: name + kind (Definition 3.1). */
export interface SiteLabel {
  name: string
  kind: SiteKind
}

/**
 * A site in a workflow version's step graph (Definition 3.1).
 * `id` is unique within a graph; labels may repeat across call sites.
 */
export interface Site {
  id: string
  label: SiteLabel
  /** Call-site fingerprint distinguishing same-label sites (Def 4.1). */
  fingerprint?: string
  /** Output contract fields the site produces (optional). */
  outputFields?: string[]
  /**
   * Consumption contract: fields demanded of this site's (or upstream) payload.
   * Used for interface risk when consumers change (Def 4.4).
   */
  demandFields?: string[]
  /**
   * Optional producer site ids whose payloads this site consumes.
   * Used for demand satisfiability checks (§4.1).
   */
  consumesFrom?: string[]
}

export type ParallelGroupKind = 'join' | 'race'

/** Series–parallel structure for concurrent branches (Def 3.2, 3.6). */
export interface ParallelGroup {
  id: string
  kind: ParallelGroupKind
  /** Branch site id lists in source (fork) order. */
  branches: string[][]
}

/**
 * Step graph G_V = (N_V ∪ {n0, n⊥}, E_V) (Definition 3.2).
 * Edges are sequential transitions; parallel groups capture concurrency.
 */
export interface StepGraph {
  sites: Site[]
  /** Directed edges (fromSiteId → toSiteId). Entry edges use from = null. */
  edges: Array<{ from: string | null, to: string, predicate?: string }>
  parallelGroups?: ParallelGroup[]
  /** Exit site id if present; otherwise implicit sink. */
  exitId?: string
}

/** Recorded protocol event (subset of world events.list surface). */
export interface ProtocolEvent {
  eventType: string
  correlationId?: string | null
  /** Hydrated payload (already decoded from storage). */
  eventData?: unknown
  createdAt?: string | Date
}

/** A run with its event log (Definition 3.3). */
export interface ProtocolRun {
  runId: string
  workflowName: string
  deploymentId: string
  status: string
  events: ProtocolEvent[]
  /** Optional business weight ω_r (Def 5.5); defaults to uniform. */
  weight?: number
  /** Optional coupling partner run ids (parent/child, saga). */
  coupledRunIds?: string[]
}

/** Path prefix: ordered site occurrences reconstructed from a log. */
export interface PathPrefix {
  /** Site ids in global invocation order (ULID-sorted). */
  siteIds: string[]
  /** Frontier: pending site id if suspended, else null (completed). */
  frontier: string | null
  /** Per-site hydrated payloads keyed by site id (completed only). */
  payloads: Map<string, unknown>
  /** Correlation ids in invocation order (for debugging). */
  correlationIds: string[]
}

export type ChangeAxis = 'protocol' | 'interface' | 'migration'

export interface ChangedSite {
  siteId: string
  axis: ChangeAxis
  /** Why this site is in Δ. */
  reason: string
  /** Severity sev(v) ∈ [0,1] (Def 5.4); default 1 for protocol. */
  severity?: number
  /** Demand fields for interface changes (new consumer requirements). */
  demandFields?: string[]
  /** Producer site whose payload is validated (interface). */
  producerSiteId?: string
}

/** Matching μ: N1 ⇀ N2 (Definition 4.1). */
export interface Matching {
  /** v1 id → v2 id */
  map: Map<string, string>
  /** Sites in G1 not matched. */
  unmatchedG1: string[]
  /** Sites in G2 not matched. */
  unmatchedG2: string[]
}

export type VerdictClass = 'migrate' | 'review' | 'pin'

export interface RunRisk {
  runId: string
  /** Backward (rehydration) risk R_b(r) (Def 5.1). */
  backwardRisk: number
  /** Forward (behavioral) risk R_f(r) (Def 5.4). */
  forwardRisk: number
  /** WUR(r) (Def 5.5). */
  wur: number
  /** 90% credible interval on WUR when Bayesian draws used. */
  wurInterval?: [number, number]
  verdict: VerdictClass
  /** Prefix validity under μ (θ ⊑_μ G2). */
  prefixValid: boolean
  frontier: string | null
  reasons: string[]
  expectedLoss?: number
}

export interface FleetRiskResult {
  /** Fleet-level WUR (Def 5.5 / coupled fixpoint). */
  wur: number
  wurInterval?: [number, number]
  runs: RunRisk[]
  /** Change annotations: which edit induces which risk. */
  annotations: Array<{
    siteId: string
    axis: ChangeAxis
    reason: string
    affectedRuns: number
  }>
  /** Coupling-aware partition when coupling graph is nonempty. */
  partition?: {
    migrate: string[]
    pin: string[]
    review: string[]
  }
  warnings: string[]
}

export interface AnalyzeOptions {
  /** Discount α on behavioral vs corruption risk (Def 5.5). Default 1. */
  alpha?: number
  /** Thresholds 0 < τ_lo < τ_hi < 1 for migrate/review/pin (Def §9). */
  tauLo?: number
  tauHi?: number
  /** Monte Carlo draws for posterior propagation. Default 0 (point estimate). */
  draws?: number
  /** Dirichlet prior concentration (symmetric). Default 1. */
  dirichletAlpha?: number
  /** Beta prior for interface (a, b). Default (1, 1). */
  betaPrior?: [number, number]
  /** Exact per-run payload checks (true) vs distributional. Default true. */
  exactRegime?: boolean
  /** Coupling edges for contagion / min-cut. */
  couplingEdges?: Array<{
    from: string
    to: string
    /** Transmission probability τ. Default 1 for deterministic channels. */
    transmission?: number
    /** Mixed-window channel penalty π_c. Default 0. */
    channelPenalty?: number
  }>
  /** Pinning cost ψ(V1) per run when coupling partition used. Default 0.1. */
  pinCost?: number
  /** Forgone-fix exposure β. Default 0.05. */
  forgoneFix?: number
}
