# Chrome Web Store Listing — ReviewShield

Copy-paste material for the Developer Console. The store renders plain text
(no markdown), so copy the blocks below as-is.

## Description (English)

ReviewShield shows you what a Google Maps rating might look like without the reviews that were removed after defamation complaints.

Since 2026, Google Maps discloses when reviews were removed from a business profile due to defamation complaints, but only as a range (such as "2 to 5" or "over 250"). Some businesses abuse defamation claims to delete negative reviews and inflate their score. ReviewShield reads Google's own disclosure and recalculates the average, showing a removal-adjusted estimate in a clear bar right below the official rating.

HOW IT WORKS

The extension treats each removed review as having a star value you choose (1 star by default, the harshest assumption) and recalculates using either the top of Google's reported range (worst case) or the bottom (conservative). The actual removed ratings are unknown, so the result is an estimate, not a verified rating, and the extension says so on every tooltip.

Businesses with no reported removals get a small clean bill instead: honesty gets credit.

Note: the disclosure only exists in a place's Reviews tab, so ReviewShield briefly opens that tab to read it, then returns you to where you were. A "Checking review status" indicator is shown while this happens. If you click or scroll during the check, ReviewShield immediately backs off and leaves you in control.

PRIVACY

Everything runs locally in your browser. No network requests, no analytics, no data collection, no account. The only permission is storage, used to save your settings. Source code: https://github.com/rvorrink/ReviewShield

## Description (German)

ReviewShield zeigt dir, wie eine Google-Maps-Bewertung ohne die Rezensionen aussehen könnte, die nach Diffamierungsbeschwerden entfernt wurden.

Seit 2026 legt Google Maps offen, wenn Bewertungen eines Unternehmensprofils aufgrund von Beschwerden wegen Diffamierung entfernt wurden, allerdings nur als Spanne (etwa "2 bis 5" oder "über 250"). Manche Unternehmen missbrauchen Diffamierungsbeschwerden, um negative Bewertungen zu löschen und ihren Schnitt zu schönen. ReviewShield liest Googles eigene Offenlegung und berechnet den Durchschnitt neu: Ein klarer Balken direkt unter der offiziellen Bewertung zeigt den bereinigten Schätzwert.

SO FUNKTIONIERT ES

Die Erweiterung behandelt jede entfernte Bewertung so, als hätte sie den von dir gewählten Sternwert (standardmäßig 1 Stern, die strengste Annahme), und rechnet wahlweise mit dem oberen Ende der von Google gemeldeten Spanne (Worst Case) oder dem unteren (konservativ). Die tatsächlich entfernten Bewertungen sind unbekannt. Das Ergebnis ist deshalb eine Schätzung und keine verifizierte Bewertung, und genau das steht auch in jedem Tooltip.

Profile ohne gemeldete Löschungen bekommen stattdessen einen kleinen sauberen Vermerk: Ehrlichkeit wird anerkannt.

Hinweis: Die Offenlegung existiert nur im Rezensionen-Tab eines Profils. ReviewShield öffnet diesen Tab deshalb kurz, liest die Angabe und kehrt dann dorthin zurück, wo du warst. Währenddessen wird ein Hinweis "Bewertungsstatus wird geprüft" angezeigt. Wenn du während der Prüfung klickst oder scrollst, hält sich ReviewShield sofort zurück und überlässt dir die Kontrolle.

DATENSCHUTZ

Alles läuft lokal in deinem Browser. Keine Netzwerkanfragen, keine Analyse, keine Datensammlung, kein Konto. Die einzige Berechtigung ist "storage" zum Speichern deiner Einstellungen. Quellcode: https://github.com/rvorrink/ReviewShield

## Other form fields

- Category: Tools
- Homepage URL: https://github.com/rvorrink/ReviewShield
- Single purpose: Shows removal-adjusted rating estimates on Google Maps business profiles.
- Permission justification (storage): Stores the user's settings (language, calculation mode, sliders).
- Host permission justification: Reads rating and review-removal information from Google Maps pages to display the adjusted estimate.
- Data usage: no collection categories apply; no data sold or transferred. Remote code: no.
- Screenshots: store-assets/screenshot-1.png, screenshot-2.png, screenshot-3.png (1280x800)
