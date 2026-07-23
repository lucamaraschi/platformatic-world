/**
 * Empirical control-flow Markov chain and hitting probabilities (Defs 5.2–5.3).
 */
import type { StepGraph } from './types.ts'
import { topologicalOrder } from './graph.ts'

export type TransitionCounts = Map<string, Map<string, number>>

const EXIT = '__exit__'

/**
 * Count transitions along historical path prefixes (Def 5.2).
 * Each path is a sequence of site ids; terminal paths transition to EXIT.
 */
export function countTransitions (
  paths: string[][],
  completed: boolean[] = []
): TransitionCounts {
  const counts: TransitionCounts = new Map()
  const bump = (u: string, w: string) => {
    if (!counts.has(u)) counts.set(u, new Map())
    const row = counts.get(u)!
    row.set(w, (row.get(w) ?? 0) + 1)
  }
  for (let p = 0; p < paths.length; p++) {
    const path = paths[p]
    for (let i = 0; i < path.length - 1; i++) {
      bump(path[i], path[i + 1])
    }
    if (path.length > 0 && (completed[p] ?? true)) {
      bump(path[path.length - 1], EXIT)
    }
  }
  return counts
}

/**
 * Posterior mean transition matrix with Dirichlet prior (Eq §6.1).
 * P(u,w) = (α_uw + c_uw) / (α_u· + c_u·)
 * Feasible successors default to graph neighbors + EXIT for sinks.
 */
export function transitionMatrix (
  counts: TransitionCounts,
  graph: StepGraph,
  dirichletAlpha = 1
): Map<string, Map<string, number>> {
  const order = topologicalOrder(graph)
  const successors = new Map<string, Set<string>>()
  for (const id of order) successors.set(id, new Set())
  for (const e of graph.edges) {
    if (e.from === null) continue
    successors.get(e.from)?.add(e.to)
  }
  // sinks → EXIT
  for (const id of order) {
    if ((successors.get(id)?.size ?? 0) === 0) {
      successors.get(id)!.add(EXIT)
    }
  }

  const P = new Map<string, Map<string, number>>()
  for (const u of order) {
    const feas = successors.get(u) ?? new Set([EXIT])
    // also include observed transitions not in graph (telemetry-only)
    const obs = counts.get(u)
    if (obs) {
      for (const w of obs.keys()) feas.add(w)
    }
    const alpha = dirichletAlpha
    let total = 0
    const rowCounts = new Map<string, number>()
    for (const w of feas) {
      const c = obs?.get(w) ?? 0
      const a = alpha
      rowCounts.set(w, a + c)
      total += a + c
    }
    const row = new Map<string, number>()
    for (const [w, v] of rowCounts) {
      row.set(w, total === 0 ? 0 : v / total)
    }
    P.set(u, row)
  }
  // EXIT is absorbing
  P.set(EXIT, new Map([[EXIT, 1]]))
  return P
}

/**
 * Sample a transition matrix from Dirichlet posteriors.
 */
export function sampleTransitionMatrix (
  counts: TransitionCounts,
  graph: StepGraph,
  dirichletAlpha = 1,
  rng: () => number = Math.random
): Map<string, Map<string, number>> {
  const order = topologicalOrder(graph)
  const successors = new Map<string, Set<string>>()
  for (const id of order) successors.set(id, new Set())
  for (const e of graph.edges) {
    if (e.from === null) continue
    successors.get(e.from)?.add(e.to)
  }
  for (const id of order) {
    if ((successors.get(id)?.size ?? 0) === 0) successors.get(id)!.add(EXIT)
  }

  const P = new Map<string, Map<string, number>>()
  for (const u of order) {
    const feas = [...(successors.get(u) ?? new Set([EXIT]))]
    const obs = counts.get(u)
    for (const w of obs?.keys() ?? []) {
      if (!feas.includes(w)) feas.push(w)
    }
    const alphas = feas.map(w => dirichletAlpha + (obs?.get(w) ?? 0))
    const draws = sampleDirichlet(alphas, rng)
    const row = new Map<string, number>()
    for (let i = 0; i < feas.length; i++) row.set(feas[i], draws[i])
    P.set(u, row)
  }
  P.set(EXIT, new Map([[EXIT, 1]]))
  return P
}

function sampleDirichlet (alphas: number[], rng: () => number): number[] {
  // Gamma samples then normalize
  const xs = alphas.map(a => sampleGamma(a, rng))
  const s = xs.reduce((a, b) => a + b, 0)
  if (s === 0) return alphas.map(() => 1 / alphas.length)
  return xs.map(x => x / s)
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

/**
 * Hitting probabilities h_v(u): probability of ever visiting v starting from u
 * (Definition 5.3). Solves the sparse linear system via value iteration.
 *
 * h_v(v) = 1, h_v(EXIT) = 0, h_v(u) = Σ_w P(u,w) h_v(w) for u ∉ {v, EXIT}.
 */
export function hittingProbabilities (
  P: Map<string, Map<string, number>>,
  target: string,
  nodes: string[]
): Map<string, number> {
  const h = new Map<string, number>()
  for (const u of nodes) h.set(u, 0)
  h.set(EXIT, 0)
  if (!nodes.includes(target) && target !== EXIT) {
    // target not in graph — never hit
    return h
  }
  h.set(target, 1)

  // Value iteration
  for (let iter = 0; iter < 200; iter++) {
    let delta = 0
    for (const u of nodes) {
      if (u === target) continue
      const row = P.get(u)
      if (!row) continue
      let sum = 0
      for (const [w, p] of row) {
        sum += p * (h.get(w) ?? (w === target ? 1 : 0))
      }
      delta = Math.max(delta, Math.abs(sum - (h.get(u) ?? 0)))
      h.set(u, sum)
    }
    if (delta < 1e-10) break
  }
  h.set(target, 1)
  h.set(EXIT, 0)
  return h
}

/**
 * For all targets in `targets`, compute h_v(·) from one factorization.
 * Returns Map<target, Map<node, h>>.
 */
export function allHittingProbabilities (
  P: Map<string, Map<string, number>>,
  targets: string[],
  nodes: string[]
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  for (const t of targets) {
    out.set(t, hittingProbabilities(P, t, nodes))
  }
  return out
}

export { EXIT }
