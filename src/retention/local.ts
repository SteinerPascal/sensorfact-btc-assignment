import { closePool } from '../shared/db'
import { handler } from './handler'

/** Runs retention once from the command line: `yarn retention:once`. */
async function main(): Promise<void> {
  await handler()
  await closePool()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
