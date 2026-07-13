const BOILERPLATE_PATTERNS = [
  /^(çerez|cookie|gizlilik|privacy|terms|kullanım şartları)/i,
  /^(reklam|advertisement|sponsorlu)/i,
  /^(menü|menu|navigation|ana sayfa|home)$/i,
  /^(giriş yap|login|sign in|kaydol|register)$/i,
];

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function cleanLines(text) {
  const seen = new Set();
  const lines = String(text || "")
    .split(/\r?\n|(?<=[.!?])\s{2,}/)
    .map(normalizeWhitespace)
    .filter((line) => line.length >= 2)
    .filter((line) => !BOILERPLATE_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => {
      const key = line.toLocaleLowerCase("tr-TR");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return lines.join(" ").replace(/\s+/g, " ").trim();
}

export function extractGeneric({ title = "", text = "", rawText } = {}) {
  const cleanText = cleanLines(text);
  return {
    success: cleanText.length >= 80,
    type: "generic",
    structured: { title: normalizeWhitespace(title) },
    cleanText,
    rawText: rawText || text,
  };
}
