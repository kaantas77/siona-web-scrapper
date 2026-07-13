import test from "node:test";
import assert from "node:assert/strict";
import { getBrowserPoolIndex } from "../src/index.js";

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
