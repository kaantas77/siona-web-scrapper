import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

describe("health endpoint", () => {
	it("returns service health (unit style)", async () => {
		const request = new Request("http://example.com/health");
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			service: "siona-web-scraper",
			architecture: "hybrid-fetch-browser"
		});
	});

	it("returns service health (integration style)", async () => {
		const response = await SELF.fetch("http://example.com/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			service: "siona-web-scraper"
		});
	});
	it("returns detailed health without a browser binding", async () => {
		const request = new Request("http://example.com/health/detailed");
		const response = await worker.fetch(
			request,
			{ POOL_COUNT: "2", TABS_PER_POOL: "4" },
			createExecutionContext()
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			browserPool: {
				configured: false,
				poolCount: 2,
				readyPools: 0,
				maxTabs: 4
			}
		});
	});
});

describe("browser pool warm-up guard", () => {
	it("does not expose warm-up without an admin token", async () => {
		const request = new Request("http://example.com/admin/warm-pools", {
			method: "POST"
		});
		const response = await worker.fetch(request, {}, createExecutionContext());
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			success: false,
			error: "Admin warm-up is not configured"
		});
	});
});
