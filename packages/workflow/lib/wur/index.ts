/**
 * Workflow Upgrade Risk (WUR) — arXiv:2607.13617
 *
 * Telemetry-driven model for quantifying upgrade risk in durable workflow
 * execution. World-agnostic: consumes step graphs + protocol telemetry only.
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
  parallelGraph,
  independencePairs,
  canonicalNormalForm,
  traceEquivalent,
  prefixHash,
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
  labelInstabilityReview,
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
  recordHasFields,
} from './telemetry.ts'

export { hydrateEventData, asRecord, hydrateToValue } from './hydrate.ts'
export type { HydratedValue, HydratedKind } from './hydrate.ts'

export {
  analyzeUpgradeRisk,
  analyzeWithChanges,
} from './analyze.ts'
export type { AnalyzeInput } from './analyze.ts'

export {
  estimateSeverity,
  collectRetryStats,
  monteCarloWur,
} from './estimate.ts'

export {
  buildCouplingGraph,
  mixedWindowPenalty,
  estimateEventRate,
  channelInterfaceRisk,
} from './channels.ts'

export {
  oracleReplay,
  oracleUnsafe,
  eventsFromPath,
} from './oracle.ts'

export {
  manifestToGraph,
  graphToManifest,
  outOfScopeWarnings,
} from './static/extract.ts'
export type { GraphManifest } from './static/extract.ts'

export {
  extractGraphsFromSource,
  extractWorkflowGraph,
} from './static/ast-extract.ts'
export type { ExtractOptions, ExtractResult } from './static/ast-extract.ts'

export {
  CalibrationStore,
  defaultCalibrationStore,
} from './calibration.ts'
export type { ChangeClass, ClassRecord, ClassCalibration } from './calibration.ts'

export { expandDevalueFlat } from './hydrate.ts'

export { runWurCli, parseWurArgs } from './cli-wur.ts'

export {
  latticeCompare,
  fieldsToSchema,
  coversDemand,
} from './lattice.ts'

export {
  certainlyPrecedes,
  invocationGateOpen,
} from './demand.ts'
