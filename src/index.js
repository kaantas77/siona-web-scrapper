import puppeteer from "@cloudflare/puppeteer";
import { extractContent } from "./extractors/index.js";
import { BrowserPool, LaunchCoordinator } from "./browser/browser-pool.js";

const VERSION = "siona-v12-browser-pool";

export { BrowserPool, LaunchCoordinator };

const MAX_TEXT_LENGTH = 50_000;

const MAX_LEGACY_BATCH_SIZE = 5;
const MAX_SYNC_BATCH_SIZE = 20;
const MAX_JOB_SIZE = 100;

const FETCH_CONCURRENCY = 6;
const BROWSER_PAGE_CONCURRENCY = 3;

const FETCH_TIMEOUT_MS = 15_000;
const BROWSER_TIMEOUT_MS = 30_000;
const MAX_QUEUE_ATTEMPTS = 3;

const EXTRACTION_MODES = new Set([
  "auto",
  "generic",
  "article",
  "investing",
  "flashscore",
  "sofascore",
  "raw"
]);

/* -------------------------------------------------------------------------- */
/*                                  RESPONSE                                  */
/* -------------------------------------------------------------------------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Expires: "0"
    }
  });
}

function getErrorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error);
}

function nowIso() {
  return new Date().toISOString();
}

function healthResponse() {
  return json({
    version: VERSION,
    success: true,
    service: "siona-web-scraper",
    architecture: "hybrid-fetch-browser",
    limits: {
      maxSyncUrls: MAX_SYNC_BATCH_SIZE,
      maxAsyncUrls: MAX_JOB_SIZE,
      maxTextLength: MAX_TEXT_LENGTH
    }
  });
}

export function summarizePoolHealth(pools) {
  const normalized = Array.isArray(pools) ? pools : [];
  const readyPools = normalized.filter((pool) => pool.ready).length;
  return {
    poolCount: normalized.length,
    readyPools,
    activeTabs: normalized.reduce(
      (total, pool) => total + Math.max(0, Number(pool.activeTabs) || 0),
      0
    ),
    waiting: normalized.reduce(
      (total, pool) => total + Math.max(0, Number(pool.waiting) || 0),
      0
    ),
    healthy: normalized.length > 0 && readyPools === normalized.length
  };
}

export function getBrowserPoolIndex(url, poolCount = 20) {
  const count = Math.max(1, Number(poolCount) || 1);
  let hash = 2166136261;
  for (const character of String(url)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}

export function getBrowserPoolCandidates(url, poolCount = 20) {
  const count = Math.max(1, Number(poolCount) || 1);
  const primary = getBrowserPoolIndex(url, count);
  if (count === 1) return [primary];

  let secondary = getBrowserPoolIndex(`${url}#secondary`, count);
  if (secondary === primary) secondary = (primary + 1) % count;
  return [primary, secondary];
}

async function getBrowserPoolStatus(env, poolIndex) {
  const id = env.BROWSER_POOL.idFromName(`pool-${poolIndex}`);
  const response = await env.BROWSER_POOL.get(id).fetch(
    "https://browser-pool/status"
  );
  if (!response.ok) {
    throw new Error(`Browser pool status failed (${response.status})`);
  }

  const body = await response.json();
  const maxTabs = Math.max(1, Number(body.maxTabs) || 1);
  const activeTabs = Math.max(0, Number(body.activeTabs) || 0);
  const waiting = Math.max(0, Number(body.waiting) || 0);
  return {
    poolIndex,
    score: (body.ready ? 0 : maxTabs) + activeTabs + (waiting * 2)
  };
}

async function getBrowserPoolHealth(env, poolIndex) {
  try {
    const id = env.BROWSER_POOL.idFromName(`pool-${poolIndex}`);
    const response = await env.BROWSER_POOL.get(id).fetch(
      "https://browser-pool/status"
    );
    if (!response.ok) {
      throw new Error(`Browser pool status failed (${response.status})`);
    }

    const body = await response.json();
    return {
      poolIndex,
      ready: Boolean(body.ready),
      activeTabs: Math.max(0, Number(body.activeTabs) || 0),
      waiting: Math.max(0, Number(body.waiting) || 0),
      maxTabs: Math.max(1, Number(body.maxTabs) || 1)
    };
  } catch (error) {
    return {
      poolIndex,
      ready: false,
      activeTabs: 0,
      waiting: 0,
      maxTabs: Math.max(1, Number(env.TABS_PER_POOL || 5)),
      error: getErrorMessage(error)
    };
  }
}

async function handleDetailedHealth(env) {
  const poolCount = Math.max(1, Number(env.POOL_COUNT || 20));
  if (!env.BROWSER_POOL) {
    return json({
      version: VERSION,
      success: true,
      service: "siona-web-scraper",
      architecture: "hybrid-fetch-browser",
      browserPool: {
        configured: false,
        ...summarizePoolHealth([]),
        poolCount,
        maxTabs: Math.max(1, Number(env.TABS_PER_POOL || 5)),
        routing: String(env.POOL_ROUTING || "deterministic")
      }
    });
  }

  const startedAt = Date.now();
  const pools = await Promise.all(
    Array.from({ length: poolCount }, (_, index) =>
      getBrowserPoolHealth(env, index)
    )
  );
  const summary = summarizePoolHealth(pools);

  return json({
    version: VERSION,
    success: true,
    service: "siona-web-scraper",
    architecture: "hybrid-fetch-browser",
    browserPool: {
      configured: true,
      ...summary,
      maxTabs: Math.max(1, Number(env.TABS_PER_POOL || 5)),
      routing: String(env.POOL_ROUTING || "deterministic"),
      durationMs: Date.now() - startedAt,
      pools
    }
  });
}

async function selectBrowserPoolIndex(url, env) {
  const candidates = getBrowserPoolCandidates(url, env.POOL_COUNT || 20);
  const fallback = candidates[0];

  if (String(env.POOL_ROUTING || "deterministic") !== "power-of-two") {
    return fallback;
  }

  try {
    const statuses = await Promise.all(
      candidates.map((poolIndex) => getBrowserPoolStatus(env, poolIndex))
    );
    statuses.sort((left, right) => left.score - right.score);
    return statuses[0]?.poolIndex ?? fallback;
  } catch {
    return fallback;
  }
}

async function scrapeWithBrowserPool(url, env, extractionMode = "auto") {
  if (!env.BROWSER_POOL) {
    throw new Error("BROWSER_POOL binding is not configured");
  }

  const poolIndex = await selectBrowserPoolIndex(url, env);
  const id = env.BROWSER_POOL.idFromName(`pool-${poolIndex}`);
  const response = await env.BROWSER_POOL.get(id).fetch(
    "https://browser-pool/scrape",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        extractor: extractionMode,
        timeoutMs: BROWSER_TIMEOUT_MS
      })
    }
  );

  let body;
  try {
    body = await response.json();
  } catch {
    body = { success: false, error: "Browser pool returned invalid JSON" };
  }

  if (!response.ok) {
    throw new Error(body.error || `Browser pool failed (${response.status})`);
  }

  return { ...body, poolIndex };
}

/* -------------------------------------------------------------------------- */
/*                               CONCURRENCY                                  */
/* -------------------------------------------------------------------------- */

