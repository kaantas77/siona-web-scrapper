import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const schema = fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const migration = fs.readFileSync(new URL("../migration-r2.sql", import.meta.url), "utf8");
const wrangler = fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

test("R2 result storage is configured and persisted by async jobs", () => {
  assert.match(wrangler, /"binding": "RESULTS"/);
  assert.match(wrangler, /"bucket_name": "siona-scrape-results"/);
  assert.match(schema, /result_key TEXT/);
  assert.match(migration, /ALTER TABLE job_items ADD COLUMN result_key/);
  assert.match(source, /env\.RESULTS\.put\(key/);
  assert.match(source, /scrape-results\/\$\{jobId\}\/\$\{itemId\}\.json/);
  assert.match(source, /result_key = \?/);
});

test("research endpoints reuse the existing validated job contract", () => {
  assert.match(source, /pathname === "\/research-scrape"/);
  assert.match(source, /pathname === "\/research-jobs"/);
  assert.match(source, /researchResultsMatch/);
  assert.match(source, /statusUrl: `\/research-jobs\/\$\{body\.jobId\}`/);
  assert.match(source, /api: "research"/);
});
