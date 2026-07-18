'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const P = require('../lib/parse.js');

// ---------------------------------------------------------------- banner match

test('matchBanner detects German banner', () => {
  const m = P.matchBanner(
    'Es wurden 2 bis 5 Bewertungen aufgrund von Beschwerden wegen Diffamierung entfernt'
  );
  assert.ok(m);
  assert.equal(m.lang, 'de');
});

test('matchBanner detects German singular banner', () => {
  const m = P.matchBanner(
    '1 Bewertung wurde aufgrund einer Beschwerde wegen Diffamierung entfernt'
  );
  assert.ok(m);
  assert.equal(m.lang, 'de');
});

test('matchBanner detects English banner', () => {
  const m = P.matchBanner('2 to 5 reviews removed due to defamation complaints');
  assert.ok(m);
  assert.equal(m.lang, 'en');
});

test('matchBanner ignores unrelated text', () => {
  assert.equal(P.matchBanner('Great pizza, lovely staff, 5 stars'), null);
});

// --------------------------------------------------------------- range parsing

test('parseRemovalRange: German closed range', () => {
  const r = P.parseRemovalRange(
    'Es wurden 2 bis 5 Bewertungen aufgrund von Beschwerden wegen Diffamierung entfernt'
  );
  assert.deepEqual(r, { min: 2, max: 5, openEnded: false });
});

test('parseRemovalRange: German larger bucket', () => {
  const r = P.parseRemovalRange(
    '21 bis 50 Bewertungen aufgrund von Beschwerden wegen Diffamierung entfernt'
  );
  assert.deepEqual(r, { min: 21, max: 50, openEnded: false });
});

test('parseRemovalRange: German single count', () => {
  const r = P.parseRemovalRange(
    '1 Bewertung wurde aufgrund einer Beschwerde wegen Diffamierung entfernt'
  );
  assert.deepEqual(r, { min: 1, max: 1, openEnded: false });
});

test('parseRemovalRange: German open-ended bucket with default worst case', () => {
  const r = P.parseRemovalRange(
    'Über 250 Bewertungen aufgrund von Beschwerden wegen Diffamierung entfernt'
  );
  assert.deepEqual(r, { min: 251, max: 500, openEnded: true, base: 250 });
});

test('parseRemovalRange: open-ended bucket respects configured worst case', () => {
  const r = P.parseRemovalRange(
    'über 250 Bewertungen aufgrund von Beschwerden wegen Diffamierung entfernt',
    1000
  );
  assert.deepEqual(r, { min: 251, max: 1000, openEnded: true, base: 250 });
});

test('parseRemovalRange: English closed range', () => {
  const r = P.parseRemovalRange('2 to 5 reviews removed due to defamation complaints');
  assert.deepEqual(r, { min: 2, max: 5, openEnded: false });
});

test('parseRemovalRange: English single count', () => {
  const r = P.parseRemovalRange('1 review was removed due to a defamation complaint');
  assert.deepEqual(r, { min: 1, max: 1, openEnded: false });
});

test('parseRemovalRange: English open-ended bucket', () => {
  const r = P.parseRemovalRange('over 250 reviews removed due to defamation complaints');
  assert.deepEqual(r, { min: 251, max: 500, openEnded: true, base: 250 });
});

test('parseRemovalRange: unrelated numbers outside the banner window are ignored', () => {
  const r = P.parseRemovalRange(
    'Open until 22:00 · 3270 reviews · lots of text here ' +
      '6 bis 10 Bewertungen aufgrund von Beschwerden wegen Diffamierung entfernt'
  );
  assert.deepEqual(r, { min: 6, max: 10, openEnded: false });
});

test('parseRemovalRange: returns null without a banner', () => {
  assert.equal(P.parseRemovalRange('2 bis 5 Sterne sind gut'), null);
});

// ---------------------------------------------------- word-form counts

test('parseRemovalRange: English word-form range', () => {
  const r = P.parseRemovalRange('Six to ten reviews removed due to defamation complaints.');
  assert.deepEqual(r, { min: 6, max: 10, openEnded: false });
});

test('parseRemovalRange: English word-form singular', () => {
  const r = P.parseRemovalRange('One review was removed due to a defamation complaint.');
  assert.deepEqual(r, { min: 1, max: 1, openEnded: false });
});

test('parseRemovalRange: English hyphenated word-form range', () => {
  const r = P.parseRemovalRange('Twenty-one to fifty reviews removed due to defamation complaints.');
  assert.deepEqual(r, { min: 21, max: 50, openEnded: false });
});

test('parseRemovalRange: English word-form open-ended bucket', () => {
  const r = P.parseRemovalRange('Over two hundred and fifty reviews removed due to defamation complaints.');
  assert.deepEqual(r, { min: 251, max: 500, openEnded: true, base: 250 });
});

test('parseRemovalRange: German word-form range', () => {
  const r = P.parseRemovalRange(
    'Sechs bis zehn Bewertungen aufgrund von Beschwerden wegen Diffamierung entfernt'
  );
  assert.deepEqual(r, { min: 6, max: 10, openEnded: false });
});

test('parseRemovalRange: German word-form singular keeps banner intact', () => {
  // "einer Beschwerde" sits inside the banner phrase and must not be rewritten
  const r = P.parseRemovalRange(
    'Eine Bewertung wurde aufgrund einer Beschwerde wegen Diffamierung entfernt'
  );
  assert.deepEqual(r, { min: 1, max: 1, openEnded: false });
});

