/**
 * Access-path demand inference for consumer slices (§4.1, Lem 4.5).
 *
 * Scans workflow source for uses of step results and infers demand fields:
 *   - member access:  x.foo, x?.bar
 *   - destructuring:  const { a, b } = x
 *   - computed access: x[expr] → entire payload unk (conservative)
 *
 * Dynamic/reflective paths (Reflect.get, lodash.get, JSON.parse) → unk.
 */

export type DemandVerdict = 'fields' | 'unk' | 'none'

export interface InferredDemand {
  /** Local binding name of the producer result. */
  binding: string
  /** Producer step call name if known (from await foo()). */
  producerStep?: string
  /** Demanded field names (empty if unk or none). */
  fields: string[]
  verdict: DemandVerdict
  /** Human-readable reason for unk. */
  reason?: string
}

export interface DemandInferenceResult {
  demands: InferredDemand[]
  /** producerStep → demanded fields (merged). */
  byProducer: Map<string, { fields: string[], unk: boolean }>
  warnings: string[]
}

/**
 * Infer consumption contracts from a workflow function body (regex scanner).
 * Prefer `inferDemandsBestEffort` from ts-demand.ts when TypeScript is available.
 */
export function inferDemandsFromSource (source: string): DemandInferenceResult {
  const warnings: string[] = []
  const demands: InferredDemand[] = []

  // Map: local binding → producer step name
  const bindingToProducer = new Map<string, string>()
  const awaitBindRe =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+([A-Za-z_$][\w$]*)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = awaitBindRe.exec(source)) !== null) {
    const binding = m[1]
    const producer = m[2]
    if (['sleep', 'createHook', 'createWebhook', 'Promise', 'fetch', 'start'].includes(producer)) continue
    bindingToProducer.set(binding, producer)
  }

  // Promise.all / allSettled array destructure:
  //   const [a, b] = await Promise.all([foo(), bar()])
  const pallRe =
    /(?:const|let|var)\s*\[([^\]]+)\]\s*=\s*await\s+Promise\.(?:all|allSettled)\s*\(\s*\[([\s\S]*?)\]\s*\)/g
  while ((m = pallRe.exec(source)) !== null) {
    const binds = m[1].split(',').map(s => s.trim()).filter(Boolean)
    const calls = [...m[2].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map(x => x[1])
    for (let i = 0; i < binds.length && i < calls.length; i++) {
      const b = binds[i].replace(/^\.\.\./, '')
      if (/^[A-Za-z_$]/.test(b) && !['sleep', 'Promise'].includes(calls[i])) {
        bindingToProducer.set(b, calls[i])
      }
    }
  }

  // Aliasing: const y = x (after all producer bindings known)
  const aliasRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*[;\n]/g
  while ((m = aliasRe.exec(source)) !== null) {
    const alias = m[1]
    const src = m[2]
    if (bindingToProducer.has(src) && !bindingToProducer.has(alias)) {
      bindingToProducer.set(alias, bindingToProducer.get(src)!)
    }
  }

  // Destructuring assignment from await: const { a, b } = await foo()
  const destructAwaitRe =
    /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*await\s+([A-Za-z_$][\w$]*)\s*\(/g
  while ((m = destructAwaitRe.exec(source)) !== null) {
    const fields = parseDestructureFields(m[1])
    const producer = m[2]
    if (['sleep', 'createHook', 'createWebhook'].includes(producer)) continue
    demands.push({
      binding: `await:${producer}`,
      producerStep: producer,
      fields,
      verdict: fields.length ? 'fields' : 'none',
    })
  }

  for (const [binding, producer] of bindingToProducer) {
    const fieldSet = new Set<string>()
    let unk = false
    let unkReason: string | undefined

    // Member access: binding.field or binding?.field
    const memberRe = new RegExp(
      `\\b${escapeReg(binding)}\\s*\\?\\.\\s*([A-Za-z_$][\\w$]*)|\\b${escapeReg(binding)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`,
      'g'
    )
    let mm: RegExpExecArray | null
    while ((mm = memberRe.exec(source)) !== null) {
      const field = mm[1] || mm[2]
      if (field) fieldSet.add(field)
    }

    // Destructuring from binding: const { a, b: c } = binding
    const destRe = new RegExp(
      `(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*${escapeReg(binding)}\\b`,
      'g'
    )
    while ((mm = destRe.exec(source)) !== null) {
      for (const f of parseDestructureFields(mm[1])) fieldSet.add(f)
    }

    // Computed access: binding[expr] → unk
    const computedRe = new RegExp(`\\b${escapeReg(binding)}\\s*\\[`, 'g')
    if (computedRe.test(source)) {
      unk = true
      unkReason = `computed property access on ${binding}`
    }

    // Reflective / deep helpers
    if (
      new RegExp(`Reflect\\.get\\s*\\(\\s*${escapeReg(binding)}`).test(source) ||
      new RegExp(`(?:lodash\\.)?get\\s*\\(\\s*${escapeReg(binding)}`).test(source) ||
      new RegExp(`JSON\\.parse\\s*\\(\\s*(?:JSON\\.stringify\\s*\\(\\s*)?${escapeReg(binding)}`).test(source)
    ) {
      unk = true
      unkReason = unkReason ?? `dynamic/reflective access on ${binding}`
    }

    // Control-flow predicates: if (binding.flag) / switch (binding.kind)
    const ifRe = new RegExp(
      `\\bif\\s*\\(\\s*!??\\s*${escapeReg(binding)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`,
      'g'
    )
    while ((mm = ifRe.exec(source)) !== null) {
      if (mm[1]) fieldSet.add(mm[1])
    }

    if (unk) {
      demands.push({
        binding,
        producerStep: producer,
        fields: [...fieldSet],
        verdict: 'unk',
        reason: unkReason,
      })
    } else if (fieldSet.size > 0) {
      demands.push({
        binding,
        producerStep: producer,
        fields: [...fieldSet],
        verdict: 'fields',
      })
    } else {
      demands.push({
        binding,
        producerStep: producer,
        fields: [],
        verdict: 'none',
      })
    }
  }

  const byProducer = new Map<string, { fields: string[], unk: boolean }>()
  for (const d of demands) {
    if (!d.producerStep) continue
    const cur = byProducer.get(d.producerStep) ?? { fields: [], unk: false }
    if (d.verdict === 'unk') cur.unk = true
    for (const f of d.fields) {
      if (!cur.fields.includes(f)) cur.fields.push(f)
    }
    byProducer.set(d.producerStep, cur)
  }

  if (demands.some(d => d.verdict === 'unk')) {
    warnings.push('some consumer slices have dynamic access (unk demand)')
  }

  return { demands, byProducer, warnings }
}

/**
 * Apply inferred demands onto a step graph (demand on consumer, consumesFrom producer).
 */
export function applyDemandsToGraph (
  graph: import('../types.ts').StepGraph,
  inference: DemandInferenceResult
): import('../types.ts').StepGraph {
  const sites = graph.sites.map(s => ({ ...s, demandFields: s.demandFields ? [...s.demandFields] : undefined, consumesFrom: s.consumesFrom ? [...s.consumesFrom] : undefined }))
  const byName = new Map<string, typeof sites>()
  for (const s of sites) {
    const bare = bareName(s.label.name)
    if (!byName.has(bare)) byName.set(bare, [])
    byName.get(bare)!.push(s)
  }

  for (const [producerName, dem] of inference.byProducer) {
    const producers = byName.get(producerName) ?? []
    if (producers.length === 0) continue
    const producer = producers[0]

    const order = sites.map(s => s.id)
    const pi = order.indexOf(producer.id)
    let consumer = pi >= 0 && pi < sites.length - 1 ? sites[pi + 1] : null
    if (!consumer || consumer.id === producer.id) {
      consumer = sites.find(s => s.id !== producer.id) ?? null
    }
    if (!consumer) continue

    consumer.consumesFrom = [...new Set([...(consumer.consumesFrom ?? []), producer.id])]
    if (dem.unk) {
      consumer.demandFields = ['*']
    } else if (dem.fields.length) {
      consumer.demandFields = [...new Set([...(consumer.demandFields ?? []), ...dem.fields])]
    }
  }

  return { ...graph, sites }
}

function bareName (qualified: string): string {
  const parts = qualified.split('//')
  return parts[parts.length - 1] || qualified
}

function parseDestructureFields (inner: string): string[] {
  const fields: string[] = []
  for (const part of inner.split(',')) {
    const t = part.trim()
    if (!t || t.startsWith('...')) continue
    const name = t.split(':')[0].trim()
    if (/^[A-Za-z_$][\w$]*$/.test(name)) fields.push(name)
  }
  return fields
}

function escapeReg (s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function enrichGraphWithDemandInference (
  source: string,
  graph: import('../types.ts').StepGraph,
  inference?: DemandInferenceResult
): { graph: import('../types.ts').StepGraph, inference: DemandInferenceResult } {
  const inf = inference ?? inferDemandsFromSource(source)
  return { graph: applyDemandsToGraph(graph, inf), inference: inf }
}
