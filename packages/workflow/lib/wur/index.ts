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
  extractResourceTouches,
  buildResourceFingerprintEdges,
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
  inferDemandsFromSource,
  applyDemandsToGraph,
  enrichGraphWithDemandInference,
} from './static/demand-infer.ts'
export type {
  DemandInferenceResult,
  InferredDemand,
  DemandVerdict,
} from './static/demand-infer.ts'

export {
  CalibrationStore,
  defaultCalibrationStore,
  recordReleaseOutcome,
  classesFromAnnotations,
} from './calibration.ts'
export type { ChangeClass, ClassRecord, ClassCalibration } from './calibration.ts'

export {
  loadCalibrationFromDb,
  recordReleaseOutcomePersistent,
  upsertCalibrationDelta,
  FLEET_KEY,
} from './calibration-db.ts'

export { expandDevalueFlat, dehydrateForTest } from './hydrate.ts'

export { runWurCli, parseWurArgs } from './cli-wur.ts'

export {
  discoverWorkflowFiles,
  loadCorpus,
  runCorpusReport,
  evaluateMutation,
  defaultMutators,
  syntheticCorpus,
  generateSyntheticCorpus,
  runLargeMutationStudy,
  prefixesOf,
} from './corpus.ts'
export type {
  CorpusEntry,
  CorpusReport,
  Confusion,
  MutationResult,
} from './corpus.ts'

export {
  latticeCompare,
  fieldsToSchema,
  coversDemand,
} from './lattice.ts'

export {
  certainlyPrecedes,
  invocationGateOpen,
} from './demand.ts'
