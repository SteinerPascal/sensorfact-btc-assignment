import { config } from './config'
import { createLogger, telemetry } from './telemetry'
import type { BlockSummary, FullBlock } from './types'

const log = createLogger('blockchain-client')

interface RawTx {
  hash: string
  size: number
}

interface RawBlock {
  hash: string
  height: number
  time: number
  n_tx: number
  main_chain?: boolean
  tx: RawTx[]
}

export class BlockNotFoundError extends Error {
  constructor(reference: string) {
    super(`Block not found: ${reference}`)
    this.name = 'BlockNotFoundError'
  }
}

/**
 * Maps the Blockchain API payload onto our domain model.
 *
 * Exported because this is the one piece of parsing that can silently go wrong
 * if the upstream shape changes, so it is unit tested against a recorded fixture.
 */
export function parseRawBlock(raw: RawBlock): FullBlock {
  const transactions = raw.tx.map(tx => {
    if (typeof tx.size !== 'number') {
      throw new Error(`Transaction ${tx.hash} in block ${raw.hash} has no size`)
    }
    return { hash: tx.hash, sizeBytes: tx.size }
  })

  return {
    hash: raw.hash,
    height: raw.height,
    time: new Date(raw.time * 1000),
    sizeBytes: transactions.reduce((total, tx) => total + tx.sizeBytes, 0),
    txCount: raw.n_tx ?? transactions.length,
    transactions,
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Spaces outgoing requests by at least `blockchainRequestDelayMs`.
 *
 * Every caller passes through here, so the worker, the backfill and the API
 * read-through share one budget instead of competing for the rate limit.
 */
let gate: Promise<void> = Promise.resolve()
let lastRequestAt = 0

async function throttle(): Promise<void> {
  const previous = gate
  let release!: () => void
  gate = new Promise<void>(resolve => {
    release = resolve
  })
  await previous
  const wait = lastRequestAt + config.blockchainRequestDelayMs - Date.now()
  if (wait > 0) {
    await sleep(wait)
  }
  lastRequestAt = Date.now()
  release()
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

async function getJson<T>(path: string): Promise<T> {
  const url = `${config.blockchainBaseUrl}${path}`

  for (let attempt = 0; ; attempt++) {
    await throttle()
    const startedAt = Date.now()

    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      telemetry.blockchainRequestDuration().record(Date.now() - startedAt, {
        'http.response.status_code': response.status,
      })

      if (response.ok) {
        return (await response.json()) as T
      }
      if (response.status === 404) {
        throw new BlockNotFoundError(path)
      }
      if (!isRetryable(response.status) || attempt >= config.blockchainMaxRetries) {
        throw new Error(`Blockchain API ${path} failed with status ${response.status}`)
      }
      log.warn('retrying blockchain request', { path, status: response.status, attempt })
    } catch (error) {
      if (error instanceof BlockNotFoundError) {
        throw error
      }
      if (attempt >= config.blockchainMaxRetries) {
        throw error
      }
      log.warn('retrying blockchain request after network error', {
        path,
        attempt,
        error: (error as Error).message,
      })
    }

    // Exponential backoff on top of the normal request spacing.
    await sleep(config.blockchainRequestDelayMs * 2 ** attempt)
  }
}

export async function fetchLatestHeight(): Promise<number> {
  const latest = await getJson<{ height: number }>('/latestblock')
  return latest.height
}

/**
 * `/block-height` returns the *full* block (transactions included), so this is a
 * single call per block with no `rawblock` follow-up. It can return more than one
 * block for a height when there was a fork, hence the main_chain filter.
 */
export async function fetchBlockByHeight(height: number): Promise<FullBlock> {
  const payload = await getJson<{ blocks: RawBlock[] }>(`/block-height/${height}?format=json`)
  const block = payload.blocks?.find(candidate => candidate.main_chain !== false)
  if (!block) {
    throw new BlockNotFoundError(`height ${height}`)
  }
  return parseRawBlock(block)
}

export async function fetchBlockByHash(hash: string): Promise<FullBlock> {
  return parseRawBlock(await getJson<RawBlock>(`/rawblock/${hash}`))
}

/**
 * Block headers for the UTC day containing `timeMs` -- one call instead of one
 * per height, which is what makes a multi-day backfill affordable.
 */
export async function fetchDayBlockSummaries(timeMs: number): Promise<BlockSummary[]> {
  const payload = await getJson<{ hash: string; height: number; time: number }[] | { blocks: unknown }>(
    `/blocks/${timeMs}?format=json`,
  )
  const rows = Array.isArray(payload)
    ? payload
    : ((payload as { blocks: { hash: string; height: number; time: number }[] }).blocks ?? [])

  return rows.map(row => ({
    hash: row.hash,
    height: row.height,
    time: new Date(row.time * 1000),
  }))
}
