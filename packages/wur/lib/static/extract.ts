/**
 * Step-graph extraction from build manifests (WS-C1a).
 * AST extraction (C1b) can generate the same manifest format.
 */
import type { ParallelGroup, Site, SiteKind, StepGraph } from '../types.ts'

/** JSON-serializable step graph manifest (post-build identity). */
export interface GraphManifest {
  version?: number
  modulePath?: string
  sites: Array<{
    id: string
    name: string
    kind?: SiteKind
    /** Module-qualified name e.g. step//./workflows/e2e//add */
    qualifiedName?: string
    fingerprint?: string
    outputFields?: string[]
    demandFields?: string[]
    consumesFrom?: string[]
  }>
  edges: Array<{ from: string | null, to: string, predicate?: string }>
  parallelGroups?: Array<{
    id: string
    kind: 'join' | 'race'
    branches: string[][]
  }>
  exitId?: string
}

export function manifestToGraph (m: GraphManifest): StepGraph {
  const sites: Site[] = m.sites.map(s => ({
    id: s.id,
    label: {
      name: s.qualifiedName ?? s.name,
      kind: s.kind ?? 'step',
    },
    fingerprint: s.fingerprint,
    outputFields: s.outputFields,
    demandFields: s.demandFields,
    consumesFrom: s.consumesFrom,
  }))
  const parallelGroups: ParallelGroup[] | undefined = m.parallelGroups?.map(g => ({
    id: g.id,
    kind: g.kind,
    branches: g.branches,
  }))
  return {
    sites,
    edges: m.edges,
    parallelGroups,
    exitId: m.exitId,
    modulePath: m.modulePath,
  }
}

export function graphToManifest (g: StepGraph): GraphManifest {
  return {
    version: 2,
    modulePath: g.modulePath,
    sites: g.sites.map(s => ({
      id: s.id,
      name: s.label.name,
      kind: s.label.kind,
      qualifiedName: s.label.name,
      fingerprint: s.fingerprint,
      outputFields: s.outputFields,
      demandFields: s.demandFields,
      consumesFrom: s.consumesFrom,
    })),
    edges: g.edges,
    parallelGroups: g.parallelGroups,
    exitId: g.exitId,
  }
}

/**
 * Out-of-scope warning: modules in lockfile change set not covered by graphs.
 */
export function outOfScopeWarnings (
  graphModules: string[],
  changedModules: string[]
): string[] {
  const covered = new Set(graphModules)
  return changedModules
    .filter(m => !covered.has(m))
    .map(m => `out-of-scope module change (not in graph diff): ${m}`)
}
