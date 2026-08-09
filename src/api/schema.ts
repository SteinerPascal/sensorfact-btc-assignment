import { createSchema } from 'graphql-yoga'
import { GraphQLError } from 'graphql'
import { DateResolver, DateTimeResolver } from 'graphql-scalars'
import { config } from '../shared/config'
import { BlockNotFoundError } from '../shared/blockchain-client'
import {
  countTransactions,
  findBlock,
  getDailyEnergy,
  getLatestBlockDay,
  listTransactions,
} from '../shared/db'
import type { Queryable } from '../shared/db'
import { energyKwh } from '../shared/energy'
import { ingestForRead } from '../shared/ingest'
import { createLogger } from '../shared/telemetry'
import type { StoredBlock } from '../shared/types'

const log = createLogger('api')

export interface ApiContext {
  db: Queryable
}

const typeDefs = /* GraphQL */ `
  scalar DateTime
  scalar Date

  type Query {
    """
    A single block by hash or height. Exactly one of the two must be given.
    Blocks outside the retention window are fetched from the Blockchain API on
    demand and cached, so this is not limited to recent history.
    """
    block(hash: ID, height: Int): Block

    """
    Energy totals per UTC day, newest first. Days without data are returned as
    zero rather than omitted, so the series has no holes.
    """
    dailyEnergy(lastDays: Int! = 7): [DailyEnergy!]!
  }

  type Block {
    hash: ID!
    height: Int!
    time: DateTime!
    txCount: Int!
    "Total energy of the block's transactions, in kWh."
    totalEnergyKwh: Float!
    transactions(first: Int = 100, offset: Int = 0): TransactionPage!
  }

  type TransactionPage {
    totalCount: Int!
    items: [Transaction!]!
  }

  type Transaction {
    hash: ID!
    sizeBytes: Int!
    energyKwh: Float!
  }

  type DailyEnergy {
    day: Date!
    totalEnergyKwh: Float!
    blockCount: Int!
    txCount: Int!
    """
    False while a day can still gain blocks: today, and the newest day we hold
    (more of its blocks may still be inside the confirmation lag).
    """
    complete: Boolean!
  }
`

interface DailyEnergyParent {
  day: string
  totalBytes: number
  blockCount: number
  txCount: number
  latestDay: string | null
}

export const schema = createSchema<ApiContext>({
  typeDefs,
  resolvers: {
    DateTime: DateTimeResolver,
    Date: DateResolver,

    Query: {
      block: async (
        _parent: unknown,
        args: { hash?: string | null; height?: number | null },
        context: ApiContext,
      ): Promise<StoredBlock | null> => {
        const hasHash = args.hash !== undefined && args.hash !== null
        const hasHeight = args.height !== undefined && args.height !== null

        if (hasHash === hasHeight) {
          throw new GraphQLError('Provide exactly one of "hash" or "height"', {
            extensions: { code: 'BAD_USER_INPUT' },
          })
        }
        if (hasHeight && args.height! < 0) {
          throw new GraphQLError('"height" must not be negative', {
            extensions: { code: 'BAD_USER_INPUT' },
          })
        }

        const stored = await findBlock(context.db, {
          hash: hasHash ? args.hash! : undefined,
          height: hasHeight ? args.height! : undefined,
        })
        if (stored) {
          return stored
        }

        // Read-through: requirement #1 asks for a specific block, not only a
        // recent one. The miss is paid once; afterwards it is served from the DB.
        try {
          const fetched = await ingestForRead(
            hasHash ? args.hash! : undefined,
            hasHeight ? args.height! : undefined,
          )
          log.info('read-through cache fill', { hash: fetched.hash, height: fetched.height })
          return {
            hash: fetched.hash,
            height: fetched.height,
            time: fetched.time,
            sizeBytes: fetched.sizeBytes,
            txCount: fetched.txCount,
          }
        } catch (error) {
          if (error instanceof BlockNotFoundError) {
            return null
          }
          throw error
        }
      },

      dailyEnergy: async (
        _parent: unknown,
        args: { lastDays: number },
        context: ApiContext,
      ): Promise<DailyEnergyParent[]> => {
        if (!Number.isInteger(args.lastDays) || args.lastDays < 1 || args.lastDays > config.retentionDays) {
          // Beyond the retention window the data provably is not there, so this
          // is an error rather than a silently short answer.
          throw new GraphQLError(`"lastDays" must be between 1 and ${config.retentionDays}`, {
            extensions: { code: 'BAD_USER_INPUT' },
          })
        }

        const [rows, latestDay] = await Promise.all([
          getDailyEnergy(context.db, args.lastDays),
          getLatestBlockDay(context.db),
        ])
        return rows.map(row => ({ ...row, latestDay }))
      },
    },

    Block: {
      totalEnergyKwh: (block: StoredBlock) => energyKwh(block.sizeBytes),

      transactions: async (
        block: StoredBlock,
        args: { first: number; offset: number },
        context: ApiContext,
      ) => {
        if (args.first < 1 || args.first > config.txPageSizeMax) {
          throw new GraphQLError(`"first" must be between 1 and ${config.txPageSizeMax}`, {
            extensions: { code: 'BAD_USER_INPUT' },
          })
        }
        if (args.offset < 0) {
          throw new GraphQLError('"offset" must not be negative', {
            extensions: { code: 'BAD_USER_INPUT' },
          })
        }

        const [totalCount, items] = await Promise.all([
          countTransactions(context.db, block.hash),
          listTransactions(context.db, block.hash, args.first, args.offset),
        ])
        return { totalCount, items }
      },
    },

    Transaction: {
      energyKwh: (transaction: { sizeBytes: number }) => energyKwh(transaction.sizeBytes),
    },

    DailyEnergy: {
      totalEnergyKwh: (row: DailyEnergyParent) => energyKwh(row.totalBytes),
      // A day is finished only once we hold a block belonging to a later day.
      complete: (row: DailyEnergyParent) => row.latestDay !== null && row.day < row.latestDay,
    },
  },
})
