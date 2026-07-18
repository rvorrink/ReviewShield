# ReviewShield

A Chrome extension (Manifest V3) that makes review-removal inflation on Google
Maps visible. Since April 2026, Google Maps in Germany discloses on business
profiles when reviews were removed after defamation complaints — but only as a
count range (e.g. "2 bis 5", "über 250"). Some businesses abuse defamation
claims to delete negative reviews and inflate their score. This extension
recalculates the average rating under the assumption that every removed review
was a 1-star rating and shows the corrected range as a badge next to the
official rating.

The extension is called **ReviewShield** in every language; the UI strings are
localized via Chrome's i18n system (English/German), with a manual language
override in the popup.

## What it does

- Detects the defamation-removal banner on a place panel (German and English
  Maps UI; matchers are centralized in `lib/config.js` so more languages can be
  added easily).
- Parses the removal range ("1", "2 bis 5" / "2 to 5", "über 250" / "over 250").
  The open-ended top bucket is treated as `[251, worst-case max]`; the
  worst-case max is configurable in the popup (default 500).
- Reads the official average rating and total review count from the panel
  header (handles German and English number formatting: `3.270` vs `3,270`,
  decimal comma vs point).
- Computes the corrected rating with `(rating · N + S · R) / (N + R)`, where
  `R` depends on the calculation mode: **worst case** (default) uses the top
  of the removal range (R = 100 for "51 to 100"), **conservative** uses the
  bottom (R = 51). `S` is the star value assumed for removed reviews,
  adjustable from 1★ (harshest, default) to 2.5★. The actual removed ratings
  are unknown; the tooltip and popup say so explicitly.
- Injects an emerald-gradient bar below the rating header: star+shield mark,
  a fractional star row filled to the adjusted score, an uppercase
  "Removal-adjusted estimate" label, and the score. Hover or keyboard/tap
  focus shows a tooltip explaining the removal range, the 1-star assumption,
  and that the result is a worst-case estimate.
- On profiles with **no** reported removals, shows a quiet "Nothing to adjust
  here" card instead — a small nod to businesses that let honest feedback
  stand.
- Works on the Overview tab too: the banner only exists in the Reviews tab
  and Maps loads it at runtime, so when it isn't in the DOM the extension
  briefly opens the Reviews tab programmatically, reads the disclosure, caches
  the verdict per place, and switches back to the tab the user was on. A
  neutral "Checking review status…" card is shown while the probe runs. The
  probe resolves as soon as the banner or the rendered reviews list appears
  (a "clean" verdict requires the list as positive evidence — on timeout
  without it, nothing is shown), and it aborts immediately if the user
  navigates to another place.
- Popup settings: on/off toggle, language override (Auto / Deutsch / English),
  calculation mode (worst case / conservative), a slider for the assumed
  removed-review star value (1★ to 2.5★), a slider for the worst-case max of
  the open "over 250" bucket, and a short methodology explanation. Persisted
  via `chrome.storage.sync`.
- **Privacy:** everything runs locally on the page. No network requests, no
  analytics, no data collection. The only permission is `storage`.

## Install (load unpacked)

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open Google Maps and visit a business profile that shows the
   defamation-removal notice.

## Project structure

```
manifest.json           MV3 manifest (localized name/description)
_locales/en|de/         Chrome i18n message catalogs
lib/config.js           All text anchors/matchers + default settings
lib/parse.js            Pure, unit-tested parsing & math functions
lib/i18n.js             Translator (auto via chrome.i18n, override via _locales JSON)
content/content.js      MutationObserver-driven detection + badge injection
content/badge.css       Badge and tooltip styling
popup/                  Settings popup (HTML/CSS/JS)
test/parse.test.js      Unit tests (Node built-in test runner)
tools/icon.svg          Icon source (star+shield on emerald gradient)
tools/make-icons.sh     Icon PNG generator (macOS: QuickLook + sips)
```

## Running the tests

```
node --test test/parse.test.js
```

## Maintenance note

Google Maps is a single-page app with obfuscated, frequently changing CSS class
names. The extension therefore anchors **only on visible text and
aria-labels** (banner phrases, "N reviews"/"N Rezensionen" labels, the rating
number pattern). If Google rewords the banner or the header labels, update the
matchers in `lib/config.js` — that is the single place where detection anchors
live. All DOM code is defensive: if an anchor is not found, the extension does
nothing rather than breaking the page.

The corrected rating is an **estimate**: Google only discloses a range, and the
actual star values of removed reviews are unknown. The 1-star assumption is the
worst case for the business and marks the lower bound of plausible inflation.

---

## Deutsch

**ReviewShield** macht sichtbar, wie stark eine Google-Maps-Bewertung durch
entfernte Rezensionen geschönt sein könnte. Seit April 2026 zeigt Google Maps
in Deutschland an, wenn Bewertungen aufgrund von Beschwerden wegen Diffamierung
entfernt wurden — allerdings nur als Spanne (z. B. „2 bis 5", „über 250").
Die Erweiterung nimmt an, dass alle entfernten Bewertungen 1-Stern-Bewertungen
waren, und blendet unter der offiziellen Bewertung einen grünen Balken mit der
bereinigten Bewertung ein (Worst Case, z. B. `4,4` statt `4,6`).

### Installation (entpackt laden)

1. `chrome://extensions` öffnen.
2. Oben rechts den **Entwicklermodus** aktivieren.
3. **Entpackte Erweiterung laden** anklicken und diesen Ordner auswählen.
4. Google Maps öffnen und ein Unternehmensprofil mit dem Hinweis auf entfernte
   Bewertungen aufrufen.

### Hinweise

- Einstellungen (Ein/Aus, Sprache, Berechnungsmodus Worst Case/konservativ,
  Worst-Case-Obergrenze für „über 250") gibt es im Popup hinter dem
  Erweiterungssymbol.
- Profile ohne gemeldete Löschungen bekommen stattdessen eine dezente Karte
  („Hier gibt es nichts zu bereinigen") — als kleine Anerkennung.
- Alles läuft lokal im Browser: keine externen Anfragen, keine Analyse, keine
  Datensammlung.
- Die korrigierte Bewertung ist eine **Schätzung** — Google nennt nur eine
  Spanne, die tatsächlichen Sternwerte der entfernten Bewertungen sind
  unbekannt.
- Google ändert die Maps-Oberfläche regelmäßig. Alle Text-Anker (Banner-Texte,
  Beschriftungen) liegen zentral in `lib/config.js` und müssen ggf. dort
  angepasst werden.
