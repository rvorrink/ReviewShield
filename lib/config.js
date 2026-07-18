/**
 * Shared configuration for RealReview / EchteSterne.
 *
 * All text anchors used to detect Google Maps UI elements live here, so new
 * languages or rewordings can be added in one place. We deliberately avoid
 * Google's obfuscated CSS class names — they change frequently. Everything is
 * anchored on visible text and aria-labels instead.
 *
 * Works both as a plain browser script (attaches to globalThis.RealReview.config)
 * and as a CommonJS module (for unit tests).
 */
(function () {
  'use strict';

  const CONFIG = {
    /** Default user settings, persisted in chrome.storage.sync. */
    DEFAULT_SETTINGS: {
      enabled: true,
      language: 'auto', // 'auto' | 'de' | 'en'
      calcMode: 'worst', // 'worst' (top of removal range) | 'conservative' (bottom)
      removedStarValue: 1, // star value assumed for removed reviews (1 to 2.5)
      worstCaseMax: 500, // assumed upper bound for the open-ended "over 250" bucket
    },

    /**
     * One matcher per supported Maps UI language. To support a new language or
     * a Google rewording, add an entry here — nothing else needs to change.
     *
     * - banner:    detects the defamation-removal disclosure text
     * - between:   parses a closed range, e.g. "2 bis 5" / "2 to 5"
     * - openEnded: parses the open top bucket, e.g. "über 250" / "over 250"
     */
    BANNER_MATCHERS: [
      {
        lang: 'de',
        banner: /Bewertung(?:en)?\s+(?:wurden?\s+)?aufgrund\s+(?:von\s+|einer\s+)?Beschwerden?\s+wegen\s+Diffamierung\s+entfernt/i,
        between: /(\d+)\s*(?:bis|–|-)\s*(\d+)/i,
        openEnded: /(?:über|mehr\s+als)\s*(\d+)/i,
      },
      {
        lang: 'en',
        banner: /reviews?\s+(?:was\s+|were\s+)?removed\s+due\s+to\s+(?:a\s+)?defamation\s+complaints?/i,
        between: /(\d+)\s*(?:to|–|-)\s*(\d+)/i,
        openEnded: /(?:over|more\s+than)\s*(\d+)/i,
      },
    ],

    /** Keywords used for the cheap first-pass DOM text search (XPath). */
    BANNER_KEYWORDS: ['Diffamierung', 'defamation'],

    /**
     * Total review count as aria-label or leaf text, e.g. "3.270 Rezensionen",
     * "3,270 reviews", "352 Berichte" (German Reviews-tab header wording).
     * Reviewer entries ("2 Rezensionen" under a reviewer's name) also match;
     * the content script rejects those by requiring the header rating nearby.
     */
    REVIEW_COUNT_LABEL: /^\s*(\d[\d.,  \s]*)\s*(?:reviews?|Rezension(?:en)?|Bewertung(?:en)?|Bericht(?:e)?)\s*$/i,

    /** Visible review count next to the stars, e.g. "(3.270)". */
    REVIEW_COUNT_TEXT: /^\(\s*(\d[\d.,  \s]*)\s*\)$/,

    /** aria-label of the header star widget, e.g. "4,6 Sterne" / "4.6 stars". */
    STARS_LABEL: /(\d[.,]\d)\s*(?:stars?|Sterne)/i,

    /**
     * aria-label of an individual review's star widget, e.g. "5 stars" /
     * "1 Stern" — exact match, so histogram rows ("5 stars, 851 reviews")
     * and the header ("4.6 stars") don't count. Several of these present
     * means the reviews list has actually rendered.
     */
    REVIEW_ITEM_STARS: /^\s*\d\s*(?:stars?|Sterne?n?)\s*$/i,

    /**
     * Numeric score chip of an individual review — hotels aggregate external
     * reviews (Booking, Expedia, …) that show "4/5", "Rated 4.0 out of 5" or
     * "4,0 von 5 Sternen" instead of a star widget.
     */
    REVIEW_ITEM_SCORE: /^\s*(?:Rated\s+|Mit\s+)?\d(?:[.,]\d)?\s*(?:\/|out\s+of|von)\s*5(?:\s+(?:stars?|Sternen?)\s*(?:bewertet)?)?\s*\.?\s*$/i,

    /** Visible header rating number, e.g. "4,6" / "4.6". */
    RATING_TEXT: /^\d[.,]\d$/,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = CONFIG;
  } else {
    globalThis.RealReview = globalThis.RealReview || {};
    globalThis.RealReview.config = CONFIG;
  }
})();
