# ReviewShield — Test Infrastructure Spec (for Codex)

You are building automated tests for a Chrome extension (MV3 content script) that runs on Google
Maps. Your job: build the test infrastructure described here, run the scenario matrix, and produce
a findings report (format at the bottom). **Do not fix bugs and do not modify extension source
files** — findings go back to another agent who owns the fixes. All test code lives under
`test/e2e/` (new directory).

## 1. What the extension does (context)

Google Maps shows a disclosure banner on some business profiles: "N to M reviews removed due to
defamation complaints" (German: "… aufgrund von Beschwerden wegen Diffamierung entfernt"). The
extension reads the official rating + review count, assumes removed reviews were 1-star, and
injects a corrected-rating badge into the place panel.

The catch: the banner only exists in the **Reviews tab's** DOM. When the user is on the Overview
tab, the content script runs a **probe**: it programmatically clicks the Reviews tab, polls the DOM
for a verdict (banner found → `flagged`; reviews surface rendered without banner → `clean`;
timeout → `unknown`), caches the verdict per place, and switches back to the tab the user was on.
While probing it shows a "checking…" card.

**Most known bugs are suspected in this probe / tab-switching state machine** — races during
Maps SPA transitions, swallowed clicks, stale panels, failure to switch back, wrong verdicts.

## 2. Files (read these first)

- `content/content.js` — everything under test. The probe machinery is lines ~404–694
  (`probeReviewsTab`, `pollForBanner`, `ensureLeftReviewsTab`, `bannerCache`), the render/scan
  loop is `scan()` + `renderCheckingCard` / `renderCleanCard` / `renderAdjustedBadge`.
- `lib/config.js` — all text anchors/regexes the script detects Maps UI by. Your fixture DOM
  must satisfy these regexes exactly (see §4).
- `lib/parse.js` — pure parsing, already unit-tested in `test/parse.test.js` (`node --test`).
  Keep those passing; you don't need to extend them.
- `lib/i18n.js` — loads `_locales/<lang>/messages.json` via `chrome.runtime.getURL` + `fetch`.

`DEBUG = true` is currently set in `content/content.js` — the script logs its decisions to the
console prefixed `[RealReview]`. Capture these logs in every test; they are your primary
diagnostic and must be quoted in findings.

## 3. Infrastructure to build

**Playwright + Chromium** driving a local "fake Maps" fixture page. Do NOT test against live
Google Maps (non-deterministic, races not reproducible on demand). Do not use jsdom (the script
depends on `getBoundingClientRect` geometry, `document.evaluate` XPath, and real visibility).

Setup per test:

1. Serve the repo root statically (so `/_locales/en/messages.json` etc. resolve) plus the fixture
   page. Load the fixture at a URL whose **path** is `/maps/place/<slug>` — the content script
   gates on `location.href` matching `/\/maps\/place\//` and derives its place key from
   `/maps/place/([^/@?]+)`. In-fixture navigation uses `history.pushState` to the next
   `/maps/place/<slug>` path (this is how Maps SPA-navigates; a static server needs a catch-all
   route returning the fixture for any `/maps/place/*` path).
2. Inject a `chrome` stub **before** the extension scripts:
   - `chrome.storage.sync.get(defaults, cb)` → calls `cb` with defaults merged with a
     per-test settings override; `chrome.storage.onChanged.addListener(fn)` → keep the listener
     so tests can push settings changes.
   - `chrome.i18n.getUILanguage()` → per-test `'en'` or `'de'`;
     `chrome.i18n.getMessage()` → return `''` (forces the messages.json fallback path, which is
     what you're serving statically anyway).
   - `chrome.runtime.getURL(p)` → `'/' + p` (served statically).
3. Inject, in order: `lib/config.js`, `lib/parse.js`, `lib/i18n.js`, `content/content.js`
   (same order as the manifest), plus `content/badge.css`.
4. Use Playwright's clock API (`page.clock`) so probe timeouts (6s base / 12s hard ceiling,
   2.5s panel-mismatch grace, 0.7s/1.8s clean-grace windows, 3s rescan interval) can be
   fast-forwarded instead of slept through. Install the clock before injecting the scripts.
   Fast-forward in small steps (e.g. 100–200ms ticks) so the script's `setTimeout` polling
   (200ms) and debounce (350ms) interleave realistically — a single big jump is not realistic
   and can mask races.

## 4. The fake-Maps fixture

