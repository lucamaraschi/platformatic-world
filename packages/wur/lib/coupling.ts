/**
 * Inter-run coupling: failure contagion least fixpoint (Def 10.3) and
 * coupling-aware migrate/pin partition via s–t min-cut (Thm 10.5).
 */
import { clamp01 } from './contracts.ts'
import type { RunRisk } from './types.ts'

export interface CouplingEdge {
  from: string
  to: string
  transmission: number
  channelPenalty: number
}

/**
 * Least fixpoint of failure-contagion operator F (Eq 9):
 *   q_r = 1 − (1 − b_r) ∏_{r'∈N(r)} (1 − τ_{r'r} q_{r'})
 * Iterates from 0 until convergence (Prop 10.4).
 */
export function contagionFixpoint (
  endogenous: Map<string, number>,
  edges: CouplingEdge[],
  maxIters = 100,
  tol = 1e-10
): Map<string, number> {
  const q = new Map<string, number>()
  for (const id of endogenous.keys()) q.set(id, 0)

  // adjacency: to ← list of (from, τ)
  const incoming = new Map<string, Array<{ from: string, tau: number }>>()
  for (const e of edges) {
    if (!incoming.has(e.to)) incoming.set(e.to, [])
    incoming.get(e.to)!.push({ from: e.from, tau: e.transmission })
    if (!q.has(e.from)) q.set(e.from, 0)
    if (!q.has(e.to)) q.set(e.to, 0)
    if (!endogenous.has(e.from)) endogenous.set(e.from, 0)
    if (!endogenous.has(e.to)) endogenous.set(e.to, 0)
  }

  for (let iter = 0; iter < maxIters; iter++) {
    let delta = 0
    const next = new Map<string, number>()
    for (const [r, b] of endogenous) {
      let prod = 1
      for (const { from, tau } of incoming.get(r) ?? []) {
        prod *= (1 - tau * (q.get(from) ?? 0))
      }
      const qr = clamp01(1 - (1 - b) * prod)
      delta = Math.max(delta, Math.abs(qr - (q.get(r) ?? 0)))
      next.set(r, qr)
    }
    for (const [k, v] of next) q.set(k, v)
    if (delta < tol) break
  }
  return q
}

/**
 * s–t min-cut partition for binary migrate/pin labels (Thm 10.5 / Fig 3).
 *
 * Construction:
 *   - source s = migrate (V2), sink t = pin (V1)
 *   - edge s→r with capacity ψ_r(V1)  (cost of pinning)
 *   - edge r→t with capacity ψ_r(V2)  (cost of migrating; ∞ if R_b > 0)
 *   - edge r↔r' with capacity π_c     (channel penalty for disagreement)
 *
 * Max-flow / min-cut with Edmonds–Karp (integer capacities).
 * Returns run ids on the migrate side (reachable from s in residual).
 */
