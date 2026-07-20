# ReviewShield E2E findings

Tested with Chromium against the deterministic fake-Maps fixture. All listed failures reproduced 3/3 times. The fixture uses the real extension scripts unchanged.

## B6 Probe overrides a user's mid-probe tab choice
- Severity: high
- Scenario: B6 (English, banner delay 1400 ms, user selects About 400 ms into probe)
- Expected: The probe yields to the user and leaves About selected, with no later programmatic tab activation.
- Actual: The probe treats About as a swallowed Reviews click, reopens Reviews, then switches to Overview; the user's choice is overridden twice.
- Repro: `cd test/e2e && npx playwright test probe.spec.js -g "B6"` — fails deterministically (3/3 runs).
- Console log: `[RealReview] probe: reviews tab not selected, re-clicking (attempt 1)`; `[RealReview] probe: banner found after 1400 ms`; `[RealReview] probe: switching back`
- Suspected location: `content/content.js:550` — the wrong-surface retry cannot distinguish a swallowed programmatic click from a subsequent user tab selection.

## C1 Visible stale panel flags the wrong venue
- Severity: high
- Scenario: C1 (English and German; old flagged panel visible for 1500 ms while new clean panel is present)
- Expected: No old-panel data is attributed to the new key; the new venue eventually receives a `clean` card.
- Actual: The probe clicks the stale panel's Reviews tab, reads its banner, caches `flagged` for `Clean_Venue`, and renders an adjusted badge for the clean venue. The same wrong verdict occurs in English and German.
- Repro: `cd test/e2e && npx playwright test probe.spec.js -g "C1"` — fails deterministically in both languages (3/3 runs each).
- Console log: `[RealReview] probe: opening reviews tab`; `[RealReview] probe: banner found after 200 ms`; `[RealReview] probe verdict for Clean_Venue flagged`
- Suspected location: `content/content.js:428` and `content/content.js:153` — global tab/banner lookup can target the first stale visible panel while panel matching succeeds because any visible main matches the new key.

## C5 Hidden stale panel prevents detection in the visible venue
- Severity: medium
- Scenario: C5 (old flagged panel retained with `display:none` for 5000 ms; new clean panel visible)
- Expected: Hidden stale DOM is ignored and the visible clean venue receives a `clean` card.
- Actual: No badge is rendered. Rating lookup selects the first `[role="main"]` even though it is hidden, then rejects all of that panel's candidates as invisible instead of trying the visible panel.
- Repro: `cd test/e2e && npx playwright test probe.spec.js -g "C5"` — fails deterministically (3/3 runs).
- Console log: `[RealReview] review count not found`; `[RealReview] rating/count not found in panel header`
- Suspected location: `content/content.js:291` — `document.querySelector('[role="main"]')` does not select the visible/current panel.

## D3 Disabling does not cancel in-flight tab movement
- Severity: high
- Scenario: D3 (disable at 400 ms while a flagged probe is on Reviews; banner delay 1400 ms)
- Expected: Disabling removes badges and prevents subsequent extension-driven tab changes.
- Actual: Badges are removed, but the in-flight probe continues and programmatically switches from Reviews back to Overview about 800 ms after disable.
- Repro: `cd test/e2e && npx playwright test probe.spec.js -g "D3"` — fails deterministically (3/3 runs).
- Console log: `[RealReview] probe: clean verdict after 1200 ms; banner-region marker: true`; `[RealReview] probe: switching back`; `[RealReview] probe verdict for Test_Venue clean`
- Suspected location: `content/content.js:1139` and `content/content.js:609` — settings invalidation clears cached state but does not cancel or invalidate the running probe.

## Passing scenarios

- A1 English — flagged Overview probe shows checking, finds banner, and returns to Overview with an adjusted badge.
- A1 German — localized flagged flow and adjusted badge pass.
- A2 English — meta-marker clean flow returns to Overview with a clean card.
- A2 German — localized clean flow passes.
- A3 — entries-only surface waits for the long clean grace.
- A4 — already-selected Reviews with a banner performs no tab switch.
- A5 — already-selected clean Reviews remains selected.
- A6 — missing Reviews tab becomes unknown once and does not retry.
- B1 English — one swallowed forward click is retried successfully.
- B1 German — localized swallowed-click recovery passes.
- B2 — exhausted forward retries end unknown on Overview.
- B3 — two swallowed back clicks recover on the third attempt.
- B4 — three swallowed back clicks give up cleanly on Reviews.
- B5 — replaced tab nodes use the label-based fallback.
- C3 — Overview review snippets cannot create a false clean verdict.
- D1 — cached flagged verdict avoids a repeat probe.
- D4 — unknown verdict does not retry on periodic rescans.
- E1 — a removed cached badge is restored without probing again.
- E2 — a 20 Hz mutation storm creates neither duplicates nor duplicate probes.
- F1 — content arriving at 5.5 seconds reaches a bounded clean verdict.
- F2 — a surface with no content ends unknown and stays quiet.
- F3a — a banner delayed 1.5 seconds after entries/meta is detected before a clean verdict.
- F3b — a banner delayed 1.5 seconds after entries without meta is found during the long grace.

## Scope notes

This intentionally focused suite covers 28 high-value cases, including the German reruns requested for A1, A2, B1, and C1. The larger spec's B7–B8, C2 and C4, D2, E3–E5, and some language permutations remain candidates for a later expansion if fixes in the state machine warrant deeper regression coverage. No extension source files were changed.
