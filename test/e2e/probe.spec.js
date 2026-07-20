'use strict';

const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repo = path.resolve(__dirname, '../..');

async function tick(page, ms, step = 100) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await page.clock.runFor(Math.min(step, ms - elapsed));
    await page.evaluate(() => Promise.resolve());
  }
}

async function boot(page, venue = {}, options = {}) {
  const logs = [];
  const consoleErrors = [];
  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith('[RealReview]')) logs.push(text);
    if (message.type() === 'error') consoleErrors.push(text);
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.goto(options.path || '/maps/place/' + encodeURIComponent(options.slug || 'Test_Venue'));
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.evaluate(({ slug, venue }) => window.__maps.venue(slug, venue), {
    slug: options.slug || 'Test_Venue', venue,
  });
  if (options.beforeInject) await page.evaluate(options.beforeInject);
  await page.addScriptTag({ content: `
    window.__settings = ${JSON.stringify(options.settings || {})};
    window.__rrLogs = [];
    const __originalConsoleLog = console.log.bind(console);
    console.log = (...args) => { if (args[0] === '[RealReview]') window.__rrLogs.push(args.map(String).join(' ')); __originalConsoleLog(...args); };
    window.__rrDebug = true; // content.js ships with DEBUG off; tests assert on its log lines
    window.chrome = {
      storage: {
        sync: { get(defaults, cb) { cb(Object.assign({}, defaults, window.__settings)); } },
        onChanged: { addListener(fn) { window.__storageListener = fn; } }
      },
      i18n: { getUILanguage() { return ${JSON.stringify(options.uiLang || venue.lang || 'en')}; }, getMessage() { return ''; } },
      runtime: { getURL(p) { return '/' + p; } }
    };
  ` });
  for (const file of ['lib/config.js', 'lib/parse.js', 'lib/i18n.js', 'content/content.js']) {
    await page.addScriptTag({ path: path.join(repo, file) });
  }
  await page.addStyleTag({ path: path.join(repo, 'content/badge.css') });
  await page.waitForTimeout(50);
  await tick(page, 100);
  return { logs, consoleErrors };
}

async function snapshot(page) { return page.evaluate(() => Object.assign(window.__maps.snapshot(), { rrLogs: window.__rrLogs || [] })); }

async function settle(page, ms = 4000) { await tick(page, ms); return snapshot(page); }

function extensionActivations(snap) { return snap.log.filter((x) => x.cause === 'extension'); }

