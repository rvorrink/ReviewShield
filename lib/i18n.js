/**
 * i18n helper for RealReview / EchteSterne.
 *
 * In "auto" mode, strings come straight from chrome.i18n.getMessage() (browser
 * UI language, Chrome's own fallback rules). When the user picks a manual
 * override (de/en) in the popup, chrome.i18n can't switch locales, so we load
 * the same _locales/<lang>/messages.json file ourselves and resolve messages
 * (including $PLACEHOLDER$ substitution) with identical semantics.
 *
 * Browser-only (uses chrome.*); attaches to globalThis.RealReview.i18n.
 */
(function () {
  'use strict';

  /** Resolves a message from a raw messages.json table, chrome.i18n-style. */
  function resolveMessage(table, key, subs) {
    const entry = table && table[key];
    if (!entry || typeof entry.message !== 'string') return '';
    const placeholders = entry.placeholders || {};
    // Placeholder names are case-insensitive in Chrome's format.
    const byLowerName = {};
    for (const name of Object.keys(placeholders)) {
      byLowerName[name.toLowerCase()] = placeholders[name];
    }
    return entry.message
      .replace(/\$([a-zA-Z0-9_@]+)\$/g, (full, name) => {
        const ph = byLowerName[name.toLowerCase()];
        if (!ph || typeof ph.content !== 'string') return full;
        return ph.content.replace(/\$(\d)/g, (_, idx) => {
          const v = subs[Number(idx) - 1];
          return v === undefined || v === null ? '' : String(v);
        });
      })
      .replace(/\$\$/g, '$');
  }

  async function loadMessageTable(lang) {
    const url = chrome.runtime.getURL('_locales/' + lang + '/messages.json');
    const res = await fetch(url);
    return res.json();
  }

  /**
   * Creates a translator for the given language setting ('auto' | 'de' | 'en').
   * Returns { lang, t(key, subs?) }. `lang` is the resolved language and is
   * also used for number formatting (decimal comma vs point).
   */
  async function createTranslator(languageSetting) {
    let uiLang = 'en';
    try {
      uiLang = (chrome.i18n.getUILanguage() || 'en').toLowerCase();
    } catch (e) {
      /* ignore */
    }
    const auto = !languageSetting || languageSetting === 'auto';
    const lang = auto ? (uiLang.startsWith('de') ? 'de' : 'en') : languageSetting;

    // Always load the raw messages table as well. In auto mode it serves as a
    // fallback for chrome.i18n.getMessage — which can start returning '' when
    // the extension is reloaded while old content scripts are still running
    // ("extension context invalidated"), silently blanking every label.
    let table = {};
    try {
      table = await loadMessageTable(lang);
    } catch (e) {
      try {
        table = await loadMessageTable('en');
      } catch (e2) {
        table = {};
      }
    }

    if (auto) {
      return {
        lang,
        t(key, subs) {
          let value = '';
          try {
            value = chrome.i18n.getMessage(key, (subs || []).map(String)) || '';
          } catch (e) {
            value = '';
          }
          return value || resolveMessage(table, key, subs || []);
        },
      };
    }

    return {
      lang,
      t(key, subs) {
        return resolveMessage(table, key, subs || []);
      },
    };
  }

  globalThis.RealReview = globalThis.RealReview || {};
  globalThis.RealReview.i18n = { createTranslator, resolveMessage };
})();
