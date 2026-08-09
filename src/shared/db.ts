import { Pool } from 'pg'
import { config } from './config'
import type { DailyEnergyRow, FullBlock, StoredBlock } from './types'

/**
 * Everything below takes a `Queryable` rather than a concrete pg client, so the
 * repository can be unit tested with a fake -- which is how the daily_energy
 * idempotency guarantee is covered without needing a live database.
 */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>
}

let pool: Pool | undefined

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl, max: config.databasePoolMax })
  }
  return pool
}

export async function closePool(): Promise<void> {
  await pool?.end()
  pool = undefined
}

export async function withTransaction<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** The UTC calendar day a block belongs to. Never depends on the server timezone. */
export function utcDay(time: Date): string {
  return time.toISOString().slice(0, 10)
}

/**
 * Writes a block, its transactions, and -- when `aggregate` is set -- its
 * contribution to the daily rollup.
 *
 * The rollup is increment-only and can never be recomputed, because retention
 * deletes the blocks it was derived from. So the increment is gated on an atomic
 * false -> true flip of `aggregated`: whoever wins that update does the counting,
 * exactly once, no matter how often the block is re-ingested.
 *
 * `aggregate: false` is used by the API read-through, which may pull in blocks
 * from outside the retention window. Those must never touch the rollup -- but if
 * the worker later reaches the same block, it still flips the flag and counts it.
 *
 * Must be called inside a transaction.
 *
 * @returns true when this call was the one that counted the block.
 */
export async function recordBlock(db: Queryable, block: FullBlock, aggregate: boolean): Promise<boolean> {
  if (aggregate) {
    // A different hash at this height means either a reorg deeper than our
    // confirmation lag, or a block the read-through cached before it settled.
    // The aggregating path is authoritative, so the stale row goes -- otherwise
    // the height unique constraint would silently block this insert forever.
    // Known limitation: if the stale row had already been counted, its share of
    // daily_energy stays. That needs a reorg deeper than CONFIRMATION_LAG.
    await db.query(`DELETE FROM blocks WHERE height = $1 AND hash <> $2`, [block.height, block.hash])
  }

  await db.query(
    `INSERT INTO blocks (hash, height, time, size_bytes, tx_count, aggregated)
     VALUES ($1, $2, $3, $4, $5, false)
     ON CONFLICT DO NOTHING`,
    [block.hash, block.height, block.time.toISOString(), block.sizeBytes, block.txCount],
  )

  await db.query(
    `INSERT INTO transactions (tx_hash, block_hash, size_bytes)
     SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[])
     ON CONFLICT DO NOTHING`,
    [
      block.transactions.map(tx => tx.hash),
      block.transactions.map(() => block.hash),
      block.transactions.map(tx => tx.sizeBytes),
    ],
  )

  if (!aggregate) {
    return false
  }

  const claimed = await db.query(
    `UPDATE blocks SET aggregated = true WHERE hash = $1 AND aggregated = false RETURNING hash`,
    [block.hash],
  )
  if (claimed.rowCount !== 1) {
    return false
  }

  await db.query(
    `INSERT INTO daily_energy (day, total_bytes, block_count, tx_count)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (day) DO UPDATE SET
       total_bytes = daily_energy.total_bytes + EXCLUDED.total_bytes,
       block_count = daily_energy.block_count + 1,
       tx_count    = daily_energy.tx_count + EXCLUDED.tx_count`,
    [utcDay(block.time), block.sizeBytes, block.txCount],
  )

  return true
}

export async function getMaxBlockHeight(db: Queryable): Promise<number | null> {
  const result = await db.query(`SELECT max(height) AS height FROM blocks WHERE aggregated = true`)
  const height = result.rows[0]?.height
  return height === null || height === undefined ? null : Number(height)
}

/**
 * Cron can fire twice. The worker takes this lock and exits if it cannot get it,
 * so two ticks never walk the same range concurrently.
 */
const WORKER_LOCK_KEY = 4815162342

export async function tryWorkerLock(db: Queryable): Promise<boolean> {
  const result = await db.query(`SELECT pg_try_advisory_lock($1) AS acquired`, [WORKER_LOCK_KEY])
  return result.rows[0]?.acquired === true
}

export async function releaseWorkerLock(db: Queryable): Promise<void> {
  await db.query(`SELECT pg_advisory_unlock($1)`, [WORKER_LOCK_KEY])
}

