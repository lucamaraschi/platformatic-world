/**
 * TypeScript AST demand inference (§4.1) using the TypeScript compiler API.
 *
 * Prefer this over the regex scanner when `typescript` is available (dev/CI).
 * Falls back to scanner-based inferDemandsFromSource if tsc cannot load.
 */
import { createRequire } from 'node:module'
import {
  inferDemandsFromSource,
  type DemandInferenceResult,
  type InferredDemand,
} from './demand-infer.ts'

type TsModule = typeof import('typescript')

let tsMod: TsModule | null | undefined

function loadTs (): TsModule | null {
  if (tsMod !== undefined) return tsMod
  try {
    const req = createRequire(import.meta.url)
    tsMod = req('typescript') as TsModule
    return tsMod
  } catch {
    tsMod = null
    return null
  }
}

export function isTsDemandAvailable (): boolean {
  return loadTs() !== null
}

/**
 * Infer demands via TypeScript AST. Returns null if typescript is unavailable.
 */
export function inferDemandsWithTypeScript (source: string): DemandInferenceResult | null {
  const ts = loadTs()
  if (!ts) return null

  let sf: import('typescript').SourceFile
  try {
    sf = ts.createSourceFile(
      'workflow.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
  } catch {
    return null
  }

  const bindingToProducer = new Map<string, string>()
  const demands: InferredDemand[] = []
  const warnings: string[] = []

  const skipProducers = new Set([
    'sleep', 'createHook', 'createWebhook', 'Promise', 'fetch', 'start',
  ])

  function producerFromCall (expr: import('typescript').Expression): string | null {
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
      const name = expr.expression.text
      return skipProducers.has(name) ? null : name
    }
    return null
  }

  function visit (node: import('typescript').Node): void {
    // const x = await foo()
    if (ts.isVariableDeclaration(node) && node.initializer) {
      let init = node.initializer
      if (ts.isAwaitExpression(init)) init = init.expression

      // Promise.all([foo(), bar()]) with array binding
      if (
        ts.isCallExpression(init) &&
        ts.isPropertyAccessExpression(init.expression) &&
        ts.isIdentifier(init.expression.expression) &&
        init.expression.expression.text === 'Promise' &&
        (init.expression.name.text === 'all' || init.expression.name.text === 'allSettled') &&
        init.arguments[0] &&
        ts.isArrayLiteralExpression(init.arguments[0]) &&
        ts.isArrayBindingPattern(node.name)
      ) {
        const elems = init.arguments[0].elements
        const binds = node.name.elements
        for (let i = 0; i < binds.length && i < elems.length; i++) {
          const be = binds[i]
          const el = elems[i]
          if (ts.isOmittedExpression(el as import('typescript').Expression)) continue
          if (!ts.isBindingElement(be) || !ts.isIdentifier(be.name)) continue
          let call: import('typescript').Expression = el as import('typescript').Expression
          if (ts.isAwaitExpression(call)) call = call.expression
          const p = producerFromCall(call)
          if (p) bindingToProducer.set(be.name.text, p)
        }
      } else if (ts.isIdentifier(node.name)) {
        const p = producerFromCall(init)
        if (p) bindingToProducer.set(node.name.text, p)
        else if (ts.isIdentifier(init) && bindingToProducer.has(init.text)) {
          bindingToProducer.set(node.name.text, bindingToProducer.get(init.text)!)
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        const p = producerFromCall(init)
        if (p) {
          const fields: string[] = []
          for (const el of node.name.elements) {
            if (!ts.isBindingElement(el)) continue
            const id = el.propertyName && ts.isIdentifier(el.propertyName)
              ? el.propertyName.text
              : ts.isIdentifier(el.name) ? el.name.text : null
            if (id) fields.push(id)
          }
          demands.push({
            binding: `await:${p}`,
            producerStep: p,
            fields,
            verdict: fields.length ? 'fields' : 'none',
          })
        } else if (ts.isIdentifier(init) && bindingToProducer.has(init.text)) {
          const prod = bindingToProducer.get(init.text)!
          const fields: string[] = []
          for (const el of node.name.elements) {
            if (!ts.isBindingElement(el)) continue
            const id = el.propertyName && ts.isIdentifier(el.propertyName)
              ? el.propertyName.text
              : ts.isIdentifier(el.name) ? el.name.text : null
            if (id) fields.push(id)
          }
          demands.push({
            binding: init.text,
            producerStep: prod,
            fields,
            verdict: fields.length ? 'fields' : 'none',
          })
        }
      }
    }

    // x.foo
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && bindingToProducer.has(node.expression.text)) {
        demands.push({
          binding: node.expression.text,
          producerStep: bindingToProducer.get(node.expression.text)!,
          fields: [node.name.text],
          verdict: 'fields',
        })
      }
    }

    // x[expr] → unk
    if (ts.isElementAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && bindingToProducer.has(node.expression.text)) {
        demands.push({
          binding: node.expression.text,
          producerStep: bindingToProducer.get(node.expression.text)!,
          fields: [],
          verdict: 'unk',
          reason: `computed property access on ${node.expression.text}`,
        })
      }
    }

    // Reflect.get / get(
    if (ts.isCallExpression(node)) {
      let isDynamic = false
      const callex = node.expression
      if (
        ts.isPropertyAccessExpression(callex) &&
        ts.isIdentifier(callex.expression) &&
        callex.expression.text === 'Reflect' &&
        callex.name.text === 'get'
      ) {
        isDynamic = true
      }
      if (ts.isIdentifier(callex) && (callex.text === 'get' || callex.text === '_get')) {
        isDynamic = true
      }
      if (isDynamic && node.arguments[0] && ts.isIdentifier(node.arguments[0])) {
        const b = node.arguments[0].text
        if (bindingToProducer.has(b)) {
          demands.push({
            binding: b,
            producerStep: bindingToProducer.get(b)!,
            fields: [],
            verdict: 'unk',
            reason: `dynamic/reflective access on ${b}`,
          })
        }
      }
    }

    if (ts.isIfStatement(node)) {
      collectPredicateFields(node.expression, bindingToProducer, demands, ts)
    }

    ts.forEachChild(node, visit)
  }

  visit(sf)

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
    warnings.push('TS-AST: some consumer slices have dynamic access (unk demand)')
  }

  return { demands, byProducer, warnings }
}

function collectPredicateFields (
  expr: import('typescript').Expression,
  bindingToProducer: Map<string, string>,
  demands: InferredDemand[],
  ts: TsModule
): void {
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    if (bindingToProducer.has(expr.expression.text)) {
      demands.push({
        binding: expr.expression.text,
        producerStep: bindingToProducer.get(expr.expression.text)!,
        fields: [expr.name.text],
        verdict: 'fields',
      })
    }
  } else if (ts.isPrefixUnaryExpression(expr)) {
    collectPredicateFields(expr.operand as import('typescript').Expression, bindingToProducer, demands, ts)
  } else if (ts.isBinaryExpression(expr)) {
    collectPredicateFields(expr.left, bindingToProducer, demands, ts)
    collectPredicateFields(expr.right, bindingToProducer, demands, ts)
  } else if (ts.isParenthesizedExpression(expr)) {
    collectPredicateFields(expr.expression, bindingToProducer, demands, ts)
  } else if (ts.isCallExpression(expr)) {
    for (const a of expr.arguments) {
      collectPredicateFields(a, bindingToProducer, demands, ts)
    }
  }
}

/** Prefer TypeScript AST; fall back to regex scanner. */
export function inferDemandsBestEffort (source: string): DemandInferenceResult {
  return inferDemandsWithTypeScript(source) ?? inferDemandsFromSource(source)
}
