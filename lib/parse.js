/**
 * Pure parsing and math functions for RealReview / EchteSterne.
 * No DOM, no chrome.* APIs — fully unit-testable in Node.
 *
 * Works both as a plain browser script (attaches to globalThis.RealReview.parse)
 * and as a CommonJS module (for unit tests).
 */
(function () {
  'use strict';

  const CONFIG =
    typeof module === 'object' && typeof require === 'function'
      ? require('./config.js')
      : (globalThis.RealReview || {}).config;

  /**
   * Returns the banner matcher whose disclosure text appears in `text`,
   * or null if no supported language matches.
   */
  function matchBanner(text, matchers) {
    if (typeof text !== 'string') return null;
    const list = matchers || CONFIG.BANNER_MATCHERS;
    const norm = text.replace(/\s+/g, ' ');
    for (const m of list) {
      if (m.banner.test(norm)) return m;
    }
    return null;
  }

  /**
   * Replaces word-form numbers with digits ("Six to ten" → "6 to 10").
   * Longer phrases are applied first so "twenty-one" wins over "twenty"/"one".
   */
  function normalizeNumberWords(text, words) {
    if (!words) return text;
    let out = text;
    const entries = Object.entries(words).sort((a, b) => b[0].length - a[0].length);
    for (const [word, value] of entries) {
      out = out.replace(new RegExp('\\b' + word + '\\b', 'gi'), String(value));
    }
    return out;
  }

  /**
   * Parses the removal count range out of a defamation banner text.
   *
   * Handles digits ("1", "2 bis 5", "über 250" / "2 to 5", "over 250") and
   * word forms ("One", "Six to ten" / "Eine", "Sechs bis zehn"). For the
   * open-ended top bucket ("über/over N") the result is [N + 1, worstCaseMax]
   * with `openEnded: true` and `base: N`.
   *
   * Returns {min, max, openEnded, base?} or null.
   */
  function parseRemovalRange(text, worstCaseMax, matchers) {
    if (typeof text !== 'string') return null;
    const worst = Number.isFinite(worstCaseMax) && worstCaseMax > 0 ? worstCaseMax : 500;
    const list = matchers || CONFIG.BANNER_MATCHERS;
    const norm = text.replace(/\s+/g, ' ');

    for (const m of list) {
      const bannerMatch = norm.match(m.banner);
      if (!bannerMatch) continue;

      // Only look at a small window ending at the banner phrase, so unrelated
      // numbers elsewhere on the page can't leak in. The count always precedes
      // the phrase ("2 bis 5 Bewertungen aufgrund …" / "2 to 5 reviews removed …").
      // Word-form counts ("Six to ten") are normalized to digits first.
      const start = Math.max(0, bannerMatch.index - 40);
      const rawContext = norm.slice(start, bannerMatch.index + bannerMatch[0].length);
      const context = normalizeNumberWords(rawContext, m.numberWords);

      const between = context.match(m.between);
      if (between) {
        const min = parseInt(between[1], 10);
        const max = parseInt(between[2], 10);
        if (min > 0 && max >= min) return { min, max, openEnded: false };
        return null;
      }

      const over = context.match(m.openEnded);
      if (over) {
        const base = parseInt(over[1], 10);
        if (base > 0) {
          return { min: base + 1, max: Math.max(worst, base + 1), openEnded: true, base };
        }
        return null;
      }

      // Single exact count, e.g. "1 Bewertung … entfernt" / "One review …".
      // Take the number closest to the banner phrase. Normalization may have
      // shifted offsets, so re-locate the phrase in the normalized context.
      const ctxBanner = context.match(m.banner);
      const before = ctxBanner ? context.slice(0, ctxBanner.index) : '';
      const nums = before.match(/\d+/g);
      if (nums && nums.length) {
        const n = parseInt(nums[nums.length - 1], 10);
        if (n > 0) return { min: n, max: n, openEnded: false };
      }
      return null;
    }
    return null;
  }

  /**
   * Parses a review count in either German or English formatting:
   * "3.270" → 3270, "3,270" → 3270, "1.234.567" → 1234567, "(412)" → 412.
   * Returns a positive integer or null.
   */
  function parseLocalizedCount(str) {
    if (typeof str !== 'string') return null;
    const cleaned = str.replace(/[\s  ()]/g, '');
    const m = cleaned.match(/\d[\d.,]*/);
    if (!m) return null;
    const num = m[0];

    let value = null;
    if (/^\d+$/.test(num)) {
      value = parseInt(num, 10);
    } else if (/^\d{1,3}(?:[.,]\d{3})+$/.test(num)) {
      // Pure grouping: "3.270", "3,270", "1.234.567"
      value = parseInt(num.replace(/[.,]/g, ''), 10);
    } else {
      // Mixed/odd formats ("1.234,5"): treat the last separator as decimal.
      const lastSep = Math.max(num.lastIndexOf('.'), num.lastIndexOf(','));
      const intPart = num.slice(0, lastSep).replace(/[.,]/g, '');
      const frac = num.slice(lastSep + 1);
      const parsed = parseFloat(intPart + '.' + frac);
      if (Number.isFinite(parsed)) value = Math.round(parsed);
    }
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /**
   * Parses an average rating in either formatting: "4,3" → 4.3, "4.3" → 4.3.
   * Returns a number in [0, 5] or null.
   */
  function parseLocalizedRating(str) {
    if (typeof str !== 'string') return null;
    const cleaned = str.replace(/[\s  ]/g, '');
    const m = cleaned.match(/\d+(?:[.,]\d+)?/);
    if (!m) return null;
    const value = parseFloat(m[0].replace(',', '.'));
    return Number.isFinite(value) && value >= 0 && value <= 5 ? value : null;
  }

  /**
   * Corrected average treating each of the `removed` reviews as having
   * `assumedStar` stars (default 1, the harshest assumption):
   * (rating * count + assumedStar * removed) / (count + removed),
   * clamped to [1, 5]. Returns null on invalid input.
   */
  function correctedRating(rating, count, removed, assumedStar) {
    const star = assumedStar === undefined ? 1 : assumedStar;
    if (!Number.isFinite(rating) || !Number.isFinite(count) || !Number.isFinite(removed)) return null;
    if (!Number.isFinite(star) || star < 0 || star > 5) return null;
    if (count <= 0 || removed < 0 || rating < 0 || rating > 5) return null;
    const value = (rating * count + star * removed) / (count + removed);
    return Math.min(5, Math.max(1, value));
  }

  /**
   * Corrected rating bounds for a removal range. More removed low-star
   * reviews → lower average, so:
   *   low  = corrected with range.max, high = corrected with range.min.
   * Returns {low, high} (unrounded) or null.
   */
  function correctedRange(rating, count, range, assumedStar) {
    if (!range) return null;
    const low = correctedRating(rating, count, range.max, assumedStar);
    const high = correctedRating(rating, count, range.min, assumedStar);
    if (low === null || high === null) return null;
    return { low, high };
  }

  /** Formats a rating with one decimal in the given language ("4,3" de / "4.3" en). */
  function formatRating(value, lang) {
    if (!Number.isFinite(value)) return '';
    const s = (Math.round(value * 10) / 10).toFixed(1);
    return lang === 'de' ? s.replace('.', ',') : s;
  }

  /** Formats a corrected range, collapsing to a single value if bounds round equal. */
  function formatCorrectedRange(low, high, lang) {
    const a = formatRating(low, lang);
    const b = formatRating(high, lang);
    if (!a || !b) return '';
    return a === b ? a : a + '–' + b;
  }

  const api = {
    matchBanner,
    parseRemovalRange,
    parseLocalizedCount,
    parseLocalizedRating,
    correctedRating,
    correctedRange,
    formatRating,
    formatCorrectedRange,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    globalThis.RealReview = globalThis.RealReview || {};
    globalThis.RealReview.parse = api;
  }
})();
