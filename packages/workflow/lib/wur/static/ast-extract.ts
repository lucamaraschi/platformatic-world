/**
 * Lightweight step-graph extraction from Workflow SDK TypeScript sources (§12.3).
 *
 * Hand-translation rules from the paper, implemented as a structure-aware scanner
 * (no TypeScript compiler dependency — works at runtime without tsc).
 *
 * Maps:
 *   'use step' calls  → step sites
 *   sleep(...)        → timer sites
 *   createWebhook/createHook + await → hook sites
 *   Promise.all       → join-observed parallel group
 *   Promise.race/any  → race group
 */
import type { ParallelGroup, Site, StepGraph } from '../types.ts'
import { enrichGraphWithDemandInference } from './demand-infer.ts'

export interface ExtractOptions {
  /** Module path for qualified names (e.g. workflows/e2e.ts). */
  modulePath?: string
  /** Prefer module-qualified site names (Def 4.1 engine identity). */
  qualifiedNames?: boolean
}

export interface ExtractResult {
  /** One graph per 'use workflow' function. */
  workflows: Array<{ name: string, graph: StepGraph }>
  warnings: string[]
}

/**
 * Extract workflow step graphs from source text.
 */
export function extractGraphsFromSource (
  source: string,
  options: ExtractOptions = {}
): ExtractResult {
  const warnings: string[] = []
  const workflows: Array<{ name: string, graph: StepGraph }> = []
  const modulePath = options.modulePath ?? 'workflow'
  const qualified = options.qualifiedNames !== false

  // Find async function declarations (params may contain nested {} for types)
  const functions: Array<{ name: string, start: number, body: string }> = []
  const fnHeader = /(?:export\s+)?async\s+function\s+(\w+)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = fnHeader.exec(source)) !== null) {
    const name = m[1]
    const paramsEnd = findMatchingParen(source, m.index + m[0].length - 1)
    if (paramsEnd < 0) continue
    const braceStart = source.indexOf('{', paramsEnd)
    if (braceStart < 0) continue
    // skip if there's a non-whitespace non-{ between ) and {
    const between = source.slice(paramsEnd + 1, braceStart).trim()
    if (between.length > 0 && !between.startsWith(':')) continue
    // if return type: ) : Type {
    let bs = braceStart
    if (between.startsWith(':')) {
      bs = source.indexOf('{', paramsEnd)
    }
    const body = extractBalanced(source, bs)
    if (!body) continue
    functions.push({ name, start: bs, body })
  }

  // Arrow: const name = async (...) => {
  const arrowHeader = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*async\s*\(/g
  while ((m = arrowHeader.exec(source)) !== null) {
    const name = m[1]
    const paramsEnd = findMatchingParen(source, m.index + m[0].length - 1)
    if (paramsEnd < 0) continue
    const arrow = source.indexOf('=>', paramsEnd)
    if (arrow < 0) continue
    const braceStart = source.indexOf('{', arrow)
    if (braceStart < 0) continue
    const body = extractBalanced(source, braceStart)
    if (!body) continue
    if (functions.some(f => f.name === name && f.start === braceStart)) continue
    functions.push({ name, start: braceStart, body })
  }

  for (const fn of functions) {
    if (!hasDirective(fn.body, 'use workflow')) continue
    let graph = extractFromWorkflowBody(fn.body, fn.name, modulePath, qualified, warnings)
    // §4.1 access-path demand inference on the workflow body
    const enriched = enrichGraphWithDemandInference(fn.body, graph)
    graph = enriched.graph
    warnings.push(...enriched.inference.warnings)
    workflows.push({ name: fn.name, graph })
  }

  if (workflows.length === 0) {
    warnings.push('no use workflow functions found')
  }

  return { workflows, warnings }
}

function hasDirective (body: string, directive: string): boolean {
  // 'use workflow' or "use workflow" as expression statement
  const re = new RegExp(`['"]${directive}['"]\\s*;?`)
  return re.test(body)
}

