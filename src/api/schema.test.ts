import { graphql } from 'graphql'
import { schema } from './schema'
import type { ApiContext } from './schema'
import type { Queryable } from '../shared/db'
import { BlockNotFoundError } from '../shared/blockchain-client'
import { ingestForRead } from '../shared/ingest'

jest.mock('../shared/ingest', () => ({ ingestForRead: jest.fn() }))

const mockedReadThrough = ingestForRead as jest.MockedFunction<typeof ingestForRead>

const BLOCK_TIME = new Date('2026-03-02T02:00:00.000Z')

interface FakeData {
  block?: { hash: string; height: number; time: Date; size_bytes: string; tx_count: number } | null
  transactions?: { tx_hash: string; size_bytes: number }[]
  daily?: { day: string; total_bytes: string; block_count: number; tx_count: number }[]
  latestTime?: Date | null
}

/** Answers the handful of statements the resolvers issue, keyed on the SQL. */
function fakeDb(data: FakeData): Queryable {
  const transactions = data.transactions ?? []
  return {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes('FROM blocks WHERE hash') || sql.includes('FROM blocks WHERE height')) {
        return { rows: data.block ? [data.block] : [], rowCount: data.block ? 1 : 0 }
      }
      if (sql.includes('count(*) AS count FROM transactions')) {
        return { rows: [{ count: String(transactions.length) }], rowCount: 1 }
      }
      if (sql.includes('FROM transactions')) {
        const [, limit, offset] = params as [string, number, number]
        return { rows: transactions.slice(offset, offset + limit), rowCount: 1 }
      }
      if (sql.includes('generate_series')) {
        return { rows: data.daily ?? [], rowCount: (data.daily ?? []).length }
      }
      if (sql.includes('max(time)')) {
        return { rows: [{ time: data.latestTime ?? null }], rowCount: 1 }
      }
      throw new Error(`unexpected query: ${sql}`)
    },
  }
}

const run = (source: string, data: FakeData, variableValues?: Record<string, unknown>) =>
  graphql({
    schema,
    source,
    contextValue: { db: fakeDb(data) } satisfies ApiContext,
    variableValues,
  })

const storedBlock = {
  hash: 'block-hash',
  height: 900_000,
  time: BLOCK_TIME,
  size_bytes: '750',
  tx_count: 2,
}

describe('Query.block', () => {
  it('returns a block with its energy derived from transaction bytes', async () => {
    const result = await run(`{ block(hash: "block-hash") { hash height txCount totalEnergyKwh } }`, {
      block: storedBlock,
    })

    expect(result.errors).toBeUndefined()
    const block = result.data?.block as {
      hash: string
      height: number
      txCount: number
      totalEnergyKwh: number
    }
    expect(block).toMatchObject({ hash: 'block-hash', height: 900_000, txCount: 2 })
    // 750 bytes * 4.56 kWh. Compared loosely: the constant is not representable
    // in binary floating point, so the exact product carries a rounding tail.
    expect(block.totalEnergyKwh).toBeCloseTo(3420, 6)
  })

  it('paginates transactions and reports the total', async () => {
    const result = await run(
      `{ block(hash: "block-hash") { transactions(first: 1, offset: 1) { totalCount items { hash energyKwh } } } }`,
      {
        block: storedBlock,
        transactions: [
          { tx_hash: 'tx-1', size_bytes: 250 },
          { tx_hash: 'tx-2', size_bytes: 500 },
        ],
      },
    )

    expect(result.errors).toBeUndefined()
    const page = (
      result.data?.block as {
        transactions: { totalCount: number; items: { hash: string; energyKwh: number }[] }
      }
    ).transactions
    expect(page.totalCount).toBe(2)
    expect(page.items.map(item => item.hash)).toEqual(['tx-2'])
    expect(page.items[0].energyKwh).toBeCloseTo(2280, 6)
  })

  it('rejects a page size above the configured maximum', async () => {
    const result = await run(`{ block(hash: "h") { transactions(first: 5000) { totalCount } } }`, {
      block: storedBlock,
    })

    expect(result.errors?.[0].message).toMatch(/"first" must be between 1 and 1000/)
  })

  it('rejects passing both hash and height', async () => {
    const result = await run(`{ block(hash: "h", height: 1) { hash } }`, {})

    expect(result.errors?.[0].message).toMatch(/exactly one/)
  })

  it('rejects passing neither hash nor height', async () => {
    const result = await run(`{ block { hash } }`, {})

    expect(result.errors?.[0].message).toMatch(/exactly one/)
  })

  it('falls back to the Blockchain API for a block outside the retention window', async () => {
    // Requirement #1 asks for a specific block, not only a recent one.
    mockedReadThrough.mockResolvedValue({
      hash: 'old-hash',
      height: 500_000,
      time: BLOCK_TIME,
      sizeBytes: 100,
      txCount: 1,
      transactions: [],
    })

    const result = await run(`{ block(hash: "old-hash") { height totalEnergyKwh } }`, { block: null })

    expect(result.errors).toBeUndefined()
    const block = result.data?.block as { height: number; totalEnergyKwh: number }
    expect(block.height).toBe(500_000)
    expect(block.totalEnergyKwh).toBeCloseTo(456, 6)
    expect(mockedReadThrough).toHaveBeenCalledWith('old-hash', undefined)
  })

  it('returns null for a block that does not exist upstream either', async () => {
    mockedReadThrough.mockRejectedValue(new BlockNotFoundError('nope'))

    const result = await run(`{ block(hash: "nope") { hash } }`, { block: null })

    expect(result.errors).toBeUndefined()
    expect(result.data?.block).toBeNull()
  })
})

