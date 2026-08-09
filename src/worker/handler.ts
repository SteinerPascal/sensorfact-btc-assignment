import { config } from '../shared/config'
import { fetchLatestHeight } from '../shared/blockchain-client'
import { getMaxBlockHeight, getPool, withWorkerLock } from '../shared/db'
import { computeIngestRange, ingestHeights, rangeToHeights } from '../shared/ingest'
import { createLogger, startTelemetry, telemetry } from '../shared/telemetry'

const log = createLogger('worker')

export interface TickResult {
  status: 'ingested' | 'up-to-date' | 'skipped-locked'
  from?: number
  to?: number
  ingested?: number
  clamped?: boolean
  durationMs: number
}

/**
 * One bounded, resumable unit of work.
 *
 * Progress lives in the database (the highest aggregated height), so a tick that
 * is cut short by a timeout simply means the next one starts where it stopped.
 */
export async function runTick(): Promise<TickResult> {
  const startedAt = Date.now()

  const result = await withWorkerLock(async (): Promise<TickResult> => {
    const [dbMaxHeight, latestHeight] = await Promise.all([getMaxBlockHeight(getPool()), fetchLatestHeight()])

    const range = computeIngestRange({
      dbMaxHeight,
      latestHeight,
      retentionDays: config.retentionDays,
      confirmationLag: config.confirmationLag,
      maxBlocksPerTick: config.maxBlocksPerTick,
    })

    if (!range) {
      log.info('nothing to ingest', { dbMaxHeight, latestHeight })
      return { status: 'up-to-date', durationMs: Date.now() - startedAt }
    }

    log.info('ingesting range', {
      from: range.from,
      to: range.to,
      latestHeight,
      coldStart: dbMaxHeight === null,
    })

    const ingested = await ingestHeights(rangeToHeights(range))
    telemetry.blocksIngested().add(ingested)

    if (range.clamped) {
      // Not an error, but it means we are behind the chain tip: either the tick
      // interval is too long or MAX_BLOCKS_PER_TICK is too low.
      log.warn('range clamped, still behind the tip', {
        to: range.to,
        settledTip: latestHeight - config.confirmationLag,
        maxBlocksPerTick: config.maxBlocksPerTick,
      })
    }

    return {
      status: 'ingested',
      from: range.from,
      to: range.to,
      ingested,
      clamped: range.clamped,
      durationMs: Date.now() - startedAt,
    }
  })

  if (result === null) {
    log.warn('another tick is already running, skipping')
    return { status: 'skipped-locked', durationMs: Date.now() - startedAt }
  }

  telemetry.tickDuration().record(result.durationMs)
  log.info('tick finished', { ...result })
  return result
}

export const handler = async (): Promise<TickResult> => {
  startTelemetry()
  try {
    return await runTick()
  } catch (error) {
    log.error('tick failed', { error: (error as Error).message })
    throw error
  }
}
