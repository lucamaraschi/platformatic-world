/**
 * Workflow Upgrade Risk (WUR) — arXiv:2607.13617
 *
 * Telemetry-driven model for quantifying upgrade risk in durable workflow
 * execution. World-agnostic: consumes only step graphs and protocol telemetry
 * (runs.list + events.list), never executes workflow code.
 */

export type {
  AnalyzeOptions,
  ChangeAxis,
  ChangedSite,
  FleetRiskResult,
  Matching,
  ParallelGroup,
  PathPrefix,
  ProtocolEvent,
  ProtocolRun,
  RunRisk,
  Site,
  SiteKind,
  SiteLabel,
  StepGraph,
  VerdictClass,
} from './types.ts'

export {
  classifyChanges,
  isPrefixValid,
  linearGraph,
  linearSequence,
  matchGraphs,
  topologicalOrder,
} from './graph.ts'

export {
  betaMean,
  clamp01,
  distributionalInterfaceRisk,
  fieldPresenceFrequencies,
  poolLogOdds,
  sampleBeta,
  validatePayload,
} from './contracts.ts'

export {
  allHittingProbabilities,
  countTransitions,
  hittingProbabilities,
  sampleTransitionMatrix,
  transitionMatrix,
  EXIT,
} from './markov.ts'

export {
  backwardRisk,
  combineWur,
  fleetWur,
  forwardRisk,
  scoreRuns,
  siteIncompatibilities,
} from './risk.ts'

export {
  classifyVerdict,
  partitionByVerdict,
  rankReview,
} from './policy.ts'

export {
  applyCoupling,
  contagionFixpoint,
  minCutPartition,
} from './coupling.ts'
export type { CouplingEdge } from './coupling.ts'

export {
  buildPrefix,
  collectTelemetry,
  extractOccurrences,
  hydratePayload,
  mapOccurrencesToSites,
} from './telemetry.ts'

export { analyzeUpgradeRisk, analyzeWithChanges } from './analyze.ts'
export type { AnalyzeInput } from './analyze.ts'
