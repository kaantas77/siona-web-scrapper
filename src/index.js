import puppeteer from "@cloudflare/puppeteer";

const VERSION = "siona-hybrid-v4";
const MAX_TEXT_LENGTH = 50_000;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
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

  for (const [broken, correct] of replacements) {
    result = result.split(broken).join(correct);
  }

  return result;
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
    rawTitle
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
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

  const text = normalizeText(rawText);

  return {
    title,
    text
  };
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
    (lowerHtml.includes("__next_data__") && text.length < 800)
  );
}

async function decodeResponse(response) {
  const buffer = await response.arrayBuffer();

  const contentType =
    response.headers.get("content-type") || "";

  const charsetMatch = contentType.match(
    /charset\s*=\s*["']?([^;"'\s]+)/i
  );

  const declaredCharset =
    charsetMatch?.[1]?.trim().toLowerCase() || "utf-8";

  const charsetAliases = {
    utf8: "utf-8",
    latin1: "windows-1252",
    "iso-8859-1": "windows-1252"
  };

  const charset =
    charsetAliases[declaredCharset] || declaredCharset;

  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
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

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 30_000
    });

    const result = await page.evaluate(() => {
      document
        .querySelectorAll(
          "script, style, noscript, svg, iframe, nav, footer"
        )
        .forEach((element) => element.remove());

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

    return {
      success: true,
      method: "browser",
      finalUrl: page.url(),
      title,
      textLength: text.length,
      text: text.slice(0, MAX_TEXT_LENGTH)
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    const requestUrl = new URL(request.url);
    const targetUrl = requestUrl.searchParams.get("url");

    if (!targetUrl) {
      return json(
        {
          version: VERSION,
          success: false,
          error: "URL gerekli",
          example: "?url=https://example.com"
        },
        400
      );
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(targetUrl);

      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Geçersiz protokol");
      }
    } catch {
      return json(
        {
          version: VERSION,
          success: false,
          error: "Geçersiz URL"
        },
        400
      );
    }

    try {
      const response = await fetch(parsedUrl.toString(), {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; SionaBot/1.0; +https://aisiona.com)",
          "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language":
            "tr-TR,tr;q=0.9,en;q=0.8"
        },
        redirect: "follow"
      });

      const contentType =
        response.headers.get("content-type") || "";

      if (contentType.includes("text/html")) {
        const html = await decodeResponse(response);
        const cleaned = cleanHtml(html);

        if (
          !needsBrowser(
            response.status,
            html,
            cleaned.text
          )
        ) {
          return json({
            version: VERSION,
            success: response.ok,
            method: "fetch",
            status: response.status,
            finalUrl: response.url,
            title: cleaned.title,
            textLength: cleaned.text.length,
            text: cleaned.text.slice(
              0,
              MAX_TEXT_LENGTH
            )
          });
        }
      }

      const browserResult = await scrapeWithBrowser(
        parsedUrl.toString(),
        env
      );

      return json({
        version: VERSION,
        ...browserResult
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
        502
      );
    }
  }
};