async function mapWithConcurrency(
  items,
  concurrency,
  handler
) {
  if (items.length === 0) {
    return [];
  }

  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      try {
        results[currentIndex] = await handler(
          items[currentIndex],
          currentIndex
        );
      } catch (error) {
        results[currentIndex] = {
          success: false,
          error: getErrorMessage(error)
        };
      }
    }
  }

  const workerCount = Math.min(
    Math.max(1, concurrency),
    items.length
  );

  await Promise.all(
    Array.from(
      { length: workerCount },
      () => worker()
    )
  );

  return results;
}

/* -------------------------------------------------------------------------- */
/*                               TEXT CLEANING                                */
/* -------------------------------------------------------------------------- */

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (match, code) => {
      try {
        return String.fromCodePoint(Number(code));
      } catch {
        return match;
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => {
      try {
        return String.fromCodePoint(
          parseInt(code, 16)
        );
      } catch {
        return match;
      }
    });
}

function fixMojibake(text) {
  const replacements = [
    ["Ã‡", "Ç"],
    ["Ã§", "ç"],
    ["Äž", "Ğ"],
    ["ÄŸ", "ğ"],
    ["Ä°", "İ"],
    ["Ä±", "ı"],
    ["Ã–", "Ö"],
    ["Ã¶", "ö"],
    ["Åž", "Ş"],
    ["ÅŸ", "ş"],
    ["Ãœ", "Ü"],
    ["Ã¼", "ü"],
    ["â€™", "'"],
    ["â€˜", "'"],
    ["â€œ", '"'],
    ["â€", '"'],
    ["â€“", "-"],
    ["â€”", "—"],
    ["â€¦", "…"],
    ["Â©", "©"],
    ["Â®", "®"],
    ["Â", ""]
  ];

  let result = String(text || "");

  for (let pass = 0; pass < 2; pass += 1) {
    for (const [broken, correct] of replacements) {
      result = result.split(broken).join(correct);
    }
  }

  return result;
}

