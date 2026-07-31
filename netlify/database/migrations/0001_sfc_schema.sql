CREATE TABLE IF NOT EXISTS sfc_realtime_values (
  key TEXT PRIMARY KEY,
  value_json TEXT,
  version BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted SMALLINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sfc_realtime_events (
  sequence BIGSERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  value_json TEXT,
  version BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted SMALLINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS sfc_realtime_events_key_sequence
  ON sfc_realtime_events(key, sequence);
