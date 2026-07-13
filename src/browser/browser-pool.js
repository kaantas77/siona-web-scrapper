import puppeteer from "@cloudflare/puppeteer";
import { extractContent } from "../extractors/index.js";

export const DEFAULT_TABS_PER_POOL = 5;
export const LAUNCH_INTERVAL_MS = 1_100;
const KEEP_ALIVE_MS = 600_000;
const MAX_TEXT_LENGTH = 50_000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function getMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function reserveLaunchSlot(env) {
  if (!env.LAUNCH_COORDINATOR) return;
  const id = env.LAUNCH_COORDINATOR.idFromName("global");
  const response = await env.LAUNCH_COORDINATOR.get(id).fetch(
    "https://launch-coordinator/acquire",
    { method: "POST" }
  );
  if (!response.ok) {
    throw new Error(`Launch coordinator failed (${response.status})`);
  }
}

export class LaunchCoordinator {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (new URL(request.url).pathname !== "/acquire") {
      return json({ success: false, error: "Not found" }, 404);
    }

    let waitMs = 0;
    await this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const nextLaunchAt = (await this.state.storage.get("nextLaunchAt")) || 0;
      waitMs = Math.max(0, nextLaunchAt - now);
      await this.state.storage.put(
        "nextLaunchAt",
        Math.max(now, nextLaunchAt) + LAUNCH_INTERVAL_MS
      );
    });

    if (waitMs > 0) await sleep(waitMs);
    return json({ success: true, waitMs });
  }
}

export class BrowserPool {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.browser = null;
    this.activeTabs = 0;
    this.waiters = [];
    this.initialized = false;
  }

  async loadState() {
    if (!this.initialized) this.initialized = true;
  }

  async ensureBrowser() {
    await this.loadState();
    if (this.browser) return this.browser;
    if (!this.env.BROWSER) throw new Error("BROWSER binding is not configured");

    await reserveLaunchSlot(this.env);
    this.browser = await puppeteer.launch(this.env.BROWSER);
    await this.state.storage.put("sessionId", this.browser.sessionId || null);
    await this.state.storage.put("lastReadyAt", new Date().toISOString());
    await this.state.storage.setAlarm(Date.now() + KEEP_ALIVE_MS);
    return this.browser;
  }

  async acquireTab() {
    await this.loadState();
    const limit = Number(this.env.TABS_PER_POOL || DEFAULT_TABS_PER_POOL);
    if (this.activeTabs >= limit) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.activeTabs += 1;
  }

  releaseTab() {
    this.activeTabs = Math.max(0, this.activeTabs - 1);
    this.waiters.shift()?.();
  }

  async scrape(request) {
    const payload = await request.json();
    const url = String(payload.url || "");
    const extractionMode = payload.extractor || "auto";
    if (!url) return json({ success: false, error: "url is required" }, 400);

    await this.acquireTab();
    let page;
    const startedAt = Date.now();
    try {
      const browser = await this.ensureBrowser();
      page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on("request", (pageRequest) => {
        const type = pageRequest.resourceType();
        const action = ["image", "media", "font"].includes(type)
          ? pageRequest.abort()
          : pageRequest.continue();
        action.catch(() => {});
      });
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: Number(payload.timeoutMs || 30_000)
      });
      const rendered = await page.evaluate(() => ({
        title: document.title || "",
        text: document.body?.innerText || ""
      }));
      const title = normalizeText(rendered.title);
      const text = normalizeText(rendered.text);
      const extraction = extractContent({
        url,
        title,
        text,
        rawText: text,
        extractor: extractionMode
      });
      const outputText = extraction.success ? extraction.cleanText : text;
      return json({
        success: outputText.length > 80,
        method: "browser_pool",
        status: response?.status() || 200,
        finalUrl: page.url(),
        title,
        text: outputText.slice(0, MAX_TEXT_LENGTH),
        textLength: outputText.length,
        extractor: extraction.extractor,
        extraction: {
          success: extraction.success,
          type: extraction.type,
          structured: extraction.structured,
          cleanText: extraction.cleanText
        },
        extractionMs: extraction.extractionMs,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      await this.state.storage.delete("sessionId");
      return json({
        success: false,
        method: "browser_pool",
        error: getMessage(error),
        durationMs: Date.now() - startedAt
      }, 502);
    } finally {
      await page?.close().catch(() => {});
      this.releaseTab();
    }
  }

  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname === "/status") {
      return json({
        success: true,
        ready: Boolean(this.browser),
        sessionId: await this.state.storage.get("sessionId"),
        activeTabs: this.activeTabs,
        waiting: this.waiters.length,
        maxTabs: Number(this.env.TABS_PER_POOL || DEFAULT_TABS_PER_POOL)
      });
    }
    if (request.method === "POST" && pathname === "/warm") {
      try {
        await this.ensureBrowser();
        return json({ success: true, ready: true });
      } catch (error) {
        return json({ success: false, error: getMessage(error) }, 502);
      }
    }
    if (request.method === "POST" && pathname === "/scrape") return this.scrape(request);
    return json({ success: false, error: "Not found" }, 404);
  }

  async alarm() {
    if (!this.browser) return;
    try {
      const page = await this.browser.newPage();
      await page.close();
      await this.state.storage.setAlarm(Date.now() + KEEP_ALIVE_MS);
    } catch {
      await this.browser.close().catch(() => {});
      this.browser = null;
      await this.state.storage.delete("sessionId");
    }
  }
}
