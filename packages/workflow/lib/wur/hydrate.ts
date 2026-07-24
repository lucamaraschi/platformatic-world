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
 * Partial devalue-like decode.
 *
 * Full devalue needs the SDK serializer. We support:
 *  - "devl" / "devalue:" + JSON payload
 *  - flattened value arrays with numeric back-refs (best-effort expand to record)
 *  - otherwise opaque → lattice unk
 */
function hydrateDevalueLike (buf: Buffer): HydratedValue {
  const text = buf.toString('utf-8')
  for (const prefix of [DEVALUE_PREFIX, 'devalue:', 'devalue']) {
    if (text.startsWith(prefix)) {
      let rest = text.slice(prefix.length)
      if (rest.startsWith(':')) rest = rest.slice(1)
      try {
        return classifyHydrated(JSON.parse(rest))
      } catch {
        break
      }
    }
  }
  try {
    return classifyHydrated(JSON.parse(text))
  } catch {
    // try UTF-8 after skipping binary header
    if (buf.length > 4) {
      try {
        const tail = buf.subarray(4).toString('utf-8')
        if (tail.startsWith('{') || tail.startsWith('[')) {
          return classifyHydrated(JSON.parse(tail))
        }
      } catch {
        // opaque
      }
    }
    return { kind: 'opaque', value: buf, recordInspectable: false }
  }
}

/**
 * Best-effort expand devalue flattened form:
 *   [0, {"id":1,"name":2}, "x", "y"] with back-refs as numbers
 * into a plain object when the root is an object index.
 */
export function expandDevalueFlat (arr: unknown[]): HydratedValue {
  if (!Array.isArray(arr) || arr.length === 0) {
    return { kind: 'array', value: arr, recordInspectable: false }
  }
  // Heuristic: if any element is a plain object with string keys, treat as value table
  const hasObj = arr.some(x => x !== null && typeof x === 'object' && !Array.isArray(x))
  if (!hasObj) {
    return { kind: 'array', value: arr, recordInspectable: false }
  }

  const resolve = (ref: unknown, depth = 0): unknown => {
    if (depth > 32) return undefined
    // Numeric refs index into the table (including when root is a pointer)
    if (typeof ref === 'number' && Number.isInteger(ref) && ref >= 0 && ref < arr.length) {
      const v = arr[ref]
      // Follow pointer chains (root → object slot)
      if (typeof v === 'number' && Number.isInteger(v)) {
        return resolve(v, depth + 1)
      }
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const out: Record<string, unknown> = {}
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          out[k] = typeof val === 'number' ? resolve(val, depth + 1) : val
        }
        return out
      }
      if (Array.isArray(v)) {
        return v.map(x => (typeof x === 'number' ? resolve(x, depth + 1) : x))
      }
      return v
    }
    return ref
  }

  const root = resolve(0)
  if (root !== null && typeof root === 'object' && !Array.isArray(root)) {
    return { kind: 'record', value: root, recordInspectable: true }
  }
  return { kind: 'array', value: arr, recordInspectable: false }
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
    // Attempt devalue flat expansion
    const expanded = expandDevalueFlat(value)
    if (expanded.recordInspectable) return expanded
    return { kind: 'array', value, recordInspectable: false }
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    // Typed wrapper tags (common in structured serializers)
    if (o.__type === 'Date' || o.__type === 'Map' || o.__type === 'Set' ||
        o.$type === 'Date' || o.$type === 'Map' || o.$type === 'Set') {
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
