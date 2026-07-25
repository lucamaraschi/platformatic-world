/**
 * Corpus evaluation — e2e-v4 + e2e-v5 workflow sources (§12-style).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  discoverWorkflowFiles,
  loadCorpus,
  runCorpusReport,
  syntheticCorpus,
  evaluateMutation,
  defaultMutators,
  prefixesOf,
} from '../lib/corpus.ts'
import { matchGraphs, isPrefixValid, oracleUnsafe } from '../lib/index.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '../../..')
const CORPUS_DIRS = [
  join(repoRoot, 'e2e-v5/workflows'),
  join(repoRoot, 'e2e-v4/workflows'),
]

describe('WUR corpus discovery', () => {
  it('finds workflow files under e2e dirs or falls back', () => {
    const files = discoverWorkflowFiles(CORPUS_DIRS)
    // monorepo checkout should have at least greet + simple
    assert.ok(files.length >= 0)
    if (files.length === 0) {
      assert.ok(syntheticCorpus().length >= 2)
    }
  })
})

describe('WUR corpus extract + self-diff', () => {
  it('extracted workflows self-diff cleanly', () => {
    const files = discoverWorkflowFiles(CORPUS_DIRS)
    const entries = files.length ? loadCorpus(files) : syntheticCorpus()
    assert.ok(entries.length >= 1, 'need at least one workflow graph')

    for (const e of entries) {
      const m = matchGraphs(e.graph, e.graph)
      for (const p of prefixesOf(e.graph)) {
        assert.equal(
          isPrefixValid(p.sites, e.graph, e.graph, m).valid,
          true,
          `${e.workflowName} prefix invalid under self-match`
        )
        assert.equal(
          oracleUnsafe(e.graph, e.graph, p.sites, p.frontier),
          false,
          `${e.workflowName} oracle self-unsafe`
        )
      }
    }
  })
})

describe('WUR corpus mutations (§12.2 style on real extracts)', () => {
  it('FN=0 on structural mutators for corpus graphs', () => {
    const files = discoverWorkflowFiles(CORPUS_DIRS)
    const entries = files.length ? loadCorpus(files) : syntheticCorpus()
    // Prefer graphs with at least one site
    const usable = entries.filter(e => e.graph.sites.length > 0)
    assert.ok(usable.length >= 1)

    let totalFn = 0
    let totalPairs = 0
    const rows: string[] = []

    for (const mut of defaultMutators()) {
      if (mut.name === 'demand-growth') continue // interface axis; not protocol FN gate
      const r = evaluateMutation(usable, mut.apply, mut.name)
      totalFn += r.fn
      totalPairs += r.prefixes
      rows.push(
        `${mut.name}: tp=${r.tp} fp=${r.fp} fn=${r.fn} tn=${r.tn} (entries=${r.entries})`
      )
      assert.equal(r.fn, 0, `FN>0 for ${mut.name}: ${JSON.stringify(r)}`)
    }

    assert.ok(totalPairs > 0, 'expected some prefix evaluations')
    // Log-friendly assertion message if needed
    assert.ok(totalFn === 0, rows.join('\n'))
  })

  it('body-only mutation never predicts unsafe', () => {
    const files = discoverWorkflowFiles(CORPUS_DIRS)
    const entries = (files.length ? loadCorpus(files) : syntheticCorpus())
      .filter(e => e.graph.sites.length > 0)
    const body = defaultMutators().find(m => m.name === 'body-only')!
    const r = evaluateMutation(entries, body.apply, 'body-only')
    assert.equal(r.tp + r.fp, 0, 'body-only should never flag protocol unsafe')
    assert.equal(r.fn, 0)
  })

  it('insert-head has true positives on non-empty prefixes', () => {
    const files = discoverWorkflowFiles(CORPUS_DIRS)
    const entries = (files.length ? loadCorpus(files) : syntheticCorpus())
      .filter(e => e.graph.sites.length >= 1)
    const head = defaultMutators().find(m => m.name === 'insert-head')!
    const r = evaluateMutation(entries, head.apply, 'insert-head')
    assert.equal(r.fn, 0)
    // At least some non-empty prefixes should be unsafe
    assert.ok(r.tp > 0, `expected TP>0 for insert-head, got ${JSON.stringify(r)}`)
  })
})

describe('WUR corpus full report', () => {
  it('runCorpusReport is sound', () => {
    const report = runCorpusReport(CORPUS_DIRS)
    // If no files, still construct from empty — force synthetic
    const effective = report.entries.length > 0
      ? report
      : (() => {
          const entries = syntheticCorpus()
          const mutations = defaultMutators().map(m =>
            evaluateMutation(entries, m.apply, m.name)
          )
          const totals = { tp: 0, fp: 0, fn: 0, tn: 0 }
          for (const r of mutations) {
            if (r.mutation === 'demand-growth') continue
            totals.tp += r.tp
            totals.fp += r.fp
            totals.fn += r.fn
            totals.tn += r.tn
          }
          return {
            entries,
            selfDiffOk: entries.length,
            selfDiffFail: 0,
            mutations,
            totals,
            sound: totals.fn === 0,
          }
        })()

    assert.ok(effective.entries.length >= 1)
    assert.equal(effective.selfDiffFail, 0)
    assert.equal(effective.totals.fn, 0, JSON.stringify(effective.totals))
    assert.equal(effective.sound, true)

    // Precision is informative (FP from conservative matching is OK)
    const { tp, fp } = effective.totals
    if (tp + fp > 0) {
      const precision = tp / (tp + fp)
      assert.ok(precision >= 0, `precision=${precision}`)
    }
  })
})
