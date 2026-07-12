import puppeteer from "@cloudflare/puppeteer";

const VERSION = "siona-hybrid-v7";
const MAX_TEXT_LENGTH = 50_000;
const MAX_BATCH_SIZE = 5;
const FETCH_TIMEOUT_MS = 15_000;
const BROWSER_TIMEOUT_MS = 30_000;

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

function decodeHtmlEntities(text) {
  return text
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
        return String.fromCodePoint(parseInt(code, 16));
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

  let result = text;

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
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";

  const title = normalizeText(
    rawTitle.replace(/<[^>]+>/g, " ")
  );

  const rawText = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, " ")
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
  return matches ? matches.length : 0;
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

  const utf8Text = decodeBuffer(buffer, "utf-8");
  const windowsText = decodeBuffer(buffer, "windows-1252");

  const utf8Score = mojibakeScore(utf8Text);
  const windowsScore = mojibakeScore(windowsText);

  if (utf8Text && utf8Score <= windowsScore) {
    return utf8Text;
  }

  return windowsText || utf8Text;
}

function needsBrowser(status, html, text) {
  if (status >= 400) return true;
  if (!html || html.length < 500) return true;
  if (!text || text.length < 80) return true;

  const lowerHtml = html.toLowerCase();

  return (
    lowerHtml.includes("enable javascript") ||
    lowerHtml.includes("javascript is required") ||
    lowerHtml.includes("checking your browser") ||
    lowerHtml.includes("just a moment") ||
    lowerHtml.includes("cf-chl-") ||
    lowerHtml.includes("loading...") ||
    (lowerHtml.includes("__next_data__") && text.length < 800)
  );
}

