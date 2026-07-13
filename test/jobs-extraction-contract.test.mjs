import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const schema = fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const migration = fs.readFileSync(new URL("../migration-extraction.sql", import.meta.url), "utf8");

test("async jobs persist and propagate the extraction mode", () => {
  assert.match(schema, /extraction_mode TEXT NOT NULL DEFAULT 'auto'/);
  assert.match(source, /body\.options\?\.extract \?\? body\.extract/);
  assert.match(source, /extractionMode\n          \}/);
  assert.match(source, /entry\.data\.extractionMode/);
  assert.match(source, /extraction: extractionMode/);
});

test("async job results persist structured extraction metadata", () => {
  assert.match(schema, /extraction_json TEXT/);
  assert.match(schema, /extraction_ms INTEGER DEFAULT 0/);
  assert.match(source, /JSON\.stringify\(result\.extraction\)/);
  assert.match(source, /JSON\.parse\(item\.extraction_json\)/);
  assert.match(migration, /ALTER TABLE jobs ADD COLUMN extraction_mode/);
  assert.match(migration, /ALTER TABLE job_items ADD COLUMN extraction_json/);
});