/** Find index of matching ')' for '(' at openIdx. */
function findMatchingParen (src: string, openIdx: number): number {
  if (src[openIdx] !== '(') return -1
  let depth = 0
  let inStr: string | null = null
  let escape = false
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (escape) { escape = false; continue }
      if (c === '\\') { escape = true; continue }
      if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return i
    } else if (c === '{' || c === '[') {
      // track nested brackets so types like { id: string } work inside params
      const close = c === '{' ? '}' : ']'
      let d2 = 1
      i++
      while (i < src.length && d2 > 0) {
        const c2 = src[i]
        if (!inStr) {
          if (c2 === '"' || c2 === "'" || c2 === '`') { inStr = c2 } else if (c2 === c) d2++
          else if (c2 === close) d2--
        } else if (c2 === inStr && src[i - 1] !== '\\') {
          inStr = null
        }
        if (d2 > 0) i++
      }
    }
  }
  return -1
}

function extractBalanced (src: string, openIdx: number): string | null {
  if (src[openIdx] !== '{') return null
  let depth = 0
  let inStr: string | null = null
  let escape = false
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (escape) { escape = false; continue }
      if (c === '\\') { escape = true; continue }
      if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return src.slice(openIdx, i + 1)
    }
  }
  return null
}

function extractFromWorkflowBody (
  body: string,
  workflowName: string,
  modulePath: string,
  qualified: boolean,
  warnings: string[]
): StepGraph {
  const sites: Site[] = []
  const edges: StepGraph['edges'] = []
  const parallelGroups: ParallelGroup[] = []
  let prev: string | null = null
  const usedNames = new Map<string, number>()

  const qname = (local: string) =>
    qualified ? `step//./${modulePath}//${local}` : local

  const addSite = (
    localName: string,
    kind: Site['label']['kind'],
    fingerprint?: string
  ): string => {
    const count = (usedNames.get(localName) ?? 0) + 1
    usedNames.set(localName, count)
    const id = count === 1 ? localName : `${localName}_${count}`
    const name = kind === 'step' ? qname(localName) : localName
    sites.push({
      id,
      label: { name, kind },
      fingerprint: fingerprint ?? (count > 1 ? `call:${count}` : undefined),
    })
    edges.push({ from: prev, to: id })
    prev = id
    return id
  }

  // Walk top-level statements roughly by scanning await expressions and Promise.all/race
  // Strip comments
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')

  // Process Promise.all / Promise.race blocks first so we can mark groups
  const parRe = /Promise\.(all|race|any)\s*\(\s*\[([\s\S]*?)\]\s*\)/g
  let parM: RegExpExecArray | null
  const parSpans: Array<{ start: number, end: number, kind: 'join' | 'race', inner: string }> = []
  while ((parM = parRe.exec(code)) !== null) {
    const kind = parM[1] === 'all' ? 'join' : 'race'
    parSpans.push({
      start: parM.index,
      end: parM.index + parM[0].length,
      kind,
      inner: parM[2],
    })
  }

  // Linear scan: find awaitables outside parallel spans, and expand parallel spans
  type Chunk =
    | { type: 'linear', text: string }
    | { type: 'par', kind: 'join' | 'race', inner: string }

  const chunks: Chunk[] = []
  let cursor = 0
  const sorted = [...parSpans].sort((a, b) => a.start - b.start)
  for (const p of sorted) {
    if (p.start > cursor) chunks.push({ type: 'linear', text: code.slice(cursor, p.start) })
    chunks.push({ type: 'par', kind: p.kind, inner: p.inner })
    cursor = p.end
  }
  if (cursor < code.length) chunks.push({ type: 'linear', text: code.slice(cursor) })

  let parIdx = 0
  for (const chunk of chunks) {
    if (chunk.type === 'linear') {
      scanLinear(chunk.text, addSite, warnings)
    } else {
      // Split branches by top-level commas
      const branches = splitTopLevel(chunk.inner, ',')
      const branchIds: string[][] = []
      const forkPrev = prev
      for (const br of branches) {
        prev = forkPrev // each branch starts from same fork point
        const startLen = sites.length
        scanLinear(br, (local, kind, fp) => {
          return addSite(local, kind, fp)
        }, warnings)
        const branchSiteIds = sites.slice(startLen).map(s => s.id)
        if (branchSiteIds.length && forkPrev !== null) {
          const firstId = branchSiteIds[0]
          const e = edges.find(x => x.to === firstId)
          if (e) e.from = forkPrev
        } else if (branchSiteIds.length && forkPrev === null) {
          const firstId = branchSiteIds[0]
          const e = edges.find(x => x.to === firstId)
          if (e) e.from = null
        }
        branchIds.push(branchSiteIds)
      }
      // After parallel, prev is undefined until join — use last sites of all branches
      // For sequential continuation, edges from each branch tip will be added on next addSite
      // Set prev to a synthetic join: next edge will need multi-pred. Approximate: last branch tip.
      const tips = branchIds.map(b => b[b.length - 1]).filter(Boolean) as string[]
      prev = tips[tips.length - 1] ?? forkPrev

      // When next site is added, only one edge from prev; also add edges from other tips
      const groupId = `par${parIdx++}`
      parallelGroups.push({
        id: groupId,
        kind: chunk.kind,
        branches: branchIds,
      })

      // Stash multi-join for next edge
      ;(addSite as any)._joinTips = tips
    }
  }

  // Second pass: for sites after parallel groups, fan-in edges from all tips
  // Simpler approach: walk parallel groups and ensure join edges exist when there's a successor
  for (const g of parallelGroups) {
    const tips = g.branches.map(b => b[b.length - 1]).filter(Boolean) as string[]
    // Find sites that have edge from one tip — add from other tips
    for (const tip of tips) {
      const successors = edges.filter(e => e.from === tip).map(e => e.to)
      for (const succ of successors) {
        for (const other of tips) {
          if (other === tip) continue
          if (!edges.some(e => e.from === other && e.to === succ)) {
            edges.push({ from: other, to: succ })
          }
        }
      }
    }
  }

  if (sites.length === 0) {
    warnings.push(`workflow ${workflowName}: no durable sites extracted`)
  }

  return {
    sites,
    edges,
    parallelGroups: parallelGroups.length ? parallelGroups : undefined,
    modulePath,
  }
}

