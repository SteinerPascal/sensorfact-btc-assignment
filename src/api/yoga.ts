import { createYoga } from 'graphql-yoga'
import { getPool } from '../shared/db'
import { schema } from './schema'
import type { ApiContext } from './schema'

/**
 * GraphiQL is left enabled: it is the schema documentation the frontend team
 * reads, and this service exposes no sensitive data.
 */
export const yoga = createYoga<object, ApiContext>({
  schema,
  graphqlEndpoint: '/graphql',
  landingPage: false,
  graphiql: { title: 'BTC Energy API' },
  context: () => ({ db: getPool() }),
})