function assertHealthy(snap, consoleErrors) {
  expect(snap.errors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(snap.maxBadges).toBeLessThanOrEqual(1);
  expect(snap.badges.length).toBeLessThanOrEqual(1);
}

test.describe('probe happy paths', () => {
  for (const lang of ['en', 'de']) {
    test(`A1 flagged venue from Overview (${lang})`, async ({ page }) => {
      const rating = lang === 'de' ? '4,6' : '4.6';
      const count = lang === 'de' ? '3.270' : '3,270';
      const ctx = await boot(page, { lang, rating, count, flagged: true, bannerDelayMs: 800 });
      expect((await snapshot(page)).badges[0]?.kind).toBe('checking');
      const snap = await settle(page, 2600);
      assertHealthy(snap, ctx.consoleErrors);
      expect(snap.selected).toBe('Overview');
      expect(snap.badges[0]).toMatchObject({ kind: 'adjusted', key: 'Test_Venue' });
      expect(snap.badges[0].text).toContain(lang === 'de' ? '4,6' : '4.6');
      expect(extensionActivations(snap).map((x) => x.tab)).toEqual(['Reviews', 'Overview']);
      expect(ctx.logs.some((x) => x.includes('banner found'))).toBeTruthy();
    });

    test(`A2 clean venue from Overview (${lang})`, async ({ page }) => {
      const ctx = await boot(page, { lang, rating: lang === 'de' ? '4,6' : '4.6', count: lang === 'de' ? '3.270' : '3,270', metaDelayMs: 500 });
      const snap = await settle(page, 2600);
      assertHealthy(snap, ctx.consoleErrors);
      expect(snap.selected).toBe('Overview');
      expect(snap.badges[0]?.kind).toBe('clean');
      expect(extensionActivations(snap).map((x) => x.tab)).toEqual(['Reviews', 'Overview']);
    });
  }

  test('A3 entries-only clean waits for long grace', async ({ page }) => {
    await boot(page, { metaDelayMs: null, entriesDelayMs: 300 });
    await tick(page, 1800);
    expect((await snapshot(page)).badges[0]?.kind).toBe('checking');
    const snap = await settle(page, 800);
    expect(snap.badges[0]?.kind).toBe('clean');
  });

  test('A4 banner on already-selected Reviews does not switch tabs', async ({ page }) => {
    const ctx = await boot(page, { initialTab: 'Reviews', flagged: true, bannerDelayMs: 0 });
    const snap = await settle(page, 500);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.selected).toBe('Reviews');
    expect(snap.badges[0]?.kind).toBe('adjusted');
    expect(extensionActivations(snap)).toHaveLength(0);
  });

  test('A5 clean on already-selected Reviews stays there', async ({ page }) => {
    await boot(page, { initialTab: 'Reviews', metaDelayMs: 0, entriesDelayMs: 0 });
    const snap = await settle(page, 2600);
    expect(snap.selected).toBe('Reviews');
    expect(snap.badges[0]?.kind).toBe('clean');
    expect(extensionActivations(snap)).toHaveLength(0);
  });

  test('A6 missing Reviews tab becomes unknown without retrying', async ({ page }) => {
    const ctx = await boot(page, { hasReviewsTab: false });
    const snap = await settle(page, 10_000);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.badges).toEqual([]);
    expect(snap.clickLog).toHaveLength(0);
    expect(ctx.logs.filter((x) => x.includes('reviews tab not found'))).toHaveLength(1);
  });
});

