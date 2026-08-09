import { config } from '../shared/config'
import { deleteBlocksOlderThan, getPool } from '../shared/db'
import { createLogger, startTelemetry } from '../shared/telemetry'

const log = createLogger('retention')

export interface RetentionResult {
  retentionDays: number
  blocksDeleted: number
  durationMs: number
}

/**
 * Drops block and transaction detail past the retention window. `daily_energy`
 * is intentionally left alone -- the aggregate outlives the rows it came from,
 * which is what lets the API answer for the full window on a small database.
 */
export async function runRetention(): Promise<RetentionResult> {
  const startedAt = Date.now()
  const blocksDeleted = await deleteBlocksOlderThan(getPool(), config.retentionDays)
  const result = { retentionDays: config.retentionDays, blocksDeleted, durationMs: Date.now() - startedAt }
  log.info('retention finished', { ...result })
  return result
}

export const handler = async (): Promise<RetentionResult> => {
  startTelemetry()
  try {
    return await runRetention()
  } catch (error) {
    log.error('retention failed', { error: (error as Error).message })
    throw error
  }
}
