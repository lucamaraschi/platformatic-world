/**
 * Compatibility lattice over record-like payload types (Def 4.3).
 */
export type LatticeRelation = 'compatible' | 'incompatible' | 'unknown'

export type FieldType =
  | 'any'
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'optional'

/** Field schema: name → type descriptor. */
export type FieldSchema = Record<string, FieldType | { type: FieldType, optional?: boolean }>

function normalizeField (f: FieldType | { type: FieldType, optional?: boolean }): {
  type: FieldType
  optional: boolean
} {
  if (typeof f === 'string') {
    return { type: f, optional: f === 'optional' }
  }
  return { type: f.type, optional: f.optional === true || f.type === 'optional' }
}

/**
 * Does producer guarantee C satisfy consumer demand D? (reader/writer lattice)
 * D ⊑ C means consumer is weaker or equal (compatible rehydration).
 * In paper terms: D₂ ⊉ C₁ is incompatible when consumer demands more.
 */
export function latticeCompare (
  producer: FieldSchema,
  consumer: FieldSchema
): LatticeRelation {
  for (const [name, raw] of Object.entries(consumer)) {
    const dem = normalizeField(raw)
    const prodRaw = producer[name]
    if (prodRaw === undefined) {
      if (dem.optional) continue
      return 'incompatible' // required field missing from producer guarantee
    }
    const prod = normalizeField(prodRaw)
    // narrowing is incompatible
    if (isNarrowing(prod.type, dem.type)) return 'incompatible'
  }
  return 'compatible'
}

function isNarrowing (from: FieldType, to: FieldType): boolean {
  if (to === 'any' || to === 'optional') return false
  if (from === 'any') return false // producer any, consumer specific — unknown at lattice level
  if (from === to) return false
  // widening producer is fine for consumer of wider type; narrowing producer type vs demand is bad
  // Here `from` is producer guarantee, `to` is consumer demand.
  // Incompatible if consumer needs a type the producer doesn't guarantee.
  if (from === 'number' && to === 'string') return true
  if (from === 'string' && to === 'number') return true
  if (from === 'boolean' && (to === 'string' || to === 'number')) return true
  return false
}

/**
 * Demand fields as schema from string list (all required any).
 */
export function fieldsToSchema (fields: string[]): FieldSchema {
  const s: FieldSchema = {}
  for (const f of fields) s[f] = 'any'
  return s
}

/**
 * Whether producer output fields cover consumer demand fields.
 */
export function coversDemand (
  outputFields: string[] | undefined,
  demandFields: string[] | undefined
): boolean {
  if (!demandFields?.length) return true
  const out = new Set(outputFields ?? [])
  // Empty producer guarantee ⇒ cannot prove cover (conservative)
  if (out.size === 0) return false
  return demandFields.every(f => out.has(f))
}
