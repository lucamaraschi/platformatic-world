#!/usr/bin/env node
/**
 * CI helper: compare workflow sources between two git SHAs and optionally
 * record change-class exposures into CalibrationStore.
 *
 * Env:
 *   WUR_BASE_SHA / WUR_HEAD_SHA  — commits to compare (required for PR mode)
 *   WUR_APP_ID                   — calibration app key (default: ci)
 *   DATABASE_URL                 — if set with WUR_RECORD=1, persist exposures
 *   WUR_RECORD=1                 — pass --record-exposure (needs DATABASE_URL or WUR_SERVICE_URL)
 *   WUR_SERVICE_URL              — HTTP calibration target (alt to DATABASE_URL)
 *   WUR_PATHS                    — space-separated path prefixes (default: e2e-v5/workflows e2e-v4/workflows)
 *   WUR_GATE=1                   — exit 1 if any compare has pin>0 or wur > WUR_MAX
 *   WUR_MAX                      — max fleet WUR when gating (default: 0.5)
 *   WUR_SMOKE=1                  — always run a self-diff smoke (default on)
 *   REPO_ROOT                    — monorepo root (default: cwd / git root)
 *
 * Usage (from monorepo root):
 *   WUR_BASE_SHA=abc WUR_HEAD_SHA=def pnpm --filter @platformatic/wur run ci:compare
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
/** Slim bin: `wur` args go straight to runWurCli (no `wur` subcommand prefix). */
const CLI = join(__dirname, '..', 'cli.js')

function env (k: string, fallback = ''): string {
  return (process.env[k] ?? fallback).trim()
}

function git (args: string[], cwd: string, opts?: { trim?: boolean }): { ok: boolean, out: string, err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  const trim = opts?.trim !== false
  const rawOut = r.stdout ?? ''
  const rawErr = r.stderr ?? ''
  return {
    ok: r.status === 0,
    out: trim ? rawOut.trim() : rawOut,
    err: rawErr.trim(),
  }
}

function findRepoRoot (): string {
  if (process.env.REPO_ROOT) return process.env.REPO_ROOT
  const r = git(['rev-parse', '--show-toplevel'], process.cwd())
  if (r.ok) return r.out
  return process.cwd()
}

function isZeroSha (sha: string): boolean {
  return !sha || /^0+$/.test(sha)
}

function pathUnderPrefixes (file: string, prefixes: string[]): boolean {
  const norm = file.replace(/\\/g, '/')
  return prefixes.some(p => {
    const pre = p.replace(/\\/g, '/').replace(/\/$/, '')
    return norm === pre || norm.startsWith(pre + '/')
  })
}

function listChangedWorkflows (root: string, base: string, head: string, prefixes: string[]): string[] {
  // Name-status so renames are handled; take the new path for R, both for C
  const r = git(['diff', '--name-only', '--diff-filter=ACMR', `${base}...${head}`], root)
  if (!r.ok) {
    console.error('git diff failed:', r.err || r.out)
    return []
  }
  return r.out
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
    .filter(f => pathUnderPrefixes(f, prefixes))
}

function showFile (root: string, sha: string, file: string): string | null {
  const r = git(['show', `${sha}:${file}`], root, { trim: false })
  if (!r.ok) return null
  return r.out
}

function hasUseWorkflow (source: string): boolean {
  return /['"]use workflow['"]/.test(source)
}

interface CompareResult {
  file: string
  code: number
  wur?: number
  pin?: number
  review?: number
  migrate?: number
  changeClasses?: string[]
  calibration?: unknown
  error?: string
}

function runWur (args: string[]): { code: number, stdout: string, stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: process.env,
  })
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  }
}

function comparePair (opts: {
  file: string
  v1: string
  v2: string
  appId: string
  record: boolean
  databaseUrl: string
  serviceUrl: string
  tmp: string
}): CompareResult {
  const { file, v1, v2, appId, record, databaseUrl, serviceUrl, tmp } = opts
  const safe = file.replace(/[/\\]/g, '__')
  const p1 = join(tmp, `${safe}.v1.ts`)
  const p2 = join(tmp, `${safe}.v2.ts`)
  mkdirSync(dirname(p1), { recursive: true })
  writeFileSync(p1, v1)
  writeFileSync(p2, v2)

  const args = [
    '--source-v1', p1,
    '--source-v2', p2,
    '--json',
  ]
  if (record) {
    args.push('--record-exposure', '--app-id', appId)
    if (databaseUrl) args.push('--database-url', databaseUrl)
    if (serviceUrl) args.push('--service-url', serviceUrl)
  }

  const { code, stdout, stderr } = runWur(args)
  if (code !== 0) {
    return { file, code, error: stderr || stdout || `exit ${code}` }
  }
  try {
    const body = JSON.parse(stdout) as {
      wur?: number
      partition?: { pin?: unknown[], review?: unknown[], migrate?: unknown[] }
      calibration?: { changeClasses?: string[] }
    }
    return {
      file,
      code: 0,
      wur: body.wur,
      pin: body.partition?.pin?.length ?? 0,
      review: body.partition?.review?.length ?? 0,
      migrate: body.partition?.migrate?.length ?? 0,
      changeClasses: body.calibration?.changeClasses,
      calibration: body.calibration,
    }
  } catch {
    return { file, code: 0, error: 'failed to parse wur JSON' }
  }
}

