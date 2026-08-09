import { BLOCKS_PER_DAY } from './config'
import { fetchBlockByHash, fetchBlockByHeight } from './blockchain-client'
import { recordBlock, withTransaction } from './db'
import type { FullBlock } from './types'

export interface IngestRange {
  from: number
  to: number
  /** True when there was more settled history available than one tick may take. */
  clamped: boolean
}

export interface RangeInput {
  /** Highest height already counted, or null on a cold start. */
  dbMaxHeight: number | null
  latestHeight: number
  retentionDays: number
  confirmationLag: number
  maxBlocksPerTick: number
  blocksPerDay?: number
}

/**
 * Decides which heights the next tick should ingest.
 *
 * Pure, because the two ways this goes wrong are both invisible at runtime:
 * a cold start with no floor walks the entire chain, and a long outage produces
 * a range too large to finish inside one invocation.
 *
 * @returns the range, or null when there is nothing settled left to do.
 */
export function computeIngestRange(input: RangeInput): IngestRange | null {
  const blocksPerDay = input.blocksPerDay ?? BLOCKS_PER_DAY

  // Only blocks below the confirmation lag are safe from a reorg.
  const settledTip = input.latestHeight - input.confirmationLag

  // Never reach back further than we are willing to keep. This is what stops a
  // cold start from trying to ingest the whole blockchain.
  const floor = input.latestHeight - input.retentionDays * blocksPerDay

  const from = input.dbMaxHeight === null ? floor : Math.max(input.dbMaxHeight + 1, floor)
  if (from > settledTip) {
    return null
  }

  const to = Math.min(settledTip, from + input.maxBlocksPerTick - 1)
  return { from, to, clamped: to < settledTip }
}

/**
 * Fetch and store one block per height, each in its own transaction so a failure
 * halfway through a range keeps everything before it.
 *
 * @returns the number of blocks that were newly counted.
 */
export async function ingestHeights(
  heights: number[],
  onBlock?: (block: FullBlock) => void,
): Promise<number> {
  let ingested = 0
  for (const height of heights) {
    const block = await fetchBlockByHeight(height)
    const counted = await withTransaction(db => recordBlock(db, block, true))
    if (counted) {
      ingested++
    }
    onBlock?.(block)
  }
  return ingested
}

/** Used by the backfill, which resolves hashes a day at a time. */
export async function ingestHash(hash: string): Promise<boolean> {
  const block = await fetchBlockByHash(hash)
  return withTransaction(db => recordBlock(db, block, true))
}

/**
 * Cache fill for the API read-through.
 *
 * Deliberately does not aggregate: this may pull in a block from outside the
 * retention window, whose day is already rolled up and whose blocks have been
 * deleted. Counting it again would corrupt that day permanently.
 */
export async function ingestForRead(hash?: string, height?: number): Promise<FullBlock> {
  const block = hash !== undefined ? await fetchBlockByHash(hash) : await fetchBlockByHeight(height!)
  await withTransaction(db => recordBlock(db, block, false))
  return block
}

export function rangeToHeights(range: IngestRange): number[] {
  const heights: number[] = []
  for (let height = range.from; height <= range.to; height++) {
    heights.push(height)
  }
  return heights
}
