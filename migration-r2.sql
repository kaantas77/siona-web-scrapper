-- Add R2 object references for async scrape results.
ALTER TABLE job_items ADD COLUMN result_key TEXT;
