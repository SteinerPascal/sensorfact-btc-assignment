# Implementation Plan

Backend engineer assignment: a GraphQL API that reports Bitcoin energy consumption
per block, per transaction, and per day.

## Assumptions

- Energy cost is **4.56 kWh per byte** (given).
- The consumer is a frontend, so responses must be small and fast — we answer from
  our own DB, not by proxying the Blockchain API.
- Postgres is available (already used in other services).
- One upstream token for blockchain.info; it is rate limited.
- "Energy of a block" = sum of its **transaction** sizes, not the raw block size.
  The assignment asks for energy _per transaction_, so this keeps block totals and
  transaction totals consistent.

## Out of scope

- Expert feature: energy per wallet address.
- Authentication / authorization.
- Input sanitisation beyond GraphQL's own type validation.

## Core idea

The Blockchain API is rate limited, so we never call it from the request path.
A **worker** ingests blocks into Postgres; the **API** only reads from Postgres.
This is also our answer to the "optimize the number of calls" requirement — a block
is fetched exactly once, ever.

```
blockchain.info  ──►  worker  ──►  postgres  ──►  api  ──►  frontend
                                      ▲
                                  retention (deletes old detail)
```

## Structure

A **single package** with four handlers and a shared core:

```
src/
  shared/     db, blockchain-client, config, telemetry, energy
  api/        graphql handler
  worker/     ingestion handler (cron)
  retention/  cleanup handler (cron)
  backfill/   one-off script
```

Not a monorepo. `serverless.yml` already bundles each `handler:` entry separately,
so the three modules deploy as independent Lambdas without workspace tooling.
The dependency direction is enforced with eslint instead of a package resolver:

```js
'no-restricted-imports': ['error', { patterns: [
  { group: ['**/api/**', '**/worker/**', '**/retention/**'],
    message: 'shared/ must not depend on modules' }
]}]
```

This keeps the boundaries real and makes a later extraction to workspaces mechanical.

## Configuration

`RETENTION_DAYS` (default 30) is the **single source of truth**. It drives all three of:

- how far the backfill reaches back,
- what retention deletes,
- the maximum accepted `lastDays` in the API.

Other config: `MAX_BLOCKS_PER_TICK`, `BLOCKCHAIN_REQUEST_DELAY_MS`, `TX_PAGE_SIZE`,
`CONFIRMATION_LAG` (default 6).

## Database

```sql
CREATE TABLE blocks (
  hash        TEXT PRIMARY KEY,
  height      INTEGER NOT NULL UNIQUE,
  time        TIMESTAMPTZ NOT NULL,
  size_bytes  BIGINT NOT NULL,     -- sum of transaction sizes
  tx_count    INTEGER NOT NULL,
  aggregated  BOOLEAN NOT NULL DEFAULT FALSE  -- counted into daily_energy yet?
);
CREATE INDEX ON blocks (time);

CREATE TABLE transactions (
  tx_hash     TEXT PRIMARY KEY,
  block_hash  TEXT NOT NULL REFERENCES blocks(hash) ON DELETE CASCADE,
  size_bytes  INTEGER NOT NULL
);
CREATE INDEX ON transactions (block_hash);

-- rolling aggregate; deliberately NOT cascaded from blocks
CREATE TABLE daily_energy (
  day          DATE PRIMARY KEY,
  total_bytes  BIGINT NOT NULL,
  block_count  INTEGER NOT NULL,
  tx_count     INTEGER NOT NULL
);
```

Two things this schema depends on:

**1. `daily_energy` is increment-only and must be idempotent.** Retention deletes
`blocks` and `transactions` but keeps `daily_energy`, so the aggregate can never be
recomputed from source. If a block is ingested twice (retry, crash mid-tick,
overlapping cron) we would double-count permanently.

The guard is the `aggregated` column. `recordBlock` increments the rollup only if
it wins an atomic `false -> true` flip on that block, in the **same transaction**:

```sql
UPDATE blocks SET aggregated = true WHERE hash = $1 AND aggregated = false RETURNING hash
```

Gating on the flip rather than on "did the block row insert" is what makes the two
writers compose: the API read-through can cache a block without counting it, and
the worker can still count that same block later.

**2. Days are bucketed in UTC**, explicitly: `(time AT TIME ZONE 'UTC')::date`.
Otherwise buckets shift with the server timezone and tests pass locally but fail in CI.

Energy is stored as bytes and converted to kWh at read time, so the constant can change
without a migration.

## Worker

Cron, bounded work per invocation, resumable via the DB. Each tick:

1. `x = SELECT max(height) FROM blocks`
2. `GET /latestblock` → `y`; target tip `j = y - CONFIRMATION_LAG`
   (the 6-block lag is our reorg protection: we only ingest confirmed blocks)
3. **Cold start floor:** `from = max(x + 1, y - RETENTION_DAYS * 144)`.
   Without this, an empty DB either ingests nothing or tries to walk the whole chain.
4. Clamp the range to `MAX_BLOCKS_PER_TICK`. Leftover work is picked up next tick.
5. `GET /block-height/$height?format=json` per block, and store block +
   transactions + the `daily_energy` increment in one DB transaction.

**Fetching blocks.** `/block-height` returns the _full_ block with its transaction
list, so the worker needs one call per block and no `rawblock` follow-up. It can
return several blocks for one height after a fork, so we take the `main_chain` one.
A call per block is unavoidable regardless of endpoint: transaction sizes exist only
in the full block payload. What the backfill optimises is the _enumeration_ of which
hashes to fetch, not the fetching itself.

