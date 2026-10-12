-- Actual RE2-OB schemas were inspected before designing these tables.
-- Store normalized epoch microseconds as BIGINT, never a JS Date/float.
CREATE TABLE incidents (
  id uuid PRIMARY KEY,
  display_title text NOT NULL,
  system text NOT NULL,
  start_time_us bigint NOT NULL,
  end_time_us bigint NOT NULL CHECK (end_time_us >= start_time_us),
  import_status text NOT NULL CHECK (import_status IN ('importing', 'ready', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE metric_samples (
  incident_id uuid NOT NULL REFERENCES incidents(id),
  source_row bigint NOT NULL,
  source_field text NOT NULL,
  ts_us bigint NOT NULL,
  service text NOT NULL,
  metric_name text NOT NULL,
  value double precision,
  unit text,
  missing_kind text CHECK (missing_kind IN ('null', 'nan')),
  PRIMARY KEY (incident_id, source_row, source_field)
);
CREATE INDEX metric_samples_scope ON metric_samples (incident_id, service, ts_us, metric_name);
CREATE TABLE log_entries (
  incident_id uuid NOT NULL REFERENCES incidents(id),
  source_row bigint NOT NULL,
  ts_us bigint NOT NULL,
  service text NOT NULL,
  severity text,
  message text,
  source_ref text NOT NULL,
  PRIMARY KEY (incident_id, source_row)
);
CREATE INDEX log_entries_scope ON log_entries (incident_id, service, ts_us);
CREATE TABLE trace_spans (
  incident_id uuid NOT NULL REFERENCES incidents(id),
  source_row bigint NOT NULL,
  trace_id text NOT NULL,
  span_id text NOT NULL,
  parent_span_id text,
  service text NOT NULL,
  source_service text NOT NULL,
  start_time_us bigint NOT NULL,
  duration_us bigint NOT NULL CHECK (duration_us >= 0),
  status_code text,
  attributes jsonb NOT NULL CHECK (octet_length(attributes::text) <= 16384),
  source_ref text NOT NULL,
  PRIMARY KEY (incident_id, source_row)
);
CREATE INDEX trace_spans_scope ON trace_spans (incident_id, service, start_time_us, trace_id);

-- Import bookkeeping is administrative, not granted to the runtime role.
CREATE TABLE import_jobs (
  incident_id uuid NOT NULL REFERENCES incidents(id),
  kind text NOT NULL CHECK (kind IN ('metrics', 'logs', 'traces')),
  revision text NOT NULL,
  sha256 text NOT NULL,
  source_bytes bigint NOT NULL,
  source_rows bigint NOT NULL,
  next_row bigint NOT NULL DEFAULT 0,
  normalized_rows bigint NOT NULL DEFAULT 0,
  null_values bigint NOT NULL DEFAULT 0,
  min_time_us bigint,
  max_time_us bigint,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'importing', 'validated', 'failed')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, kind)
);
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
