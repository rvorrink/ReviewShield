/** Popup logic: settings UI persisted via chrome.storage.sync, localized
 *  through the shared i18n helper (respects the manual language override). */
(function () {
  'use strict';

  const RR = globalThis.RealReview;
  const DEFAULTS = RR.config.DEFAULT_SETTINGS;
  const MIN_WORST_CASE = 251;

  const els = {
    enabled: document.getElementById('enabled'),
    language: document.getElementById('language'),
    calcWorst: document.getElementById('calc-worst'),
    calcConservative: document.getElementById('calc-conservative'),
    worstCaseMax: document.getElementById('worstCaseMax'),
  };

  let settings = Object.assign({}, DEFAULTS);
  let translator = null;

  function translatePage() {
    if (!translator) return;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const text = translator.t(el.getAttribute('data-i18n'));
      if (text) el.textContent = text;
    });
    document.title = translator.t('appName') || document.title;
  }

  function renderControls() {
    els.enabled.checked = !!settings.enabled;
    els.language.value = settings.language;
    const conservative = settings.calcMode === 'conservative';
    els.calcConservative.checked = conservative;
    els.calcWorst.checked = !conservative;
    els.worstCaseMax.value = settings.worstCaseMax;
  }

  function save(patch) {
    Object.assign(settings, patch);
    try {
      chrome.storage.sync.set(patch);
    } catch (e) {
      /* silent */
    }
  }

  async function init() {
    const stored = await new Promise((resolve) =>
      chrome.storage.sync.get(DEFAULTS, resolve)
    );
    settings = Object.assign({}, DEFAULTS, stored);
    translator = await RR.i18n.createTranslator(settings.language);
    renderControls();
    translatePage();

    els.enabled.addEventListener('change', () => {
      save({ enabled: els.enabled.checked });
    });

    els.language.addEventListener('change', async () => {
      save({ language: els.language.value });
      translator = await RR.i18n.createTranslator(settings.language);
      translatePage();
    });

    const onModeChange = () => {
      save({ calcMode: els.calcConservative.checked ? 'conservative' : 'worst' });
    };
    els.calcWorst.addEventListener('change', onModeChange);
    els.calcConservative.addEventListener('change', onModeChange);

    els.worstCaseMax.addEventListener('change', () => {
      let value = parseInt(els.worstCaseMax.value, 10);
      if (!Number.isFinite(value) || value < MIN_WORST_CASE) value = DEFAULTS.worstCaseMax;
      els.worstCaseMax.value = value;
      save({ worstCaseMax: value });
    });
  }

  init().catch(() => {
    /* silent */
  });
})();
