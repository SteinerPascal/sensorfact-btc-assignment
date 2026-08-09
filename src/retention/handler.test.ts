import { runRetention } from './handler'
import { deleteBlocksOlderThan } from '../shared/db'
import { config } from '../shared/config'

jest.mock('../shared/db', () => ({
  getPool: jest.fn(() => ({})),
  deleteBlocksOlderThan: jest.fn(),
}))

const mockedDelete = deleteBlocksOlderThan as jest.MockedFunction<typeof deleteBlocksOlderThan>

describe('runRetention', () => {
  it('deletes using the configured retention window', async () => {
    mockedDelete.mockResolvedValue(12)

    const result = await runRetention()

    // RETENTION_DAYS is the single source of truth: the same value bounds the
    // backfill and caps `lastDays` in the API.
    expect(mockedDelete).toHaveBeenCalledWith(expect.anything(), config.retentionDays)
    expect(result.blocksDeleted).toBe(12)
    expect(result.retentionDays).toBe(config.retentionDays)
  })

  it('reports a clean run when there was nothing to delete', async () => {
    mockedDelete.mockResolvedValue(0)

    await expect(runRetention()).resolves.toMatchObject({ blocksDeleted: 0 })
  })

  it('propagates failures instead of reporting success', async () => {
    mockedDelete.mockRejectedValue(new Error('connection reset'))

    await expect(runRetention()).rejects.toThrow('connection reset')
  })
})
