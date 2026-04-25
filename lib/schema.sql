-- Memory system schema v3: segments, ts, facts, vec
-- Safe to run on both fresh DB and existing installations (idempotent).
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Drop legacy tables (no-op on fresh DB) ───────────────────────────
DROP TABLE IF EXISTS perceptual_memories CASCADE;
DROP TABLE IF EXISTS rational_memories CASCADE;
DROP TABLE IF EXISTS threads CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;

-- ── Core tables ───────────────────────────────────────────────────────
-- segments must come before ts (ts has FK → segments)

CREATE TABLE IF NOT EXISTS segments (
  id            BIGINT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  title         TEXT,
  abstract      TEXT,
  started_at    TIMESTAMPTZ NOT NULL,
  last_event_at TIMESTAMPTZ NOT NULL,
  duration      INTEGER NOT NULL DEFAULT 0,
  event_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type  TEXT NOT NULL,
  session_id  TEXT,
  segment_id  BIGINT REFERENCES segments(id) ON DELETE SET NULL,
  content     TEXT NOT NULL,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS facts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content       TEXT NOT NULL,
  summary       TEXT NOT NULL,
  refs          JSONB DEFAULT '[]',
  confirm_count INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vec (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_table       TEXT NOT NULL,
  ref_id          TEXT NOT NULL,
  content_preview TEXT,
  embedding       vector(1024) NOT NULL,
  refs            JSONB DEFAULT '[]',
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS segments_status_idx     ON segments (status);
CREATE INDEX IF NOT EXISTS segments_started_at_idx ON segments (started_at);

CREATE INDEX IF NOT EXISTS ts_ts_idx      ON ts USING BRIN (ts);
CREATE INDEX IF NOT EXISTS ts_session_idx ON ts (session_id);
CREATE INDEX IF NOT EXISTS ts_segment_idx ON ts (segment_id);
CREATE UNIQUE INDEX IF NOT EXISTS ts_dedup_idx ON ts (session_id, ts, md5(content));

CREATE INDEX IF NOT EXISTS vec_embedding_idx ON vec USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS vec_ref_idx       ON vec (ref_table, ref_id);

-- ── Migrations (safe on fresh DB: IF EXISTS / IF NOT EXISTS guards) ───

-- Remove legacy column from ts
ALTER TABLE ts DROP COLUMN IF EXISTS dreamed;

-- Add segment_id to ts if upgrading from pre-segment schema
ALTER TABLE ts ADD COLUMN IF NOT EXISTS segment_id BIGINT REFERENCES segments(id) ON DELETE SET NULL;

-- Add segments status CHECK constraint (named, so we can idempotently manage it)
ALTER TABLE segments DROP CONSTRAINT IF EXISTS segments_status_check;
ALTER TABLE segments ADD CONSTRAINT segments_status_check
  CHECK (status IN ('open', 'closed', 'dreamed'));

-- Ensure vec.ref_id is TEXT (was UUID in older installations)
ALTER TABLE vec ALTER COLUMN ref_id TYPE TEXT USING ref_id::text;

-- Add refs column to vec if upgrading
ALTER TABLE vec ADD COLUMN IF NOT EXISTS refs JSONB DEFAULT '[]';

-- Remove stale vec rows with obsolete ref_table values before re-adding CHECK
DELETE FROM vec WHERE ref_table NOT IN ('ts', 'facts', 'segments');
ALTER TABLE vec DROP CONSTRAINT IF EXISTS vec_ref_table_check;
ALTER TABLE vec ADD CONSTRAINT vec_ref_table_check
  CHECK (ref_table IN ('ts', 'facts', 'segments'));
