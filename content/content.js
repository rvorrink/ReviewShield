/**
 * RealReview / EchteSterne — content script for Google Maps.
 *
 * Detects the defamation-removal banner in the place panel, reads the official
 * rating and review count, computes a corrected rating range (assuming all
 * removed reviews were 1-star) and injects a badge next to the official rating.
 *
 * Maps is an SPA that re-renders aggressively, so everything is driven by a
 * debounced MutationObserver, is idempotent, and fails silently: if any anchor
 * can't be found, we simply do nothing rather than break the page.
 */
(function () {
  'use strict';

  const RR = globalThis.RealReview;
  if (!RR || !RR.config || !RR.parse || !RR.i18n) return;

  const CFG = RR.config;
  const P = RR.parse;

  const BADGE_CLASS = 'realreview-badge';
  const SCAN_DEBOUNCE_MS = 350;
  const RESCAN_INTERVAL_MS = 3000;

  // Flip to true and reload the extension to trace detection in the console.
  const DEBUG = false;
  function debug() {
    if (!DEBUG) return;
    try {
      console.log.apply(console, ['[RealReview]'].concat(Array.from(arguments)));
    } catch (e) {
      /* silent */
    }
  }

  let settings = Object.assign({}, CFG.DEFAULT_SETTINGS);
  let translator = null;
  let scanTimer = null;

  // ---------------------------------------------------------------- helpers

  function removeBadges() {
    try {
      document.querySelectorAll('.' + BADGE_CLASS).forEach((el) => el.remove());
      hideTooltip();
    } catch (e) {
      /* silent */
    }
  }

  // --------------------------------------------------------------- tooltip
  // The Maps side panel clips overflowing children, so a CSS-only tooltip
  // inside the badge gets cut off. Instead we keep one fixed-position tooltip
  // element on document.body and place it next to the badge on demand.

  let tooltipEl = null;

  function hideTooltip() {
    if (tooltipEl) {
      tooltipEl.remove();
      tooltipEl = null;
    }
  }

  function showTooltip(badge) {
    try {
      hideTooltip();
      const text = badge.getAttribute('data-rr-tooltip');
      if (!text) return;
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'realreview-tooltip';
      tooltipEl.textContent = text;
      document.body.appendChild(tooltipEl);

      const rect = badge.getBoundingClientRect();
      const pad = 8;
      const w = tooltipEl.offsetWidth;
      const h = tooltipEl.offsetHeight;
      let left = rect.left;
      if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
      if (left < pad) left = pad;
      let top = rect.bottom + pad;
      if (top + h > window.innerHeight - pad) top = rect.top - h - pad;
      tooltipEl.style.left = left + 'px';
      tooltipEl.style.top = top + 'px';
    } catch (e) {
      hideTooltip();
    }
  }

  document.addEventListener('scroll', hideTooltip, { capture: true, passive: true });

  /** Stable-ish identifier for the currently open place (URL slug or title). */
  function placeKey() {
    try {
      const m = location.href.match(/\/maps\/place\/([^/@?]+)/);
      if (m) return decodeURIComponent(m[1]);
    } catch (e) {
      /* silent */
    }
    return document.title || '';
  }

  /**
   * Finds the defamation banner. Cheap first pass: XPath text search for the
   * language-independent keywords; then climb a few ancestors until the full
   * banner phrase plus its count range is present in textContent.
   *
   * Returns { el, text, range } when the banner and its range parse, or
   * { el, text, range: null } when the banner phrase is present but the range
   * could not be parsed (so callers never mistake it for a clean profile),
   * or null when no banner exists at all.
   */
  function findBanner() {
    let unparsed = null;
    for (const keyword of CFG.BANNER_KEYWORDS) {
      let snapshot;
      try {
        snapshot = document.evaluate(
          '//*[text()[contains(., "' + keyword + '")]]',
          document.body,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null
        );
      } catch (e) {
        continue;
      }
      for (let i = 0; i < snapshot.snapshotLength; i++) {
        let el = snapshot.snapshotItem(i);
        if (!el || !el.closest) continue;
        // Ignore our own badge and tooltip — their text mentions the keywords.
        if (el.closest('.' + BADGE_CLASS) || el.closest('.realreview-tooltip')) continue;
        for (let up = 0; el && up < 6; up++, el = el.parentElement) {
          const text = (el.textContent || '').replace(/\s+/g, ' ');
          if (!P.matchBanner(text)) continue;
          const range = P.parseRemovalRange(text, settings.worstCaseMax);
          if (range) return { el, text, range };
          if (!unparsed) unparsed = { el, text, range: null };
        }
      }
    }
    return unparsed;
  }

  /** True if the element is inside, or contains, the banner element. */
  function overlapsBanner(el, bannerEl) {
    if (!bannerEl) return false;
    try {
      return el.contains(bannerEl) || bannerEl.contains(el);
    } catch (e) {
      return false;
    }
  }

  /**
   * Looks for the big header rating number ("4,6"-style leaf) near an
   * element: within 5 ancestors and at most ~160px vertical distance, so a
   * count inside the reviews list can't borrow the header's rating.
   * Returns { rating, container } or null.
   */
  function findRatingNear(fromEl) {
    try {
      const fromTop = fromEl.getBoundingClientRect().top;
      let ancestor = fromEl;
      for (let up = 0; ancestor && up < 5; up++, ancestor = ancestor.parentElement) {
        for (const el of ancestor.querySelectorAll('span, div')) {
          if (el.childElementCount !== 0 || el.classList.contains(BADGE_CLASS)) continue;
          const text = (el.textContent || '').trim();
          if (text.length > 5 || !CFG.RATING_TEXT.test(text)) continue;
          const parsed = P.parseLocalizedRating(text);
          if (parsed === null) continue;
          if (Math.abs(el.getBoundingClientRect().top - fromTop) > 160) continue;
          return { rating: parsed, container: ancestor };
        }
      }
    } catch (e) {
      /* silent */
    }
    return null;
  }

  /**
   * Finds the official rating and total review count in the place panel
   * header, anchored on aria-labels and text patterns only. `bannerEl` may
   * be null (clean profiles without a removal banner).
   * Returns { rating, count, headerEl } or null.
   */
  function findRatingInfo(bannerEl) {
    const main =
      (bannerEl && bannerEl.closest && bannerEl.closest('[role="main"]')) ||
      document.querySelector('[role="main"]') ||
      document.body;

    // 1) Collect total-review-count candidates in document order:
    //    a) aria-label "3.270 Rezensionen" / "3,270 reviews" / "352 Berichte"
    //    b) visible leaf text of the same shapes, or "(3.270)"
    const candidates = [];
    for (const el of main.querySelectorAll('[aria-label]')) {
      if (candidates.length >= 20) break;
      if (el.closest('.' + BADGE_CLASS) || overlapsBanner(el, bannerEl)) continue;
      const label = el.getAttribute('aria-label') || '';
      if (/Diffamierung|defamation/i.test(label)) continue;
      const m = label.match(CFG.REVIEW_COUNT_LABEL);
      if (!m) continue;
      const parsed = P.parseLocalizedCount(m[1]);
      if (parsed) candidates.push({ el, count: parsed });
    }
    for (const el of main.querySelectorAll('span, div')) {
      if (candidates.length >= 20) break;
      if (el.childElementCount !== 0) continue;
      if (el.closest('.' + BADGE_CLASS) || overlapsBanner(el, bannerEl)) continue;
      const text = (el.textContent || '').trim();
      if (!text || text.length > 40) continue;
      const m = text.match(CFG.REVIEW_COUNT_LABEL) || text.match(CFG.REVIEW_COUNT_TEXT);
      if (!m) continue;
      const parsed = P.parseLocalizedCount(m[1]);
      if (parsed) candidates.push({ el, count: parsed });
    }
    if (!candidates.length) {
      debug('review count not found');
      if (DEBUG) {
        const labels = [];
        for (const el of main.querySelectorAll('[aria-label]')) {
          const l = el.getAttribute('aria-label') || '';
          if (/\d/.test(l) && l.length < 70) labels.push(l);
          if (labels.length >= 25) break;
        }
        debug('digit aria-labels:', JSON.stringify(labels));
        const texts = [];
        for (const el of main.querySelectorAll('span, div')) {
          if (el.childElementCount !== 0) continue;
          const t = (el.textContent || '').trim();
          if (t && t.length < 30 && /\d/.test(t)) texts.push(t);
          if (texts.length >= 25) break;
        }
        debug('digit leaf texts:', JSON.stringify(texts));
      }
      return null;
    }

    // 2) Accept the first candidate that has the big header rating number
    //    ("4,6"-style leaf) nearby: within a few ancestors AND vertically
    //    close. Reviewer entries ("2 Rezensionen" under a reviewer's name)
    //    have no such neighbor and are rejected, so the badge can neither
    //    anchor to a review card nor compute with a reviewer's count.
    let countEl = null;
    let count = null;
    let rating = null;
    let ratingContainer = null;
    for (const candidate of candidates) {
      const near = findRatingNear(candidate.el);
      if (near) {
        countEl = candidate.el;
        count = candidate.count;
        rating = near.rating;
        ratingContainer = near.container;
        break;
      }
    }
    // Fallback for layouts whose rating exists only as a star-widget
    // aria-label: use the first (header-most) candidate.
    if (!countEl) {
      for (const el of main.querySelectorAll('[aria-label]')) {
        if (overlapsBanner(el, bannerEl)) continue;
        const m = (el.getAttribute('aria-label') || '').match(CFG.STARS_LABEL);
        if (!m) continue;
        const parsed = P.parseLocalizedRating(m[1]);
        if (parsed !== null) {
          rating = parsed;
          break;
        }
      }
      if (rating === null) {
        debug('rating value not found near any count candidate');
        return null;
      }
      countEl = candidates[0].el;
      count = candidates[0].count;
    }

    // 3) The bar is inserted below the whole header block (histogram + score),
    //    so climb from the rating container until the element spans (nearly)
    //    the full panel width. Anchored on geometry, not class names.
    let headerEl = ratingContainer || countEl;
    try {
      const mainWidth = main.getBoundingClientRect().width || 0;
      for (let up = 0; up < 4; up++) {
        const width = headerEl.getBoundingClientRect().width || 0;
        if (mainWidth && width >= mainWidth * 0.8) break;
        const parent = headerEl.parentElement;
        if (!parent || parent === main || parent === document.body) break;
        headerEl = parent;
      }
    } catch (e) {
      /* keep whatever we have */
    }

    return { rating, count, headerEl };
  }

  // ------------------------------------------------- banner verdict cache
  // The defamation banner only exists in the Reviews tab's DOM — Maps loads
  // it at runtime, so fetching page HTML cannot see it. When the banner isn't
  // in the DOM, we probe: programmatically open the Reviews tab, poll for the
  // banner, cache the verdict per place, and switch back to the user's tab.
  // A neutral "checking…" card is shown while the probe runs.

  const bannerCache = new Map(); // placeKey -> {status: 'pending'|'flagged'|'clean'|'unknown', range?, ts}
  // Matches the tab's visible text ("Reviews") and its aria-label, which Maps
  // phrases as e.g. "Reviews for Wagners Juicery" / "Rezensionen für …" —
  // hence prefix matching, not full-string equality.
  const REVIEWS_TAB_LABEL = /^\s*(Reviews|Rezensionen)\b/i;
  const PROBE_TIMEOUT_MS = 5000; // hard ceiling only — verdicts normally come from content signals
  const PROBE_POLL_MS = 200;
  const CLEAN_GRACE_MS = 400; // reviews list may render a beat before the disclosure header
  let probeRunning = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function findTabButton(labelRe) {
    for (const el of document.querySelectorAll('[role="tab"], [role="tablist"] button')) {
      if (el.closest('.' + BADGE_CLASS)) continue;
      const text = (el.textContent || '').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();
      if (labelRe.test(text) || labelRe.test(aria)) return el;
    }
    return null;
  }

  function selectedTabButton() {
    return document.querySelector('[role="tab"][aria-selected="true"]');
  }

  /**
   * True once several individual review entries have rendered. Regular
   * places use star widgets ("5 stars" / "1 Stern"); hotels aggregate
   * external reviews with numeric score chips ("4/5", "Rated 4.0 out of 5"),
   * which also appear as visible leaf text — check both shapes.
   */
  function reviewsContentLoaded() {
    let found = 0;
    for (const el of document.querySelectorAll('[aria-label]')) {
      if (el.closest('.' + BADGE_CLASS)) continue;
      const label = el.getAttribute('aria-label') || '';
      if (CFG.REVIEW_ITEM_STARS.test(label) || CFG.REVIEW_ITEM_SCORE.test(label)) {
        if (++found >= 3) return true;
      }
    }
    for (const el of document.querySelectorAll('span, div')) {
      if (el.childElementCount !== 0 || el.closest('.' + BADGE_CLASS)) continue;
      const text = (el.textContent || '').trim();
      if (!text || text.length > 30) continue;
      if (CFG.REVIEW_ITEM_SCORE.test(text)) {
        if (++found >= 3) return true;
      }
    }
    return false;
  }

  /**
   * Polls the DOM until a verdict emerges:
   * - banner found → flagged (or unknown if its range doesn't parse)
   * - reviews list rendered + short grace period without a banner → clean
   * - user navigated to another place → aborted
   * - timeout without the list ever rendering → unknown (never guess clean)
   */
  async function pollForBanner(key) {
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    let contentLoadedAt = 0;
    while (Date.now() < deadline) {
      if (placeKey() !== key) return { status: 'aborted' };
      const banner = findBanner();
      if (banner) {
        return banner.range
          ? { status: 'flagged', range: banner.range }
          : { status: 'unknown' };
      }
      if (reviewsContentLoaded()) {
        if (!contentLoadedAt) contentLoadedAt = Date.now();
        else if (Date.now() - contentLoadedAt >= CLEAN_GRACE_MS) return { status: 'clean' };
      }
      await sleep(PROBE_POLL_MS);
    }
    return contentLoadedAt ? { status: 'clean' } : { status: 'unknown' };
  }

  async function probeReviewsTab(key) {
    if (probeRunning) return;
    probeRunning = true;
    let verdict = { status: 'unknown' };
    try {
      const reviewsTab = findTabButton(REVIEWS_TAB_LABEL);
      const originalTab = selectedTabButton();

      if (!reviewsTab) {
        debug('probe: reviews tab not found');
      } else if (reviewsTab === originalTab) {
        // Already on the Reviews tab — just wait for its content.
        verdict = await pollForBanner(key);
      } else {
        debug('probe: opening reviews tab');
        reviewsTab.click();
        verdict = await pollForBanner(key);
        // Switch back — but only if the user didn't navigate meanwhile.
        const nowSelected = selectedTabButton();
        if (
          verdict.status !== 'aborted' &&
          originalTab &&
          originalTab.isConnected &&
          (nowSelected === reviewsTab || nowSelected === null)
        ) {
          originalTab.click();
        }
      }
    } catch (e) {
      /* keep unknown */
    }
    // An aborted probe (or one whose place changed under it) belongs to
    // nobody — discard it so the new place gets its own probe immediately.
    if (verdict.status === 'aborted' || placeKey() !== key) {
      debug('probe aborted: navigated away from', key);
      bannerCache.delete(key);
    } else {
      verdict.ts = Date.now();
      debug('probe verdict for', key, verdict.status);
      if (bannerCache.size > 200) bannerCache.clear();
      bannerCache.set(key, verdict);
    }
    probeRunning = false;
    scan();
  }

  /**
   * Sizes the badge to the panel's text column: same left/right inset as the
   * place title (h1), centered. The insertion container's own padding varies
   * between Maps layouts, so this is measured, not hardcoded. Falls back to
   * the CSS defaults when the measurements look implausible.
   */
  function alignBadgeWidth(badge) {
    try {
      const main = badge.closest('[role="main"]');
      if (!main) return;
      const title = main.querySelector('h1');
      if (!title) return;
      const mainRect = main.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const inset = titleRect.left - mainRect.left;
      if (!(inset > 0) || inset > mainRect.width / 3) return;
      let width = Math.round(mainRect.width - 2 * inset);
      const parentWidth = badge.parentElement ? badge.parentElement.clientWidth : 0;
      if (parentWidth) width = Math.min(width, parentWidth);
      if (width < 200) return;
      badge.style.boxSizing = 'border-box';
      badge.style.width = width + 'px';
      badge.style.marginLeft = 'auto';
      badge.style.marginRight = 'auto';
    } catch (e) {
      /* keep CSS defaults */
    }
  }

  /** Localized display of the removed-review range ("2 to 5", "1", "over 250"). */
  function formatRemovedRange(range) {
    if (range.openEnded) return translator.t('rangeOver', [String(range.base)]);
    if (range.min === range.max) return String(range.min);
    const sep = translator.lang === 'de' ? ' bis ' : ' to ';
    return range.min + sep + range.max;
  }

  /** Localized unit phrase for the assumed star value: "1 star", "1,5 Sterne". */
  function formatAssumedStars(value, lang) {
    const s = Number.isInteger(value) ? String(value) : value.toFixed(1);
    const num = lang === 'de' ? s.replace('.', ',') : s;
    if (lang === 'de') return value === 1 ? '1 Stern' : num + ' Sterne';
    return value === 1 ? '1 star' : num + ' stars';
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * Star-and-shield icon (adapted from the design mockup): a rounded 5-point
   * star with a shield-check overlapping its lower right. The separation
   * between the two is a mask that cuts a slightly-enlarged shield silhouette
   * out of the star, so the badge gradient shows through as a clean gap —
   * no dark rim, no filters. viewBox 0 0 128 128.
   */
  const ICON_STAR =
    'M64 24.6 L74.1 47.3 Q75.1 49.7 77.6 50.2 L102.1 54.3 Q106 55 104 58.5 ' +
    'L86.6 76.8 Q84.8 78.8 85.4 81.4 L90.6 106.2 Q91.2 109.1 87.3 107.3 ' +
    'L65.4 96.5 Q64 95.8 62.6 96.5 L40.7 107.3 Q36.8 109.1 37.4 106.2 ' +
    'L42.6 81.4 Q43.2 78.8 41.4 76.8 L24 58.5 Q22 55 25.9 54.3 ' +
    'L50.4 50.2 Q52.9 49.7 53.9 47.3 Z';
  const ICON_SHIELD =
    'M94 66 C100.5 70.6 108.1 73.6 116.5 74.6 C118.4 74.8 119.6 76.3 119.6 78.2 ' +
    'L119.6 96 C119.6 111.6 109.6 122.4 94.6 127.4 Q94 127.6 93.4 127.4 ' +
    'C78.4 122.4 68.4 111.6 68.4 96 L68.4 78.2 C68.4 76.3 69.6 74.8 71.5 74.6 ' +
    'C79.9 73.6 87.5 70.6 94 66 Z';
  const ICON_CHECK = 'M82 96.5 L91 105.5 L107 85.5';
  const ICON_MASK_ID = 'realreview-star-mask';

  function svgNode(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    return el;
  }

  function buildIconSvg() {
    const svg = svgNode('svg', {
      viewBox: '0 0 128 128',
      width: '48',
      height: '48',
      'aria-hidden': 'true',
    });

    // Mask: white keeps the star, the black stroked shield silhouette carves
    // a uniform transparent gap around the shield.
    const defs = svgNode('defs', {});
    const mask = svgNode('mask', {
      id: ICON_MASK_ID,
      maskUnits: 'userSpaceOnUse',
      x: '-20',
      y: '-20',
      width: '168',
      height: '168',
    });
    mask.appendChild(
      svgNode('rect', { x: '-20', y: '-20', width: '168', height: '168', fill: '#fff' })
    );
    mask.appendChild(
      svgNode('path', { d: ICON_SHIELD, fill: '#000', stroke: '#000', 'stroke-width': '12' })
    );
    defs.appendChild(mask);
    svg.appendChild(defs);

    // The composed paths lean right/down inside the viewBox; this outer
    // shift optically centers the star+shield cluster in the icon box.
    const root = svgNode('g', { transform: 'translate(-6,-7)' });

    const starGroup = svgNode('g', { mask: 'url(#' + ICON_MASK_ID + ')' });
    starGroup.appendChild(
      // Shifted up-left so the star's right arm clears the shield's gap band
      // (avoids a detached sliver where the mask would cross the arm).
      svgNode('path', { d: ICON_STAR, fill: '#FFFFFF', transform: 'translate(-2,-8.85)' })
    );
    root.appendChild(starGroup);

    root.appendChild(svgNode('path', { d: ICON_SHIELD, fill: '#FFFFFF' }));
    root.appendChild(
      svgNode('path', {
        d: ICON_CHECK,
        fill: 'none',
        stroke: '#0B4A34',
        'stroke-width': '7',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      })
    );
    svg.appendChild(root);
    return svg;
  }

  function injectBadge(anchorEl, key, scoreText, caption, tooltip, fillPercent, label) {
    const badge = document.createElement('div');
    badge.className = BADGE_CLASS;
    badge.dataset.rrKey = key;
    badge.dataset.rrKind = 'adjusted';
    badge.dataset.rrLabel = label || scoreText + '|' + caption;
    badge.setAttribute('tabindex', '0');
    badge.setAttribute('role', 'note');
    badge.setAttribute('data-rr-tooltip', tooltip);
    badge.setAttribute('aria-label', tooltip);

    // Big star with a small shield-check overlapping its lower right.
    const icon = document.createElement('span');
    icon.className = 'rr-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.appendChild(buildIconSvg());
    badge.appendChild(icon);

    const divider = document.createElement('span');
    divider.className = 'rr-divider';
    badge.appendChild(divider);

    // Middle section: fractional star row with the caption micro-label
    // underneath. The score sits to the right, next to the info symbol.
    const main = document.createElement('span');
    main.className = 'rr-main';

    const stars = document.createElement('span');
    stars.className = 'rr-stars';
    stars.setAttribute('aria-hidden', 'true');
    const starsBg = document.createElement('span');
    starsBg.className = 'rr-stars-bg';
    starsBg.textContent = '★★★★★';
    const starsFill = document.createElement('span');
    starsFill.className = 'rr-stars-fill';
    starsFill.textContent = '★★★★★';
    starsFill.style.width = fillPercent + '%';
    stars.appendChild(starsBg);
    stars.appendChild(starsFill);
    main.appendChild(stars);

    const captionEl = document.createElement('span');
    captionEl.className = 'rr-caption';
    captionEl.textContent = caption;
    main.appendChild(captionEl);
    badge.appendChild(main);

    const score = document.createElement('span');
    score.className = 'rr-score';
    score.textContent = scoreText;
    badge.appendChild(score);

    const info = document.createElement('span');
    info.className = 'rr-info';
    info.setAttribute('aria-hidden', 'true');
    info.textContent = 'i';
    badge.appendChild(info);

    badge.addEventListener('mouseenter', () => showTooltip(badge));
    badge.addEventListener('mouseleave', hideTooltip);
    badge.addEventListener('focus', () => showTooltip(badge));
    badge.addEventListener('blur', hideTooltip);

    anchorEl.insertAdjacentElement('afterend', badge);
    alignBadgeWidth(badge);
  }

  /** Shield-with-check only, for the clean-profile card. */
  function buildCleanIconSvg() {
    const svg = svgNode('svg', {
      viewBox: '64 62 60 70',
      width: '30',
      height: '35',
      'aria-hidden': 'true',
    });
    svg.appendChild(svgNode('path', { d: ICON_SHIELD, fill: '#0B4A34' }));
    svg.appendChild(
      svgNode('path', {
        d: ICON_CHECK,
        fill: 'none',
        stroke: '#FFFFFF',
        'stroke-width': '7',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      })
    );
    return svg;
  }

  /** Light "nothing to adjust" card for profiles without reported removals. */
  function injectCleanBadge(anchorEl, key, title, captionText) {
    const badge = document.createElement('div');
    badge.className = BADGE_CLASS + ' rr-clean';
    badge.dataset.rrKey = key;
    badge.dataset.rrKind = 'clean';
    badge.dataset.rrLabel = title + '|' + captionText;
    badge.setAttribute('role', 'note');
    badge.setAttribute('aria-label', title + ' — ' + captionText);

    const icon = document.createElement('span');
    icon.className = 'rr-clean-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.appendChild(buildCleanIconSvg());
    badge.appendChild(icon);

    const text = document.createElement('span');
    text.className = 'rr-clean-text';
    const titleEl = document.createElement('span');
    titleEl.className = 'rr-clean-title';
    titleEl.textContent = title;
    const captionEl = document.createElement('span');
    captionEl.className = 'rr-clean-caption';
    captionEl.textContent = captionText;
    text.appendChild(titleEl);
    text.appendChild(captionEl);
    badge.appendChild(text);

    anchorEl.insertAdjacentElement('afterend', badge);
    alignBadgeWidth(badge);
  }

  // ------------------------------------------------------------------ scan

  function scan() {
    try {
      if (!settings.enabled || !translator) {
        removeBadges();
        return;
      }

      // Only act on an open place panel — search result lists also contain
      // rating-like text and must not receive a badge.
      if (!/\/maps\/place\//.test(location.href)) {
        removeBadges();
        return;
      }

      const key = placeKey();
      const domBanner = findBanner();
      const info = findRatingInfo(domBanner ? domBanner.el : null);
      if (!info) {
        debug('rating/count not found in panel header');
        removeBadges();
        return;
      }

      // The banner only exists in the Reviews tab's DOM. When it's absent,
      // fall back to the fetched per-place verdict — never treat "banner not
      // in DOM" as "clean".
      let flagged = false;
      let range = null;
      if (domBanner) {
        flagged = true;
        range = domBanner.range;
        bannerCache.set(key, range ? { status: 'flagged', range } : { status: 'unknown' });
      } else {
        const cached = bannerCache.get(key);
        if (!cached) {
          bannerCache.set(key, { status: 'pending', ts: Date.now() });
          renderCheckingCard(info, key);
          probeReviewsTab(key);
          return;
        }
        if (cached.status === 'pending') {
          renderCheckingCard(info, key);
          // A probe for another place may have blocked this one — restart
          // (probeRunning guarantees at most one probe at a time).
          if (!probeRunning) probeReviewsTab(key);
          return;
        }
        if (cached.status === 'flagged') {
          flagged = true;
          range = cached.range || null;
        } else if (cached.status !== 'clean') {
          // unknown (tabs not found / banner unparseable): show nothing.
          // No automatic retry — the probe visibly flips tabs, so it only
          // re-runs on navigation or settings changes.
          removeBadges();
          return;
        }
      }

      if (!flagged) {
        renderCleanCard(info, key);
        return;
      }
      if (!range) {
        debug(
          'banner present but range not parseable:',
          domBanner && domBanner.text ? JSON.stringify(domBanner.text.slice(0, 200)) : '(cached verdict)'
        );
        removeBadges();
        return;
      }
      renderAdjustedBadge(info, key, range);
    } catch (e) {
      // Never break the page.
    }
  }

  function renderCheckingCard(info, key) {
    const text = translator.t('checkingText');
    const existing = document.querySelector('.' + BADGE_CLASS);
    if (
      existing &&
      existing.isConnected &&
      existing.dataset.rrKey === key &&
      existing.dataset.rrKind === 'checking'
    ) {
      return;
    }
    removeBadges();
    const badge = document.createElement('div');
    badge.className = BADGE_CLASS + ' rr-checking';
    badge.dataset.rrKey = key;
    badge.dataset.rrKind = 'checking';
    badge.setAttribute('role', 'status');
    const dot = document.createElement('span');
    dot.className = 'rr-checking-dot';
    dot.setAttribute('aria-hidden', 'true');
    badge.appendChild(dot);
    const textEl = document.createElement('span');
    textEl.className = 'rr-checking-text';
    textEl.textContent = text;
    badge.appendChild(textEl);
    info.headerEl.insertAdjacentElement('afterend', badge);
    alignBadgeWidth(badge);
  }

  function renderCleanCard(info, key) {
    const title = translator.t('cleanTitle');
    const captionText = translator.t('cleanCaption');
    const existing = document.querySelector('.' + BADGE_CLASS);
    if (
      existing &&
      existing.isConnected &&
      existing.dataset.rrKey === key &&
      existing.dataset.rrKind === 'clean' &&
      existing.dataset.rrLabel === title + '|' + captionText
    ) {
      return;
    }
    removeBadges();
    injectCleanBadge(info.headerEl, key, title, captionText);
  }

  function renderAdjustedBadge(info, key, range) {
    // Star value each removed review is assumed to have had (1 = harshest).
    const starValue = Math.min(2.5, Math.max(1, parseFloat(settings.removedStarValue) || 1));
    const corrected = P.correctedRange(info.rating, info.count, range, starValue);
    if (!corrected) {
      removeBadges();
      return;
    }

    const lang = translator.lang;
    // Calculation mode: 'worst' uses the top of the removal range
    // (corrected.low), 'conservative' the bottom (corrected.high).
    const mode = settings.calcMode === 'conservative' ? 'conservative' : 'worst';
    const value = mode === 'worst' ? corrected.low : corrected.high;
    const scoreText = P.formatRating(value, lang);
    const caption = translator.t('badgeCaption');
    const tooltip = translator.t(
      mode === 'worst' ? 'badgeTooltipWorst' : 'badgeTooltipConservative',
      [
        formatRemovedRange(range),
        scoreText,
        P.formatRating(info.rating, lang),
        formatAssumedStars(starValue, lang),
      ]
    );
    const fillPercent = Math.max(0, Math.min(100, (value / 5) * 100));
    const label = scoreText + '|' + caption + '|' + mode + '|' + starValue;

    // Idempotence: keep an existing, still-attached, up-to-date badge.
    const existing = document.querySelector('.' + BADGE_CLASS);
    if (
      existing &&
      existing.isConnected &&
      existing.dataset.rrKey === key &&
      existing.dataset.rrKind === 'adjusted' &&
      existing.dataset.rrLabel === label
    ) {
      return;
    }

    removeBadges();
    injectBadge(info.headerEl, key, scoreText, caption, tooltip, fillPercent, label);
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, SCAN_DEBOUNCE_MS);
  }

  // ------------------------------------------------------------------ init

  async function applySettings(next) {
    settings = Object.assign({}, CFG.DEFAULT_SETTINGS, next);
    try {
      translator = await RR.i18n.createTranslator(settings.language);
    } catch (e) {
      translator = null;
    }
    // Cached verdicts embed the parsed range (which depends on worstCaseMax),
    // so settings changes invalidate them.
    bannerCache.clear();
    removeBadges();
    scan();
  }

  chrome.storage.sync.get(CFG.DEFAULT_SETTINGS, (stored) => {
    applySettings(stored).then(() => {
      const observer = new MutationObserver(scheduleScan);
      try {
        observer.observe(document.body, { childList: true, subtree: true });
      } catch (e) {
        /* silent */
      }
      // Safety net for renders the observer debounce might have coalesced away
      // and for URL changes that don't mutate observed nodes. Also re-measures
      // the badge width so panel resizes correct themselves.
      setInterval(() => {
        if (document.hidden) return;
        scan();
        const badge = document.querySelector('.' + BADGE_CLASS);
        if (badge) alignBadgeWidth(badge);
      }, RESCAN_INTERVAL_MS);
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const next = Object.assign({}, settings);
    for (const [k, v] of Object.entries(changes)) next[k] = v.newValue;
    applySettings(next);
  });
})();