/**
 * Advisory locks are session scoped, so this holds a single connection for the
 * duration of the tick rather than going through the pool per statement.
 *
 * @returns the callback's result, or null when another tick already holds the lock.
 */
export async function withWorkerLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const client = await getPool().connect()
  try {
    if (!(await tryWorkerLock(client))) {
      return null
    }
    try {
      return await fn()
    } finally {
      await releaseWorkerLock(client)
    }
  } finally {
    client.release()
  }
}

function toStoredBlock(row: {
  hash: string
  height: number
  time: Date
  size_bytes: string
  tx_count: number
}): StoredBlock {
  return {
    hash: row.hash,
    height: Number(row.height),
    time: row.time,
    sizeBytes: Number(row.size_bytes),
    txCount: Number(row.tx_count),
  }
}

export async function findBlock(
  db: Queryable,
  by: { hash?: string; height?: number },
): Promise<StoredBlock | null> {
  const result =
    by.hash !== undefined
      ? await db.query(`SELECT hash, height, time, size_bytes, tx_count FROM blocks WHERE hash = $1`, [
          by.hash,
        ])
      : await db.query(`SELECT hash, height, time, size_bytes, tx_count FROM blocks WHERE height = $1`, [
          by.height,
        ])

  return result.rows[0] ? toStoredBlock(result.rows[0]) : null
}

/**
 * Which of these hashes have already been counted. Lets the backfill skip whole
 * days it has done before instead of re-fetching them from the Blockchain API.
 */
export async function findAggregatedHashes(db: Queryable, hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) {
    return new Set()
  }
  const result = await db.query(
    `SELECT hash FROM blocks WHERE aggregated = true AND hash = ANY($1::text[])`,
    [hashes],
  )
  return new Set(result.rows.map(row => row.hash as string))
}

export async function countTransactions(db: Queryable, blockHash: string): Promise<number> {
  const result = await db.query(`SELECT count(*) AS count FROM transactions WHERE block_hash = $1`, [
    blockHash,
  ])
  return Number(result.rows[0]?.count ?? 0)
}

export async function listTransactions(
  db: Queryable,
  blockHash: string,
  limit: number,
  offset: number,
): Promise<{ hash: string; sizeBytes: number }[]> {
  const result = await db.query(
    `SELECT tx_hash, size_bytes FROM transactions
     WHERE block_hash = $1
     ORDER BY tx_hash
     LIMIT $2 OFFSET $3`,
    [blockHash, limit, offset],
  )
  return result.rows.map(row => ({ hash: row.tx_hash, sizeBytes: Number(row.size_bytes) }))
}

/**
 * Days are generated rather than selected, so a day with no ingested blocks
 * still shows up as zero instead of leaving a hole in the frontend's chart.
 */
export async function getDailyEnergy(db: Queryable, lastDays: number): Promise<DailyEnergyRow[]> {
  const result = await db.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day,
            COALESCE(de.total_bytes, 0) AS total_bytes,
            COALESCE(de.block_count, 0) AS block_count,
            COALESCE(de.tx_count, 0)    AS tx_count
     FROM generate_series(
            ((now() AT TIME ZONE 'UTC')::date - ($1::int - 1)),
            ((now() AT TIME ZONE 'UTC')::date),
            interval '1 day') AS d
     LEFT JOIN daily_energy de ON de.day = d::date
     ORDER BY d DESC`,
    [lastDays],
  )

  return result.rows.map(row => ({
    day: row.day,
    totalBytes: Number(row.total_bytes),
    blockCount: Number(row.block_count),
    txCount: Number(row.tx_count),
  }))
}

/**
 * The UTC day of the newest block we hold. A day is only complete once we have
 * ingested a block belonging to a later day.
 */
export async function getLatestBlockDay(db: Queryable): Promise<string | null> {
  const result = await db.query(`SELECT max(time) AS time FROM blocks WHERE aggregated = true`)
  const time = result.rows[0]?.time
  return time ? utcDay(new Date(time)) : null
}

export async function deleteBlocksOlderThan(db: Queryable, days: number): Promise<number> {
  // The cutoff is pinned to UTC on both sides. Comparing a timestamptz against a
  // bare date would let Postgres resolve the date in the *server's* timezone,
  // which silently shifts the retention boundary by the UTC offset.
  const result = await db.query(
    `DELETE FROM blocks
     WHERE time < (((now() AT TIME ZONE 'UTC')::date - $1::int) AT TIME ZONE 'UTC')`,
    [days],
  )
  return result.rowCount ?? 0
}