export function minCutPartition (
  runs: RunRisk[],
  edges: CouplingEdge[],
  options: {
    pinCost?: number
    forgoneFix?: number
    /** Scale factor to convert float capacities to integers. */
    scale?: number
  } = {}
): { migrate: string[], pin: string[], review: string[] } {
  const pinCost = options.pinCost ?? 0.1
  const forgoneFix = options.forgoneFix ?? 0.05
  const scale = options.scale ?? 10000

  const ids = runs.map(r => r.runId)
  const riskById = new Map(runs.map(r => [r.runId, r]))

  // Super-node contraction for infinite channel penalties (must-move-together)
  const parent = new Map<string, string>()
  for (const id of ids) parent.set(id, id)
  const find = (x: string): string => {
    let p = parent.get(x) ?? x
    while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p
    // path compression
    let cur = x
    while (cur !== p) {
      const n = parent.get(cur) ?? cur
      parent.set(cur, p)
      cur = n
    }
    return p
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const e of edges) {
    if (e.channelPenalty >= 1e9 || !Number.isFinite(e.channelPenalty)) {
      if (parent.has(e.from) && parent.has(e.to)) union(e.from, e.to)
    }
  }

  const supers = new Map<string, string[]>()
  for (const id of ids) {
    const r = find(id)
    if (!supers.has(r)) supers.set(r, [])
    supers.get(r)!.push(id)
  }

  // Super-node costs
  type Super = { id: string, members: string[], psiMigrate: number, psiPin: number }
  const superNodes: Super[] = []
  for (const [sid, members] of supers) {
    let psiMigrate = 0
    let psiPin = 0
    let hardPin = false
    for (const m of members) {
      const risk = riskById.get(m)!
      if (risk.backwardRisk > 0) hardPin = true
      // ψ(V2) = migration risk ≈ WUR; ∞ if R_b > 0
      psiMigrate += risk.wur
      // ψ(V1) = pin cost + forgone fix
      psiPin += pinCost + forgoneFix
    }
    if (hardPin) psiMigrate = Infinity
    superNodes.push({ id: sid, members, psiMigrate, psiPin })
  }

  // Build flow network
  const S = '__s__'
  const T = '__t__'
  const nodes = [S, T, ...superNodes.map(s => s.id)]
  const cap = new Map<string, Map<string, number>>()
  const addEdge = (u: string, v: string, c: number) => {
    if (!cap.has(u)) cap.set(u, new Map())
    const row = cap.get(u)!
    row.set(v, (row.get(v) ?? 0) + c)
    if (!cap.has(v)) cap.set(v, new Map())
    if (!cap.get(v)!.has(u)) cap.get(v)!.set(u, 0)
  }

  const toInt = (x: number) => {
    if (!Number.isFinite(x) || x >= 1e9) return Number.MAX_SAFE_INTEGER / 4
    return Math.max(0, Math.round(x * scale))
  }

  for (const sn of superNodes) {
    // s → r capacity ψ(V1) — cutting means assign pin? Standard construction:
    // edge s→r capacity = cost of assigning t-label (pin), edge r→t = cost of s-label (migrate)
    // Actually Fig 3: s is migrate, t is pin.
    // Cutting s→r means r not with s → r goes to pin, pays ψ_r(V1)?
    // Paper: "terminal edges carry the unary costs ψ_r(·)"
    // edge from s to r: capacity ψ_r(V2) would mean... Let me use the standard MRF construction:
    //   s—[ψ(pin)]→ r —[ψ(migrate)]→ t
    // Cutting s-r assigns r to t (pin), cost ψ(pin)=ψ(V1)
    // Cutting r-t assigns r to s (migrate), cost ψ(migrate)=ψ(V2)
    addEdge(S, sn.id, toInt(sn.psiPin))
    addEdge(sn.id, T, toInt(sn.psiMigrate))
  }

  // Pairwise channel penalties between super-nodes
  const superEdgeCap = new Map<string, number>()
  for (const e of edges) {
    if (!parent.has(e.from) || !parent.has(e.to)) continue
    const a = find(e.from)
    const b = find(e.to)
    if (a === b) continue
    if (!Number.isFinite(e.channelPenalty) || e.channelPenalty >= 1e9) continue
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    superEdgeCap.set(key, (superEdgeCap.get(key) ?? 0) + e.channelPenalty)
  }
  for (const [key, pi] of superEdgeCap) {
    const [a, b] = key.split('|')
    const c = toInt(pi)
    addEdge(a, b, c)
    addEdge(b, a, c)
  }

  // Edmonds–Karp
  const residual = new Map<string, Map<string, number>>()
  for (const u of nodes) {
    residual.set(u, new Map())
    for (const [v, c] of cap.get(u) ?? []) {
      residual.get(u)!.set(v, c)
    }
  }
  // ensure reverse edges exist
  for (const u of nodes) {
    for (const v of residual.get(u)?.keys() ?? []) {
      if (!residual.has(v)) residual.set(v, new Map())
      if (!residual.get(v)!.has(u)) residual.get(v)!.set(u, 0)
    }
  }

  const bfs = (): string[] | null => {
    const prev = new Map<string, string | null>()
    prev.set(S, null)
    const queue = [S]
    while (queue.length) {
      const u = queue.shift()!
      for (const [v, c] of residual.get(u) ?? []) {
        if (c > 0 && !prev.has(v)) {
          prev.set(v, u)
          if (v === T) {
            const path: string[] = []
            let cur: string | null = T
            while (cur !== null) {
              path.push(cur)
              cur = prev.get(cur) ?? null
            }
            path.reverse()
            return path
          }
          queue.push(v)
        }
      }
    }
    return null
  }

  for (;;) {
    const path = bfs()
    if (!path) break
    let bottleneck = Infinity
    for (let i = 0; i < path.length - 1; i++) {
      const c = residual.get(path[i])!.get(path[i + 1]) ?? 0
      bottleneck = Math.min(bottleneck, c)
    }
    for (let i = 0; i < path.length - 1; i++) {
      const u = path[i]
      const v = path[i + 1]
      residual.get(u)!.set(v, (residual.get(u)!.get(v) ?? 0) - bottleneck)
      residual.get(v)!.set(u, (residual.get(v)!.get(u) ?? 0) + bottleneck)
    }
  }

  // Migrate side = residual-reachable from S
  const migrateSuper = new Set<string>()
  const stack = [S]
  const seen = new Set<string>([S])
  while (stack.length) {
    const u = stack.pop()!
    for (const [v, c] of residual.get(u) ?? []) {
      if (c > 0 && !seen.has(v)) {
        seen.add(v)
        stack.push(v)
        if (v !== S && v !== T) migrateSuper.add(v)
      }
    }
  }

  const migrate: string[] = []
  const pin: string[] = []
  for (const sn of superNodes) {
    const side = migrateSuper.has(sn.id) ? migrate : pin
    // Hard-pin supers must pin even if cut says migrate (capacity ∞ should prevent this)
    if (sn.psiMigrate === Infinity) {
      pin.push(...sn.members)
    } else {
      side.push(...sn.members)
    }
  }

  // Review remains those with independent review verdict not overridden —
  // under coupling, review is label-instability (Remark 10.6); without draws,
  // keep empty and fold independent review into pin if min-cut used as hard.
  const review: string[] = []
  return { migrate, pin, review }
}

/**
 * Apply coupling: replace per-run WUR with contagion q_r, optionally re-partition.
 */
export function applyCoupling (
  runs: RunRisk[],
  edges: CouplingEdge[],
  options: {
    pinCost?: number
    forgoneFix?: number
    useMinCut?: boolean
  } = {}
): {
    coupledWur: Map<string, number>
    fleetWur: number
    partition?: { migrate: string[], pin: string[], review: string[] }
  } {
  const endogenous = new Map(runs.map(r => [r.runId, r.wur]))
  const q = contagionFixpoint(endogenous, edges)
  let num = 0
  let den = 0
  for (const r of runs) {
    const qr = q.get(r.runId) ?? r.wur
    num += qr
    den += 1
    r.wur = qr
  }
  const fleetWur = den === 0 ? 0 : num / den
  const partition = options.useMinCut !== false && edges.length > 0
    ? minCutPartition(runs, edges, options)
    : undefined
  return { coupledWur: q, fleetWur, partition }
}
