CREATE TABLE IF NOT EXISTS events (
  id                   BIGSERIAL PRIMARY KEY,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  instance_id          TEXT NOT NULL,
  event_name           TEXT NOT NULL,
  event_time_unix_nano NUMERIC NOT NULL,
  attributes           JSONB NOT NULL DEFAULT '{}'::jsonb,
  resource             JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS events_received_at_idx ON events (received_at);
CREATE INDEX IF NOT EXISTS events_event_name_idx ON events (event_name);
CREATE INDEX IF NOT EXISTS events_instance_id_idx ON events (instance_id);

CREATE TABLE IF NOT EXISTS rate_counter (
  instance_id TEXT NOT NULL,
  hour_bucket TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (instance_id, hour_bucket)
);

CREATE TABLE IF NOT EXISTS heartbeat_dedupe (
  instance_id TEXT NOT NULL,
  window_key  BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, window_key)
);

CREATE TABLE IF NOT EXISTS event_rollup_daily (
  day                DATE NOT NULL,
  event_name         TEXT NOT NULL,
  service_version    TEXT NOT NULL DEFAULT '',
  surface            TEXT NOT NULL DEFAULT '',
  model              TEXT NOT NULL DEFAULT '',
  event_count        BIGINT NOT NULL DEFAULT 0,
  distinct_instances BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event_name, service_version, surface, model)
);

CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO meta (key, value)
VALUES ('schema_version', '1')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
