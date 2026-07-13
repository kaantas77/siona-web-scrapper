-- Apply once to an existing D1 database created from the original schema.sql.
ALTER TABLE jobs ADD COLUMN extraction_mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE job_items ADD COLUMN extractor TEXT;
ALTER TABLE job_items ADD COLUMN extraction_json TEXT;
ALTER TABLE job_items ADD COLUMN extraction_ms INTEGER DEFAULT 0;
