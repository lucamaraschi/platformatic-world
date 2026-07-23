/**
 * Payload hydration for WUR interface lattice (Def 4.3, Rem 3.5).
 *
 * Field presence is only well-defined after hydration. Typed wrappers
 * (Date, Map, Set, cycles) sit outside the record lattice → unk.
 */

export type HydratedKind =
  | 'null'
  | 'primitive'
  | 'record'
  | 'array'
  | 'date'
  | 'map'
  | 'set'
  | 'opaque'
  | 'unknown'

export interface HydratedValue {
  kind: HydratedKind
  /** Plain JS value when inspectable as a record/array/primitive. */
  value: unknown
  /** True when lattice field checks are sound. */
  recordInspectable: boolean
}

const DEVALUE_PREFIX = 'devl'

/**
 * Best-effort hydrate of protocol event payloads.
 * Supports: plain JSON, base64-wrapped JSON, devalue-framed buffers (partial).
 */
export function hydrateEventData (
  raw: unknown,
  _specVersion?: number | null
): HydratedValue {
  if (raw === null || raw === undefined) {
    return { kind: 'null', value: null, recordInspectable: false }
  }

  if (typeof raw === 'string') {
    // base64?
    if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length > 8) {
      try {
        const buf = Buffer.from(raw, 'base64')
        if (buf.toString('base64') === raw || buf.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) {
          return hydrateBuffer(buf)
        }
      } catch {
        // fall through
      }
    }
    // JSON string
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        return classifyHydrated(JSON.parse(raw))
      } catch {
        return { kind: 'primitive', value: raw, recordInspectable: false }
      }
    }
    return { kind: 'primitive', value: raw, recordInspectable: false }
  }

  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    return hydrateBuffer(Buffer.from(raw))
  }

  if (typeof raw === 'object' && raw !== null && '__opaque' in (raw as object)) {
    const o = raw as { base64?: string }
    if (o.base64) {
      try {
        return hydrateBuffer(Buffer.from(o.base64, 'base64'))
      } catch {
        return { kind: 'opaque', value: raw, recordInspectable: false }
      }
    }
    return { kind: 'opaque', value: raw, recordInspectable: false }
  }

  return classifyHydrated(raw)
}

function hydrateBuffer (buf: Buffer): HydratedValue {
  if (buf.length === 0) {
    return { kind: 'null', value: null, recordInspectable: false }
  }
  // JSON
  if (buf[0] === 0x7b || buf[0] === 0x5b || buf[0] === 0x22) {
    try {
      return classifyHydrated(JSON.parse(buf.toString('utf-8')))
    } catch {
      // fall through
    }
  }
  // devalue "devl" prefix — structured serialization with typed wrappers
  const head = buf.subarray(0, 4).toString('utf-8')
  if (head.startsWith(DEVALUE_PREFIX) || buf[0] === 0x64 /* 'd' */) {
    return hydrateDevalueLike(buf)
  }
  return { kind: 'opaque', value: buf, recordInspectable: false }
}

/**
 * Partial devalue-like decode: try JSON after prefix strip; otherwise opaque.
 * Full devalue requires the SDK serializer; WUR treats unparsed wrappers as unk.
 */
function hydrateDevalueLike (buf: Buffer): HydratedValue {
  const text = buf.toString('utf-8')
  // Sometimes framed as devl + JSON
  for (const prefix of [DEVALUE_PREFIX, 'devalue:']) {
    if (text.startsWith(prefix)) {
      const rest = text.slice(prefix.length)
      try {
        return classifyHydrated(JSON.parse(rest))
      } catch {
        break
      }
    }
  }
  // Try full buffer as JSON
  try {
    return classifyHydrated(JSON.parse(text))
  } catch {
    return { kind: 'opaque', value: buf, recordInspectable: false }
  }
}

function classifyHydrated (value: unknown): HydratedValue {
  if (value === null || value === undefined) {
    return { kind: 'null', value: null, recordInspectable: false }
  }
  if (value instanceof Date) {
    return { kind: 'date', value, recordInspectable: false }
  }
  if (value instanceof Map) {
    return { kind: 'map', value, recordInspectable: false }
  }
  if (value instanceof Set) {
    return { kind: 'set', value, recordInspectable: false }
  }
  if (Array.isArray(value)) {
    // devalue flattened form is an array with special markers — treat as opaque
    // if it looks like a devalue wire format (sparse typed tags). Conservative:
    // plain arrays of objects are inspectable element-wise only for index fields.
    return { kind: 'array', value, recordInspectable: false }
  }
  if (typeof value === 'object') {
    // Detect revived typed wrappers
    const o = value as Record<string, unknown>
    if (o.__type === 'Date' || o.__type === 'Map' || o.__type === 'Set') {
      return { kind: 'unknown', value, recordInspectable: false }
    }
    return { kind: 'record', value, recordInspectable: true }
  }
  return { kind: 'primitive', value, recordInspectable: false }
}

/** Extract plain record for field-presence checks, or null if not inspectable. */
export function asRecord (h: HydratedValue): Record<string, unknown> | null {
  if (!h.recordInspectable || h.kind !== 'record') return null
  return h.value as Record<string, unknown>
}

/** Convenience: hydrate and return value for payload maps. */
export function hydrateToValue (raw: unknown, specVersion?: number | null): unknown {
  return hydrateEventData(raw, specVersion).value
}
