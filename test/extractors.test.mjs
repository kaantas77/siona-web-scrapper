import assert from "node:assert/strict";
import test from "node:test";
import { extractContent, selectExtractor } from "../src/extractors/index.js";

test("selects Investing extractor and extracts core equity fields", () => {
  const result = extractContent({
    url: "https://tr.investing.com/equities/example",
    title: "HATSN - Investing.com",
    text: "HATSN (HATSN) Price: 56,60 Change: +2,35% Previous Close: 55,30 Open: 55,65 Day Range: 55,10 - 57,70 Volume: 2,35M Market Cap: 12,25B Şirket finansal sonuçlarını açıkladı ve yatırımcılar gelişmeleri takip ediyor.",
  });

  assert.equal(selectExtractor("https://tr.investing.com/equities/example").name, "extractInvesting");
  assert.equal(result.type, "finance_equity");
  assert.equal(result.structured.price, "56,60");
  assert.equal(result.structured.change, "+2,35%");
  assert.equal(result.success, true);
});

test("selects Flashscore extractor and extracts match score and statistics", () => {
  const result = extractContent({
    url: "https://www.flashscore.com.tr/mac/futbol/example/",
    title: "The Strongest - Bolivar",
    text: "The Strongest 1 - 1 Bolivar Bitti Date: 12.07.2026 21:15 Competition: Bolivya Division Profesional xG 0.62 - 0.91 Possession 40% - 60% Shots 10 - 20 Hakem: Test Referee Stat: Estadio Hernando Siles.",
  });

  assert.equal(result.type, "football_match");
  assert.equal(result.structured.homeScore, 1);
  assert.equal(result.structured.awayScore, 1);
  assert.deepEqual(result.structured.statistics.xg, { home: 0.62, away: 0.91 });
  assert.equal(result.success, true);
});

test("falls back to generic extraction for unknown hosts", () => {
  const result = extractContent({
    url: "https://example.com/article",
    title: "Example article",
    text: "This is a sufficiently long article body that should remain available to the generic extractor for downstream research and summarization workflows.",
  });

  assert.equal(result.type, "generic");
  assert.equal(result.success, true);
  assert.match(result.cleanText, /sufficiently long article body/);
});
