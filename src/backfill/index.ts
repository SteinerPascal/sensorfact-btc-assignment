import { config } from '../shared/config'
import { fetchDayBlockSummaries, fetchLatestHeight } from '../shared/blockchain-client'
import { closePool, findAggregatedHashes, getPool } from '../shared/db'
import { ingestHash } from '../shared/ingest'
import { createLogger, startTelemetry } from '../shared/telemetry'

const log = createLogger('backfill')

export interface BackfillOptions {
  days: number
}

export interface BackfillResult {
  days: number
  blocksIngested: number
  blocksSkipped: number
  durationMs: number
}

/** Milliseconds at midday of the UTC day `daysAgo` days back. */
function dayTimestampMs(daysAgo: number): number {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - daysAgo)
  date.setUTCHours(12, 0, 0, 0)
  return date.getTime()
}

/**
 * Fills the retention window a day at a time.
 *
 * Day-oriented for two reasons: one call to `/blocks/$time_ms` enumerates a whole
 * day's hashes (instead of one call per height), and finishing a day means that
 * day's rollup is complete rather than half-written.
 *
 * Safe to re-run: blocks already counted are skipped without an API call, and
 * the aggregate guard in recordBlock makes a repeat ingest a no-op regardless.
 */
export async function runBackfill(options: BackfillOptions): Promise<BackfillResult> {
  const startedAt = Date.now()
  const settledTip = (await fetchLatestHeight()) - config.confirmationLag

  let blocksIngested = 0
  let blocksSkipped = 0

  // Oldest day first, so an interrupted run leaves a contiguous window.
  for (let daysAgo = options.days - 1; daysAgo >= 0; daysAgo--) {
    const timestamp = dayTimestampMs(daysAgo)
    const summaries = (await fetchDayBlockSummaries(timestamp)).filter(
      summary => summary.height <= settledTip,
    )
    const alreadyDone = await findAggregatedHashes(
      getPool(),
      summaries.map(summary => summary.hash),
    )

    const todo = summaries.filter(summary => !alreadyDone.has(summary.hash))
    blocksSkipped += summaries.length - todo.length

    for (const summary of todo) {
      if (await ingestHash(summary.hash)) {
        blocksIngested++
      }
    }

    log.info('day complete', {
      day: new Date(timestamp).toISOString().slice(0, 10),
      blocks: summaries.length,
      ingested: todo.length,
      skipped: summaries.length - todo.length,
    })
  }

  const result = { days: options.days, blocksIngested, blocksSkipped, durationMs: Date.now() - startedAt }
  log.info('backfill finished', { ...result })
  return result
}

function parseArgs(argv: string[]): BackfillOptions {
  const daysIndex = argv.indexOf('--days')
  const days = daysIndex === -1 ? config.retentionDays : Number.parseInt(argv[daysIndex + 1] ?? '', 10)

  if (!Number.isInteger(days) || days < 1 || days > config.retentionDays) {
    throw new Error(`--days must be an integer between 1 and RETENTION_DAYS (${config.retentionDays})`)
  }
  return { days }
}

/* istanbul ignore next -- CLI entry point */
if (require.main === module) {
  startTelemetry()
  const options = parseArgs(process.argv.slice(2))
  log.info('starting backfill', { ...options, database: config.databaseUrl.replace(/:[^:@]*@/, ':***@') })

  runBackfill(options)
    .then(() => closePool())
    .catch(async error => {
      log.error('backfill failed', { error: (error as Error).message })
      await closePool()
      process.exit(1)
    })
}
