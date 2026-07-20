# ReviewShield E2E findings — round 2

Tested with Chromium against the deterministic fake-Maps fixture after applying the round-two behavior contract. The fixture now prevents delayed Reviews content from leaking into another tab surface, and trusted-input scenarios use Playwright's real mouse input. The single listed failure reproduced 3/3 times. Extension source was loaded unchanged.

## F3a Meta-marker grace produces a false clean verdict
- Severity: high
- Scenario: F3a (English; entries and meta at 1000 ms, defamation banner at 2500 ms)
- Expected: The banner arrives within the 1800 ms long grace measured from surface load, so the venue receives an `adjusted` badge.
- Actual: The meta marker activates the 700 ms short grace; the probe declares `clean` at 1800 ms, switches to Overview, and the correctly surface-scoped delayed banner is never observed.
- Repro: `cd test/e2e && npx playwright test probe.spec.js -g "F3a"` — fails deterministically (3/3 runs).
- Console log: `[RealReview] probe: reviews surface loaded after 1000 ms; entries: true marker: true`; `[RealReview] probe: clean verdict after 1800 ms; banner-region marker: true`; `[RealReview] probe verdict for Test_Venue clean`
- Suspected location: `content/content.js:714` — the meta-marker short-grace branch can conclude before a later disclosure banner that still falls inside the long banner-arrival window.

## Passing scenarios

- A1 English — flagged Overview probe returns with an adjusted badge.
- A1 German — localized flagged probe passes.
- A2 English — clean meta-marker probe returns with a clean badge.
- A2 German — localized clean probe passes.
- A3 — entries-only clean detection waits for the long grace.
- A4 — an already-selected flagged Reviews tab is not switched.
- A5 — an already-selected clean Reviews tab remains selected.
- A6 — a missing Reviews tab becomes unknown without retrying.
- B1 English — one swallowed forward click recovers.
- B1 German — localized swallowed-forward recovery passes.
- B2a — a transient unknown re-probes exactly once and succeeds on the fifth Reviews click.
- B2b — two exhausted probes stop permanently after exactly eight Reviews clicks.
- B3 — two swallowed in-probe return clicks recover on the third.
- B4a — three swallowed return clicks schedule recovery; the fourth return click succeeds.
- B4b — permanently swallowed recovery is bounded and stays quiet after its window.
- B4c — trusted wheel input cancels pending recovery with no later return click.
- B4d — trusted user re-selection of Reviews makes in-probe switch-back yield without recovery.
- B5 — replaced tab nodes use the label fallback.
- B6 — an untrusted fixture About selection still yields correctly once Reviews was verifiably selected.
- B7 — navigation aborts the old probe, probes the new venue, and fresh-probes the old venue on return.
- B8 — rapid A→B→A hopping neither misattributes badges nor deadlocks the final probe.
- C1 English — a visible stale flagged panel cannot flag the new clean venue.
- C1 German — localized stale-panel isolation passes.
- C2 — a mismatch beyond the grace does not attribute stale flagged data to the new key.
- C3 — Overview snippets never create a verdict across both exhausted forward probes.
- C4 — a stale pre-selected Reviews panel yields to the real Overview panel.
- C5 — a hidden stale flagged panel is ignored.
- D1 — a cached verdict avoids a return probe.
- D2 — settings invalidate the cache, trigger a new probe, change calculation mode, and clamp the assumed star value.
- D3 — disabling cancels in-flight probe tab effects and removes badges.
- D4a — a transient unknown retries once and never twice.
- D4b no-content — a selected but empty Reviews surface never retries.
- D4b no-tab — a venue without a Reviews tab never retries.
- E1 — a removed badge is restored without another probe.
- E2 — a 20 Hz mutation storm produces no duplicate badge or probe.
- E3 — a reviewer-count decoy is rejected; the header count drives the calculation and anchor.
- E4 — search results remain untouched and search-to-place navigation starts detection.
- E5 coordinates — a coordinate-style key opts out of title matching safely.
- E5 short key — a short key opts out safely.
- F1 — content arriving at 5.5 seconds reaches a bounded clean verdict.
- F2 — an empty Reviews surface ends unknown without retry.
- F3b — without the meta marker, the late banner is found during the long grace.

## Contract and fixture notes

- The obsolete round-one expectations for B2, B4, C3, and D4 were replaced by the addendum's one-shot retry and switch-back recovery contracts.
- The former B4 “stuck on Reviews after three dropped return clicks” behavior is fixed: B4a now returns successfully through background recovery.
- The round-one B6, C1, C5, and D3 findings all pass with the updated extension.
- The F3 fixture leak is fixed by stamping each surface with its active tab and discarding delayed callbacks after the surface changes away from Reviews. F3a therefore now fails for the extension's actual early-clean behavior, not because of delayed DOM leakage.
- All 43 scenarios produced the same pass/fail outcome across three consecutive runs: 42 passed and F3a failed in each run.