function normalizeText(text) {
  return fixMojibake(
    decodeHtmlEntities(text)
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function cleanHtml(html) {
  const rawTitle =
    html.match(
      /<title[^>]*>([\s\S]*?)<\/title>/i
    )?.[1] || "";

  const title = normalizeText(
    rawTitle.replace(/<[^>]+>/g, " ")
  );

  const rawText = html
    .replace(
      /<script\b[^>]*>[\s\S]*?<\/script>/gi,
      " "
    )
    .replace(
      /<style\b[^>]*>[\s\S]*?<\/style>/gi,
      " "
    )
    .replace(
      /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,
      " "
    )
    .replace(
      /<svg\b[^>]*>[\s\S]*?<\/svg>/gi,
      " "
    )
    .replace(
      /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi,
      " "
    )
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<\/(p|div|article|section|main|header|footer|li|h1|h2|h3|h4|h5|h6|br)>/gi,
      " "
    )
    .replace(/<[^>]+>/g, " ");

  return {
    title,
    text: normalizeText(rawText)
  };
}

function mojibakeScore(text) {
  const matches = text.match(/[ÃÄÅÂâ€]/g);

  return matches
    ? matches.length
    : 0;
}

function decodeBuffer(buffer, encoding) {
  try {
    return new TextDecoder(encoding, {
      fatal: false
    }).decode(buffer);
  } catch {
    return "";
  }
}

async function decodeResponse(response) {
  const buffer = await response.arrayBuffer();

  const utf8Text = decodeBuffer(
    buffer,
    "utf-8"
  );

  const windowsText = decodeBuffer(
    buffer,
    "windows-1252"
  );

  const utf8Score = mojibakeScore(utf8Text);
  const windowsScore =
    mojibakeScore(windowsText);

  if (
    utf8Text &&
    utf8Score <= windowsScore
  ) {
    return utf8Text;
  }

  return windowsText || utf8Text;
}

/* -------------------------------------------------------------------------- */
/*                              URL VALIDATION                                */
/* -------------------------------------------------------------------------- */

function isPrivateOrLocalHostname(hostname) {
  const value = hostname.toLowerCase();

  if (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local")
  ) {
    return true;
  }

  if (
    /^127\./.test(value) ||
    /^10\./.test(value) ||
    /^192\.168\./.test(value) ||
    /^169\.254\./.test(value)
  ) {
    return true;
  }

  const match172 =
    value.match(/^172\.(\d+)\./);

  if (match172) {
    const secondOctet =
      Number(match172[1]);

    if (
      secondOctet >= 16 &&
      secondOctet <= 31
    ) {
      return true;
    }
  }

  return (
    value === "0.0.0.0" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe80:")
  );
}

function parseAndValidateUrl(input) {
  let parsedUrl;

  try {
    parsedUrl = new URL(input);
  } catch {
    throw new Error("Geçersiz URL");
  }

  if (
    parsedUrl.protocol !== "http:" &&
    parsedUrl.protocol !== "https:"
  ) {
    throw new Error(
      "Yalnızca HTTP ve HTTPS destekleniyor"
    );
  }

  if (
    isPrivateOrLocalHostname(
      parsedUrl.hostname
    )
  ) {
    throw new Error(
      "Yerel veya özel ağ adreslerine erişim yasak"
    );
  }

  return parsedUrl;
}

function normalizeUrl(input) {
  return parseAndValidateUrl(
    input
  ).toString();
}

function normalizeUrlArray(
  input,
  maximum
) {
  if (!Array.isArray(input)) {
    throw new Error(
      '"urls" bir dizi olmalı'
    );
  }

  const urls = [
    ...new Set(
      input
        .filter(
          (url) =>
            typeof url === "string"
        )
        .map((url) => url.trim())
        .filter(Boolean)
        .map(normalizeUrl)
    )
  ];

  if (urls.length === 0) {
    throw new Error(
      "En az bir URL gerekli"
    );
  }

  if (urls.length > maximum) {
    throw new Error(
      `En fazla ${maximum} farklı URL gönderilebilir`
    );
  }

  return urls;
}

function normalizeExtractionMode(input) {
  const mode =
    typeof input === "string" && input.trim()
      ? input.trim().toLowerCase()
      : "auto";

  if (!EXTRACTION_MODES.has(mode)) {
    throw new Error(
      'Geçersiz extract seçeneği: ' + mode
    );
  }

  return mode;
}

/* -------------------------------------------------------------------------- */
/*                            PAGE CLASSIFICATION                             */
/* -------------------------------------------------------------------------- */

function isFlashscoreMatchPage(url) {
  try {
    const parsedUrl = new URL(url);

    return (
      parsedUrl.hostname.includes(
        "flashscore."
      ) &&
      parsedUrl.pathname.includes("/mac/")
    );
  } catch {
    return false;
  }
}

function needsBrowser(
  status,
  html,
  text
) {
  if (status >= 400) {
    return true;
  }

  if (!html || html.length < 500) {
    return true;
  }

  if (!text || text.length < 80) {
    return true;
  }

  const lowerHtml =
    html.toLowerCase();

  return (
    lowerHtml.includes(
      "enable javascript"
    ) ||
    lowerHtml.includes(
      "javascript is required"
    ) ||
    lowerHtml.includes(
      "checking your browser"
    ) ||
    lowerHtml.includes(
      "just a moment"
    ) ||
    lowerHtml.includes("cf-chl-") ||
    lowerHtml.includes(
      "loading..."
    ) ||
    lowerHtml.includes(
      "verify you are human"
    ) ||
    (
      lowerHtml.includes(
        "__next_data__"
      ) &&
      text.length < 800
    )
  );
}

function detectBlockedText(
  title,
  text
) {
  const content =
    `${title || ""} ${text || ""}`
      .toLowerCase();

  return (
    content.includes(
      "just a moment"
    ) ||
    content.includes(
      "checking your browser"
    ) ||
    content.includes(
      "verify you are human"
    ) ||
    content.includes(
      "access denied"
    ) ||
    content.includes(
      "unusual traffic"
    ) ||
    content.includes("cf-chl-")
  );
}

/* -------------------------------------------------------------------------- */
/*                                 FAST FETCH                                 */
/* -------------------------------------------------------------------------- */

async function fetchWithTimeout(
  url,
  options,
  timeoutMs
) {
  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function tryFastFetch(
  url,
  extractionMode = "auto"
) {
  if (isFlashscoreMatchPage(url)) {
    return {
      requiresBrowser: true,
      reason:
        "Flashscore maç sayfası browser ile açılmalı"
    };
  }

  try {
    const response =
      await fetchWithTimeout(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; SionaBot/1.0; +https://aisiona.com)",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language":
              "tr-TR,tr;q=0.9,en;q=0.8"
          },
          redirect: "follow"
        },
        FETCH_TIMEOUT_MS
      );

    const contentType =
      response.headers.get(
        "content-type"
      ) || "";

    if (
      !contentType
        .toLowerCase()
        .includes("text/html")
    ) {
      return {
        requiresBrowser: true,
        reason:
          `HTML olmayan içerik: ${
            contentType || "bilinmiyor"
          }`
      };
    }

    const html =
      await decodeResponse(response);

    const cleaned =
      cleanHtml(html);

    if (
      needsBrowser(
        response.status,
        html,
        cleaned.text
      )
    ) {
      return {
        requiresBrowser: true,
        reason:
          "Sayfa JavaScript veya browser gerektiriyor"
      };
    }

    const extraction = extractContent({
      url,
      title: cleaned.title,
      text: cleaned.text,
      rawText: cleaned.text,
      extractor: extractionMode
    });

    const outputText = extraction.success
      ? extraction.cleanText
      : cleaned.text;

    return {
      requiresBrowser: false,
      result: {
        success: response.ok,
        method: "fetch",
        status: response.status,
        finalUrl: response.url,
        title: cleaned.title,
        textLength:
          outputText.length,
        extractor: extraction.extractor,
        extraction: {
          success: extraction.success,
          type: extraction.type,
          structured: extraction.structured,
          cleanText: extraction.cleanText
        },
        extractionMs: extraction.extractionMs,
        blocked: false,
        text: outputText.slice(
          0,
          MAX_TEXT_LENGTH
        )
      }
    };
  } catch (error) {
    return {
      requiresBrowser: true,
      reason:
        getErrorMessage(error)
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                              BROWSER SCRAPING                              */
/* -------------------------------------------------------------------------- */

async function configurePage(page) {
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/124.0.0.0 Safari/537.36"
  );

  await page.setExtraHTTPHeaders({
    "Accept-Language":
      "tr-TR,tr;q=0.9,en;q=0.8"
  });

  await page.setViewport({
    width: 1440,
    height: 1200
  });
}

async function waitForRenderedPage(
  page,
  url
) {
  if (isFlashscoreMatchPage(url)) {
    try {
      await page.waitForFunction(
        () => {
          const bodyText =
            document.body?.innerText || "";

          return (
            !bodyText.includes(
              "Loading..."
            ) &&
            bodyText.length > 1000
          );
        },
        {
          timeout: 15_000
        }
      );
    } catch {
      await new Promise(
        (resolve) =>
          setTimeout(resolve, 5_000)
      );
    }

    return;
  }

  try {
    await page.waitForNetworkIdle({
      idleTime: 1_000,
      timeout: 10_000
    });
  } catch {
    await new Promise(
      (resolve) =>
        setTimeout(resolve, 1_500)
    );
  }
}

async function scrapePageWithBrowser(
  browser,
  url,
  extractionMode = "auto"
) {
  const page =
    await browser.newPage();

  try {
    await configurePage(page);

    const response =
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout:
          BROWSER_TIMEOUT_MS
      });

    await waitForRenderedPage(
      page,
      url
    );

    const result =
      await page.evaluate(() => {
        const title =
          document.title || "";

        const text =
          document.body?.innerText
            ?.replace(/\s+/g, " ")
            .trim() || "";

        return {
          title,
          text
        };
      });

    const title =
      normalizeText(result.title);

    const text =
      normalizeText(result.text);

    const stillLoading =
      text.includes("Loading...") ||
      text.length < 80;

    const blocked =
      detectBlockedText(
        title,
        text
      );

    const extraction = extractContent({
      url,
      title,
      text,
      rawText: text,
      extractor: extractionMode
    });

    const outputText = extraction.success
      ? extraction.cleanText
      : text;

    return {
      success:
        !stillLoading &&
        !blocked &&
        text.length > 80,
      method: "browser",
      status:
        response?.status() || 200,
      finalUrl: page.url(),
      title,
      textLength: outputText.length,
      extractor: extraction.extractor,
      extraction: {
        success: extraction.success,
        type: extraction.type,
        structured: extraction.structured,
        cleanText: extraction.cleanText
      },
      extractionMs: extraction.extractionMs,
      stillLoading,
      blocked,
      text: outputText.slice(
        0,
        MAX_TEXT_LENGTH
      )
    };
  } finally {
    await page
      .close()
      .catch(() => {});
  }
}

