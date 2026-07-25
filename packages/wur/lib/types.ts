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
 */
export interface Site {
  id: string
  label: SiteLabel
  /** Call-site fingerprint distinguishing same-label sites (Def 4.1). */
  fingerprint?: string
  /** Output contract fields the site produces. */
  outputFields?: string[]
  /** Consumption contract: fields demanded of upstream payloads. */
  demandFields?: string[]
  /** Producer site ids whose payloads this site consumes. */
  consumesFrom?: string[]
  /** Typed output schema for lattice (Def 4.3). */
  outputContract?: Record<string, string>
  /** Typed demand schema for lattice. */
  demandContract?: Record<string, string>
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
 */
export interface StepGraph {
  sites: Site[]
  edges: Array<{ from: string | null, to: string, predicate?: string }>
  parallelGroups?: ParallelGroup[]
  exitId?: string
  /** Module path for out-of-scope warnings. */
  modulePath?: string
}

/** Recorded protocol event (subset of world events.list surface). */
export interface ProtocolEvent {
  eventType: string
  correlationId?: string | null
  eventData?: unknown
  createdAt?: string | Date
  specVersion?: number | null
}

/** A run with its event log (Definition 3.3). */
export interface ProtocolRun {
  runId: string
  workflowName: string
  deploymentId: string
  status: string
  events: ProtocolEvent[]
  weight?: number
  coupledRunIds?: string[]
}

/**
 * Path prefix with invocation-time store (Def 3.3 + §5.1 boundary).
 */
export interface PathPrefix {
  siteIds: string[]
  frontier: string | null
  /** End-of-prefix payloads by site id. */
  payloads: Map<string, unknown>
  correlationIds: string[]
  /**
   * Invocation-time store: for each consumer site id in prefix ∪ {frontier},
   * the map of producer → payload available when that site was/would be invoked.
   */
  invocationStore: Map<string, Map<string, unknown>>
}

export type ChangeAxis = 'protocol' | 'interface' | 'migration'

export interface ChangedSite {
  siteId: string
  axis: ChangeAxis
  reason: string
  severity?: number
  demandFields?: string[]
  producerSiteId?: string
  /** G2 insert anchor in G1 for forward hazard. */
  insertAfter?: string | null
  unsatisfiable?: boolean
}

/** Matching μ: N1 ⇀ N2 (Definition 4.1). */
export interface Matching {
  map: Map<string, string>
  unmatchedG1: string[]
  unmatchedG2: string[]
}

export type VerdictClass = 'migrate' | 'review' | 'pin'

export interface RunRisk {
  runId: string
  backwardRisk: number
  forwardRisk: number
  wur: number
  wurInterval?: [number, number]
  verdict: VerdictClass
  prefixValid: boolean
  frontier: string | null
  reasons: string[]
  expectedLoss?: number
  diagnosis?: string
}

export interface FleetRiskResult {
  wur: number
  wurInterval?: [number, number]
  runs: RunRisk[]
  annotations: Array<{
    siteId: string
    axis: ChangeAxis
    reason: string
    affectedRuns: number
  }>
  partition?: {
    migrate: string[]
    pin: string[]
    review: string[]
  }
  warnings: string[]
}

export interface AnalyzeOptions {
  alpha?: number
  tauLo?: number
  tauHi?: number
  /** Monte Carlo draws; 0 = point estimate only. Default 0 for tests, 200 for prod. */
  draws?: number
  dirichletAlpha?: number
  betaPrior?: [number, number]
  exactRegime?: boolean
  couplingEdges?: Array<{
    from: string
    to: string
    transmission?: number
    channelPenalty?: number
  }>
  /** Auto-build coupling graph from telemetry. */
  autoCouple?: boolean
  pinCost?: number
  forgoneFix?: number
  /** unk prior: uninformative → review; pessimistic → pin. */
  unkMode?: 'uninformative' | 'pessimistic'
  /** Class severity prior when no deployment history. */
  classSeverityPrior?: number
  /** Build coupling from protocol signals. */
  buildCouplingFromTelemetry?: boolean
}
