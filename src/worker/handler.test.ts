import { runTick } from './handler'
import { fetchLatestHeight } from '../shared/blockchain-client'
import { getMaxBlockHeight, withWorkerLock } from '../shared/db'
import { ingestHeights } from '../shared/ingest'

jest.mock('../shared/blockchain-client')
jest.mock('../shared/ingest', () => ({
  ...jest.requireActual('../shared/ingest'),
  ingestHeights: jest.fn(),
}))
jest.mock('../shared/db', () => ({
  getPool: jest.fn(() => ({})),
  getMaxBlockHeight: jest.fn(),
  withWorkerLock: jest.fn(),
}))

const mockedLock = withWorkerLock as jest.MockedFunction<typeof withWorkerLock>
const mockedMaxHeight = getMaxBlockHeight as jest.MockedFunction<typeof getMaxBlockHeight>
const mockedLatestHeight = fetchLatestHeight as jest.MockedFunction<typeof fetchLatestHeight>
const mockedIngest = ingestHeights as jest.MockedFunction<typeof ingestHeights>

/** Runs the callback, as the real lock does when it is free. */
const lockAcquired = () => mockedLock.mockImplementation(fn => fn())

describe('runTick', () => {
  it('ingests the settled range and reports how many blocks it counted', async () => {
    lockAcquired()
    mockedMaxHeight.mockResolvedValue(899_990)
    mockedLatestHeight.mockResolvedValue(900_000)
    mockedIngest.mockResolvedValue(4)

    const result = await runTick()

    expect(result.status).toBe('ingested')
    expect(result.from).toBe(899_991)
    expect(result.to).toBe(899_994)
    expect(result.ingested).toBe(4)
    expect(mockedIngest).toHaveBeenCalledWith([899_991, 899_992, 899_993, 899_994])
  })

  it('does nothing when a concurrent tick holds the lock', async () => {
    // Scheduled invocations can overlap; two ticks walking the same range is the
    // scenario the advisory lock exists to prevent.
    mockedLock.mockResolvedValue(null)

    const result = await runTick()

    expect(result.status).toBe('skipped-locked')
    expect(mockedIngest).not.toHaveBeenCalled()
  })

  it('reports up-to-date without calling the ingestion path', async () => {
    lockAcquired()
    mockedMaxHeight.mockResolvedValue(899_994)
    mockedLatestHeight.mockResolvedValue(900_000)

    const result = await runTick()

    expect(result.status).toBe('up-to-date')
    expect(mockedIngest).not.toHaveBeenCalled()
  })

  it('clamps a large gap to one tick and flags that it is behind', async () => {
    lockAcquired()
    mockedMaxHeight.mockResolvedValue(899_000)
    mockedLatestHeight.mockResolvedValue(900_000)
    mockedIngest.mockResolvedValue(25)

    const result = await runTick()

    expect(result.clamped).toBe(true)
    expect(mockedIngest.mock.calls[0][0]).toHaveLength(25)
  })
})
