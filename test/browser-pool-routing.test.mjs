import test from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";
import {
  getBrowserPoolCandidates,
  getBrowserPoolIndex,
  summarizePoolHealth
} from "../src/index.js";

test("browser pool routing is deterministic and bounded", () => {
  const url = "https://example.com/dynamic";
  const first = getBrowserPoolIndex(url, 20);

  assert.equal(first, getBrowserPoolIndex(url, 20));
  assert.ok(first >= 0 && first < 20);
  assert.ok(getBrowserPoolIndex(url, 1) === 0);
});

test("browser pool routing handles invalid pool counts", () => {
  assert.equal(getBrowserPoolIndex("https://example.com", 0), 0);
  assert.equal(getBrowserPoolIndex("https://example.com", "bad"), 0);
});

test("browser pool candidates provide two distinct bounded choices", () => {
  const candidates = getBrowserPoolCandidates("https://example.com", 20);

  assert.equal(candidates.length, 2);
  assert.notEqual(candidates[0], candidates[1]);
  assert.ok(candidates.every((index) => index >= 0 && index < 20));
});

test("browser pool routing includes load-aware status fallback", () => {
  const source = fs.readFileSync(
    new URL("../src/index.js", import.meta.url),
    "utf8"
  );
  const wrangler = fs.readFileSync(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8"
  );

  assert.match(source, /POOL_ROUTING/);
  assert.match(source, /browser-pool\/status/);
  assert.match(source, /return fallback/);
  assert.match(wrangler, /"POOL_ROUTING": "power-of-two"/);
});

test("browser pool health summary aggregates readiness and load", () => {
  assert.deepEqual(
    summarizePoolHealth([
      { ready: true, activeTabs: 2, waiting: 1 },
      { ready: false, activeTabs: 0, waiting: 3 },
      { ready: true, activeTabs: 1, waiting: 0 }
    ]),
    {
      poolCount: 3,
      readyPools: 2,
      activeTabs: 3,
      waiting: 4,
      healthy: false
    }
  );
});
