import { parseRawBlock } from './blockchain-client'
import { energyKwh } from './energy'

/**
 * Trimmed from a real `/rawblock` response. Kept as a fixture because a silent
 * change in the upstream shape is the one failure that would produce plausible
 * but wrong numbers rather than an error.
 */
const rawBlock = {
  hash: '0000000000000000000590fc0f3eba193a278534220b2b37e9849e1a770ca959',
  ver: 1073733636,
  prev_block: '0000000000000000000aa3ce000eb559f4143be419108134e0ce71042fc636eb',
  time: 1631333672,
  n_tx: 3,
  size: 1276422,
  block_index: 700000,
  main_chain: true,
  height: 700000,
  tx: [
    { hash: 'tx-coinbase', size: 300 },
    { hash: 'tx-a', size: 226 },
    { hash: 'tx-b', size: 374 },
  ],
}

describe('parseRawBlock', () => {
  it('maps the upstream payload onto the domain model', () => {
    const block = parseRawBlock(rawBlock)

    expect(block.hash).toBe(rawBlock.hash)
    expect(block.height).toBe(700_000)
    expect(block.txCount).toBe(3)
    expect(block.transactions).toHaveLength(3)
  })

  it('converts the unix timestamp to a Date', () => {
    expect(parseRawBlock(rawBlock).time.toISOString()).toBe('2021-09-11T04:14:32.000Z')
  })

  it('sums transaction sizes rather than using the raw block size', () => {
    const block = parseRawBlock(rawBlock)

    // 300 + 226 + 374, not the 1276422 the block header reports. The assignment
    // asks for energy per transaction, so block and transaction totals must add up.
    expect(block.sizeBytes).toBe(900)
    expect(block.sizeBytes).not.toBe(rawBlock.size)
  })

  it('produces a block total equal to the sum of its transactions', () => {
    const block = parseRawBlock(rawBlock)
    const summed = block.transactions.reduce((total, tx) => total + energyKwh(tx.sizeBytes), 0)

    expect(energyKwh(block.sizeBytes)).toBeCloseTo(summed, 6)
  })

  it('refuses a transaction without a size instead of counting it as zero', () => {
    const broken = { ...rawBlock, tx: [{ hash: 'tx-a' } as unknown as { hash: string; size: number }] }

    expect(() => parseRawBlock(broken)).toThrow(/has no size/)
  })
})

describe('energyKwh', () => {
  it('applies the 4.56 kWh per byte constant', () => {
    expect(energyKwh(1000)).toBeCloseTo(4560, 6)
  })

  it('accepts the string form Postgres returns for BIGINT columns', () => {
    expect(energyKwh('250')).toBeCloseTo(1140, 6)
  })
})
