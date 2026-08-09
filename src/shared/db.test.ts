import { deleteBlocksOlderThan, recordBlock, utcDay } from './db'
import type { Queryable } from './db'
import type { FullBlock } from './types'

interface Recorded {
  sql: string
  params?: unknown[]
}

/**
 * Fake instead of a live database: the point of these tests is the *order* and
 * the *conditions* of the statements, which is exactly what a real database
 * would hide behind a correct-looking final row count.
 */
class FakeDb implements Queryable {
  public readonly queries: Recorded[] = []

  constructor(private readonly claimsAggregation: boolean) {}

  async query(sql: string, params?: unknown[]) {
    this.queries.push({ sql, params })
    if (sql.includes('UPDATE blocks SET aggregated')) {
      return this.claimsAggregation
        ? { rows: [{ hash: 'block-hash' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 0 }
  }

  ran(fragment: string): boolean {
    return this.queries.some(query => query.sql.includes(fragment))
  }

  paramsFor(fragment: string): unknown[] | undefined {
    return this.queries.find(query => query.sql.includes(fragment))?.params
  }
}

const block: FullBlock = {
  hash: 'block-hash',
  height: 900_000,
  time: new Date('2026-03-02T02:00:00.000Z'),
  sizeBytes: 750,
  txCount: 2,
  transactions: [
    { hash: 'tx-1', sizeBytes: 250 },
    { hash: 'tx-2', sizeBytes: 500 },
  ],
}

describe('recordBlock', () => {
  it('counts a block into daily_energy the first time', async () => {
    const db = new FakeDb(true)

    await expect(recordBlock(db, block, true)).resolves.toBe(true)

    expect(db.ran('INSERT INTO blocks')).toBe(true)
    expect(db.ran('INSERT INTO transactions')).toBe(true)
    expect(db.ran('INSERT INTO daily_energy')).toBe(true)
    expect(db.paramsFor('INSERT INTO daily_energy')).toEqual(['2026-03-02', 750, 2])
  })

  it('does not count the same block twice', async () => {
    // The aggregated flag is already true, so the false -> true flip finds no row.
    const db = new FakeDb(false)

    await expect(recordBlock(db, block, true)).resolves.toBe(false)

    // This is the failure that would silently corrupt daily_energy forever:
    // the rollup can never be recomputed, because retention deletes its source.
    expect(db.ran('INSERT INTO daily_energy')).toBe(false)
  })

  it('caches a block for reads without touching the rollup', async () => {
    const db = new FakeDb(true)

    // The API read-through may pull in a block from outside the retention
    // window, whose day is already rolled up and whose blocks are long deleted.
    await expect(recordBlock(db, block, false)).resolves.toBe(false)

    expect(db.ran('INSERT INTO blocks')).toBe(true)
    expect(db.ran('INSERT INTO transactions')).toBe(true)
    expect(db.ran('UPDATE blocks SET aggregated')).toBe(false)
    expect(db.ran('INSERT INTO daily_energy')).toBe(false)
  })

  it('lets the worker still count a block the read-through cached first', async () => {
    // Row exists with aggregated = false, so the flip succeeds and it counts.
    const db = new FakeDb(true)

    await expect(recordBlock(db, block, true)).resolves.toBe(true)

    expect(db.ran('INSERT INTO daily_energy')).toBe(true)
  })

  it('clears a stale block at the same height before inserting', async () => {
    const db = new FakeDb(true)

    await recordBlock(db, block, true)

    expect(db.paramsFor('DELETE FROM blocks WHERE height')).toEqual([900_000, 'block-hash'])
  })

  it('does not delete on the non-aggregating path', async () => {
    const db = new FakeDb(true)

    await recordBlock(db, block, false)

    expect(db.ran('DELETE FROM blocks WHERE height')).toBe(false)
  })
})

describe('utcDay', () => {
  it('buckets by UTC, not by the server timezone', () => {
    // 02:00 UTC is still the previous day in New York; the bucket must not move.
    expect(utcDay(new Date('2026-03-02T02:00:00.000Z'))).toBe('2026-03-02')
    expect(utcDay(new Date('2026-03-01T23:59:59.999Z'))).toBe('2026-03-01')
  })
})

describe('deleteBlocksOlderThan', () => {
  it('deletes block detail only and leaves the rollup alone', async () => {
    const db = new FakeDb(true)

    await deleteBlocksOlderThan(db, 30)

    expect(db.ran('DELETE FROM blocks')).toBe(true)
    expect(db.ran('daily_energy')).toBe(false)
    expect(db.paramsFor('DELETE FROM blocks')).toEqual([30])
  })
})
