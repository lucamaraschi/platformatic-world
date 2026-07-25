/**
 * Matching μ: N1 ⇀ N2 (Definition 4.1).
 */
import { topologicalOrder } from './sp.ts'
import type { Matching, Site, StepGraph } from './types.ts'

function labelKey (site: Site): string {
  return `${site.label.kind}:${site.label.name}`
}

function siteKey (site: Site): string {
  return site.fingerprint
    ? `${labelKey(site)}#${site.fingerprint}`
    : labelKey(site)
}

/**
 * LCS matching on site keys along topological order, then verify
 * relative order on all paths (conservative path check via topo positions).
 */
export function matchGraphs (g1: StepGraph, g2: StepGraph): Matching {
  const seq1 = topologicalOrder(g1)
  const seq2 = topologicalOrder(g2)
  const site1 = new Map(g1.sites.map(s => [s.id, s]))
  const site2 = new Map(g2.sites.map(s => [s.id, s]))

  const keys1 = seq1.map(id => siteKey(site1.get(id)!))
  const keys2 = seq2.map(id => siteKey(site2.get(id)!))
  const n = keys1.length
  const m = keys2.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = keys1[i - 1] === keys2[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const map = new Map<string, string>()
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (keys1[i - 1] === keys2[j - 1]) {
      map.set(seq1[i - 1], seq2[j - 1])
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }

  // Drop matches that violate relative order on the topo path
  const pos2 = new Map(seq2.map((id, idx) => [id, idx]))
  const matched = [...map.entries()].sort(
    (a, b) => seq1.indexOf(a[0]) - seq1.indexOf(b[0])
  )
  let lastPos = -1
  const clean = new Map<string, string>()
  for (const [v1, v2] of matched) {
    const p = pos2.get(v2) ?? -1
    if (p > lastPos) {
      clean.set(v1, v2)
      lastPos = p
    }
  }

  const unmatchedG1 = seq1.filter(id => !clean.has(id))
  const matchedG2 = new Set(clean.values())
  const unmatchedG2 = seq2.filter(id => !matchedG2.has(id))

  return { map: clean, unmatchedG1, unmatchedG2 }
}

/** Normalize branch predicate for syntactic compare (conservative). */
export function normalizePredicate (p: string | undefined): string {
  if (!p) return ''
  return p.replace(/\s+/g, ' ').trim()
}