One HTML page + a control API (`window.__maps`) that tests call via `page.evaluate`. It must
emulate the Maps structures the content script anchors on:

**Place panel** — a `div[role="main"]` with `aria-label="<venue name>"` (this is the primary
identity anchor; also give it an `h1` with the venue name). Inside, a header block containing:
- rating leaf: `<span>4.6</span>` (must match `/^\d[.,]\d$/`, no child elements)
- count leaf: `<span>(3,270)</span>` and/or an element with `aria-label="3,270 reviews"`
- optionally a star widget with `aria-label="4.6 stars"`

**Tabs** — a `[role="tablist"]` with `[role="tab"]` buttons ("Overview", "Reviews", "About"),
`aria-selected` maintained on click. The Reviews tab's `aria-label` should be
`"Reviews for <venue>"` (the script prefix-matches `/^\s*(Reviews|Rezensionen)\b/i`).
Tab *content* renders after a configurable delay (see knobs).

**Reviews tab content**, each part independently delayable:
- meta line: text `Reviews aren't verified` (German: `Rezensionen werden nicht überprüft`)
- review entries: ≥2 elements with `aria-label="5 stars"` / `aria-label="1 star"` (exact-match
  shape; also support hotel-style leaf text `4/5`)
- banner (flagged venues only): a text node containing e.g.
  `2 to 5 reviews removed due to defamation complaints` /
  `Es wurden 2 bis 5 Bewertungen aufgrund von Beschwerden wegen Diffamierung entfernt`

**Overview tab content** — a couple of review *snippets* that also carry `aria-label="5 stars"`
(Maps really does this; the script must not take them as evidence the Reviews surface loaded).

**Visibility semantics**: the script treats an element as visible iff its bounding rect is >1×1.
Hide stale panels with `display:none` (or keep them visible to simulate transition overlap — see
knobs). All visible elements need real layout (the page must actually render them, not 0-height).

**Control API / scenario knobs** (all per-venue, all settable per test):
- `venue(name, {rating, count, flagged, bannerText, lang})` — create/replace a place panel
- `navigate(slug)` — pushState to `/maps/place/<slug>`, then swap panels after
  `panelSwapDelayMs` (during which the OLD panel stays visible and the new one doesn't exist —
  this is the SPA transition window the guards target)
- `tabContentDelayMs`, `metaDelayMs`, `entriesDelayMs`, `bannerDelayMs` — render delays after a
  tab becomes selected
- `swallowClicks(tabName, n)` — the first n clicks on that tab do nothing (Maps drops clicks
  mid-transition; the script has retry logic specifically for this)
- `replaceTabsOn(event)` — recreate the tab DOM elements (new nodes, same labels) after a tab
  switch, so held element references become stale (`isConnected === false`)
- `keepStalePanel(ms)` — after navigate, keep the previous venue's panel attached AND visible
  alongside/instead of the new one for `ms`
- `userClickTab(tabName)` — simulate the user clicking a tab mid-probe

**Instrumentation** (the fixture records, tests assert):
- ordered log of every tab activation with timestamp and cause (extension click vs `userClickTab`)
- current `aria-selected` tab at any time
- helper: count of `.realreview-badge` elements and their `data-rr-kind`
  (`checking` | `clean` | `adjusted`), `data-rr-key`, and badge text

## 5. Scenario matrix

For every scenario assert, at minimum: final badge kind + content, final selected tab, total
number of programmatic tab switches, no duplicate badges at any point, and no uncaught errors.
Run the full matrix in **English**; re-run at least A1, A2, B1, C1 in **German** (`lang:'de'`,
German banner/meta/tab texts, rating `4,6`, count `(3.270)` or `aria-label="3.270 Rezensionen"`).

### A. Probe happy paths
- **A1 flagged venue, user on Overview.** Probe opens Reviews, banner (delay ~800ms) is found,
  probe switches back. Expect: exactly 2 tab switches (Overview→Reviews→Overview), final tab
  Overview, badge kind `adjusted`, score = corrected rating for rating 4.6 / count 3270 /
  range 2–5 / assumed 1★ (worst mode uses top of range: verify against
  `lib/parse.js` `correctedRange`). A `checking` card must have appeared during the probe.
- **A2 clean venue, user on Overview.** Meta line renders 500ms after tab switch. Expect: verdict
  `clean` (after the 700ms grace), switch back to Overview, badge kind `clean`.
