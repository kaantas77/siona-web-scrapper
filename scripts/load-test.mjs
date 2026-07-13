#!/usr/bin/env node

const DEFAULT_ENDPOINT = "http://localhost:8787/scrape-many";
const DEFAULT_URLS = [
  "https://tr.investing.com/equities/hatsan-gemi-insaa-bakim-onarim",
  "https://www.flashscore.com.tr/mac/futbol/bolivar-WImzpcSF/the-strongest-Wfi42xS2/?mid=44fo7mq4",
];

function parseArgs(argv) {
  const options = {
    users: 1,
    urlsPerUser: 1,
    endpoint: DEFAULT_ENDPOINT,
    urls: DEFAULT_URLS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--users") options.users = Math.max(1, Number(next));
    if (value === "--urls-per-user") options.urlsPerUser = Math.max(1, Number(next));
    if (value === "--endpoint") options.endpoint = next;
    if (value === "--urls") options.urls = next.split(",").map((url) => url.trim()).filter(Boolean);
  }

  if (!Number.isInteger(options.users) || !Number.isInteger(options.urlsPerUser) || options.urls.length === 0) {
    throw new Error("--users, --urls-per-user and --urls değerleri geçerli olmalı");
  }
  return options;
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.max(0, index)];
}

function addNestedMetric(result, key, value) {
  if (value === undefined || value === null || value === "") return;
  result[key] = (result[key] || 0) + 1;
}

async function runRequest(options, userIndex) {
  const urls = Array.from({ length: options.urlsPerUser }, (_, index) =>
    options.urls[(userIndex * options.urlsPerUser + index) % options.urls.length]
  );
  const startedAt = Date.now();
  try {
    const response = await fetch(options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    const body = await response.json().catch(() => ({}));
    const results = Array.isArray(body.results) ? body.results : [];
    return {
      success: response.ok && body.success !== false && Number(body.failed || 0) === 0,
      durationMs: Date.now() - startedAt,
      status: response.status,
      methods: results.map((item) => item.method).filter(Boolean),
      pools: results.map((item) => item.poolIndex).filter((value) => value !== undefined),
      sessions: results.map((item) => item.sessionId).filter(Boolean),
      cacheHits: results.filter((item) => item.cacheHit === true).length,
      error: body.error || null,
    };
  } catch (error) {
    return {
      success: false,
      durationMs: Date.now() - startedAt,
      status: 0,
      methods: [],
      pools: [],
      sessions: [],
      cacheHits: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function printReport(options, results) {
  const durations = results.map((result) => result.durationMs);
  const methods = {};
  const pools = {};
  const sessions = new Set();
  let cacheHits = 0;
  for (const result of results) {
    for (const method of result.methods) addNestedMetric(methods, method);
    for (const pool of result.pools) addNestedMetric(pools, String(pool));
    for (const session of result.sessions) sessions.add(session);
    cacheHits += result.cacheHits;
  }

  const successful = results.filter((result) => result.success).length;
  console.log(JSON.stringify({
    endpoint: options.endpoint,
    users: options.users,
    urlsPerUser: options.urlsPerUser,
    totalRequests: results.length,
    successfulRequests: successful,
    failedRequests: results.length - successful,
    averageDurationMs: durations.length
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : 0,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    methodDistribution: methods,
    poolDistribution: pools,
    uniqueSessionIds: sessions.size,
    cacheHitCount: cacheHits,
    errors: results.filter((result) => result.error).slice(0, 10).map((result) => result.error),
  }, null, 2));
}

const options = parseArgs(process.argv.slice(2));
const results = await Promise.all(
  Array.from({ length: options.users }, (_, userIndex) => runRequest(options, userIndex))
);
printReport(options, results);
process.exitCode = results.every((result) => result.success) ? 0 : 1;
