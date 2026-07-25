/**
 * Postgres persistence for CalibrationStore.
 *
 * Rows keyed by application_key:
 *   'fleet'           → cross-app prior
 *   external app_id   → per-tenant counts (URL appId string)
 */
import type pg from 'pg'
import {
  CalibrationStore,
  type ChangeClass,
  type ClassRecord,
} from './calibration.ts'

export type PgQueryable = Pick<pg.Pool, 'query'>

export const FLEET_KEY = 'fleet'

/**
 * Load all calibration rows into a store (replaces in-memory state).
 */
export async function loadCalibrationFromDb (
  pgClient: PgQueryable,
  store: CalibrationStore = new CalibrationStore()
): Promise<CalibrationStore> {
  const result = await pgClient.query(
    `SELECT application_key, change_class, exposures, incidents
     FROM workflow_wur_calibration`
  )

  const fleet: ClassRecord[] = []
  const apps: Record<string, ClassRecord[]> = {}

  for (const row of result.rows) {
    const rec: ClassRecord = {
      changeClass: row.change_class as ChangeClass,
      exposures: Number(row.exposures),
      incidents: Number(row.incidents),
    }
    if (row.application_key === FLEET_KEY) {
      fleet.push(rec)
    } else {
      const key = String(row.application_key)
      if (!apps[key]) apps[key] = []
      apps[key].push(rec)
    }
  }

  store.replaceFrom(CalibrationStore.fromJSON({ fleet, apps }))
  return store
}

/**
 * Increment counts for one (application_key, change_class) row.
 */
export async function upsertCalibrationDelta (
  pgClient: PgQueryable,
  applicationKey: string,
  rec: ClassRecord
): Promise<void> {
  await pgClient.query(
    `INSERT INTO workflow_wur_calibration
       (application_key, change_class, exposures, incidents, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (application_key, change_class) DO UPDATE SET
       exposures = workflow_wur_calibration.exposures + EXCLUDED.exposures,
       incidents = workflow_wur_calibration.incidents + EXCLUDED.incidents,
       updated_at = NOW()`,
    [applicationKey, rec.changeClass, rec.exposures, rec.incidents]
  )
}

/**
 * Persist a release outcome to DB and update in-memory store.
 */
export async function recordReleaseOutcomePersistent (opts: {
  pg: PgQueryable
  appIdStr?: string | null
  changeClasses: ChangeClass[]
  incident?: boolean
  exposures?: number
  store?: CalibrationStore
}): Promise<void> {
  const { defaultCalibrationStore } = await import('./calibration.ts')
  const store = opts.store ?? defaultCalibrationStore
  const exposures = Math.max(1, opts.exposures ?? 1)
  const incidents = opts.incident === true ? exposures : 0
  const appKey = opts.appIdStr && opts.appIdStr.length > 0 ? opts.appIdStr : null

  for (const changeClass of opts.changeClasses) {
    const rec: ClassRecord = { changeClass, exposures, incidents }
    // memory (fleet + app)
    store.record(appKey, rec)
    // fleet always
    await upsertCalibrationDelta(opts.pg, FLEET_KEY, rec)
    // per-app when known
    if (appKey) {
      await upsertCalibrationDelta(opts.pg, appKey, rec)
    }
  }
}
