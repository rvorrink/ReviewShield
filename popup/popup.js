/** Popup logic: settings UI persisted via chrome.storage.sync, localized
 *  through the shared i18n helper (respects the manual language override). */
(function () {
  'use strict';

  const RR = globalThis.RealReview;
  const DEFAULTS = RR.config.DEFAULT_SETTINGS;

  const els = {
    enabled: document.getElementById('enabled'),
    language: document.getElementById('language'),
    calcWorst: document.getElementById('calc-worst'),
    calcConservative: document.getElementById('calc-conservative'),
    removedStarValue: document.getElementById('removedStarValue'),
    removedStarValueOut: document.getElementById('removedStarValueOut'),
    worstCaseMax: document.getElementById('worstCaseMax'),
    worstCaseMaxOut: document.getElementById('worstCaseMaxOut'),
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

  function formatStarValue(value) {
    const s = Number.isInteger(value) ? String(value) : value.toFixed(1);
    const num = translator && translator.lang === 'de' ? s.replace('.', ',') : s;
    return num + '★';
  }

  function updateSliderOutputs() {
    els.removedStarValueOut.textContent = formatStarValue(parseFloat(els.removedStarValue.value));
    els.worstCaseMaxOut.textContent = els.worstCaseMax.value;
  }

  function renderControls() {
    els.enabled.checked = !!settings.enabled;
    els.language.value = settings.language;
    const conservative = settings.calcMode === 'conservative';
    els.calcConservative.checked = conservative;
    els.calcWorst.checked = !conservative;
    els.removedStarValue.value = settings.removedStarValue;
    els.worstCaseMax.value = settings.worstCaseMax;
    updateSliderOutputs();
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
      updateSliderOutputs();
    });

    const onModeChange = () => {
      save({ calcMode: els.calcConservative.checked ? 'conservative' : 'worst' });
    };
    els.calcWorst.addEventListener('change', onModeChange);
    els.calcConservative.addEventListener('change', onModeChange);

    els.removedStarValue.addEventListener('input', updateSliderOutputs);
    els.removedStarValue.addEventListener('change', () => {
      let value = parseFloat(els.removedStarValue.value);
      if (!Number.isFinite(value)) value = DEFAULTS.removedStarValue;
      value = Math.min(2.5, Math.max(1, value));
      save({ removedStarValue: value });
    });

    els.worstCaseMax.addEventListener('input', updateSliderOutputs);
    els.worstCaseMax.addEventListener('change', () => {
      let value = parseInt(els.worstCaseMax.value, 10);
      if (!Number.isFinite(value)) value = DEFAULTS.worstCaseMax;
      save({ worstCaseMax: value });
    });
  }

  init().catch(() => {
    /* silent */
  });
})();
