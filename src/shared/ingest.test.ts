import { computeIngestRange } from './ingest'

const base = {
  retentionDays: 30,
  confirmationLag: 6,
  maxBlocksPerTick: 25,
  blocksPerDay: 144,
}

describe('computeIngestRange', () => {
  it('starts at the retention floor on a cold start instead of walking the whole chain', () => {
    const range = computeIngestRange({ ...base, dbMaxHeight: null, latestHeight: 900_000 })

    // 30 days * 144 blocks = 4320 blocks of history, not 900k.
    expect(range).toEqual({ from: 895_680, to: 895_704, clamped: true })
  })

  it('continues from the last counted block', () => {
    const range = computeIngestRange({ ...base, dbMaxHeight: 899_990, latestHeight: 900_000 })

    // Tip is 900_000 - 6 = 899_994, so only four blocks are settled.
    expect(range).toEqual({ from: 899_991, to: 899_994, clamped: false })
  })

  it('clamps a large gap and reports that it is still behind', () => {
    const range = computeIngestRange({ ...base, dbMaxHeight: 899_000, latestHeight: 900_000 })

    expect(range).toEqual({ from: 899_001, to: 899_025, clamped: true })
  })

  it('re-floors after a long outage rather than replaying months of blocks', () => {
    // The database is 50 days behind, but we only keep 30 days.
    const range = computeIngestRange({ ...base, dbMaxHeight: 892_800, latestHeight: 900_000 })

    expect(range?.from).toBe(895_680)
  })

  it('returns null when everything settled is already ingested', () => {
    const range = computeIngestRange({ ...base, dbMaxHeight: 899_994, latestHeight: 900_000 })

    expect(range).toBeNull()
  })

  it('never ingests inside the confirmation lag', () => {
    const range = computeIngestRange({ ...base, dbMaxHeight: 899_993, latestHeight: 900_000 })

    expect(range).toEqual({ from: 899_994, to: 899_994, clamped: false })
  })

  it('resumes exactly where a clamped tick stopped', () => {
    const first = computeIngestRange({ ...base, dbMaxHeight: 899_000, latestHeight: 900_000 })
    const second = computeIngestRange({ ...base, dbMaxHeight: first!.to, latestHeight: 900_000 })

    expect(second!.from).toBe(first!.to + 1)
  })
})
