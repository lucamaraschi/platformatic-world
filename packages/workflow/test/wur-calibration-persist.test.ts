/**
 * Durable WUR calibration — survives process "reload" via Postgres.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  CalibrationStore,
  defaultCalibrationStore,
  loadCalibrationFromDb,
  recordReleaseOutcomePersistent,
  FLEET_KEY,
} from '../lib/wur/index.ts'
import { setupTest, teardownTest, type TestContext } from './helper.ts'

describe('WUR calibration Postgres durability', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('table exists after migrations', async () => {
    const r = await ctx.app.pg.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_name = 'workflow_wur_calibration'`
    )
    assert.equal(r.rows.length, 1)
  })

  it('POST calibration persists; reload restores posteriors', async () => {
    const appId = ctx.appId

    // Clear in-memory only (DB will accumulate)
    defaultCalibrationStore.clear()

    const post = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/upgrade-risk/calibration`,
      payload: {
        changeClasses: ['insert-step'],
        incident: true,
        exposures: 5,
      },
    })
    assert.equal(post.statusCode, 200, post.body)
    assert.equal(post.json().durable, true)

    // DB has rows
    const dbRows = await ctx.app.pg.query(
      `SELECT application_key, change_class, exposures, incidents
       FROM workflow_wur_calibration
       WHERE change_class = 'insert-step'
         AND (application_key = $1 OR application_key = $2)`,
      [appId, FLEET_KEY]
    )
    assert.ok(dbRows.rows.length >= 2, `expected fleet+app rows, got ${dbRows.rows.length}`)
    const appRow = dbRows.rows.find((r: { application_key: string }) => r.application_key === appId)
    assert.ok(appRow)
    assert.equal(Number(appRow.exposures), 5)
    assert.equal(Number(appRow.incidents), 5)

    // Simulate restart: empty memory, load from DB
    const fresh = new CalibrationStore()
    await loadCalibrationFromDb(ctx.app.pg, fresh)
    const cal = fresh.calibrate('insert-step', appId)
    assert.ok(cal.mean > 0.7, `mean=${cal.mean}`)
    assert.equal(cal.coldStart, false)
  })

  it('recordReleaseOutcomePersistent increments on second write', async () => {
    const appId = ctx.appId
    await recordReleaseOutcomePersistent({
      pg: ctx.app.pg,
      appIdStr: appId,
      changeClasses: ['delete-site'],
      incident: false,
      exposures: 2,
      store: defaultCalibrationStore,
    })
    await recordReleaseOutcomePersistent({
      pg: ctx.app.pg,
      appIdStr: appId,
      changeClasses: ['delete-site'],
      incident: true,
      exposures: 1,
      store: defaultCalibrationStore,
    })

    const r = await ctx.app.pg.query(
      `SELECT exposures, incidents FROM workflow_wur_calibration
       WHERE application_key = $1 AND change_class = 'delete-site'`,
      [appId]
    )
    assert.equal(r.rows.length, 1)
    assert.equal(Number(r.rows[0].exposures), 3)
    assert.equal(Number(r.rows[0].incidents), 1)
  })

  it('GET calibration reflects durable store', async () => {
    const appId = ctx.appId
    // ensure memory matches DB
    await loadCalibrationFromDb(ctx.app.pg, defaultCalibrationStore)

    const get = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${appId}/upgrade-risk/calibration`,
    })
    assert.equal(get.statusCode, 200)
    const body = get.json()
    assert.ok(body.app['insert-step'])
    assert.ok(body.store.fleet.length > 0 || Object.keys(body.store.apps).length > 0)
  })
})