**Rate limiting.** All Blockchain API calls go through one client in `shared/` with a
fixed delay between requests and exponential backoff on 429/5xx, so the worker and
backfill cannot compete with each other.

**Overlap.** Cron can double-fire. The tick takes a Postgres advisory lock and exits
immediately if it cannot get it. This is also the second line of defence for the
`daily_energy` double-count.

**Observability.** OpenTelemetry with `ConsoleSpanExporter`: Blockchain API response
time, blocks ingested per tick, tick duration, and a warning when the range was
clamped by `MAX_BLOCKS_PER_TICK` (meaning we are falling behind).

## Backfill

A script, runnable against a configurable environment, that fills `RETENTION_DAYS`
of history. It walks **day by day** using `GET /blocks/$time_ms?format=json`, which
returns block headers for a whole day in one call — one enumeration call per day
instead of one per block. That endpoint returns only `hash`/`height`/`time`, so
blocks above the settled tip are filtered by height rather than by `main_chain`.

Day-at-a-time also means each `daily_energy` row is written complete-or-not-at-all,
and the script is resumable per day. Blocks already counted are skipped without an
API call; re-running it is a no-op thanks to the `aggregated` guard.

Oldest day first, so an interrupted run leaves a contiguous window rather than holes.

## Retention

Cron. Deletes `blocks` older than `RETENTION_DAYS` (transactions cascade).
`daily_energy` is kept — the aggregates stay available even once the detail is gone.
Logs rows deleted, or the reason it failed.

The cutoff is pinned to UTC on both sides:

```sql
WHERE time < (((now() AT TIME ZONE 'UTC')::date - $1::int) AT TIME ZONE 'UTC')
```

Comparing a `timestamptz` against a bare `date` would let Postgres resolve the date
in the **server's** timezone, shifting the retention boundary by the UTC offset.

## API

GraphQL Yoga v5, reads only from Postgres, serves the schema documentation.

```graphql
type Query {
  block(hash: ID, height: Int): Block
  dailyEnergy(lastDays: Int! = 7): [DailyEnergy!]!
}

type Block {
  hash: ID!
  height: Int!
  time: DateTime!
  txCount: Int!
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
  complete: Boolean!
}
```

- `lastDays` is validated to `1..RETENTION_DAYS`; out of range is a GraphQL error,
  because the data provably is not there. `0` is meaningless.
- `complete` is `day < the UTC day of the newest block we hold` — a day is finished
  only once a block from a later day has arrived. That covers both today (still
  accumulating) and the newest day (still inside the confirmation lag).
- Days with no data are returned as zero via `generate_series` rather than omitted,
  so the frontend's series has no holes.
- **`block` falls back to a read-through.** On a cache miss we fetch `rawblock`, store
  it, and return it. Requirement #1 asks for _a specific block_, not only recent ones —
  without this, anything outside the retention window returns `null`. It also
  strengthens the "avoid duplicate calls" story: the miss is paid once.
  The read-through stores with `aggregated = false`: it may pull in a block from
  outside the retention window, whose day is already rolled up and whose blocks are
  long deleted. Counting it would corrupt that day permanently.
- Transactions are paginated (page size configurable) — a block can hold thousands.

## Serverless notes

- The worker does **bounded** work per invocation and keeps its position in the DB;
  it must not sleep through a long rate-limited loop inside one Lambda.
- The 29s timeout on the current config is the httpApi ceiling. The cron handlers get
  their own, longer timeout.
- Postgres connections are pooled with a small maximum, so concurrent invocations do
  not exhaust the server.

## Testing

Docker Compose with Postgres, seeded with two days of blocks (one transaction each).
Logs and metrics to the console.

Unit tests:

- `rawblock` parsing, from a recorded fixture.
- Energy calculation.
- **Ingesting the same block twice does not double-count `daily_energy`.**
- **A gap larger than `MAX_BLOCKS_PER_TICK` is clamped and resumed next tick.**
- Retention deletes the right rows and leaves `daily_energy` intact.
- API input/output tests, including `lastDays` out of range and the `block`
  read-through miss.

The two bolded cases are the risky paths — they are where silent, permanent data
corruption would come from.

## Validation

Verified on the built system, not just asserted:

- `yarn compile`, `yarn lint`, `yarn test` — clean; **43 tests pass**.
- `docker compose up` brings up Postgres with the schema and seed applied.
- `yarn start` serves the API; `dailyEnergy` and `block` return correct values and
  both validation errors fire.
- Read-through: an uncached block took 5.6s (fetch + store), the same block 0.34s
  from the DB on the next call.
- The read-through block landed with `aggregated = false` and **did not** alter
  `daily_energy` — the invariant that would otherwise corrupt the rollup.
- A real worker tick floored to `tip - 30*144`, clamped to `MAX_BLOCKS_PER_TICK`,
  logged that it was still behind, and ingested 25 blocks.
- A concurrent `worker:once` was refused by the advisory lock while that tick ran.
- Re-ingesting an already-counted block against live Postgres returned `false` and
  left `daily_energy` byte-identical.

Known gaps, deliberately left:

- The `complete` flag and retention are exercised by unit tests but not by a full
  30-day backfill — that run is hours long at the API's rate limit.
- A reorg deeper than `CONFIRMATION_LAG` would leave its share in `daily_energy`;
  the rollup cannot be recomputed by design. Documented at the guard in `db.ts`.
- `docker compose` v2 syntax is used in `package.json`; this machine has the v1
  `docker-compose` binary, so `yarn db:up` needs adjusting there.
- The handlers still deploy as serverless functions.