test.describe('tab-switch races', () => {
  for (const lang of ['en', 'de']) {
    test(`B1 swallowed forward click recovers (${lang})`, async ({ page }) => {
      const ctx = await boot(page, { lang, flagged: true }, { beforeInject: () => window.__maps.swallowClicks('Reviews', 1), uiLang: lang });
      const snap = await settle(page, 3500);
      assertHealthy(snap, ctx.consoleErrors);
      expect(snap.selected).toBe('Overview');
      expect(snap.badges[0]?.kind).toBe('adjusted');
      expect(snap.clickLog.filter((x) => x.tab === 'Reviews')).toHaveLength(2);
      expect(ctx.logs.some((x) => x.includes('re-clicking'))).toBeTruthy();
    });
  }

  test('B2a transient forward failure re-probes exactly once and succeeds', async ({ page }) => {
    const ctx = await boot(page, { flagged: true }, { beforeInject: () => window.__maps.swallowClicks('Reviews', 4) });
    const snap = await settle(page, 14_000);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.selected).toBe('Overview');
    expect(snap.badges[0]?.kind).toBe('adjusted');
    expect(snap.clickLog.filter((x) => x.tab === 'Reviews')).toHaveLength(5);
    expect(snap.rrLogs.filter((x) => x.includes('transient unknown verdict, re-probing once'))).toHaveLength(1);
  });

  test('B2b permanent forward failure retries once then stays quiet', async ({ page }) => {
    const ctx = await boot(page, { flagged: true }, { beforeInject: () => window.__maps.swallowClicks('Reviews', 8) });
    await tick(page, 18_000);
    const before = await snapshot(page);
    expect(before.badges).toEqual([]);
    expect(before.clickLog.filter((x) => x.tab === 'Reviews')).toHaveLength(8);
    await tick(page, 10_000);
    const snap = await snapshot(page);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.selected).toBe('Overview');
    expect(snap.badges).toEqual([]);
    expect(snap.clickLog.filter((x) => x.tab === 'Reviews')).toHaveLength(8);
    expect(snap.rrLogs.filter((x) => x.includes('transient unknown verdict, re-probing once'))).toHaveLength(1);
  });

  test('B3 two swallowed back clicks recover on third attempt', async ({ page }) => {
    const ctx = await boot(page, { flagged: true }, { beforeInject: () => window.__maps.swallowClicks('Overview', 2) });
    const snap = await settle(page, 3000);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.selected).toBe('Overview');
    expect(snap.badges[0]?.kind).toBe('adjusted');
    expect(snap.clickLog.filter((x) => x.tab === 'Overview')).toHaveLength(3);
  });

  test('B4a recovery returns after three swallowed back clicks', async ({ page }) => {
    const ctx = await boot(page, { flagged: true }, { beforeInject: () => window.__maps.swallowClicks('Overview', 3) });
    const snap = await settle(page, 6000);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.selected).toBe('Overview');
    expect(snap.badges[0]?.kind).toBe('adjusted');
    expect(snap.clickLog.filter((x) => x.tab === 'Overview')).toHaveLength(4);
    expect(snap.rrLogs.some((x) => x.includes('scheduling switch-back recovery'))).toBeTruthy();
    expect(snap.rrLogs.some((x) => x.includes('recovery: retrying switch-back'))).toBeTruthy();
  });

  test('B4b recovery gives up after its bounded window', async ({ page }) => {
    const ctx = await boot(page, { flagged: true }, { beforeInject: () => window.__maps.swallowClicks('Overview', 99) });
    await tick(page, 15_000);
    const before = await snapshot(page);
    const attempts = before.clickLog.filter((x) => x.tab === 'Overview').length;
    expect(attempts).toBeGreaterThanOrEqual(10);
    expect(attempts).toBeLessThanOrEqual(16);
    await tick(page, 6000);
    const snap = await snapshot(page);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.selected).toBe('Reviews');
    expect(snap.badges[0]?.kind).toBe('adjusted');
    expect(snap.clickLog.filter((x) => x.tab === 'Overview')).toHaveLength(attempts);
  });

  test('B4c trusted user input cancels pending recovery', async ({ page }) => {
    const ctx = await boot(page, { flagged: true }, { beforeInject: () => window.__maps.swallowClicks('Overview', 99) });
    for (let i = 0; i < 50; i++) {
      if ((await snapshot(page)).rrLogs.some((x) => x.includes('scheduling switch-back recovery'))) break;
      await tick(page, 100);
    }
    const beforeInput = await snapshot(page);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(100);
    await tick(page, 5000);
    const snap = await snapshot(page);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.selected).toBe('Reviews');
    expect(snap.clickLog.filter((x) => x.tab === 'Overview')).toHaveLength(
      beforeInput.clickLog.filter((x) => x.tab === 'Overview').length
    );
    expect(snap.rrLogs.some((x) => x.includes('recovery: user input, cancelling pending switch-back'))).toBeTruthy();
  });

  test('B4d trusted Reviews re-selection makes switch-back yield', async ({ page }) => {
    const ctx = await boot(page, { flagged: true });
    for (let i = 0; i < 40; i++) {
      if ((await snapshot(page)).clickLog.some((x) => x.tab === 'Overview' && x.cause === 'extension')) break;
      await tick(page, 50, 50);
    }
    await page.getByRole('tab', { name: /Reviews for/ }).click();
    await page.waitForTimeout(100);
    const snap = await settle(page, 2200);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.selected).toBe('Reviews');
    expect(snap.clickLog.filter((x) => x.tab === 'Overview' && x.cause === 'extension')).toHaveLength(1);
    expect(snap.rrLogs.some((x) => x.includes('user input during switch-back, yielding'))).toBeTruthy();
    expect(snap.rrLogs.some((x) => x.includes('scheduling switch-back recovery'))).toBeFalsy();
  });

  test('B5 replaced tab nodes use label fallback', async ({ page }) => {
    const ctx = await boot(page, { flagged: true }, { beforeInject: () => window.__maps.replaceTabsOn('reviews-selected') });
    const snap = await settle(page, 3000);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.selected).toBe('Overview');
    expect(snap.badges[0]?.kind).toBe('adjusted');
  });

  test('B6 user selecting About mid-probe is not hijacked', async ({ page }) => {
    const ctx = await boot(page, { flagged: true, bannerDelayMs: 1400 });
    await tick(page, 400);
    await page.evaluate(() => window.__maps.userClickTab('About'));
    const snap = await settle(page, 3000);
    if (process.env.DUMP_LOGS) console.log('\nB6 LOGS\n' + snap.rrLogs.join('\n'), '\nB6 TABS\n', snap.log);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.selected).toBe('About');
    expect(snap.log.filter((x) => x.at > snap.log.find((y) => y.cause === 'user').at && x.cause === 'extension')).toHaveLength(0);
  });

  test('B7 navigation mid-probe aborts old work and re-probes on return', async ({ page }) => {
    const ctx = await boot(page, { name: 'Test Venue', flagged: true, bannerDelayMs: 800 });
    await tick(page, 500);
    await page.evaluate(() => window.__maps.navigate('Other_Venue', {
      name: 'Other Venue', flagged: false, metaDelayMs: 0, entriesDelayMs: 0,
    }));
    await tick(page, 2500);
    let snap = await snapshot(page);
    expect(snap.badges[0]).toMatchObject({ key: 'Other_Venue', kind: 'clean' });
    const otherClicks = snap.clickLog.filter((x) => x.slug === 'Other_Venue' && x.tab === 'Reviews').length;
    expect(otherClicks).toBe(1);
    await page.evaluate(() => window.__maps.navigate('Test_Venue'));
    snap = await settle(page, 4000);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.badges[0]).toMatchObject({ key: 'Test_Venue', kind: 'adjusted' });
    expect(snap.clickLog.filter((x) => x.slug === 'Test_Venue' && x.tab === 'Reviews').length).toBeGreaterThanOrEqual(2);
    expect(snap.rrLogs.some((x) => x.includes('probe aborted: navigated away from Test_Venue'))).toBeTruthy();
  });

  test('B8 rapid A to B to A hopping does not deadlock or misattribute badges', async ({ page }) => {
    const ctx = await boot(page, { name: 'Alpha Venue', flagged: true, bannerDelayMs: 1200 }, { slug: 'Alpha_Venue' });
    await tick(page, 500);
    await page.evaluate(() => window.__maps.navigate('Beta_Venue', {
      name: 'Beta Venue', flagged: false, metaDelayMs: 300, entriesDelayMs: 300,
    }));
    let snap = await snapshot(page);
    expect(snap.badges.every((b) => b.key === 'Beta_Venue')).toBeTruthy();
    await tick(page, 500);
    await page.evaluate(() => window.__maps.navigate('Alpha_Venue'));
    snap = await snapshot(page);
    expect(snap.badges.every((b) => b.key === 'Alpha_Venue')).toBeTruthy();
    snap = await settle(page, 4500);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.current).toBe('Alpha_Venue');
    expect(snap.badges[0]).toMatchObject({ key: 'Alpha_Venue', kind: 'adjusted' });
  });
});