function scanLinear (
  text: string,
  addSite: (local: string, kind: Site['label']['kind'], fp?: string) => string,
  _warnings: string[]
): void {
  // await sleep(...)
  const sleepRe = /\bawait\s+sleep\s*\(/g
  // await createWebhook / createHook
  const hookRe = /\bawait\s+(?:createWebhook|createHook)\s*\(/g
  // await foo(  where foo is not sleep/createHook — treat as step call
  // Also: await someCall(...) for step functions
  const awaitCallRe = /\bawait\s+([A-Za-z_$][\w$]*)\s*\(/g

  type Hit = { idx: number, kind: 'timer' | 'hook' | 'step', name: string }
  const hits: Hit[] = []

  let m: RegExpExecArray | null
  while ((m = sleepRe.exec(text)) !== null) {
    hits.push({ idx: m.index, kind: 'timer', name: 'sleep' })
  }
  while ((m = hookRe.exec(text)) !== null) {
    hits.push({ idx: m.index, kind: 'hook', name: 'hook' })
  }
  while ((m = awaitCallRe.exec(text)) !== null) {
    const name = m[1]
    if (name === 'sleep' || name === 'createWebhook' || name === 'createHook' ||
        name === 'Promise' || name === 'start') continue
    // Skip if this is already covered as sleep/hook at same position
    hits.push({ idx: m.index, kind: 'step', name })
  }

  hits.sort((a, b) => a.idx - b.idx)
  // Dedupe overlapping (sleep matches both sleepRe and awaitCall)
  const seen = new Set<number>()
  for (const h of hits) {
    // Snap to 10-char window
    const key = Math.floor(h.idx / 5)
    if (seen.has(key) && h.kind === 'step') continue
    if (h.kind === 'timer' || h.kind === 'hook') seen.add(key)
    if (h.kind === 'step' && seen.has(key)) continue
    seen.add(key)
    addSite(h.name, h.kind)
  }
}

function splitTopLevel (text: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inStr: string | null = null
  let escape = false
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (escape) { escape = false; continue }
      if (c === '\\') { escape = true; continue }
      if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  const last = text.slice(start).trim()
  if (last) parts.push(last)
  return parts.filter(p => p.length > 0)
}

/**
 * Extract a single workflow by name, or the first one.
 */
export function extractWorkflowGraph (
  source: string,
  workflowName?: string,
  options: ExtractOptions = {}
): StepGraph | null {
  const { workflows } = extractGraphsFromSource(source, options)
  if (workflowName) {
    return workflows.find(w => w.name === workflowName)?.graph ?? null
  }
  return workflows[0]?.graph ?? null
}
