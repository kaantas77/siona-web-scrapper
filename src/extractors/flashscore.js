import { extractGeneric } from "./generic.js";

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match.slice(1);
  }
  return [];
}

function numberValue(value) {
  if (value == null) return null;
  const match = String(value).match(/\d+(?:[.,]\d+)?/);
  return match ? Number(match[0].replace(",", ".")) : null;
}

export function extractFlashscore({ title = "", text = "", rawText } = {}) {
  const generic = extractGeneric({ title, text, rawText });
  const source = `${title} ${text}`.replace(/\s+/g, " ");
  const teams = firstMatch(source, [
    /(.{2,60})\s+(\d+)\s*[-:]\s*(\d+)\s+(.{2,60})/,
    /(.{2,60})\s+vs\.?\s+(.{2,60})/i,
  ]);
  const score = firstMatch(source, [
    /(?:final|bitti|finished|full time|maç sonucu)\D{0,30}(\d+)\s*[-:]\s*(\d+)/i,
    /\b(\d+)\s*[-:]\s*(\d+)\b/,
  ]);
  const possession = firstMatch(source, [
    /(?:possession|topa sahip olma)\D{0,25}(\d{1,3})\s*%?\D{0,15}(\d{1,3})\s*%?/i,
  ]);
  const xg = firstMatch(source, [
    /(?:xg|expected goals)\D{0,25}([0-9.,]+)\D{0,15}([0-9.,]+)/i,
  ]);
  const shots = firstMatch(source, [
    /(?:shots|şutlar|şut)\D{0,25}(\d+)\D{0,15}(\d+)/i,
  ]);

  const structured = {
    type: "football_match",
    homeTeam: teams[0]?.trim() || null,
    awayTeam: teams[3]?.trim() || teams[1]?.trim() || null,
    homeScore: numberValue(score[0]),
    awayScore: numberValue(score[1]),
    status: firstMatch(source, [
      /(?:status|durum)\s*[:：-]?\s*([^|,;]+)/i,
      /\b(Bitti|Finished|Live|Canlı|Postponed|Ertelendi)\b/i,
    ])[0]?.trim() || null,
    date: firstMatch(source, [
      /(?:date|tarih)\s*[:：-]?\s*([^|;]+)/i,
      /(\d{1,2}[./]\d{1,2}[./]\d{2,4}\s+\d{1,2}:\d{2})/,
    ])[0]?.trim() || null,
    competition: firstMatch(source, [
      /(?:competition|lig|turnuva)\s*[:：-]?\s*([^|;]+)/i,
    ])[0]?.trim() || null,
    events: [],
    statistics: {
      xg: xg.length ? { home: numberValue(xg[0]), away: numberValue(xg[1]) } : null,
      possession: possession.length
        ? { home: numberValue(possession[0]), away: numberValue(possession[1]) }
        : null,
      shots: shots.length
        ? { home: numberValue(shots[0]), away: numberValue(shots[1]) }
        : null,
    },
    referee: firstMatch(source, [/(?:referee|hakem)\s*[:：-]?\s*([^|;]+)/i])[0]?.trim() || null,
    stadium: firstMatch(source, [/(?:stadium|stat)\s*[:：-]?\s*([^|;]+)/i])[0]?.trim() || null,
    capacity: numberValue(firstMatch(source, [/(?:capacity|kapasite)\s*[:：-]?\s*([^|;]+)/i])[0]),
  };

  const usefulFields = [structured.homeTeam, structured.awayTeam, structured.homeScore, structured.awayScore]
    .filter((value) => value !== null && value !== undefined).length;

  return {
    ...generic,
    success: generic.success && usefulFields >= 2,
    type: "football_match",
    structured,
  };
}
