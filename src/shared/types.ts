/** A transaction as we store it: we only care about its size. */
export interface BlockTransaction {
  hash: string
  sizeBytes: number
}

/** A fully fetched block, ready to be written to the database. */
export interface FullBlock {
  hash: string
  height: number
  time: Date
  /**
   * Sum of the sizes of the block's transactions -- deliberately not the raw
   * block size, which also covers the header. The assignment asks for energy
   * per transaction, so block totals and transaction totals stay consistent.
   */
  sizeBytes: number
  txCount: number
  transactions: BlockTransaction[]
}

/** The lightweight shape returned by the "blocks for one day" endpoint. */
export interface BlockSummary {
  hash: string
  height: number
  time: Date
}

export interface StoredBlock {
  hash: string
  height: number
  time: Date
  sizeBytes: number
  txCount: number
}

export interface DailyEnergyRow {
  day: string
  totalBytes: number
  blockCount: number
  txCount: number
}
