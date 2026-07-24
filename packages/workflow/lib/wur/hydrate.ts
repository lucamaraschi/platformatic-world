/**
 * Payload hydration for WUR interface lattice (Def 4.3, Rem 3.5).
 *
 * Uses the `devalue` library (same as Workflow SDK) for `devl`-prefixed
 * payloads. Field presence is only well-defined after hydration.
 * Typed wrappers (Date, Map, Set) sit outside the record lattice → unk.
 *
 * Encrypted (`encr`) payloads cannot be field-checked without a key → opaque.
 */
import { parse as devalueParse, stringify as devalueStringify, unflatten as devalueUnflatten } from 'devalue'

export type HydratedKind =
  | 'null'
  | 'primitive'
  | 'record'
  | 'array'
  | 'date'
  | 'map'
  | 'set'
  | 'opaque'
  | 'encrypted'
  | 'unknown'

export interface HydratedValue {
  kind: HydratedKind
  value: unknown
  recordInspectable: boolean
  /** Detected format prefix if any (devl, encr, …). */
  format?: string
}

const FORMAT_LEN = 4
const RE_FORMAT = /^[a-z0-9]{4}$/

/** Minimal revivers for common devalue reducers used without full SDK globals. */
const WUR_REVIVERS: Record<string, (value: any) => any> = {
  Date: (v: string | number) => new Date(v),
  URL: (v: string) => {
    try { return new URL(v) } catch { return v }
  },
  // Map/Set: devalue passes entries arrays
  Map: (v: [any, any][]) => new Map(v),
  Set: (v: any[]) => new Set(v),
  // Unknown custom types: keep structural data if object-like
  Error: (v: any) => (typeof v === 'object' && v !== null ? { ...v, __type: 'Error' } : v),
}

/**
 * Hydrate protocol event payloads for interface lattice checks.
 */
export function hydrateEventData (
  raw: unknown,
  _specVersion?: number | null
): HydratedValue {
  if (raw === null || raw === undefined) {
    return { kind: 'null', value: null, recordInspectable: false }
  }

  if (typeof raw === 'string') {
    if (/^[A-Za-z0-9+/_=-]+$/.test(raw) && raw.length > 8) {
      try {
        const buf = Buffer.from(raw, 'base64')
        // round-trip check (standard or url-safe-ish)
        if (buf.length > 0) {
          const b64 = buf.toString('base64')
          if (b64 === raw || b64.replace(/=+$/, '') === raw.replace(/=+$/, '')) {
            return hydrateBuffer(buf)
          }
        }
      } catch {
        // fall through
      }
    }
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        return classifyHydrated(JSON.parse(raw))
      } catch {
        // try devalue text without prefix
        return tryDevalueString(raw)
      }
    }
    // devalue-encoded string without binary prefix
    const d = tryDevalueString(raw)
    if (d.kind !== 'opaque') return d
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

  // Format prefix: 4-byte [a-z0-9]
  if (buf.length >= FORMAT_LEN) {
    const prefix = buf.subarray(0, FORMAT_LEN).toString('utf-8')
    if (RE_FORMAT.test(prefix)) {
      const payload = buf.subarray(FORMAT_LEN)
      if (prefix === 'encr') {
        return { kind: 'encrypted', value: buf, recordInspectable: false, format: prefix }
      }
      if (prefix === 'devl') {
        return hydrateDevaluePayload(payload, prefix)
      }
      // unknown format (e.g. cbor) — try devalue/json on payload anyway
      const attempt = hydrateDevaluePayload(payload, prefix)
      if (attempt.kind !== 'opaque') return attempt
      return { kind: 'opaque', value: buf, recordInspectable: false, format: prefix }
    }
  }

  // JSON
  if (buf[0] === 0x7b || buf[0] === 0x5b || buf[0] === 0x22) {
    try {
      return classifyHydrated(JSON.parse(buf.toString('utf-8')))
    } catch {
      // fall through
    }
  }

  // bare devalue text
  return tryDevalueString(buf.toString('utf-8'))
}