function isFlashscoreMatchPage(url) {
  try {
    const parsedUrl = new URL(url);

    return (
      parsedUrl.hostname.includes("flashscore.") &&
      parsedUrl.pathname.includes("/mac/")
    );
  } catch {
    return false;
  }
}

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

  const match172 = value.match(/^172\.(\d+)\./);

  if (match172) {
    const secondOctet = Number(match172[1]);

    if (secondOctet >= 16 && secondOctet <= 31) {
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
    throw new Error("Yalnızca HTTP ve HTTPS destekleniyor");
  }

  if (isPrivateOrLocalHostname(parsedUrl.hostname)) {
    throw new Error("Yerel veya özel ağ adreslerine erişim yasak");
  }

  return parsedUrl;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function tryFastFetch(url) {
  if (isFlashscoreMatchPage(url)) {
    return {
      requiresBrowser: true,
      reason: "Flashscore maç sayfası browser ile açılmalı"
    };
  }

  try {
    const response = await fetchWithTimeout(
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
      response.headers.get("content-type") || "";

    if (!contentType.toLowerCase().includes("text/html")) {
      return {
        requiresBrowser: true,
        reason: `HTML olmayan içerik: ${contentType || "bilinmiyor"}`
      };
    }

    const html = await decodeResponse(response);
    const cleaned = cleanHtml(html);

    if (needsBrowser(response.status, html, cleaned.text)) {
      return {
        requiresBrowser: true,
        reason: "Sayfa JavaScript veya browser gerektiriyor"
      };
    }

    return {
      requiresBrowser: false,
      result: {
        success: response.ok,
        method: "fetch",
        status: response.status,
        finalUrl: response.url,
        title: cleaned.title,
        textLength: cleaned.text.length,
        text: cleaned.text.slice(0, MAX_TEXT_LENGTH)
      }
    };
  } catch (error) {
    return {
      requiresBrowser: true,
      reason:
        error instanceof Error
          ? error.message
          : String(error)
    };
  }
}

async function scrapeWithBrowser(url, env) {
  let browser;

  try {
    browser = await puppeteer.launch(env.BROWSER);

    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/124.0.0.0 Safari/537.36"
    );

    await page.setExtraHTTPHeaders({
      "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8"
    });

    await page.setViewport({
      width: 1440,
      height: 1200
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: BROWSER_TIMEOUT_MS
    });

    if (isFlashscoreMatchPage(url)) {
      try {
        await page.waitForFunction(
          () => {
            const bodyText = document.body?.innerText || "";

            return (
              !bodyText.includes("Loading...") &&
              bodyText.length > 1000
            );
          },
          {
            timeout: 15_000
          }
        );
      } catch {
        await new Promise((resolve) =>
          setTimeout(resolve, 5_000)
        );
      }
    } else {
      try {
        await page.waitForNetworkIdle({
          idleTime: 1_000,
          timeout: 10_000
        });
      } catch {
        // Bazı sitelerde ağ hiç tamamen boş kalmayabilir.
      }
    }

    const result = await page.evaluate(() => {
      const title = document.title || "";

      const text =
        document.body?.innerText
          ?.replace(/\s+/g, " ")
          .trim() || "";

      return {
        title,
        text
      };
    });

    const title = normalizeText(result.title);
    const text = normalizeText(result.text);

    const stillLoading = text.includes("Loading...");

    return {
      success: !stillLoading && text.length > 80,
      method: "browser",
      status: 200,
      finalUrl: page.url(),
      title,
      textLength: text.length,
      stillLoading,
      text: text.slice(0, MAX_TEXT_LENGTH)
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function scrapeSingleUrl(url, env) {
  const parsedUrl = parseAndValidateUrl(url);
  const normalizedUrl = parsedUrl.toString();

  const fastResult = await tryFastFetch(normalizedUrl);

  if (!fastResult.requiresBrowser) {
    return {
      requestedUrl: normalizedUrl,
      ...fastResult.result
    };
  }

  try {
    const browserResult = await scrapeWithBrowser(
      normalizedUrl,
      env
    );

    return {
      requestedUrl: normalizedUrl,
      fallbackReason: fastResult.reason,
      ...browserResult
    };
  } catch (error) {
    return {
      requestedUrl: normalizedUrl,
      success: false,
      method: "browser",
      error:
        error instanceof Error
          ? error.message
          : String(error),
      fallbackReason: fastResult.reason
    };
  }
}

async function handleSingleRequest(request, env) {
  const requestUrl = new URL(request.url);
  const targetUrl = requestUrl.searchParams.get("url");

  if (!targetUrl) {
    return json(
      {
        version: VERSION,
        success: false,
        error: "URL gerekli",
        example: "/?url=https://example.com"
      },
      400
    );
  }

  try {
    const result = await scrapeSingleUrl(targetUrl, env);

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
          error instanceof Error
            ? error.message
            : String(error)
      },
      400
    );
  }
}

async function handleBatchRequest(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json(
      {
        version: VERSION,
        success: false,
        error: "Geçerli JSON gövdesi gerekli"
      },
      400
    );
  }

  if (!Array.isArray(body.urls)) {
    return json(
      {
        version: VERSION,
        success: false,
        error: '"urls" bir dizi olmalı'
      },
      400
    );
  }

  const urls = [
    ...new Set(
      body.urls
        .filter((url) => typeof url === "string")
        .map((url) => url.trim())
        .filter(Boolean)
    )
  ];

  if (urls.length === 0) {
    return json(
      {
        version: VERSION,
        success: false,
        error: "En az bir URL gerekli"
      },
      400
    );
  }

  if (urls.length > MAX_BATCH_SIZE) {
    return json(
      {
        version: VERSION,
        success: false,
        error: `Tek batch içinde en fazla ${MAX_BATCH_SIZE} URL gönderilebilir`
      },
      400
    );
  }

  const startedAt = Date.now();

  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        return await scrapeSingleUrl(url, env);
      } catch (error) {
        return {
          requestedUrl: url,
          success: false,
          error:
            error instanceof Error
              ? error.message
              : String(error)
        };
      }
    })
  );

  const successful = results.filter(
    (result) => result.success
  ).length;

  return json({
    version: VERSION,
    success: successful > 0,
    requested: urls.length,
    successful,
    failed: urls.length - successful,
    durationMs: Date.now() - startedAt,
    results
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Cache-Control": "no-store"
        }
      });
    }

    const requestUrl = new URL(request.url);

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/batch"
    ) {
      return handleBatchRequest(request, env);
    }

    if (
      request.method === "GET" &&
      (
        requestUrl.pathname === "/" ||
        requestUrl.pathname === "/scrape"
      )
    ) {
      return handleSingleRequest(request, env);
    }

    return json(
      {
        version: VERSION,
        success: false,
        error: "Endpoint bulunamadı",
        endpoints: {
          single: "GET /?url=https://example.com",
          batch: "POST /batch"
        }
      },
      404
    );
  }
};