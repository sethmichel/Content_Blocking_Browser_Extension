/* Popup: one switch per site, backed straight by chrome.storage.local. Content
   scripts listen for storage changes, so toggling here updates open tabs live. */

const DEFAULTS = { youtube: true, amazon: true };

chrome.storage.local.get(DEFAULTS, (settings) => {
  for (const site of Object.keys(DEFAULTS)) {
    const input = document.getElementById(site);
    input.checked = settings[site] !== false;
    input.addEventListener("change", () => {
      chrome.storage.local.set({ [site]: input.checked });
    });
  }
});