function hydrateDevaluePayload (payload: Buffer | Uint8Array, format?: string): HydratedValue {
  const text = Buffer.from(payload).toString('utf-8')
  const parsed = tryDevalueString(text)
  if (parsed.kind !== 'opaque') {
    return { ...parsed, format: format ?? parsed.format }
  }
  // legacy flattened array as JSON
  try {
    const j = JSON.parse(text)
    if (Array.isArray(j)) {
      try {
        const v = devalueUnflatten(j, WUR_REVIVERS)
        return { ...classifyHydrated(v), format }
      } catch {
        return { ...expandDevalueFlat(j), format }
      }
    }
    return { ...classifyHydrated(j), format }
  } catch {
    return { kind: 'opaque', value: payload, recordInspectable: false, format }
  }
}

function tryDevalueString (text: string): HydratedValue {
  try {
    const v = devalueParse(text, WUR_REVIVERS)
    return classifyHydrated(v)
  } catch {
    return { kind: 'opaque', value: text, recordInspectable: false }
  }
}

/**
 * Expand devalue flattened form / legacy unflatten input.
 */
export function expandDevalueFlat (arr: unknown[]): HydratedValue {
  if (!Array.isArray(arr) || arr.length === 0) {
    return { kind: 'array', value: arr, recordInspectable: false }
  }
  // Real devalue tables only — accept unflatten when it yields a useful value
  try {
    const v = devalueUnflatten(arr as any[], WUR_REVIVERS)
    const c = classifyHydrated(v)
    if (c.recordInspectable || (c.kind !== 'primitive' && c.kind !== 'null')) {
      return c
    }
    // unflatten returned a bare primitive index — try pointer-table expand
  } catch {
    // manual pointer table fallback
  }
  const hasObj = arr.some(x => x !== null && typeof x === 'object' && !Array.isArray(x))
  if (!hasObj) {
    return { kind: 'array', value: arr, recordInspectable: false }
  }

  const resolve = (ref: unknown, depth = 0): unknown => {
    if (depth > 32) return undefined
    if (typeof ref === 'number' && Number.isInteger(ref) && ref >= 0 && ref < arr.length) {
      const v = arr[ref]
      if (typeof v === 'number' && Number.isInteger(v)) return resolve(v, depth + 1)
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
  if (value instanceof URL) {
    return { kind: 'unknown', value, recordInspectable: false }
  }
  if (Array.isArray(value)) {
    const expanded = expandDevalueFlat(value)
    if (expanded.recordInspectable) return expanded
    return { kind: 'array', value, recordInspectable: false }
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (o.__type === 'Date' || o.__type === 'Map' || o.__type === 'Set' ||
        o.$type === 'Date' || o.$type === 'Map' || o.$type === 'Set' ||
        o.__type === 'Error') {
      // Error-like may still have message fields — not full record lattice
      if (o.__type === 'Error' && typeof o === 'object') {
        return { kind: 'record', value: o, recordInspectable: true }
      }
      return { kind: 'unknown', value, recordInspectable: false }
    }
    return { kind: 'record', value, recordInspectable: true }
  }
  return { kind: 'primitive', value, recordInspectable: false }
}

export function asRecord (h: HydratedValue): Record<string, unknown> | null {
  if (!h.recordInspectable || h.kind !== 'record') return null
  return h.value as Record<string, unknown>
}

export function hydrateToValue (raw: unknown, specVersion?: number | null): unknown {
  return hydrateEventData(raw, specVersion).value
}

/**
 * Serialize a plain value the way the SDK does for step results (devl + devalue).
 * Useful for tests and fixtures.
 */
export function dehydrateForTest (value: unknown): Buffer {
  const str = devalueStringify(value)
  const body = Buffer.from(str, 'utf-8')
  const out = Buffer.alloc(FORMAT_LEN + body.length)
  out.write('devl', 0, 'utf-8')
  body.copy(out, FORMAT_LEN)
  return out
}