test.describe('guards, cache, and rendering', () => {
  for (const lang of ['en', 'de']) {
    test(`C1 visible stale flagged panel cannot flag new clean venue (${lang})`, async ({ page }) => {
      await boot(page, { name: 'Test Venue', lang, flagged: true, bannerDelayMs: 0 }, { uiLang: lang });
      await settle(page, 1800);
      await page.evaluate(({ lang }) => {
        window.__maps.keepStalePanel(1500, false);
        window.__maps.navigate('Clean_Venue', {
          name: 'Clean Venue', lang, flagged: false, metaDelayMs: 0,
          rating: lang === 'de' ? '4,6' : '4.6', count: lang === 'de' ? '3.270' : '3,270',
        });
      }, { lang });
      const snap = await settle(page, 3500);
      if (process.env.DUMP_LOGS) console.log(`\nC1 ${lang} LOGS\n` + snap.rrLogs.join('\n'));
      expect(snap.badges[0]).toMatchObject({ kind: 'clean', key: 'Clean_Venue' });
    });
  }

  test('C2 persistent mismatch never attributes stale flagged data to the new key', async ({ page }) => {
    const ctx = await boot(page, { name: 'Old Venue', initialTab: 'Reviews', flagged: true, bannerDelayMs: 0 }, { slug: 'Old_Venue' });
    await settle(page, 500);
    await page.evaluate(() => {
      window.__maps.setKnobs({ panelSwapDelayMs: 4000 });
      window.__maps.navigate('New_Venue', { name: 'New Venue', flagged: false, metaDelayMs: 0, entriesDelayMs: 0 });
    });
    await tick(page, 3200);
    let snap = await snapshot(page);
    expect(snap.badges.some((b) => b.key === 'New_Venue' && b.kind === 'adjusted')).toBeFalsy();
    snap = await settle(page, 4500);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.badges[0]).toMatchObject({ key: 'New_Venue', kind: 'clean' });
  });

  test('C3 Overview snippets cannot fake clean after swallowed Reviews clicks', async ({ page }) => {
    await boot(page, { flagged: true, overviewSnippets: true }, { beforeInject: () => window.__maps.swallowClicks('Reviews', 8) });
    const snap = await settle(page, 18_000);
    expect(snap.badges).toEqual([]);
    expect(snap.clickLog.filter((x) => x.tab === 'Reviews')).toHaveLength(8);
  });

  test('C4 stale pre-selected Reviews yields to the real Overview panel', async ({ page }) => {
    const ctx = await boot(page, { name: 'Old Venue', initialTab: 'Reviews', flagged: true, bannerDelayMs: 0 }, { slug: 'Old_Venue' });
    await settle(page, 500);
    await page.evaluate(() => {
      window.__maps.setKnobs({ panelSwapDelayMs: 1000 });
      window.__maps.navigate('Real_Venue', { name: 'Real Venue', flagged: false, metaDelayMs: 0, entriesDelayMs: 0 });
    });
    const snap = await settle(page, 4000);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.selected).toBe('Overview');
    expect(snap.badges[0]).toMatchObject({ key: 'Real_Venue', kind: 'clean' });
  });

  test('C5 hidden stale flagged panel does not leak into clean venue', async ({ page }) => {
    await boot(page, { flagged: true, bannerDelayMs: 0 });
    await settle(page, 1800);
    await page.evaluate(() => {
      window.__maps.keepStalePanel(5000, true);
      window.__maps.navigate('Clean_Venue', { name: 'Clean Venue', flagged: false, metaDelayMs: 0 });
    });
    const snap = await settle(page, 3200);
    if (process.env.DUMP_LOGS) console.log('\nC5 LOGS\n' + snap.rrLogs.join('\n'));
    expect(snap.badges[0]).toMatchObject({ kind: 'clean', key: 'Clean_Venue' });
  });

  test('D1 cached flagged verdict avoids a second probe', async ({ page }) => {
    await boot(page, { name: 'Test Venue', flagged: true });
    await settle(page, 2500);
    await page.evaluate(() => window.__maps.venue('Other_Venue', { name: 'Other Venue', flagged: false, metaDelayMs: 0 }));
    await page.evaluate(() => history.pushState({}, '', '/maps/place/Other_Venue'));
    await tick(page, 500);
    await page.evaluate(() => { history.pushState({}, '', '/maps/place/Test_Venue'); window.__maps.venue('Test_Venue', { name: 'Test Venue', flagged: true }); window.__maps.resetLog(); });
    const snap = await settle(page, 500);
    expect(snap.badges[0]).toMatchObject({ kind: 'adjusted', key: 'Test_Venue' });
    expect(snap.clickLog).toHaveLength(0);
  });

  test('D2 settings change invalidates cache, re-probes, and clamps star value', async ({ page }) => {
    const ctx = await boot(page, { rating: '4.6', count: '100', flagged: true });
    let snap = await settle(page, 2500);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.badges[0]?.label).toContain('4.4|');
    expect(snap.clickLog.filter((x) => x.tab === 'Reviews')).toHaveLength(1);
    await page.evaluate(() => window.__maps.fireSettings({ calcMode: 'conservative', removedStarValue: 9 }));
    snap = await settle(page, 3000);
    expect(snap.badges[0]?.kind).toBe('adjusted');
    expect(snap.badges[0]?.label).toContain('4.6|');
    expect(snap.badges[0]?.label).toContain('conservative|2.5');
    expect(snap.clickLog.filter((x) => x.tab === 'Reviews')).toHaveLength(2);
  });

  test('D3 disabling mid-probe removes badges and records tab side effects', async ({ page }) => {
    await boot(page, { flagged: true, bannerDelayMs: 1400 });
    await tick(page, 400);
    const disabledAt = await page.evaluate(() => { const at = Date.now(); window.__maps.fireSettings({ enabled: false }); return at; });
    const snap = await settle(page, 2500);
    if (process.env.DUMP_LOGS) console.log('\nD3 LOGS\n' + snap.rrLogs.join('\n'), '\nD3 TABS\n', snap.log);
    expect(snap.badges).toEqual([]);
    expect(snap.log.filter((x) => x.at > disabledAt && x.cause === 'extension')).toHaveLength(0);
  });

  test('D4a transient unknown retries once and never a second time', async ({ page }) => {
    await boot(page, { flagged: true }, { beforeInject: () => window.__maps.swallowClicks('Reviews', 8) });
    await tick(page, 18_000);
    const before = await snapshot(page);
    expect(before.clickLog.filter((x) => x.tab === 'Reviews')).toHaveLength(8);
    await tick(page, 10_000);
    const snap = await snapshot(page);
    expect(snap.clickLog.filter((x) => x.tab === 'Reviews')).toHaveLength(8);
    expect(snap.badges).toEqual([]);
    expect(snap.rrLogs.filter((x) => x.includes('transient unknown verdict, re-probing once'))).toHaveLength(1);
  });

  for (const variant of ['no-content', 'no-tab']) {
    test(`D4b non-transient unknown never retries (${variant})`, async ({ page }) => {
      const venue = variant === 'no-tab'
        ? { hasReviewsTab: false }
        : { metaDelayMs: null, entriesDelayMs: null };
      await boot(page, venue);
      await tick(page, 18_000);
      const snap = await snapshot(page);
      expect(snap.badges).toEqual([]);
      expect(snap.clickLog.filter((x) => x.tab === 'Reviews')).toHaveLength(variant === 'no-tab' ? 0 : 1);
      expect(snap.rrLogs.some((x) => x.includes('transient unknown verdict, re-probing once'))).toBeFalsy();
    });
  }

  test('E1 deleted cached badge returns on periodic rescan', async ({ page }) => {
    await boot(page, { flagged: true });
    await settle(page, 2500);
    await page.evaluate(() => { window.__maps.removeBadge(); window.__maps.resetLog(); });
    await tick(page, 3100);
    const snap = await snapshot(page);
    expect(snap.badges[0]?.kind).toBe('adjusted');
    expect(snap.clickLog).toHaveLength(0);
    expect(snap.maxBadges).toBeLessThanOrEqual(1);
  });

  test('E2 mutation storm does not duplicate badges or probes', async ({ page }) => {
    await boot(page, { flagged: true });
    for (let i = 0; i < 100; i++) { await page.evaluate(() => window.__maps.mutate()); await tick(page, 50, 50); }
    const snap = await settle(page, 1000);
    expect(snap.badges).toHaveLength(1);
    expect(snap.maxBadges).toBeLessThanOrEqual(1);
    expect(snap.clickLog.filter((x) => x.tab === 'Reviews')).toHaveLength(1);
  });

  test('E3 reviewer-count decoy is rejected in favor of header count', async ({ page }) => {
    const ctx = await boot(page, { reviewerDecoy: true, flagged: true });
    const snap = await settle(page, 2500);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.badges[0]?.kind).toBe('adjusted');
    expect(snap.badges[0]?.label).toContain('4.6|');
    expect(await page.locator('.realreview-badge').evaluate((el) => !!el.closest('.header'))).toBeTruthy();
  });

  test('E4 search results stay untouched and search-to-place navigation works', async ({ page }) => {
    const ctx = await boot(page, { name: 'Search Decoy', flagged: true }, { path: '/maps/search/cafes', slug: 'Search_Decoy' });
    await tick(page, 5000);
    let snap = await snapshot(page);
    expect(snap.badges).toEqual([]);
    expect(snap.clickLog).toHaveLength(0);
    await page.evaluate(() => window.__maps.navigate('Real_Venue', {
      name: 'Real Venue', flagged: false, metaDelayMs: 0, entriesDelayMs: 0,
    }));
    snap = await settle(page, 3900);
    assertHealthy(snap, ctx.consoleErrors);
    expect(snap.badges[0]).toMatchObject({ key: 'Real_Venue', kind: 'clean' });
  });

  for (const slug of ['52.5200,13.4050°', 'AB']) {
    test(`E5 non-comparable place key opts out safely (${slug})`, async ({ page }) => {
      const ctx = await boot(page, { name: 'Coordinate Venue', flagged: false, metaDelayMs: 0, entriesDelayMs: 0 }, { slug });
      const snap = await settle(page, 2500);
      assertHealthy(snap, ctx.consoleErrors);
      expect(snap.badges[0]).toMatchObject({ key: slug, kind: 'clean' });
      expect(snap.selected).toBe('Overview');
    });
  }
});

