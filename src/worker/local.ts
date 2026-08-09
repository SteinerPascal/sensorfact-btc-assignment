import { closePool } from '../shared/db'
import { handler } from './handler'

/** Runs a single worker tick from the command line: `yarn worker:once`. */
async function main(): Promise<void> {
  await handler()
  await closePool()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
