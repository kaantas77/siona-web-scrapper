# Siona scaling plan

## Current milestone

The async API now accepts up to 1,500 URLs per job. This is the request shape needed for 100 users sending 15 URLs each; it is not a guarantee that 1,500 browser renders finish at once. The synchronous API remains capped at 20 URLs.

The worker writes D1 statements in groups of 50 and Queue messages in groups of 100. Queue consumers are configured for batches of 10 with up to 40 concurrent invocations. Browser work is still protected by the Durable Object pool and its per-pool tab limit.

## Operating model

1. Submit large research requests to `POST /research-jobs`, not `/research-scrape`.
2. Poll `GET /research-jobs/:jobId` until `completed` or `completed_with_errors`.
3. Read results page by page from `GET /research-jobs/:jobId/results?limit=20&page=N`.
4. Warm pools before a planned browser-heavy test with the authenticated admin endpoint.
5. Measure p50/p95/p99 and failed URLs before increasing limits.

Example 100-user async load test:

```bash
node scripts/load-test.mjs \
  --mode async \
  --users 100 \
  --urls-per-user 15 \
  --endpoint https://siona-web-scraper-build.kaantas778899.workers.dev/research-jobs \
  --urls https://example.com,https://example.org,https://example.net
```

The script submits all users concurrently, polls each job, and reports submitted, completed, and failed URL counts plus request latency percentiles. Use an authorized, representative URL corpus for browser-heavy tests; do not treat repeated public demo URLs as a capacity result.

## Next gates

- Run 20 browser-required URLs and verify no launch 429s.
- Run 100 users x 15 URLs with an 80/20 fetch/browser corpus.
- Run a browser-heavy test while watching `/health/detailed`, Queue backlog, D1 latency, R2 errors, and timeout rate.
- Add tenant authentication, per-tenant concurrency quotas, and request rate limiting before opening the endpoint to untrusted traffic.
- Tune `max_concurrency`, pool count, and tabs per pool only from measured p95/p99 and error-rate data.

## Capacity boundary

The current architecture provides bounded concurrency and backpressure through Queue and Durable Objects. It does not imply 1,500 simultaneous browser pages: 20 pools x 5 tabs is a theoretical 100-page browser capacity, and browser rendering, origin throttling, Cloudflare account limits, memory, and URL mix determine actual throughput.