test.describe('timing edges', () => {
  test('F1 content arriving at 5.5s still reaches clean before hard ceiling', async ({ page }) => {
    await boot(page, { metaDelayMs: 5500, entriesDelayMs: null });
    const snap = await settle(page, 8600);
    expect(snap.badges[0]?.kind).toBe('clean');
    expect(snap.selected).toBe('Overview');
  });

  test('F2 no content ends unknown and stays quiet', async ({ page }) => {
    await boot(page, { metaDelayMs: null, entriesDelayMs: null });
    const snap = await settle(page, 10_000);
    expect(snap.badges).toEqual([]);
    expect(snap.clickLog.filter((x) => x.tab === 'Reviews')).toHaveLength(1);
  });

  // Field observation (2026-07): the "Reviews aren't verified" marker and the
  // removal banner are mutually exclusive — flagged venues never show the
  // marker. The old F3a scenario (marker present, banner arriving later) does
  // not occur on real Maps, so the marker now grants a fast clean verdict.
  test('F3a marker-present clean venue verdicts fast and switches back quickly', async ({ page }) => {
    await boot(page, { metaDelayMs: 300, entriesDelayMs: 300 });
    const snap = await settle(page, 1700);
    if (process.env.DUMP_LOGS) console.log('\nF3a LOGS\n' + snap.rrLogs.join('\n'));
    expect(snap.badges[0]?.kind).toBe('clean');
    expect(snap.selected).toBe('Overview');
    expect(extensionActivations(snap).map((x) => x.tab)).toEqual(['Reviews', 'Overview']);
  });

  test('F3c a banner seen later overrides a cached clean verdict', async ({ page }) => {
    await boot(page, { metaDelayMs: 0, entriesDelayMs: 0 });
    let snap = await settle(page, 2500);
    expect(snap.badges[0]?.kind).toBe('clean'); // clean verdict cached
    // The user opens Reviews later and the venue now shows the removal
    // banner (defense in depth if marker/banner exclusivity is ever wrong).
    await page.evaluate(() => window.__maps.venue('Test_Venue', {
      name: 'Test Venue', flagged: true, bannerDelayMs: 0, initialTab: 'Reviews',
    }));
    snap = await settle(page, 1500);
    expect(snap.badges[0]?.kind).toBe('adjusted');
  });

  test('F3b late banner without meta is found during long grace', async ({ page }) => {
    await boot(page, { flagged: true, entriesDelayMs: 1000, metaDelayMs: null, bannerDelayMs: 2500 });
    const snap = await settle(page, 3500);
    expect(snap.badges[0]?.kind).toBe('adjusted');
  });
});
