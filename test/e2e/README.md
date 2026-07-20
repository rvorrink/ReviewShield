# ReviewShield E2E tests

Deterministic Playwright tests run the real content script in Chromium against a local fake Google Maps page. The fixture records tab clicks, supports delayed review content, swallowed clicks and replaced tab nodes, and captures `[RealReview]` diagnostics.

## Install

```sh
cd test/e2e
npm install
npx playwright install chromium
```

## Run

From `test/e2e/`:

```sh
npm test
```

Run one scenario:

```sh
npx playwright test probe.spec.js -g "B3"
```

Run headed for visual diagnosis:

```sh
npm run test:headed -- -g "A1"
```

The suite uses Playwright's virtual clock in 50–100 ms steps. Extension source files are loaded unchanged from the repository root; no extension packaging step is involved.

Round two expands the suite to 43 scenarios, including bounded switch-back recovery, trusted-user-input cancellation, one-shot unknown re-probes, rapid venue navigation, stale panels, settings invalidation, decoy counts, search-page gating, and timing edges. See `FINDINGS-2.md` for the current result. The suite intentionally exits non-zero while a deterministic extension finding remains encoded as a failing regression test.
