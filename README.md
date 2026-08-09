# Backend Engineer Technical Assignment

## My thoughts on the task
As I understand is the task to show the energy used for bitcoin transactions. Interestingly I don't think the endpoints I had to deliver will really be a solution for this. The problem is that the energy used for a transaction is quite small compared to the energy used for mining. So if you really want to see the impact and energy usage of the bitcoin blockchain then you should more compare the mining difficulty with the time it was solved and some estimation on how much energy it takes a GPU to find that solution.  

Furthermore, if sustainability is so important then one might be really considering whether a blockchain is the needed solution. It is just per design not that efficient because everything has to go through a whole networks instead of one centralized actor ;) 

## Out of scope
I left the (expert) feature out-of-scope because it had quite a few unknowns to me. Especially with the limitation of the free blockchain api key (5 requests/second limit & 1,000 API requests/day) it is difficult to not run quickly into a limit situation. or even worse chooking other requests by trying to fetch a whole wallet history. Especially because the task asked for "The platform will visualize the energy consumed by the network...". which means an adhoc wallet history fetching would need quite heavy pagination and could eat up the API limits quite rapidly. So there I would just ask for a bit more functional clarity. 
Another interesting question is about how the energy should be calculated for each wallet. especially because a transaction can involve mutliple wallets. And what about if a wallet receives a transaction? Does this count for half the energy?

# Solution

**Disclaimer**: The input for the AI and my personal design decisions trade-offs are written up in [`implementation.md`](./implementation.md).

The Blockchain API is rate limited, so it is never called from the request path.
A **worker** ingests settled blocks into Postgres; the **API** reads only from
Postgres. That is also the answer to the "optimize the number of calls"
requirement: a block is fetched once, ever.

One package, four entry points — `api`, `worker`, `retention` and a `backfill`
script — over a shared core. Each handler is bundled separately by
`serverless-esbuild`, so they deploy as independent Lambdas.

## Requirements

- **Node.js 20.x** — run `nvm use` in the root folder
- **Yarn** (v1, classic)
- **Docker** with Compose, for the local Postgres

use `docker-compose`
> wherever this README says `docker compose`. The `db:up` / `db:down` scripts
> assume v2.

## Running it

```sh
nvm use
yarn
```

**1. Start Postgres.** Schema and seed data are applied automatically on first
start — two UTC days of blocks, one transaction each — so the API returns
something immediately, without waiting for an ingest.

```sh
yarn db:up          # docker compose up -d
```

**2. Start the API.**

```sh
yarn start
```

GraphiQL is at **http://localhost:4000/graphql** and serves the schema
documentation.

`serverless offline` also registers the two cron schedules, so the worker starts
ingesting live blocks every 5 minutes on its own. To run either one immediately
instead:

```sh
yarn worker:once        # one bounded ingest tick
yarn retention:once     # one retention sweep
```

**3. Optionally backfill history.** The worker only walks forward from where it
is; this fills the window backwards, a day at a time.

```sh
yarn backfill                       # RETENTION_DAYS of history
yarn backfill --days 2              # just the last two days
```

> A full 30-day backfill is roughly 4,300 blocks. At the default one request per
> second that is hours. so i would not recommend it. 

Tear down with `yarn db:down` (this also drops the volume).

## Try it

```graphql
# Energy per day, newest first
{
  dailyEnergy(lastDays: 3) {
    day
    totalEnergyKwh
    blockCount
    complete
  }
}

# A specific block and its transactions.
# Not in the database? It is fetched from blockchain.info and cached,
# so the second call is served locally.
{
  block(height: 700000) {
    hash
    time
    txCount
    totalEnergyKwh
    transactions(first: 5) {
      totalCount
      items {
        hash
        sizeBytes
        energyKwh
      }
    }
  }
}
```

## Development

```sh
yarn test           # 43 unit tests
yarn compile        # tsc --noEmit
yarn lint           # eslint, incl. the module-boundary rule
yarn format         # prettier
```

Logs are structured JSON on stdout; traces and metrics go to the console through
OpenTelemetry (`ConsoleSpanExporter`), since there is no collector to ship to in a demo.

## Configuration

| Variable                      | Default                                   | Purpose                                            |
| ----------------------------- | ----------------------------------------- | -------------------------------------------------- |
| `DATABASE_URL`                | `postgres://btc:btc@localhost:5432/btcenergy` | Postgres connection                             |
| `RETENTION_DAYS`              | `30`                                      | History window; also caps `lastDays`               |
| `CONFIRMATION_LAG`            | `6`                                       | Blocks left uningested at the tip, for reorg safety |
| `MAX_BLOCKS_PER_TICK`         | `25`                                      | Upper bound on work per worker invocation          |
| `BLOCKCHAIN_REQUEST_DELAY_MS` | `1000`                                    | Minimum spacing between Blockchain API calls       |
| `TX_PAGE_SIZE_MAX`            | `1000`                                    | Largest `first` accepted on `Block.transactions`   |
| `DATABASE_POOL_MAX`           | `4`                                       | Pool size; kept small for concurrent invocations   |

