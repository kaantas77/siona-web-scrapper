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
    mode: "sync",
    pollMs: 1_000,
    timeoutMs: 120_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--users") options.users = Math.max(1, Number(next));
    if (value === "--urls-per-user") options.urlsPerUser = Math.max(1, Number(next));
    if (value === "--endpoint") options.endpoint = next;
    if (value === "--urls") options.urls = next.split(",").map((url) => url.trim()).filter(Boolean);
    if (value === "--mode") options.mode = next;
    if (value === "--poll-ms") options.pollMs = Math.max(100, Number(next));
    if (value === "--timeout-ms") options.timeoutMs = Math.max(1_000, Number(next));
  }

  if (!Number.isInteger(options.users) || !Number.isInteger(options.urlsPerUser)) {
    throw new Error("--users ve --urls-per-user geçerli olmalı");
  }
  if (!options.urls.length || !["sync", "async"].includes(options.mode)) {
    throw new Error("--urls boş olamaz ve --mode sync veya async olmalı");
  }
  return options;
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.max(0, index)];
}

function addMetric(result, key, value) {
  if (value === undefined || value === null || value === "") return;
  result[key] = (result[key] || 0) + 1;
}

function urlsForUser(options, userIndex) {
  return Array.from({ length: options.urlsPerUser }, (_, index) =>
    options.urls[(userIndex * options.urlsPerUser + index) % options.urls.length]
  );
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function waitForJob(options, jobUrl) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const { response, body } = await fetchJson(jobUrl);
    if (!response.ok) {
      return { success: false, status: response.status, error: body.error || `status ${response.status}` };
    }
    const job = body.job || {};
    if (["completed", "completed_with_errors", "failed"].includes(job.status)) {
      return {
        success: job.status === "completed" && Number(job.failed || 0) === 0,
        status: response.status,
        jobStatus: job.status,
        completed: Number(job.completed || 0),
        failed: Number(job.failed || 0),
        error: job.status === "completed" ? null : `job status: ${job.status}`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
  return { success: false, status: 408, error: `job polling timeout after ${options.timeoutMs}ms` };
}

async function runRequest(options, userIndex) {
  const urls = urlsForUser(options, userIndex);
  const startedAt = Date.now();
  try {
    const { response, body } = await fetchJson(options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls }),
    });

    if (!response.ok || body.success === false) {
      return {
        success: false,
        durationMs: Date.now() - startedAt,
        status: response.status,
        submittedUrls: urls.length,
        completedUrls: 0,
        failedUrls: urls.length,
        error: body.error || `status ${response.status}`,
      };
    }

    if (options.mode === "async") {
      const base = new URL(options.endpoint);
      const statusPath = body.statusUrl || `/jobs/${body.jobId}`;
      const jobUrl = new URL(statusPath, base).toString();
      const result = await waitForJob(options, jobUrl);
      return {
        success: result.success,
        durationMs: Date.now() - startedAt,
        status: result.status,
        submittedUrls: urls.length,
        completedUrls: result.completed || 0,
        failedUrls: result.failed || 0,
        jobStatus: result.jobStatus,
        error: result.error,
      };
    }

    const results = Array.isArray(body.results) ? body.results : [];
    return {
      success: body.success !== false && Number(body.failed || 0) === 0,
      durationMs: Date.now() - startedAt,
      status: response.status,
      submittedUrls: urls.length,
      completedUrls: results.filter((item) => item.success).length,
      failedUrls: results.filter((item) => item.success === false).length,
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
      submittedUrls: urls.length,
      completedUrls: 0,
      failedUrls: urls.length,
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
  let submittedUrls = 0;
  let completedUrls = 0;
  let failedUrls = 0;

  for (const result of results) {
    submittedUrls += result.submittedUrls || 0;
    completedUrls += result.completedUrls || 0;
    failedUrls += result.failedUrls || 0;
    for (const method of result.methods || []) addMetric(methods, method);
    for (const pool of result.pools || []) addMetric(pools, String(pool));
    for (const session of result.sessions || []) sessions.add(session);
    cacheHits += result.cacheHits || 0;
  }

  const successful = results.filter((result) => result.success).length;
  console.log(JSON.stringify({
    mode: options.mode,
    endpoint: options.endpoint,
    users: options.users,
    urlsPerUser: options.urlsPerUser,
    submittedUrls,
    completedUrls,
    failedUrls,
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