- **A3 clean venue, meta line never renders, entries do.** Expect: clean only after the long
  grace (1800ms), not before.
- **A4 user already on Reviews, banner present in DOM.** Expect: NO probe (zero programmatic tab
  switches), badge `adjusted` directly.
- **A5 user already on Reviews, clean venue.** Expect: verdict without any tab switch; final tab
  still Reviews (the script must only navigate back if it navigated itself — check the
  `reclicks > 0` condition holds).
- **A6 venue with no Reviews tab at all** (e.g. bare panel). Expect: verdict `unknown`, no badge,
  no crash, and — important — no retry loop (probe must not re-run every rescan).

### B. Tab-switch races (primary suspect area)
- **B1 forward click swallowed.** `swallowClicks('Reviews', 1)`. Expect: re-click fires
  (~600ms), probe still reaches a verdict, and the switch-back still happens. Assert final tab =
  Overview.
- **B2 forward click swallowed 3×.** All re-click attempts exhausted, tab never opens. Expect:
  verdict `unknown` at timeout, no badge, final tab Overview (never left), and the probe must NOT
  "return to first tab" spuriously.
- **B3 switch-back click swallowed.** First back-click does nothing. Expect: retry (up to 3),
  final tab Overview. This is `ensureLeftReviewsTab` — verify it actually verifies, i.e. with 2
  swallowed clicks it still ends on Overview.
- **B4 switch-back click swallowed 3×.** Expect: script gives up gracefully (logs
  "switch-back did not take effect"), user is left on Reviews (acceptable), but badge/verdict
  must still be correct and no error thrown.
- **B5 tab elements replaced during probe.** `replaceTabsOn('reviews-selected')` so the held
  `originalTab` reference is disconnected when switching back. Expect: label-based fallback finds
  the NEW "Overview" button; final tab Overview.
- **B6 user clicks a different tab (About) mid-probe.** Expect: probe yields — it must NOT drag
  the user back to Overview or Reviews. Final tab = About.
- **B7 user navigates to another venue mid-probe.** `navigate('Other_Venue')` while polling.
  Expect: probe aborts, cache entry for the old venue is DELETED (verify: navigating back later
  triggers a fresh probe), new venue gets its own probe attributed to its own key, and no tab
  clicks fire against the new venue on behalf of the old probe.
