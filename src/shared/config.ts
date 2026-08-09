/**
 * All configuration in one place.
 *
 * RETENTION_DAYS is the single source of truth for how much history the system
 * holds. It drives three things that must never drift apart:
 *   - how far back the backfill reaches,
 *   - what the retention job deletes,
 *   - the maximum `lastDays` the API will accept.
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`)
  }
  return parsed
}

function str(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

export const config = {
  /** Energy cost per byte of transaction data, in kWh. Given by the assignment. */
  kwhPerByte: 4.56,

  /** How much history we keep, and therefore how far back the API can look. */
  retentionDays: int('RETENTION_DAYS', 30),

  /**
   * Blocks below `tip - confirmationLag` are considered settled. This is our
   * reorg protection: we never ingest a block that could still be orphaned.
   */
  confirmationLag: int('CONFIRMATION_LAG', 6),

  /**
   * Upper bound on how many blocks a single worker invocation will ingest.
   * Work left over is picked up by the next tick, so this bounds invocation
   * time without losing progress.
   */
  maxBlocksPerTick: int('MAX_BLOCKS_PER_TICK', 25),

  /** Minimum delay between two Blockchain API requests, to stay under the rate limit. */
  blockchainRequestDelayMs: int('BLOCKCHAIN_REQUEST_DELAY_MS', 1000),

  /** Retries for 429/5xx responses from the Blockchain API. */
  blockchainMaxRetries: int('BLOCKCHAIN_MAX_RETRIES', 4),

  blockchainBaseUrl: str('BLOCKCHAIN_BASE_URL', 'https://blockchain.info'),

  /** Default and maximum page size for Block.transactions. */
  txPageSize: int('TX_PAGE_SIZE', 100),
  txPageSizeMax: int('TX_PAGE_SIZE_MAX', 1000),

  databaseUrl: str('DATABASE_URL', 'postgres://btc:btc@localhost:5432/btcenergy'),

  /** Kept small: many concurrent Lambda invocations share one Postgres server. */
  databasePoolMax: int('DATABASE_POOL_MAX', 4),

  /** Shared namespace for logs, traces and metrics. */
  serviceName: str('OTEL_SERVICE_NAME', 'btc-energy'),
} as const

/** Average blocks per day on the Bitcoin network (one every ~10 minutes). */
export const BLOCKS_PER_DAY = 144