// --------------------------------------------------------------- count parsing

test('parseLocalizedCount handles German grouping', () => {
  assert.equal(P.parseLocalizedCount('3.270'), 3270);
  assert.equal(P.parseLocalizedCount('1.234.567'), 1234567);
});

test('parseLocalizedCount handles English grouping', () => {
  assert.equal(P.parseLocalizedCount('3,270'), 3270);
  assert.equal(P.parseLocalizedCount('1,234,567'), 1234567);
});

test('parseLocalizedCount handles plain and wrapped numbers', () => {
  assert.equal(P.parseLocalizedCount('412'), 412);
  assert.equal(P.parseLocalizedCount('(3.270)'), 3270);
  assert.equal(P.parseLocalizedCount('3 270'), 3270); // narrow no-break space
});

test('parseLocalizedCount rejects garbage', () => {
  assert.equal(P.parseLocalizedCount('no numbers'), null);
  assert.equal(P.parseLocalizedCount(''), null);
  assert.equal(P.parseLocalizedCount(null), null);
});

// -------------------------------------------------------------- rating parsing

test('parseLocalizedRating handles both decimal separators', () => {
  assert.equal(P.parseLocalizedRating('4,3'), 4.3);
  assert.equal(P.parseLocalizedRating('4.3'), 4.3);
  assert.equal(P.parseLocalizedRating('5,0'), 5);
});

test('parseLocalizedRating tolerates surrounding label text', () => {
  assert.equal(P.parseLocalizedRating('4,6 Sterne'), 4.6);
  assert.equal(P.parseLocalizedRating('4.6 stars'), 4.6);
});

test('parseLocalizedRating rejects out-of-range and garbage values', () => {
  assert.equal(P.parseLocalizedRating('42'), null);
  assert.equal(P.parseLocalizedRating('stars'), null);
  assert.equal(P.parseLocalizedRating(undefined), null);
});

// ------------------------------------------------------------------ correction

test('correctedRating applies the 1-star assumption', () => {
  // (4.6 * 100 + 1 * 5) / 105 = 4.4285…
  const v = P.correctedRating(4.6, 100, 5);
  assert.ok(Math.abs(v - 465 / 105) < 1e-12);
});

test('correctedRating with zero removed is the original rating', () => {
  assert.ok(Math.abs(P.correctedRating(4.2, 50, 0) - 4.2) < 1e-12);
});

test('correctedRating rejects invalid input', () => {
  assert.equal(P.correctedRating(4.2, 0, 5), null);
  assert.equal(P.correctedRating(NaN, 100, 5), null);
  assert.equal(P.correctedRating(6, 100, 5), null);
});

test('correctedRange orders bounds correctly (more removed → lower)', () => {
  const r = P.correctedRange(4.6, 100, { min: 2, max: 5 });
  assert.ok(r.low < r.high);
  assert.ok(Math.abs(r.low - 465 / 105) < 1e-12); // R = max = 5
  assert.ok(Math.abs(r.high - 462 / 102) < 1e-12); // R = min = 2
});

test('correctedRange stays within [1, 5] for the worst case', () => {
  const r = P.correctedRange(4.9, 10, { min: 251, max: 500 });
  assert.ok(r.low >= 1 && r.high <= 5);
});

test('correctedRating honors the assumed star value', () => {
  // (4.6 * 100 + 2.5 * 5) / 105
  const v = P.correctedRating(4.6, 100, 5, 2.5);
  assert.ok(Math.abs(v - 472.5 / 105) < 1e-12);
  assert.equal(P.correctedRating(4.6, 100, 5, 6), null);
  assert.equal(P.correctedRating(4.6, 100, 5, NaN), null);
});

test('a higher assumed star value softens the correction', () => {
  const harsh = P.correctedRange(4.6, 100, { min: 2, max: 5 }, 1);
  const soft = P.correctedRange(4.6, 100, { min: 2, max: 5 }, 2.5);
  assert.ok(soft.low > harsh.low && soft.high > harsh.high);
  assert.ok(soft.low < soft.high);
});

// ------------------------------------------------------------------ formatting

test('formatRating localizes the decimal separator', () => {
  assert.equal(P.formatRating(4.529, 'de'), '4,5');
  assert.equal(P.formatRating(4.529, 'en'), '4.5');
  assert.equal(P.formatRating(5, 'de'), '5,0');
});

test('formatCorrectedRange renders a range or a single value', () => {
  assert.equal(P.formatCorrectedRange(4.43, 4.53, 'de'), '4,4–4,5');
  assert.equal(P.formatCorrectedRange(4.43, 4.53, 'en'), '4.4–4.5');
  assert.equal(P.formatCorrectedRange(4.44, 4.41, 'en'), '4.4');
});

// --------------------------------------------------------- end-to-end example

test('end to end: German panel with "2 bis 5" removed', () => {
  const range = P.parseRemovalRange(
    '2 bis 5 Bewertungen aufgrund von Beschwerden wegen Diffamierung entfernt',
    500
  );
  const rating = P.parseLocalizedRating('4,6');
  const count = P.parseLocalizedCount('3.270');
  const corrected = P.correctedRange(rating, count, range);
  assert.equal(P.formatCorrectedRange(corrected.low, corrected.high, 'de'), '4,6');
  // With a small review base the effect is visible:
  const corrected2 = P.correctedRange(4.6, 40, range);
  assert.equal(P.formatCorrectedRange(corrected2.low, corrected2.high, 'de'), '4,2–4,4');
});
