-- © Infinitum Corporation®. All rights reserved.
-- Operational tables plus an append-only Firmament-style audit log.
-- Biometric templates are not stored here. Only pointers and attestations.

CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'reviewer', 'auditor')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purposes (
  code TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  edition TEXT NOT NULL CHECK (edition IN ('civilian', 'business')),
  legal_bases TEXT[] NOT NULL,
  dataset_ids TEXT[] NOT NULL,
  allowed_roles TEXT[] NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subjects (
  cid TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'withdrawn')),
  record_attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  enrolled_at TIMESTAMPTZ NOT NULL,
  withdrawn_at TIMESTAMPTZ
);

CREATE TABLE consents (
  id TEXT PRIMARY KEY,
  cid TEXT NOT NULL REFERENCES subjects (cid),
  purpose_code TEXT NOT NULL,
  dataset_ids TEXT[] NOT NULL,
  legal_basis TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('granted', 'withdrawn')),
  granted_at TIMESTAMPTZ NOT NULL,
  withdrawn_at TIMESTAMPTZ,
  receipt_hash TEXT NOT NULL
);

CREATE TABLE template_pointers (
  id TEXT PRIMARY KEY,
  cid TEXT NOT NULL REFERENCES subjects (cid),
  store_key TEXT NOT NULL,
  quality REAL NOT NULL,
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  purged_at TIMESTAMPTZ
);

CREATE TABLE searches (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  purpose_code TEXT NOT NULL,
  legal_basis TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  edition TEXT NOT NULL,
  subject_cid TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending_review', 'decided', 'denied')),
  denial_code TEXT,
  model_name TEXT,
  model_version TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE match_candidates (
  id TEXT PRIMARY KEY,
  search_id TEXT NOT NULL REFERENCES searches (id),
  cid TEXT NOT NULL,
  confidence REAL NOT NULL,
  rank INT NOT NULL,
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  search_id TEXT NOT NULL UNIQUE REFERENCES searches (id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'decided')),
  decision TEXT CHECK (decision IS NULL OR decision IN ('confirm', 'reject', 'inconclusive')),
  selected_cid TEXT,
  notes TEXT,
  reviewer_id TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE bias_reports (
  release_id TEXT PRIMARY KEY,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE audit_entries (
  seq BIGINT PRIMARY KEY,
  recorded_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  attestation JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);

CREATE TABLE audit_checkpoints (
  through_seq BIGINT PRIMARY KEY,
  leaf_count INT NOT NULL,
  merkle_root TEXT NOT NULL,
  computed_at TEXT NOT NULL
);

CREATE TABLE audit_lock (
  id INT PRIMARY KEY
);

INSERT INTO audit_lock (id) VALUES (1);

CREATE INDEX consents_cid_idx ON consents (cid);
CREATE INDEX template_pointers_cid_idx ON template_pointers (cid);
CREATE INDEX reviews_status_idx ON reviews (status);
CREATE INDEX searches_created_idx ON searches (created_at);

CREATE OR REPLACE FUNCTION eidetic_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit store is append-only';
END;
$$;

CREATE TRIGGER audit_entries_no_mutate
  BEFORE UPDATE OR DELETE ON audit_entries
  FOR EACH ROW EXECUTE FUNCTION eidetic_audit_append_only();

CREATE TRIGGER audit_checkpoints_no_mutate
  BEFORE UPDATE OR DELETE ON audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION eidetic_audit_append_only();
