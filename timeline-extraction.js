(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ApplicationTrackerTimeline = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MONTHS = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
  };

  const RELEVANT_CONTEXT = /\b(?:role|position|job|program(?:me)?|internship|placement|cohort)\b.{0,45}\b(?:start(?:s|ing)?|begin(?:s|ning)?|commenc(?:e|es|ing|ement))\b|\b(?:start(?:s|ing)?|begin(?:s|ning)?|commenc(?:e|es|ing|ement))\b.{0,45}\b(?:role|position|job|program(?:me)?|internship|placement|cohort)\b|\b(?:hiring|recruitment|selection)\s+(?:period|process|cycle)\b.{0,35}\b(?:end(?:s|ing)?|finish(?:es|ing)?|conclude(?:s|d)?)\b/i;
  const APPLICATION_DEADLINE_ONLY = /\b(?:applications?|submissions?)\s+(?:close|closing|due)|\b(?:application|submission)\s+deadline\b/i;

  function isoDate(year, month, day) {
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    if (
      !Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) ||
      parsed.getUTCFullYear() !== y ||
      parsed.getUTCMonth() !== m - 1 ||
      parsed.getUTCDate() !== d
    ) {
      return null;
    }
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  function datesInText(text) {
    const dates = [];
    let match;

    const iso = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g;
    while ((match = iso.exec(text))) {
      const value = isoDate(match[1], match[2], match[3]);
      if (value) dates.push(value);
    }

    const numeric = /\b([0-3]?\d)[\/.]([01]?\d)[\/.](20\d{2})\b/g;
    while ((match = numeric.exec(text))) {
      const value = isoDate(match[3], match[2], match[1]);
      if (value) dates.push(value);
    }

    const dayFirst = /\b([0-3]?\d)(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|Sept|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*,?\s*(20\d{2})\b/gi;
    while ((match = dayFirst.exec(text))) {
      const value = isoDate(match[3], MONTHS[match[2].toLowerCase()], match[1]);
      if (value) dates.push(value);
    }

    const monthFirst = /\b(January|February|March|April|May|June|July|August|September|Sept|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+([0-3]?\d)(?:st|nd|rd|th)?\s*,?\s*(20\d{2})\b/gi;
    while ((match = monthFirst.exec(text))) {
      const value = isoDate(match[3], MONTHS[match[1].toLowerCase()], match[2]);
      if (value) dates.push(value);
    }

    return dates;
  }

  function extractHiringEndDate(pageText) {
    if (typeof pageText !== "string" || !pageText.trim()) return null;

    const candidates = [];
    // Job boards generally keep timeline facts on one line or one compact
    // paragraph. Restricting the local fallback to those blocks avoids
    // attaching an unrelated footer/date to a nearby "start" word.
    const blocks = pageText.split(/\n{1,}|(?<=[.!?])\s+/);
    for (const block of blocks) {
      if (!RELEVANT_CONTEXT.test(block)) continue;
      if (APPLICATION_DEADLINE_ONLY.test(block) && !/\b(?:start|begin|commenc)/i.test(block)) {
        continue;
      }
      candidates.push(...datesInText(block));
    }

    if (!candidates.length) return null;
    candidates.sort();
    return candidates[0];
  }

  return { extractHiringEndDate };
});
