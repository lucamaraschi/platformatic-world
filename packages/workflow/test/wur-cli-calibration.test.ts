/**
 * CLI calibration feed for CI (record-exposure / calibration subcommands).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseWurArgs, runWurCli, FLEET_KEY } from '@platformatic/wur'
import { setupTest, teardownTest, type TestContext } from './helper.ts'

describe('WUR CLI parse calibration flags', () => {
  it('parses --record-exposure and calibration subcommand', () => {
    const a = parseWurArgs([
      '--source-v1', 'a.ts', '--source-v2', 'b.ts',
      '--app-id', 'app1', '--record-exposure', '--incident',
    ])
    assert.equal(a.recordExposure, true)
    assert.equal(a.incident, true)
    assert.equal(a.appId, 'app1')

    const b = parseWurArgs(['calibration', 'record', '--class', 'insert-step,delete-site', '--app-id', 'x'])
    assert.deepEqual(b.subcommand, ['calibration', 'record'])
    assert.deepEqual(b.classes, ['insert-step', 'delete-site'])
  })
})

describe('WUR CLI record-exposure via DATABASE_URL', () => {
  let ctx: TestContext
  let dir: string

  before(async () => {
    ctx = await setupTest()
    dir = mkdtempSync(join(tmpdir(), 'wur-cli-'))
  })

  after(async () => {
    rmSync(dir, { recursive: true, force: true })
    await teardownTest(ctx)
  })

  it('analyze + --record-exposure writes Postgres rows', async () => {
    const v1 = join(dir, 'v1.ts')
    const v2 = join(dir, 'v2.ts')
    writeFileSync(v1, `
      export async function orderFlow() {
        'use workflow'
        await validate()
        await charge()
      }
      async function validate() { 'use step'; return {} }
      async function charge() { 'use step'; return {} }
    `)
    writeFileSync(v2, `
      export async function orderFlow() {
        'use workflow'
        await audit()
        await validate()
        await charge()
      }
      async function audit() { 'use step'; return {} }
      async function validate() { 'use step'; return {} }
      async function charge() { 'use step'; return {} }
    `)

    const code = await runWurCli([
      '--source-v1', v1,
      '--source-v2', v2,
      '--workflow', 'orderFlow',
      '--app-id', ctx.appId,
      '--database-url', process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow',
      '--record-exposure',
      '--json',
    ])
    assert.equal(code, 0)

    const rows = await ctx.app.pg.query(
      `SELECT application_key, change_class, exposures, incidents
       FROM workflow_wur_calibration
       WHERE application_key = $1 OR application_key = $2`,
      [ctx.appId, FLEET_KEY]
    )
    assert.ok(rows.rows.length >= 1, 'expected calibration rows after --record-exposure')
    const appRows = rows.rows.filter((r: { application_key: string }) => r.application_key === ctx.appId)
    assert.ok(appRows.length >= 1)
    assert.ok(appRows.every((r: { incidents: number }) => Number(r.incidents) === 0))
  })

  it('calibration record --incident increments incidents', async () => {
    const code = await runWurCli([
      'calibration', 'record',
      '--app-id', ctx.appId,
      '--class', 'insert-step',
      '--incident',
      '--database-url', process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow',
    ])
    assert.equal(code, 0)

    const r = await ctx.app.pg.query(
      `SELECT exposures, incidents FROM workflow_wur_calibration
       WHERE application_key = $1 AND change_class = 'insert-step'`,
      [ctx.appId]
    )
    assert.ok(r.rows.length === 1)
    assert.ok(Number(r.rows[0].incidents) >= 1)
  })

  it('calibration show returns posteriors', async () => {
    const code = await runWurCli([
      'calibration', 'show',
      '--app-id', ctx.appId,
      '--database-url', process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow',
    ])
    assert.equal(code, 0)
  })
})
