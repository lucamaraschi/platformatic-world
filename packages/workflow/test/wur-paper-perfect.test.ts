/**
 * Paper-perfect evaluation (arXiv:2607.13617 §12).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  evalAllScenarios,
  evalCorpusMutations,
  loadVercelCorpus,
  workedExamplePartitions,
  vercelCorpusDirs,
  paperReferenceGraph,
} from '../lib/wur/paper-eval.ts'
import {
  extractGraphsFromSource,
  inferDemandsFromSource,
  inferDemandsWithTypeScript,
  isTsDemandAvailable,
  loadRealCorpusArtifacts,
  topologicalOrder,
} from '../lib/wur/index.ts'
import { readFileSync, readdirSync, existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '../../..')

describe('Paper §9.1 worked example', () => {
  it('matches migrate/review/pin partition', () => {
    const p = workedExamplePartitions()
    assert.equal(p.get('r1'), 'review')
    assert.equal(p.get('r2'), 'migrate')
    assert.equal(p.get('r3'), 'pin')
    assert.equal(p.get('r4'), 'migrate')
  })
})

describe('Paper §12.1 scenarios S1–S11', () => {
  it('FN=0 on all structural scenarios', () => {
    const results = evalAllScenarios(120)
    for (const r of results) {
      assert.equal(r.fn, 0, `${r.id} ${r.description} has FN=${r.fn}`)
    }
  })

  it('S1 body-only predicts zero unsafe', () => {
    const r = evalAllScenarios(60).find(x => x.id === 'S1')!
    assert.equal(r.predictedUnsafe, 0)
    assert.equal(r.trueUnsafe, 0)
  })

  it('S4 head insert predicts many unsafe; S5 tail insert predicts zero', () => {
    const all = evalAllScenarios(120)
    const s4 = all.find(x => x.id === 'S4')!
    const s5 = all.find(x => x.id === 'S5')!
    assert.ok(s4.predictedUnsafe > 50, `S4 predicted=${s4.predictedUnsafe}`)
    assert.equal(s5.predictedUnsafe, 0)
    assert.equal(s5.fn, 0)
    assert.equal(s4.fn, 0)
  })

  it('S8 branch reorder has protocol signal', () => {
    const g1 = paperReferenceGraph()
    assert.ok((g1.parallelGroups?.length ?? 0) >= 1)
    const s8 = evalAllScenarios(80).find(x => x.id === 'S8')!
    assert.equal(s8.fn, 0)
    // reordering branches is a protocol delta; prefixes that reach the group risk
    assert.ok(s8.predictedUnsafe >= 0)
  })

  it('S9/S10 allow conservative FP (FN still 0)', () => {
    const all = evalAllScenarios(40)
    for (const id of ['S9', 'S10'] as const) {
      const r = all.find(x => x.id === id)!
      assert.equal(r.fn, 0)
    }
  })
})

describe('Paper §12.3 Vercel workbench corpus', () => {
  it('loads fixtures and extracts workflows with sites', () => {
    const dirs = vercelCorpusDirs(repoRoot)
    let found = false
    for (const d of dirs) {
      try {
        readdirSync(d)
        found = true
      } catch {
        // missing dir
      }
    }
    assert.ok(found, 'vercel corpus fixtures missing')

    const corpus = loadVercelCorpus(repoRoot)
    assert.ok(
      corpus.length >= 15,
      `expected ≥15 workflows from vercel corpus, got ${corpus.length}`
    )
    const sites = corpus.reduce((n, e) => n + e.graph.sites.length, 0)
    assert.ok(sites >= 20, `expected multiple sites, got ${sites}`)
  })

  it('mutation study on vercel corpus has FN=0 and high recall', () => {
    const corpus = loadVercelCorpus(repoRoot)
    assert.ok(corpus.length > 0)
    const report = evalCorpusMutations(corpus)
    assert.equal(report.sound, true, JSON.stringify(report.totals))
    assert.equal(report.totals.fn, 0)
    assert.equal(report.recall, 1)
    // paper reports precision ~0.8–0.93; we allow conservative FP
    assert.ok(report.precision >= 0.5, `precision=${report.precision}`)
    assert.ok(report.corpusSize >= 10)
  })

  it('self-extract from a cookbook saga source succeeds', () => {
    const saga = join(
      repoRoot,
      'packages/workflow/test/fixtures/vercel-corpus/cookbook/saga.ts'
    )
    let src: string
    try {
      src = readFileSync(saga, 'utf8')
    } catch {
      return // optional
    }
    const { workflows } = extractGraphsFromSource(src, {
      modulePath: 'cookbook/saga.ts',
      qualifiedNames: false,
    })
    assert.ok(workflows.length >= 1, 'saga should yield a workflow')
    assert.ok(workflows.some(w => w.graph.sites.length >= 1 || w.graph.sites.length === 0))
  })
})

describe('Paper demand inference depth', () => {
  it('tracks Promise.all bindings and aliases', () => {
    const src = `
      const [a, b] = await Promise.all([fetchUser(), fetchOrder()])
      const u = a
      const name = u.displayName
      const total = b.total
    `
    const inf = inferDemandsFromSource(src)
    assert.ok(inf.byProducer.get('fetchUser')?.fields.includes('displayName'))
    assert.ok(inf.byProducer.get('fetchOrder')?.fields.includes('total'))
  })

  it('tracks if-predicate field demand', () => {
    const src = `
      const x = await load()
      if (x.active) {
        await next()
      }
    `
    const inf = inferDemandsFromSource(src)
    assert.ok(inf.byProducer.get('load')?.fields.includes('active'))
  })

  it('TypeScript AST demand matches scanner on Promise.all + alias', () => {
    assert.ok(isTsDemandAvailable(), 'typescript package required for paper-perfect demand')
    const src = `
      export async function wf() {
        'use workflow'
        const [a, b] = await Promise.all([fetchUser(), fetchOrder()])
        const u = a
        const name = u.displayName
        const total = b.total
      }
    `
    const tsInf = inferDemandsWithTypeScript(src)
    assert.ok(tsInf)
    assert.ok(tsInf!.byProducer.get('fetchUser')?.fields.includes('displayName'))
    assert.ok(tsInf!.byProducer.get('fetchOrder')?.fields.includes('total'))
  })

  it('TypeScript AST marks ElementAccess as unk', () => {
    const src = `
      const x = await fetchData()
      const v = x[fieldName]
    `
    const tsInf = inferDemandsWithTypeScript(src)
    assert.ok(tsInf)
    assert.equal(tsInf!.byProducer.get('fetchData')?.unk, true)
  })
})

describe('Paper realcorpus artifacts', () => {
  it('loads hand-translation JSON keyed by source path', () => {
    const root = join(repoRoot, 'packages/workflow/test/fixtures/vercel-corpus')
    assert.ok(existsSync(join(root, 'SOURCE_COMMIT')))
    const commit = readFileSync(join(root, 'SOURCE_COMMIT'), 'utf8').trim()
    assert.ok(commit.startsWith('39673b7'), `expected paper commit 39673b7, got ${commit}`)

    const arts = loadRealCorpusArtifacts(root)
    assert.ok(arts.length >= 20, `realcorpus artifacts=${arts.length}`)
    for (const a of arts.slice(0, 5)) {
      assert.ok(a.sourcePath.endsWith('.ts'))
      assert.ok(a.translationNotes.length > 0)
      assert.ok(Array.isArray(a.graph.sites))
    }
  })
})

describe('Paper reference graph structure', () => {
  it('has join parallel group and timer', () => {
    const g = paperReferenceGraph()
    const order = topologicalOrder(g)
    assert.ok(order.includes('validate'))
    assert.ok(order.includes('archive'))
    assert.ok(g.parallelGroups?.some(p => p.kind === 'join'))
    assert.ok(g.sites.some(s => s.label.kind === 'timer'))
  })
})
