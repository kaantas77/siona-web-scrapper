import puppeteer from "@cloudflare/puppeteer";

function cleanHtml(html) {
  const title =
    html
      .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "";

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();

  return { title, text };
}

function needsBrowser(status, html, text) {
  if (status >= 400) return true;
  if (!html || html.length < 500) return true;
  if (text.length < 80) return true;

  const lower = html.toLowerCase();

  return (
    lower.includes("enable javascript") ||
    lower.includes("javascript is required") ||
    lower.includes("checking your browser") ||
    lower.includes("cf-chl-") ||
    lower.includes("__next_data__") && text.length < 800
  );
}

async function scrapeWithBrowser(url, env) {
  let browser;

  try {
    browser = await puppeteer.launch(env.BROWSER);

    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 Chrome/124 Safari/537.36"
    );

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 30000
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

      return { title, text };
    });

    return {
      success: true,
      method: "browser",
      finalUrl: page.url(),
      title: result.title,
      textLength: result.text.length,
      text: result.text.slice(0, 50000)
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    const targetUrl = requestUrl.searchParams.get("url");

    if (!targetUrl) {
      return Response.json(
        {
          error: "URL gerekli",
          example: "?url=https://example.com"
        },
        { status: 400 }
      );
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(targetUrl);

      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Geçersiz protokol");
      }
    } catch {
      return Response.json(
        { error: "Geçersiz URL" },
        { status: 400 }
      );
    }

    try {
      const response = await fetch(parsedUrl.toString(), {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; SionaBot/1.0; +https://aisiona.com)",
          Accept: "text/html,application/xhtml+xml"
        },
        redirect: "follow"
      });

      const contentType =
        response.headers.get("content-type") || "";

      if (contentType.includes("text/html")) {
        const html = await response.text();
        const cleaned = cleanHtml(html);

        if (
          !needsBrowser(
            response.status,
            html,
            cleaned.text
          )
        ) {
          return Response.json({
            version: "siona-hybrid-v1",
            success: response.ok,
            method: "fetch",
            status: response.status,
            finalUrl: response.url,
            title: cleaned.title,
            textLength: cleaned.text.length,
            text: cleaned.text.slice(0, 50000)
          });
        }
      }

      const browserResult = await scrapeWithBrowser(
        parsedUrl.toString(),
        env
      );

      return Response.json({
        version: "siona-hybrid-v1",
        ...browserResult
      });
    } catch (error) {
      return Response.json(
        {
          version: "siona-hybrid-v1",
          success: false,
          error:
            error instanceof Error
              ? error.message
              : String(error)
        },
        { status: 502 }
      );
    }
  }
};