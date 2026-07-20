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

  // Off in production. To trace detection in the console, flip to true and
  // reload the extension. The e2e harness enables it by defining
  // globalThis.__rrDebug before injecting this script (its assertions anchor
  // on the log lines), so shipping builds stay silent without breaking tests.
  const DEBUG = globalThis.__rrDebug === true;
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

  /**
   * True when the element is actually rendered on screen. Maps keeps previous
   * venues' panels hidden in the DOM for back-navigation; every detector must
   * ignore those, or stale tabs/banners/counts leak into the current venue.
   */
  function isElementVisible(el) {
    try {
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    } catch (e) {
      return false;
    }
  }

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

  /** Letters and digits only, lowercased — immune to punctuation drift
   *  between URL slugs and displayed titles (apostrophes, commas, spacing). */
  function normalizeForMatch(s) {
    return (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  }

  /**
   * Normalizes a place key for panel-title comparison. Returns null when the
   * key isn't a comparable venue name (coordinates, plus codes, very short
   * slugs) — the panel-identity guard is not applicable then.
   */
  function normalizedKey(key) {
    let decoded = key || '';
    try {
      decoded = decodeURIComponent(decoded);
    } catch (e) {
      /* use as-is */
    }
    decoded = decoded.replace(/\+/g, ' ').trim();
    if (!decoded || /°/.test(decoded)) return null; // coordinate-style key
    const want = normalizeForMatch(decoded);
    return want.length < 4 ? null : want; // too short to compare meaningfully
  }

  /**
   * The visible place panel whose title matches the given place key, or null.
   * Maps keeps previous venues' panels in the DOM (sometimes still visible
   * during SPA transitions); every detector must run inside the panel that
   * belongs to the current place, or stale tabs/banners/counts leak in.
   */
  function findCurrentMain(key) {
    const want = normalizedKey(key);
    if (!want) return null;
    const matches = (raw) => {
      const got = normalizeForMatch(raw);
      return !!got && (got === want || got.includes(want) || want.includes(got));
    };
    try {
      // Primary anchor: the place panel's role="main" container carries the
      // venue name as its aria-label. (Some Maps variants render titles with
      // no h1/heading semantics at all, so this must come first.)
      for (const main of document.querySelectorAll('[role="main"]')) {
        if (!isElementVisible(main)) continue;
        if (matches(main.getAttribute('aria-label'))) return main;
      }
      // Fallback: a visible title heading, for layouts that have one.
      for (const h1 of document.querySelectorAll('[role="main"] h1')) {
        if (!isElementVisible(h1)) continue;
        if (matches(h1.textContent)) return h1.closest('[role="main"]');
      }
    } catch (e) {
      return null;
    }
    // No visible matching title: still transitioning (or a stale panel).
    return null;
  }

  /**
   * True when a visible place panel's title matches the given place key.
   * Opts out (true) for keys that aren't venue names.
   */
  function panelMatchesKey(key) {
    if (normalizedKey(key) === null) return true; // guard not applicable
    return !!findCurrentMain(key);
  }

  /**
   * The element all detection runs inside: the key-matching visible panel
   * when one exists, otherwise the first VISIBLE panel (hidden back-nav
   * panels must never win), otherwise the whole body.
   */
  function detectionRoot(key) {
    const matching = findCurrentMain(key);
    if (matching) return matching;
    try {
      for (const el of document.querySelectorAll('[role="main"]')) {
        if (isElementVisible(el)) return el;
      }
    } catch (e) {
      /* fall through */
    }
    return document.body;
  }

  /** Debug aid: where does this layout put the venue title? */
  function dumpHeadings() {
    try {
      const mains = [];
      for (const el of document.querySelectorAll('[role="main"]')) {
        if (mains.length >= 6) break;
        mains.push({
          label: (el.getAttribute('aria-label') || '').slice(0, 60),
          visible: isElementVisible(el),
        });
      }
      debug('mains:', JSON.stringify(mains));
      const out = [];
      for (const el of document.querySelectorAll('h1, [role="heading"]')) {
        if (out.length >= 10) break;
        out.push({
          text: (el.textContent || '').trim().slice(0, 60),
          visible: isElementVisible(el),
          inMain: !!el.closest('[role="main"]'),
        });
      }
      debug('headings:', JSON.stringify(out));
    } catch (e) {
      /* silent */
    }
  }

  // Transition guard bookkeeping: a panel/key mismatch is only trusted for a
  // short window. Real SPA transitions resolve within a couple of seconds; a
  // mismatch that persists longer means the guard misjudged the layout, and
  // detection proceeds without it rather than going permanently silent.
  const PANEL_MISMATCH_GRACE_MS = 2500;
  let panelMismatchKey = null;
  let panelMismatchSince = 0;

  /**
   * Finds the defamation banner. Cheap first pass: XPath text search for the
   * language-independent keywords; then climb a few ancestors until the full
   * banner phrase plus its count range is present in textContent.
   *
   * Returns { el, text, range } when the banner and its range parse, or
   * { el, text, range: null } when the banner phrase is present but the range
   * could not be parsed (so callers never mistake it for a clean profile),
   * or null when no banner exists at all.
   *
   * `root` scopes the search to the current place's panel so a stale
   * still-visible panel's banner can't be attributed to another venue.
   */
  function findBanner(root) {
    let unparsed = null;
    for (const keyword of CFG.BANNER_KEYWORDS) {
      let snapshot;
      try {
        snapshot = document.evaluate(
          './/*[text()[contains(., "' + keyword + '")]]',
          root || document.body,
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
        // Ignore our own badge and tooltip — their text mentions the keywords —
        // and anything in a hidden (stale) panel.
        if (el.closest('.' + BADGE_CLASS) || el.closest('.realreview-tooltip')) continue;
        if (!isElementVisible(el)) continue;
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
          if (parsed === null || !isElementVisible(el)) continue;
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
   * Returns { rating, count, headerEl } or null. `root` is the current
   * place's panel (see detectionRoot) — never the first [role="main"] in
   * the DOM, which can be a hidden stale panel.
   */
  function findRatingInfo(bannerEl, root) {
    const main =
      (bannerEl && bannerEl.closest && bannerEl.closest('[role="main"]')) ||
      root ||
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
      if (parsed && isElementVisible(el)) candidates.push({ el, count: parsed });
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
      if (parsed && isElementVisible(el)) candidates.push({ el, count: parsed });
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
  const PROBE_TIMEOUT_MS = 6000; // base deadline — extends when content arrives late
  const PROBE_HARD_TIMEOUT_MS = 12000; // absolute ceiling regardless of extensions
  const PROBE_POLL_MS = 200;
  // The reviews list — and even the banner region's marker line ("Reviews
  // aren't verified") — can render well before the disclosure banner itself
  // (observed: banner more than 1s after the marker). A clean verdict
  // therefore always waits a full banner-arrival grace after the surface
  // loads; the marker is only a "surface has rendered" signal, never proof
  // that no banner is coming.
  const CLEAN_GRACE_MS = 1800;
  // A failed switch-back (all in-probe retries swallowed) keeps retrying in
  // the background for a bounded window, driven by the regular scan ticks.
  const RETURN_RECOVERY_MS = 10000;
  const RETURN_RETRY_GAP_MS = 800;
  // An 'unknown' verdict caused by transient click-swallowing (the probe
  // never reached the Reviews surface) gets one silent re-probe after a
  // cooldown — SPA transition storms settle within a few seconds.
  const UNKNOWN_RETRY_COOLDOWN_MS = 4000;
  let probeRunning = false;
  // Bumped on every settings change: a running probe compares its own
  // generation against this and cancels itself instead of continuing to
  // flip tabs under settings (or an extension state) that no longer apply.
  let probeGeneration = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ------------------------------------------------- switch-back recovery
  // When every in-probe switch-back attempt is swallowed, the return to the
  // user's tab is handed to this bounded background recovery instead of
  // stranding them on Reviews. Any trusted user input cancels it — a user
  // who meanwhile started reading reviews is never yanked away. (Our own
  // programmatic clicks are untrusted and can't cancel it.)

  let pendingReturn = null; // { key, generation, resolveBack, until, lastAttempt, registeredAt }
  let lastUserInputAt = 0;

  function noteUserInput(e) {
    if (!e.isTrusted) return;
    lastUserInputAt = Date.now();
    if (pendingReturn) {
      debug('recovery: user input, cancelling pending switch-back');
      pendingReturn = null;
    }
  }
  document.addEventListener('pointerdown', noteUserInput, { capture: true, passive: true });
  document.addEventListener('keydown', noteUserInput, { capture: true, passive: true });
  document.addEventListener('wheel', noteUserInput, { capture: true, passive: true });

  /** Called from scan(): retries a registered switch-back until it takes
   *  effect, the user acts, the place/settings change, or the window ends. */
  function tryPendingReturn() {
    if (!pendingReturn) return;
    const pr = pendingReturn;
    if (
      pr.generation !== probeGeneration ||
      placeKey() !== pr.key ||
      Date.now() > pr.until ||
      lastUserInputAt > pr.registeredAt
    ) {
      pendingReturn = null;
      return;
    }
    if (!reviewsTabSelected(detectionRoot(pr.key))) {
      pendingReturn = null; // switch-back took effect (or the user moved on)
      return;
    }
    // Self-driving: as long as a return is pending, keep a scan scheduled so
    // recovery isn't at the mercy of the slow rescan interval.
    scheduleScan();
    if (probeRunning) return;
    if (Date.now() - pr.lastAttempt < RETURN_RETRY_GAP_MS) return;
    pr.lastAttempt = Date.now();
    const back = pr.resolveBack();
    if (back) {
      debug('recovery: retrying switch-back');
      back.click();
    }
  }

  /**
   * Tab lookups are scoped to the current place's panel (`root`) so a stale
   * panel's tablist can't be clicked. Falls back to a document-wide search
   * only when the scoped search finds nothing (layouts whose tablist lives
   * outside the panel).
   */
  function findTabButton(labelRe, root) {
    const scopes = root && root !== document.body ? [root, document] : [document];
    for (const scope of scopes) {
      for (const el of scope.querySelectorAll('[role="tab"], [role="tablist"] button')) {
        if (el.closest('.' + BADGE_CLASS) || !isElementVisible(el)) continue;
        const text = (el.textContent || '').trim();
        const aria = (el.getAttribute('aria-label') || '').trim();
        if (labelRe.test(text) || labelRe.test(aria)) return el;
      }
    }
    return null;
  }

  function selectedTabButton(root) {
    const scopes = root && root !== document.body ? [root, document] : [document];
    for (const scope of scopes) {
      for (const el of scope.querySelectorAll('[role="tab"][aria-selected="true"]')) {
        if (isElementVisible(el)) return el;
      }
    }
    return null;
  }

  /** True while the Reviews tab is verifiably the selected tab. */
  function reviewsTabSelected(root) {
    const sel = selectedTabButton(root);
    if (!sel) return false;
    const text = (sel.textContent || '').trim();
    const aria = (sel.getAttribute('aria-label') || '').trim();
    return REVIEWS_TAB_LABEL.test(text) || REVIEWS_TAB_LABEL.test(aria);
  }

  /**
   * True once several individual review entries have rendered. Regular
   * places use star widgets ("5 stars" / "1 Stern"); hotels aggregate
   * external reviews with numeric score chips ("4/5", "Rated 4.0 out of 5"),
   * which also appear as visible leaf text — check both shapes.
   */
  function reviewsContentLoaded(root) {
    root = root || document.body;
    let found = 0;
    for (const el of root.querySelectorAll('[aria-label]')) {
      if (el.closest('.' + BADGE_CLASS)) continue;
      const label = el.getAttribute('aria-label') || '';
      if (CFG.REVIEW_ITEM_STARS.test(label) || CFG.REVIEW_ITEM_SCORE.test(label)) {
        if (isElementVisible(el) && ++found >= 2) return true;
      }
    }
    for (const el of root.querySelectorAll('span, div')) {
      if (el.childElementCount !== 0 || el.closest('.' + BADGE_CLASS)) continue;
      const text = (el.textContent || '').trim();
      if (!text || text.length > 30) continue;
      if (CFG.REVIEW_ITEM_SCORE.test(text)) {
        if (isElementVisible(el) && ++found >= 2) return true;
      }
    }
    return false;
  }

  /** True once the "Reviews aren't verified" header line has rendered —
   *  it lives in the same block as the disclosure banner. */
  function reviewsMetaVisible(root) {
    for (const keyword of CFG.REVIEWS_META_KEYWORDS) {
      let snapshot;
      try {
        snapshot = document.evaluate(
          './/*[text()[contains(., "' + keyword + '")]]',
          root || document.body,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null
        );
      } catch (e) {
        continue;
      }
      const limit = Math.min(snapshot.snapshotLength, 10);
      for (let i = 0; i < limit; i++) {
        const el = snapshot.snapshotItem(i);
        if (el && isElementVisible(el) && CFG.REVIEWS_META_TEXT.test(el.textContent || '')) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Polls the DOM until a verdict emerges:
   * - banner found → flagged (or unknown if its range doesn't parse)
   * - Reviews tab VERIFIABLY SELECTED + surface rendered (entries or the
   *   banner-region marker) + full banner-arrival grace → clean
   * - user navigated to another place → aborted
   * - timeout without a confident signal → unknown (never guess clean)
   *
   * The tab-selected requirement is load-bearing: during page transitions a
   * tab click can be swallowed, and the Overview's own review snippets carry
   * "5 stars" labels that would otherwise satisfy the content signal on the
   * wrong surface. If the tab isn't selected, the click is retried a few
   * times and all clean-signals are discarded.
   */
  async function pollForBanner(key, probeState) {
    const startedAt = Date.now();
    const hardDeadline = startedAt + PROBE_HARD_TIMEOUT_MS;
    let deadline = startedAt + PROBE_TIMEOUT_MS;
    let contentLoadedAt = 0;
    let panelMismatchAt = 0;
    while (Date.now() < deadline) {
      if (probeState.generation !== probeGeneration) return { status: 'cancelled' };
      if (placeKey() !== key) return { status: 'aborted' };
      // A still-visible previous panel must not feed signals for this venue —
      // but only within the grace window; a persistent mismatch means the
      // guard misjudged the layout and the probe proceeds without it.
      if (!panelMatchesKey(key)) {
        if (!panelMismatchAt) panelMismatchAt = Date.now();
        if (Date.now() - panelMismatchAt < PANEL_MISMATCH_GRACE_MS) {
          contentLoadedAt = 0;
          await sleep(PROBE_POLL_MS);
          continue;
        }
      } else {
        panelMismatchAt = 0;
      }
      // Panels can swap mid-probe; resolve the current place's panel fresh
      // every iteration so no signal is ever read from a stale one.
      const root = detectionRoot(key);
      const banner = findBanner(root);
      if (banner) {
        debug('probe: banner found after', Date.now() - startedAt, 'ms');
        return banner.range
          ? { status: 'flagged', range: banner.range }
          : { status: 'unknown' };
      }
      if (!reviewsTabSelected(root)) {
        // Once Reviews was verifiably selected, only a user click moves the
        // selection to another tab (the probe never clicks away while
        // polling). Yield immediately — never fight the user for the tabs.
        if (probeState.sawSelected && selectedTabButton(root)) {
          debug('probe: user switched tabs during probe, yielding');
          return { status: 'user-nav' };
        }
        // Wrong surface: nothing seen here may count toward "clean".
        contentLoadedAt = 0;
        if (probeState.reclicks < 3 && Date.now() - startedAt > (probeState.reclicks + 1) * 600) {
          const tab = findTabButton(REVIEWS_TAB_LABEL, root);
          if (tab) {
            debug('probe: reviews tab not selected, re-clicking (attempt', probeState.reclicks + 1 + ')');
            tab.click();
          }
          probeState.reclicks++;
        }
      } else {
        if (!probeState.sawSelected) {
          probeState.sawSelected = true;
          debug('probe: reviews tab selected after', Date.now() - startedAt, 'ms');
        }
        // Two independent "the reviews surface has rendered" signals: review
        // entries, and the banner-region marker line (which also covers
        // venues with fewer reviews than the entries threshold). Either one
        // only STARTS the clean grace clock — the banner can render later
        // than both, so clean always waits the full grace.
        const entriesOk = reviewsContentLoaded(root);
        const metaOk = reviewsMetaVisible(root);
        if (entriesOk || metaOk) {
          if (!contentLoadedAt) {
            contentLoadedAt = Date.now();
            debug(
              'probe: reviews surface loaded after', contentLoadedAt - startedAt,
              'ms; entries:', entriesOk, 'marker:', metaOk
            );
            // Slow loads get their full grace window measured from content
            // arrival, not from probe start (capped by the hard ceiling).
            deadline = Math.min(
              hardDeadline,
              Math.max(deadline, contentLoadedAt + CLEAN_GRACE_MS + 600)
            );
          }
          const waited = Date.now() - contentLoadedAt;
          if (waited >= CLEAN_GRACE_MS) {
            debug(
              'probe: clean verdict after', Date.now() - startedAt,
              'ms; banner-region marker:', metaOk
            );
            return { status: 'clean' };
          }
        }
      }
      await sleep(PROBE_POLL_MS);
    }
    debug('probe: timeout; tab selected seen:', probeState.sawSelected, '; content loaded:', !!contentLoadedAt);
    return { status: 'unknown' };
  }

  /**
   * Clicks away from the Reviews tab and VERIFIES the switch took effect,
   * retrying a few times — a single click can be swallowed while the tab
   * transition is still settling (same phenomenon as the forward direction).
   * Yields immediately if the user navigated or is no longer on Reviews.
   */
  async function ensureLeftReviewsTab(key, generation, resolveBack) {
    const startedAt = Date.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (generation !== probeGeneration) return; // settings changed: hands off the tabs
      if (placeKey() !== key) return;
      if (!reviewsTabSelected(detectionRoot(key))) return;
      // Reviews still (or again) selected after our click already fired AND
      // the user has interacted since — they re-selected it deliberately.
      // Yield instead of fighting them for the tabs.
      if (attempt > 0 && lastUserInputAt > startedAt) {
        debug('probe: user input during switch-back, yielding');
        return;
      }
      const back = resolveBack();
      if (!back) {
        // Transitions can briefly remove the target tab; recovery below
        // keeps re-resolving it instead of giving up on the first miss.
        debug('probe: no tab to switch back to yet');
        break;
      }
      debug('probe: switching back' + (attempt ? ' (retry ' + attempt + ')' : ''));
      back.click();
      for (let waited = 0; waited < 600; waited += PROBE_POLL_MS) {
        await sleep(PROBE_POLL_MS);
        if (generation !== probeGeneration || placeKey() !== key) return;
        if (!reviewsTabSelected(detectionRoot(key))) return;
      }
    }
    debug('probe: switch-back did not take effect after retries');
    if (lastUserInputAt > startedAt) return; // user engaged with Reviews — leave them
    debug('probe: scheduling switch-back recovery');
    pendingReturn = {
      key,
      generation,
      resolveBack,
      until: Date.now() + RETURN_RECOVERY_MS,
      lastAttempt: Date.now(),
      registeredAt: Date.now(),
    };
  }

  async function probeReviewsTab(key) {
    if (probeRunning) return;
    probeRunning = true;
    pendingReturn = null; // a new probe supersedes any older pending switch-back
    let verdict = { status: 'unknown' };
    const generation = probeGeneration;
    const probeState = { reclicks: 0, generation, sawSelected: false, tabFound: false };
    // Statuses after which the probe must NOT touch the tabs again: the user
    // navigated away / took over, or a settings change cancelled the probe.
    const handsOff = (status) =>
      status === 'aborted' || status === 'cancelled' || status === 'user-nav';
    try {
      const root = detectionRoot(key);
      const reviewsTab = findTabButton(REVIEWS_TAB_LABEL, root);
      const originalTab = selectedTabButton(root);
      probeState.tabFound = !!reviewsTab;

      if (!reviewsTab) {
        debug('probe: reviews tab not found');
      } else if (reviewsTab === originalTab) {
        // Reviews tab appears already selected. That is either the user
        // genuinely sitting on it, or a still-visible previous panel during a
        // transition. pollForBanner sorts it out (panel-match gating plus
        // re-clicks); if the probe had to navigate itself, it cleans up by
        // returning to the tablist's first tab (Overview).
        verdict = await pollForBanner(key, probeState);
        if (!handsOff(verdict.status) && probeState.reclicks > 0) {
          debug('probe: probe navigated itself, returning to first tab');
          await ensureLeftReviewsTab(key, generation, () => {
            const sel = selectedTabButton(detectionRoot(key));
            const tablist = sel && sel.closest('[role="tablist"]');
            const firstTab = tablist && tablist.querySelector('[role="tab"]');
            return firstTab && firstTab !== sel && isElementVisible(firstTab) ? firstTab : null;
          });
        }
      } else {
        debug('probe: opening reviews tab');
        // Capture the original tab's visible label (venue-independent, e.g.
        // "Overview"/"Übersicht"): page transitions can replace the tab
        // elements, so the element reference alone is not a reliable way back.
        const originalLabel = originalTab
          ? (originalTab.textContent || '').trim() ||
            (originalTab.getAttribute('aria-label') || '').trim()
          : '';
        reviewsTab.click();
        verdict = await pollForBanner(key, probeState);
        // Switch back unless the user navigated to a different tab themselves
        // (then the Reviews tab is no longer the selected one and we yield).
        if (!handsOff(verdict.status) && originalLabel) {
          await ensureLeftReviewsTab(key, generation, () => {
            if (originalTab && originalTab.isConnected && isElementVisible(originalTab)) {
              return originalTab;
            }
            const escaped = originalLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return findTabButton(new RegExp('^\\s*' + escaped + '\\s*$', 'i'), detectionRoot(key));
          });
        }
      }
    } catch (e) {
      /* keep unknown */
    }
    if (verdict.status === 'user-nav') {
      // The user took over tab navigation mid-probe. Record the venue as
      // unknown: no badge, and — crucially — no automatic re-probe that
      // would wrestle the tabs away from them again.
      verdict = { status: 'unknown' };
    }
    if (verdict.status === 'cancelled') {
      // Settings changed under the probe: the cache was already cleared and
      // (if still enabled) a fresh probe starts from scan(). This verdict
      // belongs to the old settings — record nothing.
      debug('probe cancelled by settings change for', key);
    } else if (verdict.status === 'aborted' || placeKey() !== key) {
      // An aborted probe (or one whose place changed under it) belongs to
      // nobody — discard it so the new place gets its own probe immediately.
      debug('probe aborted: navigated away from', key);
      bannerCache.delete(key);
    } else {
      verdict.ts = Date.now();
      if (verdict.status === 'unknown') {
        const prior = bannerCache.get(key);
        // Retry-eligible: a Reviews tab existed but the probe never
        // verifiably reached it — the transient click-swallow signature.
        // `retried` marks the one allowed re-probe as already consumed.
        verdict.transient = probeState.tabFound && !probeState.sawSelected;
        verdict.retried = !!(prior && prior.retriedOnce);
      }
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
      tryPendingReturn();
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
      // During SPA transitions the visible panel may still belong to the
      // previous venue while the URL already names the new one — don't read
      // or render anything until they agree (bounded by the grace window).
      if (!panelMatchesKey(key)) {
        if (panelMismatchKey !== key) {
          panelMismatchKey = key;
          panelMismatchSince = Date.now();
        }
        if (Date.now() - panelMismatchSince < PANEL_MISMATCH_GRACE_MS) {
          debug('panel does not match key yet (transitioning)');
          return;
        }
        if (DEBUG) dumpHeadings();
        debug('panel mismatch persists, proceeding without the guard');
      } else {
        panelMismatchKey = null;
      }
      const root = detectionRoot(key);
      const domBanner = findBanner(root);
      const info = findRatingInfo(domBanner ? domBanner.el : null, root);
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
          // unknown: show nothing. One exception — an unknown that looks
          // transient (Reviews tab existed but its clicks were swallowed)
          // gets a single re-probe after a cooldown. Everything else only
          // re-runs on navigation or settings changes, because the probe
          // visibly flips tabs.
          if (
            cached.status === 'unknown' &&
            cached.transient &&
            !cached.retried &&
            !probeRunning &&
            Date.now() - (cached.ts || 0) > UNKNOWN_RETRY_COOLDOWN_MS
          ) {
            debug('transient unknown verdict, re-probing once');
            bannerCache.set(key, { status: 'pending', ts: Date.now(), retriedOnce: true });
            renderCheckingCard(info, key);
            probeReviewsTab(key);
            return;
          }
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
    // Cancel any in-flight probe synchronously: it runs under the old
    // settings and must not keep flipping tabs (especially after disable).
    probeGeneration++;
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
