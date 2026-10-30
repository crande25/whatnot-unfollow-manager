// Entry point: starts the panel on whatnot.com pages and answers the
// toolbar button (see src/background.js).
(() => {
  'use strict';
  const WUM = globalThis.WUM;
  if (WUM.started) return;
  WUM.started = true;

  let panel = null;
  let openRequested = false;

  // Registered right away so a toolbar click during page load isn't lost.
  // 'wum:toggle' comes from a click on a Whatnot tab; 'wum:open' from a
  // click elsewhere, after background.js opened this tab.
  WUM.ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || (msg.type !== 'wum:toggle' && msg.type !== 'wum:open')) return;
    if (!panel) openRequested = true;
    else if (msg.type === 'wum:open') panel.open();
    else panel.toggle();
    sendResponse({ ok: true });
  });

  WUM.store.load().then(() => {
    panel = WUM.createPanel();
    if (openRequested) panel.open();
  });
})();
