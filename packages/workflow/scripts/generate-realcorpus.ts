#!/usr/bin/env node
/**
 * Generate paper §12.3 realcorpus JSON artifacts from vendored sources.
 *
 * Usage:
 *   node --experimental-strip-types packages/workflow/scripts/generate-realcorpus.ts
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateRealCorpusArtifacts } from '../lib/wur/static/realcorpus.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const corpusRoot = join(__dirname, '../test/fixtures/vercel-corpus')

const arts = generateRealCorpusArtifacts(corpusRoot)
console.log(`generated ${arts.length} realcorpus artifacts under ${corpusRoot}/realcorpus`)
for (const a of arts.slice(0, 10)) {
  console.log(`  ${a.sourcePath} :: ${a.workflowName} (${a.graph.sites.length} sites)`)
}
if (arts.length > 10) console.log(`  ... +${arts.length - 10} more`)