describe('Query.dailyEnergy', () => {
  const daily = [
    { day: '2026-03-02', total_bytes: '800', block_count: 2, tx_count: 2 },
    { day: '2026-03-01', total_bytes: '650', block_count: 2, tx_count: 2 },
  ]

  it('converts stored bytes to kWh per day', async () => {
    const result = await run(`{ dailyEnergy(lastDays: 2) { day totalEnergyKwh blockCount } }`, {
      daily,
      latestTime: new Date('2026-03-02T20:00:00.000Z'),
    })

    expect(result.errors).toBeUndefined()
    const days = result.data?.dailyEnergy as { day: string; totalEnergyKwh: number; blockCount: number }[]
    expect(days.map(entry => entry.day)).toEqual(['2026-03-02', '2026-03-01'])
    expect(days[0].totalEnergyKwh).toBeCloseTo(3648, 6) // 800 bytes * 4.56
    expect(days[1].totalEnergyKwh).toBeCloseTo(2964, 6) // 650 bytes * 4.56
    expect(days.every(entry => entry.blockCount === 2)).toBe(true)
  })

  it('marks a day complete only once a later day has blocks', async () => {
    const result = await run(`{ dailyEnergy(lastDays: 2) { day complete } }`, {
      daily,
      latestTime: new Date('2026-03-02T20:00:00.000Z'),
    })

    expect(result.data?.dailyEnergy).toEqual([
      // Newest day we hold: more of its blocks may still be in the confirmation lag.
      { day: '2026-03-02', complete: false },
      { day: '2026-03-01', complete: true },
    ])
  })

  it('marks nothing complete when there are no blocks at all', async () => {
    const result = await run(`{ dailyEnergy(lastDays: 2) { complete } }`, { daily, latestTime: null })

    expect(result.data?.dailyEnergy).toEqual([{ complete: false }, { complete: false }])
  })

  it.each([0, -1, 31])('rejects lastDays = %s as out of the retention window', async lastDays => {
    const result = await run(`query ($d: Int!) { dailyEnergy(lastDays: $d) { day } }`, {}, { d: lastDays })

    expect(result.errors?.[0].message).toMatch(/"lastDays" must be between 1 and 30/)
  })

  it('defaults to seven days', async () => {
    const result = await run(`{ dailyEnergy { day } }`, { daily, latestTime: null })

    expect(result.errors).toBeUndefined()
  })
})