async function main (): Promise<number> {
  const root = findRepoRoot()
  const base = env('WUR_BASE_SHA')
  const head = env('WUR_HEAD_SHA', env('GITHUB_SHA'))
  const appId = env('WUR_APP_ID', 'ci')
  const databaseUrl = env('DATABASE_URL')
  const serviceUrl = env('WUR_SERVICE_URL', env('PLT_WORLD_SERVICE_URL'))
  const record = env('WUR_RECORD', databaseUrl || serviceUrl ? '1' : '0') === '1'
  const gate = env('WUR_GATE', '0') === '1'
  const maxWur = Number(env('WUR_MAX', '0.5'))
  const smoke = env('WUR_SMOKE', '1') === '1'
  const prefixes = env(
    'WUR_PATHS',
    'e2e-v5/workflows e2e-v4/workflows'
  ).split(/\s+/).filter(Boolean)

  if (record && !databaseUrl && !serviceUrl) {
    console.error('WUR_RECORD=1 requires DATABASE_URL or WUR_SERVICE_URL')
    return 1
  }

  const tmp = mkdtempSync(join(tmpdir(), 'wur-ci-'))
  const results: CompareResult[] = []

  try {
    // --- smoke: self-diff a known fixture (always exercises CLI path) ---
    if (smoke) {
      const smokeRel = 'e2e-v5/workflows/greet.ts'
      const smokeAbs = join(root, smokeRel)
      if (existsSync(smokeAbs)) {
        const src = git(['show', `HEAD:${smokeRel}`], root)
        const body = src.ok ? src.out : null
        if (body && hasUseWorkflow(body)) {
          const r = comparePair({
            file: `${smokeRel} (self-diff smoke)`,
            v1: body,
            v2: body,
            appId,
            record: false, // never calibrate no-op self-diff
            databaseUrl,
            serviceUrl,
            tmp,
          })
          results.push(r)
          console.log(`[smoke] ${smokeRel}: wur=${r.wur ?? '?'} exit=${r.code}`)
        }
      }
    }

    // --- PR / push: base...head changed workflow files ---
    if (!isZeroSha(base) && !isZeroSha(head) && base !== head) {
      const changed = listChangedWorkflows(root, base, head, prefixes)
      console.log(`Comparing ${base.slice(0, 7)}...${head.slice(0, 7)} under [${prefixes.join(', ')}]`)
      console.log(`Changed workflow files: ${changed.length || '(none)'}`)

      for (const file of changed) {
        const v1 = showFile(root, base, file)
        const v2 = showFile(root, head, file)
        if (!v2) {
          console.log(`  skip ${file}: missing at head`)
          continue
        }
        if (!hasUseWorkflow(v2) && !(v1 && hasUseWorkflow(v1))) {
          console.log(`  skip ${file}: no 'use workflow'`)
          continue
        }
        // New file: compare empty-ish linear noop? Skip insert-only without v1 graph.
        if (!v1) {
          console.log(`  skip ${file}: new file (no base version to score against)`)
          continue
        }
        if (!hasUseWorkflow(v1) || !hasUseWorkflow(v2)) {
          console.log(`  skip ${file}: only one side is a workflow`)
          continue
        }

        const r = comparePair({
          file,
          v1,
          v2,
          appId,
          record,
          databaseUrl,
          serviceUrl,
          tmp,
        })
        results.push(r)
        const classes = r.changeClasses?.join(',') || '—'
        console.log(
          `  ${relative(root, file) === file ? file : file}: ` +
          `wur=${r.wur ?? 'err'} pin=${r.pin ?? '?'} review=${r.review ?? '?'} ` +
          `classes=${classes} exit=${r.code}` +
          (r.error ? ` (${r.error.split(sep).pop()})` : '')
        )
      }
    } else if (!smoke) {
      console.log('No base/head range (set WUR_BASE_SHA + WUR_HEAD_SHA); nothing to compare')
    }

    // Summary JSON for job logs / artifacts
    const summary = {
      base: base || null,
      head: head || null,
      appId,
      record,
      results,
    }
    console.log('--- wur-ci-compare summary ---')
    console.log(JSON.stringify(summary, null, 2))

    const hardFail = results.some(r => r.code !== 0)
    if (hardFail) return 1

    if (gate) {
      const gated = results.filter(r =>
        !String(r.file).includes('self-diff') &&
        ((r.pin ?? 0) > 0 || (r.wur ?? 0) > maxWur)
      )
      if (gated.length) {
        console.error(`WUR_GATE: ${gated.length} file(s) exceed pin>0 or wur>${maxWur}`)
        for (const g of gated) {
          console.error(`  ${g.file}: wur=${g.wur} pin=${g.pin}`)
        }
        return 1
      }
    }

    return 0
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

main().then(code => process.exit(code), err => {
  console.error(err)
  process.exit(1)
})
