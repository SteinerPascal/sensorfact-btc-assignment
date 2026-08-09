CREATE TABLE blocks (
  hash        TEXT PRIMARY KEY,
  height      INTEGER NOT NULL UNIQUE,
  time        TIMESTAMPTZ NOT NULL,
  -- Sum of the block's transaction sizes, not the raw block size.
  size_bytes  BIGINT NOT NULL,
  tx_count    INTEGER NOT NULL,
  -- Whether this block has been counted into daily_energy. The false -> true
  -- flip is what makes ingestion idempotent; see recordBlock in shared/db.ts.
  aggregated  BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX blocks_time_idx ON blocks (time);
CREATE INDEX blocks_aggregated_height_idx ON blocks (height) WHERE aggregated;

CREATE TABLE transactions (
  tx_hash     TEXT PRIMARY KEY,
  block_hash  TEXT NOT NULL REFERENCES blocks(hash) ON DELETE CASCADE,
  size_bytes  INTEGER NOT NULL
);
CREATE INDEX transactions_block_hash_idx ON transactions (block_hash);

-- Rolling aggregate. Deliberately NOT cascaded from blocks: retention deletes
-- block and transaction detail, but the daily totals survive, which is what lets
-- the API answer for the whole retention window from a small database.
-- The flip side is that this can never be recomputed, so every increment must
-- happen exactly once.
CREATE TABLE daily_energy (
  day          DATE PRIMARY KEY,
  total_bytes  BIGINT NOT NULL,
  block_count  INTEGER NOT NULL,
  tx_count     INTEGER NOT NULL
);