- **B8 rapid A→B→A venue hopping** (navigate every ~500ms during probes). Expect: no interleaved
  badges (a badge for venue A never shows while B's panel is up — check `data-rr-key` against
  current URL slug at every step), no stuck `probeRunning` (a probe eventually runs and completes
  for the final venue; `pending` cache entries don't deadlock).

### C. Stale panel / transition guards
- **C1 old panel visible after URL change.** `keepStalePanel(1500)` where old venue is flagged,
  new is clean. Expect: during overlap, NO badge for the new key derived from old panel's data;
  after swap, correct `clean` card. The old venue's banner must not flag the new venue.
- **C2 mismatch persists past grace.** `keepStalePanel(4000)` (> 2500ms grace) with a panel
  whose title never matches the URL key. Expect: script proceeds without the guard after ~2.5s
  (by design) — document what verdict results; if it attributes the stale panel's data to the
  new key, that's a finding.
- **C3 Overview snippets must not fake a clean verdict.** Flagged venue, Overview has
  `aria-label="5 stars"` snippets, Reviews tab click swallowed 3× (probe never gets there).
  Expect: `unknown`, NOT `clean`. (This is the "wrong surface" guard: content signals while
  `reviewsTabSelected()` is false must be discarded.)
- **C4 Reviews tab appears pre-selected during transition** (stale panel's tablist still visible
  with Reviews selected, real panel arrives 1s later on Overview). Expect: probe sorts it out via
  panel-match gating + re-clicks; correct verdict for the real venue; if the probe navigated
  itself, it ends on the first tab.
- **C5 hidden stale panel with banner.** Old flagged venue's panel stays in DOM but
  `display:none` (Maps back-navigation cache). New clean venue visible. Expect: `clean` — hidden
  banner must not leak (visibility guard).

### D. Cache & settings
- **D1 verdict cached.** Visit flagged venue (probe runs), navigate away, navigate back. Expect:
  badge `adjusted` immediately, ZERO tab switches on the return visit.
- **D2 settings change invalidates cache.** After D1, fire `chrome.storage.onChanged` (e.g.
  `calcMode` → `'conservative'`). Expect: cache cleared, re-probe happens, badge shows bottom of
  range now. Also verify `removedStarValue: 2.5` changes the computed score, and out-of-range
  values clamp (1–2.5).
- **D3 disabled kills everything.** `enabled: false` via onChanged mid-probe. Expect: badges
  removed. Document what happens to the in-flight probe (it isn't cancelled by design — if it
  still flips tabs afterward, that's a finding).
- **D4 `unknown` does not auto-retry.** After a B2-style unknown, let the 3s rescan interval fire
  several times. Expect: no new probe, no tab flipping (probes re-run only on navigation or
  settings change).

### E. Rendering / idempotence
- **E1 Maps re-render removes the badge.** Delete the badge node (simulating a Maps re-render);
  expect it re-appears within ~3.5s and there is never more than one.
- **E2 mutation storm.** Append/remove unrelated nodes at 20Hz for 5s during and after probe.
  Expect: exactly one badge, no duplicate probes, no runaway CPU (scan is debounced at 350ms).
- **E3 reviewer-count decoy.** Panel where the first count-shaped text is a reviewer's
  "2 reviews" inside a review card (no header rating nearby), header count present further down.
  Expect: badge anchors to header, math uses 3270 not 2.
- **E4 search results page.** URL without `/maps/place/` but panels with rating-like text.
  Expect: no badge, and navigating from search → place works.
- **E5 non-Latin/short place keys.** Slug is coordinates (`52.5200,13.4050` style with °) or
  <4 letters. Expect: guard opts out gracefully, no permanent silence, no crash.

### F. Timing edges
- **F1 content arrives late (5.5s).** Base deadline is 6s but arrival extends it. Expect: clean
  verdict still reached (deadline extension works), bounded by the 12s hard ceiling.
- **F2 nothing ever renders.** Expect: `unknown` at ~6s, no badge, no retry (see D4).
- **F3 banner renders 1.5s after entries.** Entries at 1s, banner at 2.5s (< entries + 1800ms
  long grace, but > entries + 700ms — so this tests whether the meta-line short grace can
  prematurely conclude `clean`; run once with meta line present at 1s and once without).
  A `clean` verdict for a flagged venue here is a **high-severity finding**.

## 6. Findings report (hand back exactly this)

Write `test/e2e/FINDINGS.md`. For each failing or suspicious scenario:

```
## <ID> <one-line title>            e.g. "B3 switch-back retry never fires"
- Severity: high | medium | low     (high = wrong verdict/badge or user-visible tab hijack)
- Scenario: <ID> (+ lang, + knob values if parameterized)
- Expected: <one sentence>
- Actual: <one sentence>
- Repro: <exact command, e.g. `npx playwright test e2e/probe.spec.js -g "B3"`> — must fail
  deterministically; if flaky, say the failure rate over 10 runs.
- Console log: <the relevant `[RealReview]` lines, verbatim>
- Suspected location: <file:line in content.js — best guess, optional>
```

Also list scenarios that PASS (one line each) so the fixer knows what's covered, and any place
where the spec's expectation seems wrong (don't silently change expectations — flag them).
Findings must describe behavior only — no patches, no edits to extension source. If a fixture
limitation (not the extension) causes a failure, say so explicitly rather than reporting it as
an extension bug.

## 7. Round 2 addendum (2026-07-20) — REVISED BEHAVIOR CONTRACT

Round 1 is done (28 scenarios, 4 bugs found, all fixed — see `test/e2e/FINDINGS.md`). Since then
the extension's INTENDED behavior changed in two places, so some round-1 tests now assert
obsolete expectations. Your round-2 job: (a) update those tests to the new contract below,
(b) add the new scenarios, (c) add the previously-skipped scenarios, (d) run everything and
write `FINDINGS-2.md` in the same format. Same ground rules: no extension source changes.

### 7.1 New behavior: switch-back recovery (replaces old B4 expectation)

Giving up after 3 swallowed switch-back clicks and stranding the user on Reviews is NO LONGER
acceptable. New contract: after in-probe retries are exhausted, the extension registers a
bounded background recovery that keeps retrying the switch-back — driven by its scan loop,
roughly every ~1s — until it succeeds, for at most ~10s (`RETURN_RECOVERY_MS`). Any TRUSTED
user input (pointerdown / keydown / wheel) cancels the recovery permanently: a user who
meanwhile started using the Reviews tab must never be yanked away. Log lines to anchor on:
`probe: scheduling switch-back recovery`, `recovery: retrying switch-back`,
`recovery: user input, cancelling pending switch-back`.

- **B4a (rewrites B4):** 3 swallowed back clicks. Expect: recovery lands, final tab Overview
  within ~5s of probe end, exactly 4 Overview clicks total, badge `adjusted` throughout.
- **B4b bounded give-up:** back clicks swallowed indefinitely (swallow 99). Expect: recovery
  attempts stop after the ~10s window (~12 attempts total), user stays on Reviews, badge still
  correct, and NO further clicks ever after the window (verify with an extra 5s+ of ticks).
- **B4c user input cancels recovery:** back clicks swallowed indefinitely; ~0.5s after the
  probe gives up its in-probe retries, deliver REAL user input. IMPORTANT: fixture-driven
  `__maps.userClickTab` dispatches untrusted events and will NOT cancel — use Playwright's real
  input APIs (`page.mouse.wheel`, `page.mouse.click`, `page.keyboard.press`), and give the CDP
  event a real-time beat to land (`await page.waitForTimeout(100)`) before resuming clock
  ticks, or the test flakes. Expect: zero extension-caused tab clicks after the input, user
  stays on Reviews.
- **B4d user re-selects Reviews during in-probe switch-back:** after the probe's first
  successful switch-back click, real-click the Reviews tab within ~0.5s. Expect: the probe
  yields (log `probe: user input during switch-back, yielding`) instead of fighting; at most
  one extension back-click after the user's click, no recovery registered.

### 7.2 New behavior: one-shot re-probe for transient unknowns (updates B2/C3/D4)

An `unknown` verdict whose probe found a Reviews tab but never verifiably reached it (the
click-swallow signature) is now retried EXACTLY ONCE, ~4s later (`UNKNOWN_RETRY_COOLDOWN_MS`),
with the checking card shown again. All other unknowns (no Reviews tab at all, surface never
rendered, user took over mid-probe) still never auto-retry. Log line:
`transient unknown verdict, re-probing once`.

- **B2a (rewrites B2):** swallow 4 forward clicks. Expect: first probe ends unknown (4 clicks),
  re-probe at ~10-11s succeeds → badge `adjusted`, final tab Overview, exactly 5 Reviews clicks.
- **B2b permanent failure:** swallow 8+ forward clicks. Expect: both probes fail (exactly 8
  Reviews clicks total), no badge, and permanently quiet afterwards (10s+ of extra ticks).
- **C3 update:** swallow 8+ (was 4) so both probes fail; the property under test is unchanged —
  Overview star-snippets must never produce `clean` (nor `adjusted`).
- **D4 split:** D4a — transient unknown retries exactly once, never twice. D4b — non-transient
  unknown (F2-style: tab opens but no content ever renders; and A6-style: no Reviews tab)
  retries zero times. A6/F2 expectations are unchanged.

### 7.3 Previously-skipped scenarios, now required

Round 1 skipped these (see FINDINGS.md scope notes); the probe state machine has since been
reworked twice, so they're now required regression coverage: **B7, B8, C2, C4, D2, E3, E4, E5**
as specified in §5. Notes: the fixture already supports `reviewerDecoy` for E3; for D2 use
`__maps.fireSettings` and assert the cache invalidation triggers a fresh probe and the badge
reflects `calcMode: 'conservative'` / a changed `removedStarValue` (and clamping >2.5 → 2.5).

### 7.4 Fixture fix required

F3a currently passes partly by accident: a pending `setTimeout` in `renderSurface` appends the
banner into whatever the surface shows at fire time (even Overview, post-switch-back). Guard
the delayed appends on the tab still being Reviews (e.g. stamp the surface with the kind it was
rendered for). Then re-verify F3a/F3b still pass for the right reason — if F3a fails after the
fixture fix, that IS a real extension finding (report it, don't paper over it).

## 8. Ground rules

- Deterministic first: every scenario must pass or fail identically across 3 consecutive runs
  before it goes in the report. Use the clock API, not real sleeps, wherever possible.
- Keep `node --test test/parse.test.js` green and untouched.
- New deps (Playwright etc.): put a `package.json` inside `test/e2e/` only — the extension itself
  must stay dependency-free and packagable as-is.
- `test/e2e/README.md` with: how to install, how to run everything, how to run one scenario.
