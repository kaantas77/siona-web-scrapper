import { extractGeneric } from "./generic.js";
import { extractInvesting } from "./investing.js";
import { extractFlashscore } from "./flashscore.js";

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function selectExtractor(url, requested = "auto") {
  if (requested === "generic" || requested === "raw") return extractGeneric;
  const hostname = hostnameOf(url);
  if (requested === "investing" || hostname.includes("investing.com")) return extractInvesting;
  if (requested === "flashscore" || hostname.includes("flashscore.")) return extractFlashscore;
  return extractGeneric;
}

export function extractContent({ url, title, text, rawText, extractor = "auto" } = {}) {
  const startedAt = Date.now();
  const selected = selectExtractor(url, extractor);
  let result;
  try {
    result = selected({ title, text, rawText });
  } catch {
    result = extractGeneric({ title, text, rawText });
  }
  return {
    ...result,
    extractor: selected.name || "generic",
    extractionMs: Date.now() - startedAt,
  };
}