async function scrapeWithNewBrowser(
  url,
  env,
  extractionMode = "auto"
) {
  let browser;

  try {
    browser =
      await puppeteer.launch(
        env.BROWSER
      );

    return await scrapePageWithBrowser(
      browser,
      url,
      extractionMode
    );
  } finally {
    if (browser) {
      await browser
        .close()
        .catch(() => {});
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                            SINGLE URL SCRAPING                             */
/* -------------------------------------------------------------------------- */

async function scrapeSingleUrl(
  url,
  env,
  extractionMode = "auto"
) {
  const normalizedUrl =
    normalizeUrl(url);

  const startedAt = Date.now();

  const fastResult =
    await tryFastFetch(
      normalizedUrl,
      extractionMode
    );

  if (!fastResult.requiresBrowser) {
    return {
      requestedUrl: normalizedUrl,
      durationMs:
        Date.now() - startedAt,
      ...fastResult.result
    };
  }

  try {
    const browserResult = env.BROWSER_POOL
      ? await scrapeWithBrowserPool(
          normalizedUrl,
          env,
          extractionMode
        )
      : await scrapeWithNewBrowser(
          normalizedUrl,
          env,
          extractionMode
        );

    return {
      requestedUrl: normalizedUrl,
      fallbackReason:
        fastResult.reason,
      durationMs:
        Date.now() - startedAt,
      ...browserResult
    };
  } catch (error) {
    return {
      requestedUrl: normalizedUrl,
      success: false,
      method: "browser",
      durationMs:
        Date.now() - startedAt,
      error:
        getErrorMessage(error),
      fallbackReason:
        fastResult.reason
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                        SYNCHRONOUS MULTI SCRAPE                            */
/* -------------------------------------------------------------------------- */

function buildSynchronousResponse(
  urls,
  results,
  startedAt
) {
  const successful =
    results.filter(
      (result) => result?.success
    ).length;

  const browserCount =
    results.filter(
      (result) =>
        result?.method === "browser" ||
        result?.method === "browser_pool"
    ).length;

  const fetchCount =
    results.filter(
      (result) =>
        result?.method === "fetch"
    ).length;

  return {
    version: VERSION,
    success: successful > 0,
    mode: "synchronous",
    requested: urls.length,
    successful,
    failed:
      urls.length - successful,
    fetchCount,
    browserCount,
    durationMs:
      Date.now() - startedAt,
    results
  };
}

async function scrapeManySynchronously(
  urls,
  env,
  extractionMode = "auto"
) {
  const startedAt = Date.now();

  const classifications =
    await mapWithConcurrency(
      urls,
      FETCH_CONCURRENCY,
      async (url) => {
        const itemStartedAt =
          Date.now();

        try {
          const fastResult =
            await tryFastFetch(url, extractionMode);

          return {
            url,
            itemStartedAt,
            fastResult
          };
        } catch (error) {
          return {
            url,
            itemStartedAt,
            fastResult: {
              requiresBrowser: true,
              reason:
                getErrorMessage(error)
            }
          };
        }
      }
    );

  const results =
    new Array(urls.length);

  const browserItems = [];

  for (
    let index = 0;
    index <
    classifications.length;
    index += 1
  ) {
    const classification =
      classifications[index];

    const {
      url,
      itemStartedAt,
      fastResult
    } = classification;

    if (
      !fastResult.requiresBrowser
    ) {
      results[index] = {
        requestedUrl: url,
        durationMs:
          Date.now() -
          itemStartedAt,
        fallbackReason: null,
        ...fastResult.result
      };

      continue;
    }

    browserItems.push({
      index,
      url,
      itemStartedAt,
      fallbackReason:
        fastResult.reason
    });
  }

  if (
    browserItems.length === 0
  ) {
    return buildSynchronousResponse(
      urls,
      results,
      startedAt
    );
  }

  if (env.BROWSER_POOL) {
    const browserResults = await mapWithConcurrency(
      browserItems,
      BROWSER_PAGE_CONCURRENCY,
      async (item) => {
        try {
          const browserResult = await scrapeWithBrowserPool(
            item.url,
            env,
            extractionMode
          );
          return {
            index: item.index,
            result: {
              requestedUrl: item.url,
              fallbackReason: item.fallbackReason,
              durationMs: Date.now() - item.itemStartedAt,
              ...browserResult
            }
          };
        } catch (error) {
          return {
            index: item.index,
            result: {
              requestedUrl: item.url,
              success: false,
              method: "browser_pool",
              fallbackReason: item.fallbackReason,
              durationMs: Date.now() - item.itemStartedAt,
              error: getErrorMessage(error)
            }
          };
        }
      }
    );

    for (const browserResult of browserResults) {
      results[browserResult.index] = browserResult.result;
    }

    return buildSynchronousResponse(urls, results, startedAt);
  }

  let browser;

  try {
    browser =
      await puppeteer.launch(
        env.BROWSER
      );

    const browserResults =
      await mapWithConcurrency(
        browserItems,
        BROWSER_PAGE_CONCURRENCY,
        async (item) => {
          try {
            const browserResult =
              await scrapePageWithBrowser(
                browser,
                item.url,
                extractionMode
              );

            return {
              index: item.index,
              result: {
                requestedUrl:
                  item.url,
                fallbackReason:
                  item.fallbackReason,
                durationMs:
                  Date.now() -
                  item.itemStartedAt,
                ...browserResult
              }
            };
          } catch (error) {
            return {
              index: item.index,
              result: {
                requestedUrl:
                  item.url,
                success: false,
                method: "browser",
                fallbackReason:
                  item.fallbackReason,
                durationMs:
                  Date.now() -
                  item.itemStartedAt,
                error:
                  getErrorMessage(error)
              }
            };
          }
        }
      );

    for (
      const browserResult
      of browserResults
    ) {
      results[
        browserResult.index
      ] = browserResult.result;
    }
  } catch (error) {
    const errorMessage =
      getErrorMessage(error);

    for (
      const item
      of browserItems
    ) {
      results[item.index] = {
        requestedUrl: item.url,
        success: false,
        method: "browser",
        fallbackReason:
          item.fallbackReason,
        durationMs:
          Date.now() -
          item.itemStartedAt,
        error: errorMessage
      };
    }
  } finally {
    if (browser) {
      await browser
        .close()
        .catch(() => {});
    }
  }

  return buildSynchronousResponse(
    urls,
    results,
    startedAt
  );
}

async function persistResultToR2(env, jobId, itemId, result) {
  if (!env.RESULTS || !result?.success) return null;

  const key = `scrape-results/${jobId}/${itemId}.json`;
  try {
    await env.RESULTS.put(key, JSON.stringify({
      version: VERSION,
      jobId,
      itemId,
      result
    }), {
      httpMetadata: { contentType: "application/json; charset=utf-8" }
    });
    return key;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                              D1 JOB HELPERS                                */
/* -------------------------------------------------------------------------- */

async function createJob(
  env,
  urls,
  extractionMode = "auto"
) {
  const jobId =
    `job_${crypto.randomUUID()}`;

  const createdAt = nowIso();

  const statements = [
    env.DB.prepare(
      `
        INSERT INTO jobs (
          id,
          status,
          total,
          completed,
          successful,
          failed,
          created_at,
          updated_at,
          extraction_mode
        )
        VALUES (
          ?,
          'queued',
          ?,
          0,
          0,
          0,
          ?,
          ?,
          ?
        )
      `
    ).bind(
      jobId,
      urls.length,
      createdAt,
      createdAt,
      extractionMode
    )
  ];

  const items = urls.map(
    (url, index) => {
      const itemId =
        `item_${String(
          index + 1
        ).padStart(3, "0")}_` +
        crypto.randomUUID();

      statements.push(
        env.DB.prepare(
          `
            INSERT INTO job_items (
              id,
              job_id,
              url,
              status,
              created_at,
              updated_at
            )
            VALUES (
              ?,
              ?,
              ?,
              'queued',
              ?,
              ?
            )
          `
        ).bind(
          itemId,
          jobId,
          url,
          createdAt,
          createdAt
        )
      );

      return {
        itemId,
        jobId,
        url
      };
    }
  );

  await env.DB.batch(
    statements
  );

  return {
    jobId,
    items
  };
}

async function getJob(
  env,
  jobId
) {
  return env.DB.prepare(
    `
      SELECT
        id,
        status,
        total,
        completed,
        successful,
        failed,
        created_at,
        updated_at,
        extraction_mode
      FROM jobs
      WHERE id = ?
    `
  )
    .bind(jobId)
    .first();
}

async function getJobItem(
  env,
  itemId
) {
  return env.DB.prepare(
    `
      SELECT
        id,
        job_id,
        url,
        status,
        method,
        title,
        text_length,
        final_url,
        result_key,
        error,
        duration_ms,
        created_at,
        updated_at
      FROM job_items
      WHERE id = ?
    `
  )
    .bind(itemId)
    .first();
}

async function markItemProcessing(
  env,
  itemId
) {
  await env.DB.prepare(
    `
      UPDATE job_items
      SET
        status = 'processing',
        error = NULL,
        updated_at = ?
      WHERE id = ?
    `
  )
    .bind(
      nowIso(),
      itemId
    )
    .run();
}

async function saveItemResult(
  env,
  jobId,
  itemId,
  result
) {
  const resultKey = await persistResultToR2(env, jobId, itemId, result);
  const itemStatus =
    result.success
      ? "completed"
      : "failed";

  await env.DB.prepare(
    `
      UPDATE job_items
      SET
        status = ?,
        method = ?,
        title = ?,
        text = ?,
        text_length = ?,
        final_url = ?,
        result_key = ?,
        extractor = ?,
        extraction_json = ?,
        extraction_ms = ?,
        error = ?,
        duration_ms = ?,
        updated_at = ?
      WHERE
        id = ?
        AND job_id = ?
    `
  )
    .bind(
      itemStatus,
      result.method || null,
      result.title || null,
      result.text || null,
      result.textLength || 0,
      result.finalUrl || null,
      resultKey,
      result.extractor || null,
      result.extraction
        ? JSON.stringify(result.extraction)
        : null,
      result.extractionMs || 0,
      result.error || null,
      result.durationMs || 0,
      nowIso(),
      itemId,
      jobId
    )
    .run();

  await refreshJobStatus(
    env,
    jobId
  );
}

async function markItemForRetry(
  env,
  itemId,
  errorMessage
) {
  await env.DB.prepare(
    `
      UPDATE job_items
      SET
        status = 'queued',
        error = ?,
        updated_at = ?
      WHERE id = ?
    `
  )
    .bind(
      errorMessage,
      nowIso(),
      itemId
    )
    .run();
}

async function markItemPermanentlyFailed(
  env,
  jobId,
  itemId,
  errorMessage
) {
  await env.DB.prepare(
    `
      UPDATE job_items
      SET
        status = 'failed',
        error = ?,
        updated_at = ?
      WHERE
        id = ?
        AND job_id = ?
    `
  )
    .bind(
      errorMessage,
      nowIso(),
      itemId,
      jobId
    )
    .run();

  await refreshJobStatus(
    env,
    jobId
  );
}

async function refreshJobStatus(
  env,
  jobId
) {
  const counts =
    await env.DB.prepare(
      `
        SELECT
          COUNT(*) AS total,
          SUM(
            CASE
              WHEN status = 'completed'
              THEN 1
              ELSE 0
            END
          ) AS successful,
          SUM(
            CASE
              WHEN status = 'failed'
              THEN 1
              ELSE 0
            END
          ) AS failed,
          SUM(
            CASE
              WHEN status IN (
                'completed',
                'failed'
              )
              THEN 1
              ELSE 0
            END
          ) AS completed
        FROM job_items
        WHERE job_id = ?
      `
    )
      .bind(jobId)
      .first();

  const total =
    Number(counts?.total || 0);

  const successful =
    Number(
      counts?.successful || 0
    );

  const failed =
    Number(counts?.failed || 0);

  const completed =
    Number(
      counts?.completed || 0
    );

  let status = "processing";

  if (
    completed >= total &&
    total > 0
  ) {
    status =
      failed > 0
        ? "completed_with_errors"
        : "completed";
  } else if (
    completed === 0
  ) {
    status = "queued";
  }

  await env.DB.prepare(
    `
      UPDATE jobs
      SET
        status = ?,
        total = ?,
        completed = ?,
        successful = ?,
        failed = ?,
        updated_at = ?
      WHERE id = ?
    `
  )
    .bind(
      status,
      total,
      completed,
      successful,
      failed,
      nowIso(),
      jobId
    )
    .run();
}

async function markJobEnqueueFailed(
  env,
  jobId,
  errorMessage
) {
  const updatedAt = nowIso();

  await env.DB.batch([
    env.DB.prepare(
      `
        UPDATE job_items
        SET
          status = 'failed',
          error = ?,
          updated_at = ?
        WHERE job_id = ?
      `
    ).bind(
      `Queue gönderimi başarısız: ${errorMessage}`,
      updatedAt,
      jobId
    ),

    env.DB.prepare(
      `
        UPDATE jobs
        SET
          status = 'failed',
          completed = total,
          successful = 0,
          failed = total,
          updated_at = ?
        WHERE id = ?
      `
    ).bind(
      updatedAt,
      jobId
    )
  ]);
}

/* -------------------------------------------------------------------------- */
/*                              REQUEST HELPERS                               */
/* -------------------------------------------------------------------------- */

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    throw new Error(
      "Geçerli JSON gövdesi gerekli"
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                              JOB ENDPOINTS                                 */
/* -------------------------------------------------------------------------- */

async function handleCreateJob(
  request,
  env
) {
  let body;

  try {
    body =
      await readJsonBody(request);
  } catch (error) {
    return json(
      {
        version: VERSION,
        success: false,
        error:
          getErrorMessage(error)
      },
      400
    );
  }

  let extractionMode;

  try {
    extractionMode = normalizeExtractionMode(
      body.options?.extract ?? body.extract
    );
  } catch (error) {
    return json(
      {
        version: VERSION,
        success: false,
        error: getErrorMessage(error)
      },
      400
    );
  }

  let urls;

  try {
    urls = normalizeUrlArray(
      body.urls,
      MAX_JOB_SIZE
    );
  } catch (error) {
    return json(
      {
        version: VERSION,
        success: false,
        error:
          getErrorMessage(error)
      },
      400
    );
  }

  let createdJob;

  try {
    createdJob =
      await createJob(
        env,
        urls,
        extractionMode
      );
  } catch (error) {
    return json(
      {
        version: VERSION,
        success: false,
        error:
          `D1 job oluşturulamadı: ${getErrorMessage(
            error
          )}`
      },
      500
    );
  }

  try {
    await env.SCRAPE_QUEUE.sendBatch(
      createdJob.items.map(
        (item) => ({
          body: {
            type: "scrape_url",
            jobId: item.jobId,
            itemId: item.itemId,
            url: item.url,
            extractionMode
          }
        })
      )
    );
  } catch (error) {
    const message =
      getErrorMessage(error);

    await markJobEnqueueFailed(
      env,
      createdJob.jobId,
      message
    );

    return json(
      {
        version: VERSION,
        success: false,
        jobId:
          createdJob.jobId,
        error:
          `Queue gönderimi başarısız: ${message}`
      },
      500
    );
  }

  return json(
    {
      version: VERSION,
      success: true,
      mode: "asynchronous",
      jobId:
        createdJob.jobId,
      status: "queued",
      extraction: extractionMode,
      total: urls.length,
      statusUrl:
        `/jobs/${createdJob.jobId}`,
      resultsUrl:
        `/jobs/${createdJob.jobId}/results`
    },
    202
  );
}

async function handleGetJob(
  env,
  jobId
) {
  const job =
    await getJob(
      env,
      jobId
    );

  if (!job) {
    return json(
      {
        version: VERSION,
        success: false,
        error:
          "Job bulunamadı"
      },
      404
    );
  }

  const total =
    Number(job.total || 0);

  const completed =
    Number(
      job.completed || 0
    );

  return json({
    version: VERSION,
    success: true,
    job: {
      ...job,
      total,
      completed,
      successful:
        Number(
          job.successful || 0
        ),
      failed:
        Number(
          job.failed || 0
        ),
      pending:
        Math.max(
          0,
          total - completed
        ),
      progress:
        total > 0
          ? Math.round(
              (
                completed /
                total
              ) * 100
            )
          : 0
    }
  });
}

async function handleGetJobResults(
  request,
  env,
  jobId
) {
  const job =
    await getJob(
      env,
      jobId
    );

  if (!job) {
    return json(
      {
        version: VERSION,
        success: false,
        error:
          "Job bulunamadı"
      },
      404
    );
  }

  const requestUrl =
    new URL(request.url);

  const parsedPage =
    Number(
      requestUrl.searchParams.get(
        "page"
      ) || 1
    );

  const parsedLimit =
    Number(
      requestUrl.searchParams.get(
        "limit"
      ) || 10
    );

  const page =
    Number.isFinite(parsedPage)
      ? Math.max(
          1,
          Math.floor(parsedPage)
        )
      : 1;

  const limit =
    Number.isFinite(parsedLimit)
      ? Math.min(
          20,
          Math.max(
            1,
            Math.floor(
              parsedLimit
            )
          )
        )
      : 10;

  const includeText =
    requestUrl.searchParams.get(
      "includeText"
    ) === "1" ||
    requestUrl.searchParams.get(
      "includeText"
    ) === "true";

  const offset =
    (page - 1) * limit;

  const selectText =
    includeText
      ? ", text"
      : "";

  const query = `
    SELECT
      id,
      url,
      status,
      method,
      title,
      text_length,
      final_url,
      result_key,
      error,
      duration_ms,
      created_at,
      extractor,
      extraction_json,
      extraction_ms,
      updated_at
      ${selectText}
    FROM job_items
    WHERE job_id = ?
    ORDER BY created_at ASC
    LIMIT ? OFFSET ?
  `;

  const result =
    await env.DB.prepare(query)
      .bind(
        jobId,
        limit,
        offset
      )
      .all();

  return json({
    version: VERSION,
    success: true,
    jobId,
    status: job.status,
    extraction: job.extraction_mode || "auto",
    total:
      Number(job.total || 0),
    page,
    limit,
    includeText,
    results:
      (result.results || []).map((item) => {
        if (!item.extraction_json) {
          return item;
        }

        let extraction = null;
        try {
          extraction = JSON.parse(item.extraction_json);
        } catch {
          extraction = null;
        }

        const { extraction_json, ...withoutRawExtraction } = item;
        return {
          ...withoutRawExtraction,
          extraction
        };
      })
  });
}

async function handleCreateResearchJob(request, env) {
  const response = await handleCreateJob(request, env);
  if (!response.ok) return response;

  const body = await response.json();
  return json({
    ...body,
    api: "research",
    statusUrl: `/research-jobs/${body.jobId}`,
    resultsUrl: `/research-jobs/${body.jobId}/results`
  }, response.status);
}

async function handleResearchScrapeRequest(request, env) {
  const response = await handleScrapeManyRequest(request, env);
  const body = await response.json();
  return json({
    ...body,
    api: "research",
    mode: "research_synchronous"
  }, response.status);
}

/* -------------------------------------------------------------------------- */
/*                           SYNCHRONOUS ENDPOINT                             */
/* -------------------------------------------------------------------------- */

async function handleScrapeManyRequest(
  request,
  env
) {
  let body;

  try {
    body =
      await readJsonBody(request);
  } catch (error) {
    return json(
      {
        version: VERSION,
        success: false,
        error:
          getErrorMessage(error)
      },
      400
    );
  }

  let extractionMode;

  try {
    extractionMode = normalizeExtractionMode(
      body.options?.extract ?? body.extract
    );
  } catch (error) {
    return json(
      {
        version: VERSION,
        success: false,
        error: getErrorMessage(error)
      },
      400
    );
  }

  let urls;

  try {
    urls = normalizeUrlArray(
      body.urls,
      MAX_SYNC_BATCH_SIZE
    );
  } catch (error) {
    return json(
      {
        version: VERSION,
        success: false,
        error:
          getErrorMessage(error),
        synchronousLimit:
          MAX_SYNC_BATCH_SIZE,
        largeJobEndpoint:
          "POST /jobs"
      },
      400
    );
  }

  try {
    const result =
      await scrapeManySynchronously(
        urls,
        env,
        extractionMode
      );

    return json(result);
  } catch (error) {
    return json(
      {
        version: VERSION,
        success: false,
        mode: "synchronous",
        error:
          getErrorMessage(error)
      },
      500
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                            LEGACY ENDPOINTS                                */
/* -------------------------------------------------------------------------- */

async function handleSingleRequest(
  request,
  env
) {
  const requestUrl =
    new URL(request.url);

  const targetUrl =
    requestUrl.searchParams.get(
      "url"
    );

  let extractionMode;

  try {
    extractionMode = normalizeExtractionMode(
      requestUrl.searchParams.get("extract")
    );
  } catch (error) {
    return json(
      {
        version: VERSION,
        success: false,
        error: getErrorMessage(error)
      },
      400
    );
  }

  if (!targetUrl) {
    return json(
      {
        version: VERSION,
        success: false,
        error: "URL gerekli",
        example:
          "/?url=https://example.com"
      },
      400
    );
  }

  try {
    const result =
      await scrapeSingleUrl(
        targetUrl,
        env,
        extractionMode
      );

    return json({
      version: VERSION,
      ...result
    });
  } catch (error) {
    return json(
      {
        version: VERSION,
        success: false,
        error:
          getErrorMessage(error)
      },
      400
    );
  }
}

async function handleBatchRequest(
  request,
  env
) {
  let body;

  try {
    body =
      await readJsonBody(request);
  } catch (error) {
    return json(
      {
        version: VERSION,
        success: false,
        error:
          getErrorMessage(error)
      },
      400
    );
  }

  let extractionMode;

  try {
    extractionMode = normalizeExtractionMode(
      body.options?.extract ?? body.extract
    );
  } catch (error) {
    return json(
      {
        version: VERSION,
        success: false,
        error: getErrorMessage(error)
      },
      400
    );
  }

  let urls;

  try {
    urls = normalizeUrlArray(
      body.urls,
      MAX_LEGACY_BATCH_SIZE
    );
  } catch (error) {
    return json(
      {
        version: VERSION,
        success: false,
        error:
          getErrorMessage(error)
      },
      400
    );
  }

  const result =
    await scrapeManySynchronously(
      urls,
      env,
      extractionMode
    );

  return json({
    ...result,
    mode: "legacy_batch"
  });
}

/* -------------------------------------------------------------------------- */
/*                             QUEUE PROCESSOR                                */
/* -------------------------------------------------------------------------- */

async function processQueueMessageWithResult(
  env,
  messageData,
  result
) {
  await saveItemResult(
    env,
    messageData.jobId,
    messageData.itemId,
    result
  );
}

async function processQueueBatch(
  batch,
  env
) {
  const pendingMessages = [];

  for (
    const message
    of batch.messages
  ) {
    const data = message.body;

    if (
      !data ||
      data.type !==
        "scrape_url" ||
      !data.jobId ||
      !data.itemId ||
      !data.url
    ) {
      message.ack();
      continue;
    }

    const currentItem =
      await getJobItem(
        env,
        data.itemId
      );

    if (!currentItem) {
      message.ack();
      continue;
    }

    if (
      currentItem.status ===
        "completed" ||
      currentItem.status ===
        "failed"
    ) {
      message.ack();
      continue;
    }

    await markItemProcessing(
      env,
      data.itemId
    );

    pendingMessages.push({
      message,
      data,
      startedAt: Date.now()
    });
  }

  if (
    pendingMessages.length === 0
  ) {
    return;
  }

  const fastResults =
    await mapWithConcurrency(
      pendingMessages,
      FETCH_CONCURRENCY,
      async (entry) => {
        try {
          return {
            entry,
            fastResult:
              await tryFastFetch(
                entry.data.url,
                entry.data.extractionMode
              )
          };
        } catch (error) {
          return {
            entry,
            fastError: error
          };
        }
      }
    );

  const browserEntries = [];

  for (
    const item
    of fastResults
  ) {
    const { entry } = item;

    if (item.fastError) {
      browserEntries.push({
        ...entry,
        fallbackReason:
          getErrorMessage(
            item.fastError
          )
      });

      continue;
    }

    if (
      !item.fastResult
        .requiresBrowser
    ) {
      const result = {
        requestedUrl:
          entry.data.url,
        durationMs:
          Date.now() -
          entry.startedAt,
        ...item.fastResult.result
      };

      await processQueueMessageWithResult(
        env,
        entry.data,
        result
      );

      entry.message.ack();
      continue;
    }

    browserEntries.push({
      ...entry,
      fallbackReason:
        item.fastResult.reason
    });
  }

  if (
    browserEntries.length === 0
  ) {
    return;
  }

  if (env.BROWSER_POOL) {
    const browserResults = await mapWithConcurrency(
      browserEntries,
      BROWSER_PAGE_CONCURRENCY,
      async (entry) => {
        try {
          const browserResult = await scrapeWithBrowserPool(
            entry.data.url,
            env,
            entry.data.extractionMode
          );
          return {
            entry,
            success: true,
            result: {
              requestedUrl: entry.data.url,
              fallbackReason: entry.fallbackReason,
              durationMs: Date.now() - entry.startedAt,
              ...browserResult
            }
          };
        } catch (error) {
          return {
            entry,
            success: false,
            error: getErrorMessage(error)
          };
        }
      }
    );

    for (const browserItem of browserResults) {
      const entry = browserItem.entry;
      if (browserItem.success) {
        await processQueueMessageWithResult(
          env,
          entry.data,
          browserItem.result
        );
        entry.message.ack();
        continue;
      }

      const errorMessage = browserItem.error;
      if (entry.message.attempts >= MAX_QUEUE_ATTEMPTS) {
        await markItemPermanentlyFailed(
          env,
          entry.data.jobId,
          entry.data.itemId,
          errorMessage
        );
        entry.message.ack();
      } else {
        await markItemForRetry(
          env,
          entry.data.itemId,
          errorMessage
        );
        entry.message.retry({
          delaySeconds: Math.min(
            30,
            Math.max(2, 2 ** entry.message.attempts)
          )
        });
      }
    }

    return;
  }

  let browser;

  try {
    browser =
      await puppeteer.launch(
        env.BROWSER
      );

    const browserResults =
      await mapWithConcurrency(
        browserEntries,
        BROWSER_PAGE_CONCURRENCY,
        async (entry) => {
          try {
            const browserResult =
              await scrapePageWithBrowser(
                browser,
                entry.data.url,
                entry.data.extractionMode
              );

            return {
              entry,
              success: true,
              result: {
                requestedUrl:
                  entry.data.url,
                fallbackReason:
                  entry.fallbackReason,
                durationMs:
                  Date.now() -
                  entry.startedAt,
                ...browserResult
              }
            };
          } catch (error) {
            return {
              entry,
              success: false,
              error:
                getErrorMessage(error)
            };
          }
        }
      );

    for (
      const browserItem
      of browserResults
    ) {
      const entry =
        browserItem.entry;

      if (browserItem.success) {
        await processQueueMessageWithResult(
          env,
          entry.data,
          browserItem.result
        );

        entry.message.ack();
        continue;
      }

      const errorMessage =
        browserItem.error;

      if (
        entry.message.attempts >=
        MAX_QUEUE_ATTEMPTS
      ) {
        await markItemPermanentlyFailed(
          env,
          entry.data.jobId,
          entry.data.itemId,
          errorMessage
        );

        entry.message.ack();
      } else {
        await markItemForRetry(
          env,
          entry.data.itemId,
          errorMessage
        );

        entry.message.retry({
          delaySeconds:
            Math.min(
              30,
              Math.max(
                2,
                2 **
                  entry.message
                    .attempts
              )
            )
        });
      }
    }
  } catch (error) {
    const errorMessage =
      getErrorMessage(error);

    for (
      const entry
      of browserEntries
    ) {
      if (
        entry.message.attempts >=
        MAX_QUEUE_ATTEMPTS
      ) {
        await markItemPermanentlyFailed(
          env,
          entry.data.jobId,
          entry.data.itemId,
          errorMessage
        );

        entry.message.ack();
      } else {
        await markItemForRetry(
          env,
          entry.data.itemId,
          errorMessage
        );

        entry.message.retry({
          delaySeconds:
            Math.min(
              30,
              Math.max(
                2,
                2 **
                  entry.message
                    .attempts
              )
            )
        });
      }
    }
  } finally {
    if (browser) {
      await browser
        .close()
        .catch(() => {});
    }
  }
}

/* -------------------------------------------------------------------------- */
async function handleWarmPools(request, env) {
  if (!env.ADMIN_TOKEN) {
    return json({ success: false, error: "Admin warm-up is not configured" }, 503);
  }
  const authorization = request.headers.get("Authorization") || "";
  if (authorization !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }
  const poolCount = Math.max(1, Number(env.POOL_COUNT || 20));
  const startedAt = Date.now();
  const pools = await Promise.all(Array.from({ length: poolCount }, async (_, index) => {
    try {
      const id = env.BROWSER_POOL.idFromName(`pool-${index}`);
      const response = await env.BROWSER_POOL.get(id).fetch(
        "https://browser-pool/warm",
        { method: "POST" }
      );
      const body = await response.json();
      return { index, ...body };
    } catch (error) {
      return { index, success: false, error: getErrorMessage(error) };
    }
  }));
  return json({
    success: pools.every((pool) => pool.success),
    poolCount,
    readyPools: pools.filter((pool) => pool.success).length,
    durationMs: Date.now() - startedAt,
    pools
  });
}

/* -------------------------------------------------------------------------- */

export default {
  async fetch(request, env) {
    if (
      request.method === "OPTIONS"
    ) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin":
            "*",
          "Access-Control-Allow-Methods":
            "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type",
          "Cache-Control":
            "no-store"
        }
      });
    }

    const requestUrl =
      new URL(request.url);

    const pathname =
      requestUrl.pathname;

    if (
      request.method === "GET" &&
      pathname === "/health"
    ) {
      return healthResponse();
    }

    if (
      request.method === "GET" &&
      pathname === "/health/detailed"
    ) {
      return handleDetailedHealth(env);
    }

    if (
      request.method === "POST" &&
      pathname === "/admin/warm-pools"
    ) {
      return handleWarmPools(request, env);
    }

    if (request.method === "POST" && pathname === "/research-scrape") {
      return handleResearchScrapeRequest(request, env);
    }

    if (request.method === "POST" && pathname === "/scrape-many") {
      return handleScrapeManyRequest(
        request,
        env
      );
    }

    if (request.method === "POST" && pathname === "/research-jobs") {
      return handleCreateResearchJob(request, env);
    }

    if (request.method === "POST" && pathname === "/jobs") {
      return handleCreateJob(
        request,
        env
      );
    }

    const researchResultsMatch = pathname.match(/^\/research-jobs\/([^/]+)\/results$/);
    if (request.method === "GET" && researchResultsMatch) {
      return handleGetJobResults(request, env, decodeURIComponent(researchResultsMatch[1]));
    }

    const resultsMatch =
      pathname.match(
        /^\/jobs\/([^/]+)\/results$/
      );

    if (
      request.method === "GET" &&
      resultsMatch
    ) {
      return handleGetJobResults(
        request,
        env,
        decodeURIComponent(
          resultsMatch[1]
        )
      );
    }

    const researchJobMatch = pathname.match(/^\/research-jobs\/([^/]+)$/);
    if (request.method === "GET" && researchJobMatch) {
      return handleGetJob(env, decodeURIComponent(researchJobMatch[1]));
    }

    const jobMatch =
      pathname.match(
        /^\/jobs\/([^/]+)$/
      );

    if (
      request.method === "GET" &&
      jobMatch
    ) {
      return handleGetJob(
        env,
        decodeURIComponent(
          jobMatch[1]
        )
      );
    }

    if (
      request.method === "POST" &&
      pathname === "/batch"
    ) {
      return handleBatchRequest(
        request,
        env
      );
    }

    if (
      request.method === "GET" &&
      (
        pathname === "/" ||
        pathname === "/scrape"
      )
    ) {
      return handleSingleRequest(
        request,
        env
      );
    }

    return json(
      {
        version: VERSION,
        success: false,
        error:
          "Endpoint bulunamadı",
        endpoints: {
          single:
            "GET /?url=https://example.com",
          scrapeMany:
            "POST /scrape-many — tek cevapta en fazla 20 URL",
          researchScrape:
            "POST /research-scrape — araştırma senkron akışı",
          batch:
            "POST /batch — tek cevapta en fazla 5 URL",
          createJob:
            "POST /jobs — arka planda en fazla 100 URL",
          researchJobs:
            "POST /research-jobs — araştırma async akışı",
          jobStatus:
            "GET /jobs/:jobId",
          jobResults:
            "GET /jobs/:jobId/results",
          researchJobStatus:
            "GET /research-jobs/:jobId",
          researchJobResults:
            "GET /research-jobs/:jobId/results",
          fullJobResults:
            "GET /jobs/:jobId/results?includeText=1"
        }
      },
      404
    );
  },

  async queue(batch, env) {
    await processQueueBatch(
      batch,
      env
    );
  }
};