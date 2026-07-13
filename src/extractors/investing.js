import { extractGeneric } from "./generic.js";

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function rangeMatch(text, patterns) {
  const value = firstMatch(text, patterns);
  if (!value) return null;
  const parts = value.split(/\s*(?:-|–|—|to|ile)\s*/i);
  return parts.length >= 2
    ? { low: parts[0].trim(), high: parts[1].trim() }
    : { raw: value };
}

function extractNews(text) {
  const candidates = text
    .split(/(?<=[.!?])\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length >= 35 && value.length <= 220)
    .filter((value) => !/^(fiyat|açılış|hacim|volume|market cap)/i.test(value));
  return [...new Set(candidates)].slice(0, 10);
}

export function extractInvesting({ title = "", text = "", rawText } = {}) {
  const generic = extractGeneric({ title, text, rawText });
  const source = `${title} ${text}`.replace(/\s+/g, " ");
  const structured = {
    type: "finance_equity",
    symbol: firstMatch(source, [
      /\(([A-Z0-9]{1,8})\)/,
      /(?:symbol|ticker|sembol)\s*[:：-]?\s*([A-Z0-9]{1,8})/i,
    ]),
    company: firstMatch(source, [
      /(?:company|şirket|firma)\s*[:：-]\s*([^|,;]+)/i,
    ]) || title.replace(/\s*[|-]\s*Investing\.com.*$/i, "").trim() || null,
    price: firstMatch(source, [
      /(?:price|fiyat|son fiyat)\s*[:：-]?\s*([0-9][0-9.,]*)/i,
    ]),
    change: firstMatch(source, [
      /(?:change|değişim|değişiklik)\s*[:：-]?\s*([+-]?[0-9][0-9.,]*\s*%?)/i,
    ]),
    previousClose: firstMatch(source, [
      /(?:previous close|önceki kapanış)\s*[:：-]?\s*([0-9][0-9.,]*)/i,
    ]),
    open: firstMatch(source, [
      /(?:open|açılış)\s*[:：-]?\s*([0-9][0-9.,]*)/i,
    ]),
    dayRange: rangeMatch(source, [
      /(?:day range|gün aralığı)\s*[:：-]?\s*([^|;]+)/i,
    ]),
    week52Range: rangeMatch(source, [
      /(?:52 week range|52 hafta aralığı|52 haftalık aralık)\s*[:：-]?\s*([^|;]+)/i,
    ]),
    volume: firstMatch(source, [/(?:volume|hacim)\s*[:：-]?\s*([^|;,]+)/i]),
    averageVolume: firstMatch(source, [
      /(?:average volume|ortalama hacim)\s*[:：-]?\s*([^|;,]+)/i,
    ]),
    marketCap: firstMatch(source, [
      /(?:market cap|piyasa değeri)\s*[:：-]?\s*([^|;,]+)/i,
    ]),
    technicalSummary: firstMatch(source, [
      /(?:technical summary|teknik özet|teknik analiz)\s*[:：-]?\s*([^|.]+)/i,
    ]),
    news: extractNews(generic.cleanText),
  };

  const usefulFields = [structured.price, structured.change, structured.volume, structured.marketCap]
    .filter(Boolean).length;

  return {
    ...generic,
    success: generic.success && usefulFields >= 1,
    type: "finance_equity",
    structured,
  };
}
