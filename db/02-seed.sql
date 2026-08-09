-- Minimal fixture so the API returns something the moment the stack is up,
-- without needing a backfill first: two UTC days, two blocks each, one
-- transaction per block.
--
-- Dates are relative to today so the rows always sit inside the retention
-- window. Heights are far below the current chain tip, so the worker's floor
-- (tip - RETENTION_DAYS * 144) keeps it from ever colliding with these.

INSERT INTO blocks (hash, height, time, size_bytes, tx_count, aggregated) VALUES
  ('seed0000000000000000000000000000000000000000000000000000000000a1', 900000,
   ((((now() AT TIME ZONE 'UTC')::date - 2) + time '10:00') AT TIME ZONE 'UTC'), 250, 1, TRUE),
  ('seed0000000000000000000000000000000000000000000000000000000000a2', 900001,
   ((((now() AT TIME ZONE 'UTC')::date - 2) + time '18:30') AT TIME ZONE 'UTC'), 400, 1, TRUE),
  ('seed0000000000000000000000000000000000000000000000000000000000b1', 900002,
   ((((now() AT TIME ZONE 'UTC')::date - 1) + time '09:15') AT TIME ZONE 'UTC'), 300, 1, TRUE),
  ('seed0000000000000000000000000000000000000000000000000000000000b2', 900003,
   ((((now() AT TIME ZONE 'UTC')::date - 1) + time '21:45') AT TIME ZONE 'UTC'), 500, 1, TRUE);

INSERT INTO transactions (tx_hash, block_hash, size_bytes) VALUES
  ('seedtx000000000000000000000000000000000000000000000000000000000a1',
   'seed0000000000000000000000000000000000000000000000000000000000a1', 250),
  ('seedtx000000000000000000000000000000000000000000000000000000000a2',
   'seed0000000000000000000000000000000000000000000000000000000000a2', 400),
  ('seedtx000000000000000000000000000000000000000000000000000000000b1',
   'seed0000000000000000000000000000000000000000000000000000000000b1', 300),
  ('seedtx000000000000000000000000000000000000000000000000000000000b2',
   'seed0000000000000000000000000000000000000000000000000000000000b2', 500);

-- Must match the blocks above: the rollup is increment-only and is never
-- recomputed from them.
INSERT INTO daily_energy (day, total_bytes, block_count, tx_count) VALUES
  (((now() AT TIME ZONE 'UTC')::date - 2), 650, 2, 2),
  (((now() AT TIME ZONE 'UTC')::date - 1), 800, 2, 2);
